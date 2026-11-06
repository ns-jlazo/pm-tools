"""Jira sync + linking service (read-only)."""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Sequence, Tuple

import requests
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .. import models, schemas
from .auth import JiraNotConfigured, get_jira_credentials
from .client import JiraClient


logger = logging.getLogger(__name__)


_DEFAULT_TTL_SECONDS = 300
# Labels that tag a project feature live on stories in this Jira project.
_DEFAULT_LABEL_PROJECT_KEY = "SNA"


def _ttl_seconds() -> int:
    raw = os.environ.get("JIRA_SYNC_TTL_SECONDS")
    if not raw:
        return _DEFAULT_TTL_SECONDS
    try:
        return max(0, int(raw))
    except ValueError:
        return _DEFAULT_TTL_SECONDS


def label_project_key(override: Optional[str] = None) -> str:
    """Jira project the label search is scoped to, most specific source first."""
    for candidate in (override, os.environ.get("JIRA_LABEL_PROJECT_KEY")):
        if candidate and candidate.strip():
            return candidate.strip()
    return _DEFAULT_LABEL_PROJECT_KEY


def get_client() -> JiraClient:
    url, email, token = get_jira_credentials()
    return JiraClient(url=url, email=email, api_token=token)


# ---------------------------------------------------------------- normalization


def _parse_date(value: Any) -> Optional[date]:
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _normalize_raw(raw: Dict[str, Any], server_url: str) -> Dict[str, Any]:
    """Convert a raw Jira issue dict into columns for `JiraIssue`."""
    fields = raw.get("fields") or {}
    status = fields.get("status") or {}
    status_category = (status.get("statusCategory") or {}).get("key", "")
    issue_type = (fields.get("issuetype") or {}).get("name") or ""
    assignee = fields.get("assignee") or {}
    parent = fields.get("parent") or {}
    key = raw.get("key") or ""
    return {
        "jira_key": key,
        "jira_url": f"{server_url.rstrip('/')}/browse/{key}" if key else "",
        "issue_type": issue_type,
        "summary": fields.get("summary") or "",
        "status": status.get("name") or "",
        "status_category": status_category,
        "assignee_name": assignee.get("displayName") or "",
        "assignee_email": assignee.get("emailAddress") or "",
        "parent_key": (parent.get("key") or None) if parent else None,
        "due_date": _parse_date(fields.get("duedate")),
    }


def _to_search_result(raw: Dict[str, Any], server_url: str) -> schemas.JiraSearchResult:
    norm = _normalize_raw(raw, server_url)
    return schemas.JiraSearchResult(
        key=norm["jira_key"],
        url=norm["jira_url"],
        issue_type=norm["issue_type"],
        summary=norm["summary"],
        status=norm["status"],
        status_category=norm["status_category"],
        assignee_name=norm["assignee_name"],
        assignee_email=norm["assignee_email"],
        parent_key=norm["parent_key"],
        due_date=norm["due_date"],
    )


def _server_base(browse_url: str) -> str:
    """Recover the Jira server root from a stored `.../browse/KEY` URL."""
    return (browse_url or "").split("/browse/")[0]


def _link_ref(
    relation: str, raw_issue: Dict[str, Any], server_url: str
) -> Optional[schemas.JiraIssueLinkRef]:
    """Build one link ref from the partial issue Jira embeds in a relationship."""
    key = raw_issue.get("key") or ""
    if not key:
        return None
    fields = raw_issue.get("fields") or {}
    status = fields.get("status") or {}
    return schemas.JiraIssueLinkRef(
        relation=relation,
        key=key,
        url=f"{server_url.rstrip('/')}/browse/{key}",
        summary=fields.get("summary") or "",
        status=status.get("name") or "",
        status_category=(status.get("statusCategory") or {}).get("key", ""),
        issue_type=(fields.get("issuetype") or {}).get("name") or "",
    )


def _parse_issue_links(raw_json: str, server_url: str) -> List[schemas.JiraIssueLinkRef]:
    """Extract a story's Jira relationships from the cached `raw_json`.

    `JiraClient.search_issues` asks for `issuelinks` alongside `*navigable`, so
    the blocks / is blocked by / relates to graph is already on disk — the Gantt
    overlay needs no extra Jira calls. Malformed or partial payloads yield [].
    """
    if not raw_json:
        return []
    try:
        raw = json.loads(raw_json)
    except (TypeError, ValueError):
        return []
    fields = (raw or {}).get("fields") or {}

    refs: List[schemas.JiraIssueLinkRef] = []
    for item in fields.get("issuelinks") or []:
        if not isinstance(item, dict):
            continue
        link_type = item.get("type") or {}
        if item.get("inwardIssue"):
            # `inward` reads from this issue's perspective, e.g. "is blocked by".
            ref = _link_ref(
                link_type.get("inward") or "relates to", item["inwardIssue"], server_url
            )
        elif item.get("outwardIssue"):
            ref = _link_ref(
                link_type.get("outward") or "relates to",
                item["outwardIssue"],
                server_url,
            )
        else:
            ref = None
        if ref is not None:
            refs.append(ref)

    parent = fields.get("parent") or {}
    if parent:
        ref = _link_ref("parent", parent, server_url)
        if ref is not None:
            refs.append(ref)

    for subtask in fields.get("subtasks") or []:
        if not isinstance(subtask, dict):
            continue
        ref = _link_ref("subtask", subtask, server_url)
        if ref is not None:
            refs.append(ref)

    return refs


def _issue_to_read(issue: models.JiraIssue) -> schemas.JiraIssueRead:
    return schemas.JiraIssueRead(
        id=issue.id,
        key=issue.jira_key,
        url=issue.jira_url,
        issue_type=issue.issue_type,
        summary=issue.summary,
        status=issue.status,
        status_category=issue.status_category,
        assignee_name=issue.assignee_name,
        assignee_email=issue.assignee_email,
        parent_key=issue.parent_key,
        due_date=issue.due_date,
        synced_at=issue.synced_at,
        links=_parse_issue_links(issue.raw_json, _server_base(issue.jira_url)),
    )


# ---------------------------------------------------------------------- upsert


def _upsert_issue(
    db: Session, raw: Dict[str, Any], server_url: str, now: datetime
) -> models.JiraIssue:
    norm = _normalize_raw(raw, server_url)
    key = norm["jira_key"]
    if not key:
        raise ValueError("Jira response missing issue key.")

    issue = db.scalar(select(models.JiraIssue).where(models.JiraIssue.jira_key == key))
    if issue is None:
        issue = models.JiraIssue(
            jira_key=key,
            jira_url=norm["jira_url"],
            issue_type=norm["issue_type"],
            summary=norm["summary"],
            status=norm["status"],
            status_category=norm["status_category"],
            assignee_name=norm["assignee_name"],
            assignee_email=norm["assignee_email"],
            parent_key=norm["parent_key"],
            due_date=norm["due_date"],
            raw_json=json.dumps(raw),
            synced_at=now,
        )
        db.add(issue)
        db.flush()
        return issue

    issue.jira_url = norm["jira_url"] or issue.jira_url
    issue.issue_type = norm["issue_type"]
    issue.summary = norm["summary"]
    issue.status = norm["status"]
    issue.status_category = norm["status_category"]
    issue.assignee_name = norm["assignee_name"]
    issue.assignee_email = norm["assignee_email"]
    issue.parent_key = norm["parent_key"]
    issue.due_date = norm["due_date"]
    issue.raw_json = json.dumps(raw)
    issue.synced_at = now
    db.flush()
    return issue


# ---------------------------------------------------------------- public API


SEARCH_PAGE_SIZE = 10


def search(
    jql: str,
    limit: int = SEARCH_PAGE_SIZE,
    next_page_token: Optional[str] = None,
) -> schemas.JiraSearchResponse:
    client = get_client()
    envelope = client.search_issues(
        jql=jql, max_results=limit, next_page_token=next_page_token
    )
    server_url = client.url
    issues = [_to_search_result(raw, server_url) for raw in envelope.get("issues") or []]
    return schemas.JiraSearchResponse(
        total=envelope.get("total") or len(issues),
        issues=issues,
        next_page_token=envelope.get("nextPageToken"),
        is_last=bool(envelope.get("isLast", True)),
    )


def check_health() -> schemas.JiraHealth:
    """Report whether Jira is configured *and* whether the token actually works.

    A bad token is otherwise invisible: Jira Cloud answers searches
    anonymously (200 with zero issues) and issue reads with a 404, so the UI
    would show "no results" instead of a credential problem.
    """
    try:
        url, email, _ = get_jira_credentials()
    except JiraNotConfigured as exc:
        return schemas.JiraHealth(configured=False, detail=str(exc))

    try:
        me = get_client().get_myself()
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else None
        if status in (401, 403):
            detail = (
                "Jira rejected the credentials for {email} "
                "(check JIRA_EMAIL / JIRA_API_TOKEN).".format(email=email)
            )
        else:
            detail = "Could not reach Jira: {exc}".format(exc=exc)
        return schemas.JiraHealth(configured=True, url=url, detail=detail)
    except requests.RequestException as exc:
        return schemas.JiraHealth(
            configured=True, url=url, detail="Could not reach Jira: {exc}".format(exc=exc)
        )

    return schemas.JiraHealth(
        configured=True,
        authenticated=True,
        account=me.get("displayName") or me.get("emailAddress") or email,
        url=url,
    )


def get_issue_by_key(key: str) -> schemas.JiraSearchResult:
    """Fetch one issue directly from Jira (used to validate paste-a-key)."""
    client = get_client()
    raw = client.get_issue(key)
    return _to_search_result(raw, client.url)


def fetch_children(epic_key: str, limit: int = 100) -> List[schemas.JiraSearchResult]:
    """Return stories/tasks whose parent is `epic_key` for the sidebar."""
    jql = f'parent = "{epic_key}" ORDER BY status, key'
    client = get_client()
    raw_issues = client.search_all_issues(jql=jql, max_results=limit)
    return [_to_search_result(raw, client.url) for raw in raw_issues]


# ------------------------------------------------------------------------ labels


def _quote_jql(value: str) -> str:
    """Escape a user-supplied value for a double-quoted JQL literal."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _unquote_jql(value: str) -> str:
    """Undo Jira's JQL quoting of an autocomplete `value`.

    Jira returns suggestion values ready to paste into JQL, so a label that
    needs quoting comes back wrapped and escaped — `"#cap-upsize"` or
    `"\\"cap-review\\""`. Handing that straight back to `labels = "..."` searches
    for a label whose name contains the quotes, which never matches anything.
    """
    cleaned = (value or "").strip()
    if len(cleaned) >= 2 and cleaned.startswith('"') and cleaned.endswith('"'):
        # Unwrap once only: `"\"cap-review\""` is a label whose name really does
        # contain quotes, and `_quote_jql` re-escapes it on the way back out.
        cleaned = cleaned[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return cleaned.strip()


def _labels_from_issues(client: JiraClient, project_key: str, prefix: str) -> List[str]:
    """Derive labels actually in use in `project_key` from recent issues."""
    jql = (
        f'project = "{_quote_jql(project_key)}" AND labels IS NOT EMPTY '
        "ORDER BY updated DESC"
    )
    raws = client.search_all_issues(jql=jql, max_results=100)
    lowered = prefix.lower()
    found = set()
    for raw in raws:
        for label in (raw.get("fields") or {}).get("labels") or []:
            if label and lowered in str(label).lower():
                found.add(str(label))
    return sorted(found)


def suggest_labels(
    query: str = "", project_key: Optional[str] = None, limit: int = 25
) -> schemas.JiraLabelSuggestions:
    """Label typeahead for the "By label" picker tab.

    Jira's autocomplete endpoint is tenant-wide, so results are filtered on the
    query here. If it is unavailable (some tenants restrict it), fall back to the
    labels actually used by recent issues in `project_key` — slower, but scoped.
    """
    key = label_project_key(project_key)
    client = get_client()
    prefix = (query or "").strip()

    try:
        payload = client.get_label_suggestions(prefix)
    except requests.HTTPError as exc:
        logger.warning("Jira label autocomplete unavailable, deriving from issues: %s", exc)
        return schemas.JiraLabelSuggestions(
            project_key=key,
            labels=_labels_from_issues(client, key, prefix)[:limit],
            source="issues",
        )

    lowered = prefix.lower()
    labels = []
    for item in payload.get("results") or []:
        value = _unquote_jql((item or {}).get("value") or "")
        if value and lowered in value.lower() and value not in labels:
            labels.append(value)
    return schemas.JiraLabelSuggestions(
        project_key=key, labels=labels[:limit], source="suggestions"
    )


def _epic_start_field() -> Optional[str]:
    """Tenant-specific custom field holding an epic's start date, if configured."""
    value = (os.environ.get("JIRA_EPIC_START_FIELD") or "").strip()
    return value or None


def _epic_dates(raw_json: str) -> Tuple[Optional[date], Optional[date]]:
    """(start, due) of an epic from its cached `raw_json`; either may be None."""
    try:
        fields = (json.loads(raw_json) or {}).get("fields") or {}
    except (TypeError, ValueError):
        return None, None
    field = _epic_start_field()
    start = _parse_date(fields.get(field)) if field else None
    return start, _parse_date(fields.get("duedate"))


def _effective_range(
    epic: Optional[Tuple[Optional[date], Optional[date]]], story_due: Optional[date]
) -> Tuple[Optional[date], Optional[date]]:
    """The parent epic's dates, else the story's due date, else undated."""
    if epic is not None and (epic[0] or epic[1]):
        start, end = epic
    elif story_due is not None:
        start, end = None, story_due
    else:
        return None, None
    # A one-sided range is a single known day.
    return start or end, end or start


def _overlaps(
    start: Optional[date],
    end: Optional[date],
    date_from: Optional[date],
    date_to: Optional[date],
) -> bool:
    if start is None or end is None:
        return True  # undated stories are kept, and flagged for the caller
    if date_from is not None and end < date_from:
        return False
    if date_to is not None and start > date_to:
        return False
    return True


def _linked_in_by_key(
    db: Session, project_id: int
) -> Dict[str, List[schemas.JiraLinkedIn]]:
    """Which of the workspace's deliverables already carry each Jira key."""
    grouped = list_project_deliverable_links(
        db, project_id, refresh_stale=False
    ).links_by_deliverable
    if not grouped:
        return {}
    titles = {
        row.id: row.title
        for row in db.scalars(
            select(models.Deliverable).where(models.Deliverable.id.in_(list(grouped)))
        )
    }
    by_key: Dict[str, List[schemas.JiraLinkedIn]] = {}
    for deliverable_id, links in grouped.items():
        for link in links:
            by_key.setdefault(link.issue.key, []).append(
                schemas.JiraLinkedIn(
                    deliverable_id=deliverable_id,
                    title=titles.get(deliverable_id, ""),
                )
            )
    return by_key


def search_by_label(
    label: str,
    project_key: Optional[str] = None,
    limit: int = 500,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    db: Optional[Session] = None,
    project_id: Optional[int] = None,
) -> schemas.JiraLabelSearchResponse:
    """Every issue in `project_key` carrying `label`, newest first.

    With `db`, each story is placed in time by its parent epic (fetched in one
    batch and cached) and the date window filters on that; with `project_id`
    too, each story reports which deliverables already link it.
    """
    # A label picked from the typeahead before it started unquoting — or pasted
    # out of a JQL snippet — arrives wrapped in quotes; search for the name.
    cleaned = _unquote_jql(label or "")
    if not cleaned:
        raise ValueError("A Jira label is required.")
    if date_from and date_to and date_from > date_to:
        raise ValueError("The start date must be on or before the end date.")
    key = label_project_key(project_key)
    jql = (
        f'project = "{_quote_jql(key)}" AND labels = "{_quote_jql(cleaned)}" '
        "ORDER BY updated DESC"
    )
    client = get_client()
    raws = client.search_all_issues(jql=jql, max_results=limit)
    # The caller's cap was hit, so there may be more behind it.
    truncated = len(raws) >= limit

    epics: Dict[str, models.JiraIssue] = {}
    linked_in: Dict[str, List[schemas.JiraLinkedIn]] = {}
    if db is not None:
        now = datetime.utcnow()
        for raw in raws:
            _upsert_issue(db, raw, client.url, now)
        db.commit()
        parent_keys = {
            (raw.get("fields") or {}).get("parent", {}).get("key")
            for raw in raws
            if (raw.get("fields") or {}).get("parent")
        }
        epics = sync_keys(db, [k for k in parent_keys if k])
        if project_id is not None:
            linked_in = _linked_in_by_key(db, project_id)

    issues: List[schemas.JiraLabelIssue] = []
    for raw in raws:
        base = _to_search_result(raw, client.url)
        epic = epics.get(base.parent_key or "")
        start, end = _effective_range(
            _epic_dates(epic.raw_json) if epic is not None else None, base.due_date
        )
        if not _overlaps(start, end, date_from, date_to):
            continue
        issues.append(
            schemas.JiraLabelIssue(
                **base.model_dump(),
                labels=list((raw.get("fields") or {}).get("labels") or []),
                epic_key=base.parent_key,
                epic_summary=epic.summary if epic is not None else "",
                effective_start=start,
                effective_end=end,
                undated=start is None,
                linked_in=linked_in.get(base.key, []),
            )
        )
    return schemas.JiraLabelSearchResponse(
        project_key=key, label=cleaned, issues=issues, truncated=truncated
    )


# ------------------------------------------------------------------ label sync

# (label, project key, from, to) a cached result was fetched with, so a changed
# label or window is never answered from a stale entry.
_LabelSignature = Tuple[str, str, Optional[date], Optional[date]]
# deliverable id -> (monotonic fetch time, signature, issue keys, truncated)
_label_sync_cache: Dict[int, Tuple[float, _LabelSignature, List[str], bool]] = {}


def _linked_keys(db: Session, deliverable_id: int) -> set:
    return {
        link.issue.jira_key
        for link in _load_links(db, _DELIVERABLE_LINKS, deliverable_id)
    }


def sync_labels(
    db: Session,
    project_id: int,
    force: bool = False,
    deliverable_id: Optional[int] = None,
) -> schemas.JiraLabelSyncResponse:
    """Report each labelled deliverable's stories that are not linked yet.

    Surface-only: it refreshes the issue cache and counts what is new, but never
    links anything — the user decides what to link. Per-deliverable results are
    re-used for `JIRA_SYNC_TTL_SECONDS` unless `force`; a cached answer is still
    compared against the current links, so linking stories clears the badge.
    Jira trouble comes back as `error`, never as an exception.
    """
    if db.get(models.Project, project_id) is None:
        raise ValueError("Project not found.")

    stmt = select(models.Deliverable).where(
        models.Deliverable.project_id == project_id,
        models.Deliverable.jira_label.is_not(None),
    )
    if deliverable_id is not None:
        stmt = stmt.where(models.Deliverable.id == deliverable_id)
        force = True  # an explicit per-deliverable check is never throttled
    deliverables = list(db.scalars(stmt.order_by(models.Deliverable.id)))

    ttl = _ttl_seconds()
    results: List[schemas.JiraLabelSyncItem] = []
    for deliverable in deliverables:
        signature: _LabelSignature = (
            deliverable.jira_label,
            deliverable.jira_label_project_key or "",
            deliverable.jira_label_from,
            deliverable.jira_label_to,
        )
        cached = _label_sync_cache.get(deliverable.id)
        fresh = (
            not force
            and cached is not None
            and cached[1] == signature
            and time.monotonic() - cached[0] < ttl
        )
        item = schemas.JiraLabelSyncItem(
            deliverable_id=deliverable.id, label=deliverable.jira_label
        )
        try:
            if fresh:
                keys, truncated = cached[2], cached[3]
                item.cached = True
            else:
                response = search_by_label(
                    deliverable.jira_label,
                    project_key=deliverable.jira_label_project_key,
                    date_from=deliverable.jira_label_from,
                    date_to=deliverable.jira_label_to,
                    db=db,
                    project_id=project_id,
                )
                keys = [issue.key for issue in response.issues]
                truncated = response.truncated
                _label_sync_cache[deliverable.id] = (
                    time.monotonic(),
                    signature,
                    keys,
                    truncated,
                )
        except JiraNotConfigured as exc:
            return schemas.JiraLabelSyncResponse(results=results, error=str(exc))
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Label sync failed for deliverable %s: %s", deliverable.id, exc
            )
            item.error = "Could not check Jira for this label."
            results.append(item)
            continue
        linked = _linked_keys(db, deliverable.id)
        item.total = len(keys)
        item.new_keys = [key for key in keys if key not in linked]
        item.new_count = len(item.new_keys)
        item.truncated = truncated
        results.append(item)
    return schemas.JiraLabelSyncResponse(results=results)


def sync_keys(db: Session, keys: Sequence[str]) -> Dict[str, models.JiraIssue]:
    """Refresh a set of Jira keys in one JQL batch and upsert results."""
    unique = sorted({k for k in keys if k})
    if not unique:
        return {}
    client = get_client()
    now = datetime.utcnow()
    fetched: Dict[str, models.JiraIssue] = {}
    # Jira's `issuekey in (...)` accepts arbitrary lists; keep batches small to stay under URL limits.
    for start in range(0, len(unique), 50):
        batch = unique[start : start + 50]
        quoted = ", ".join(f'"{k}"' for k in batch)
        try:
            raws = client.search_all_issues(
                jql=f"issuekey in ({quoted})", max_results=len(batch)
            )
        except requests.HTTPError as exc:
            logger.warning("Jira batch sync failed for %s: %s", batch, exc)
            continue
        for raw in raws:
            issue = _upsert_issue(db, raw, client.url, now)
            fetched[issue.jira_key] = issue
    db.commit()
    return fetched


def _link_stale(links: Sequence[models.JiraIssue]) -> bool:
    ttl = _ttl_seconds()
    if ttl <= 0:
        return True
    cutoff = datetime.utcnow() - timedelta(seconds=ttl)
    return any(issue.synced_at < cutoff for issue in links)


def _latest_sync(issues: Sequence[models.JiraIssue]) -> Optional[datetime]:
    if not issues:
        return None
    return max(issue.synced_at for issue in issues)


# --------------------------------------------------------------- project links


def list_project_links(
    db: Session, project_id: int, refresh_stale: bool = True
) -> schemas.ProjectJiraLinksGrouped:
    project = db.get(models.Project, project_id)
    if project is None:
        raise ValueError("Project not found.")

    links = _load_project_links(db, project_id)
    issues = [link.issue for link in links]
    stale = _link_stale(issues) if issues else False
    if stale and refresh_stale:
        try:
            sync_keys(db, [issue.jira_key for issue in issues])
        except JiraNotConfigured:
            raise
        except Exception as exc:  # noqa: BLE001
            # Stale refresh is best-effort; surface data we already have.
            logger.warning("Stale refresh for project %s failed: %s", project_id, exc)
        else:
            links = _load_project_links(db, project_id)
            issues = [link.issue for link in links]
            stale = False

    return schemas.ProjectJiraLinksGrouped(
        project_id=project_id,
        links=[_project_link_read(link) for link in links],
        stale=stale,
        synced_at=_latest_sync(issues),
    )


def _load_project_links(db: Session, project_id: int) -> List[models.ProjectJiraLink]:
    stmt = (
        select(models.ProjectJiraLink)
        .where(models.ProjectJiraLink.project_id == project_id)
        .options(selectinload(models.ProjectJiraLink.issue))
        .order_by(models.ProjectJiraLink.id)
    )
    return list(db.scalars(stmt))


def _project_link_read(link: models.ProjectJiraLink) -> schemas.ProjectJiraLinkRead:
    return schemas.ProjectJiraLinkRead(
        id=link.id,
        project_id=link.project_id,
        team_id=link.team_id,
        linked_at=link.linked_at,
        issue=_issue_to_read(link.issue),
    )


def link_epic_to_project(
    db: Session, project_id: int, payload: schemas.JiraLinkCreate
) -> schemas.ProjectJiraLinkRead:
    project = db.get(models.Project, project_id)
    if project is None:
        raise ValueError("Project not found.")
    if payload.team_id is not None:
        team = db.get(models.Team, payload.team_id)
        if team is None or team.project_id != project_id:
            raise ValueError("Team does not belong to this project.")

    fetched = sync_keys(db, [payload.jira_key])
    issue = fetched.get(payload.jira_key.upper()) or fetched.get(payload.jira_key)
    if issue is None:
        raise ValueError(f"Jira issue {payload.jira_key} was not found.")

    existing = db.scalar(
        select(models.ProjectJiraLink).where(
            models.ProjectJiraLink.project_id == project_id,
            models.ProjectJiraLink.jira_issue_id == issue.id,
        )
    )
    if existing is not None:
        existing.team_id = payload.team_id
        db.commit()
        db.refresh(existing)
        return _project_link_read(existing)

    link = models.ProjectJiraLink(
        project_id=project_id,
        team_id=payload.team_id,
        jira_issue_id=issue.id,
        linked_at=datetime.utcnow(),
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return _project_link_read(link)


def unlink_project_link(db: Session, project_id: int, link_id: int) -> None:
    link = db.get(models.ProjectJiraLink, link_id)
    if link is None or link.project_id != project_id:
        raise ValueError("Link not found.")
    db.delete(link)
    db.commit()


def force_sync_project(db: Session, project_id: int) -> schemas.ProjectJiraLinksGrouped:
    links = _load_project_links(db, project_id)
    if links:
        sync_keys(db, [link.issue.jira_key for link in links])
    return list_project_links(db, project_id, refresh_stale=False)


# ------------------------------------------------- work item links (generic core)
# Deliverables and milestones both own Jira links, and the two link tables differ
# only in their owner column. These helpers hold the shared behaviour — batched
# fetch, dedupe, stale refresh — so each owner type only needs a thin wrapper.


class _LinkKind:
    """How one owner type's Jira links are stored and read back."""

    def __init__(self, noun: str, owner_model, link_model, owner_column, read_factory):
        self.noun = noun
        self.owner_model = owner_model
        self.link_model = link_model
        self.owner_column = owner_column
        self.read_factory = read_factory

    def owner_id_of(self, link) -> int:
        return getattr(link, self.owner_column.key)


def _deliverable_link_read(link: models.DeliverableJiraLink) -> schemas.DeliverableJiraLinkRead:
    return schemas.DeliverableJiraLinkRead(
        id=link.id,
        deliverable_id=link.deliverable_id,
        linked_at=link.linked_at,
        issue=_issue_to_read(link.issue),
    )


def _milestone_link_read(link: models.MilestoneJiraLink) -> schemas.MilestoneJiraLinkRead:
    return schemas.MilestoneJiraLinkRead(
        id=link.id,
        milestone_id=link.milestone_id,
        linked_at=link.linked_at,
        issue=_issue_to_read(link.issue),
    )


_DELIVERABLE_LINKS = _LinkKind(
    noun="Deliverable",
    owner_model=models.Deliverable,
    link_model=models.DeliverableJiraLink,
    owner_column=models.DeliverableJiraLink.deliverable_id,
    read_factory=_deliverable_link_read,
)

_MILESTONE_LINKS = _LinkKind(
    noun="Milestone",
    owner_model=models.Milestone,
    link_model=models.MilestoneJiraLink,
    owner_column=models.MilestoneJiraLink.milestone_id,
    read_factory=_milestone_link_read,
)


def _load_links(db: Session, kind: _LinkKind, owner_id: int) -> List[Any]:
    stmt = (
        select(kind.link_model)
        .where(kind.owner_column == owner_id)
        .options(selectinload(kind.link_model.issue))
        .order_by(kind.link_model.id)
    )
    return list(db.scalars(stmt))


def _require_owner(db: Session, kind: _LinkKind, owner_id: int):
    owner = db.get(kind.owner_model, owner_id)
    if owner is None:
        raise ValueError(f"{kind.noun} not found.")
    return owner


def _list_owner_links(
    db: Session, kind: _LinkKind, owner_id: int, refresh_stale: bool = True
) -> List[Any]:
    _require_owner(db, kind, owner_id)

    links = _load_links(db, kind, owner_id)
    issues = [link.issue for link in links]
    if issues and refresh_stale and _link_stale(issues):
        try:
            sync_keys(db, [issue.jira_key for issue in issues])
        except JiraNotConfigured:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Stale refresh for %s %s failed: %s", kind.noun.lower(), owner_id, exc
            )
        else:
            links = _load_links(db, kind, owner_id)

    return [kind.read_factory(link) for link in links]


def _link_one(
    db: Session, kind: _LinkKind, owner_id: int, payload: schemas.JiraLinkCreate
) -> Any:
    _require_owner(db, kind, owner_id)

    fetched = sync_keys(db, [payload.jira_key])
    issue = fetched.get(payload.jira_key.upper()) or fetched.get(payload.jira_key)
    if issue is None:
        raise ValueError(f"Jira issue {payload.jira_key} was not found.")

    existing = db.scalar(
        select(kind.link_model).where(
            kind.owner_column == owner_id,
            kind.link_model.jira_issue_id == issue.id,
        )
    )
    if existing is not None:
        return kind.read_factory(existing)

    link = kind.link_model(
        **{kind.owner_column.key: owner_id},
        jira_issue_id=issue.id,
        linked_at=datetime.utcnow(),
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return kind.read_factory(link)


def _link_many(
    db: Session, kind: _LinkKind, owner_id: int, jira_keys: Sequence[str]
) -> schemas.JiraBulkLinkResult:
    """Link many Jira keys to one owner in a single Jira round trip.

    Linking a whole label's worth of stories one key at a time would mean one
    Jira search each; `sync_keys` already batches, so the fetch cost here is flat.
    """
    _require_owner(db, kind, owner_id)

    requested = list(dict.fromkeys((key or "").strip() for key in jira_keys))
    requested = [key for key in requested if key]
    if not requested:
        return schemas.JiraBulkLinkResult()

    fetched = sync_keys(db, requested)
    existing_issue_ids = {
        link.jira_issue_id for link in _load_links(db, kind, owner_id)
    }

    result = schemas.JiraBulkLinkResult()
    now = datetime.utcnow()
    for key in requested:
        issue = fetched.get(key.upper()) or fetched.get(key)
        if issue is None:
            result.not_found.append(key)
            continue
        if issue.id in existing_issue_ids:
            result.skipped.append(issue.jira_key)
            continue
        db.add(
            kind.link_model(
                **{kind.owner_column.key: owner_id},
                jira_issue_id=issue.id,
                linked_at=now,
            )
        )
        existing_issue_ids.add(issue.id)
        result.linked.append(issue.jira_key)

    if result.linked:
        db.commit()
    return result


def _unlink(db: Session, kind: _LinkKind, owner_id: int, link_id: int) -> None:
    link = db.get(kind.link_model, link_id)
    if link is None or kind.owner_id_of(link) != owner_id:
        raise ValueError("Link not found.")
    db.delete(link)
    db.commit()


def _load_project_links_grouped(
    db: Session, kind: _LinkKind, project_id: int, join_clauses
) -> List[Any]:
    stmt = select(kind.link_model)
    for target, onclause in join_clauses:
        stmt = stmt.join(target, onclause)
    stmt = (
        stmt.where(models.Deliverable.project_id == project_id)
        .options(selectinload(kind.link_model.issue))
        .order_by(kind.owner_column, kind.link_model.id)
    )
    return list(db.scalars(stmt))


def _group_project_links(
    db: Session,
    kind: _LinkKind,
    project_id: int,
    join_clauses,
    refresh_stale: bool,
) -> Tuple[Dict[int, List[Any]], bool, Optional[datetime]]:
    """Every owner's Jira links for one project, in a single round trip.

    The Gantt story overlay would otherwise need one request per row.
    """
    project = db.get(models.Project, project_id)
    if project is None:
        raise ValueError("Project not found.")

    links = _load_project_links_grouped(db, kind, project_id, join_clauses)
    issues = [link.issue for link in links]
    stale = _link_stale(issues) if issues else False
    if stale and refresh_stale:
        try:
            sync_keys(db, [issue.jira_key for issue in issues])
        except JiraNotConfigured:
            raise
        except Exception as exc:  # noqa: BLE001
            # Stale refresh is best-effort; surface data we already have.
            logger.warning(
                "Stale refresh for project %s %s links failed: %s",
                project_id,
                kind.noun.lower(),
                exc,
            )
        else:
            links = _load_project_links_grouped(db, kind, project_id, join_clauses)
            issues = [link.issue for link in links]
            stale = False

    grouped: Dict[int, List[Any]] = {}
    for link in links:
        grouped.setdefault(kind.owner_id_of(link), []).append(kind.read_factory(link))
    return grouped, stale, _latest_sync(issues)


# ----------------------------------------------------------- deliverable links


def list_deliverable_links(
    db: Session, deliverable_id: int, refresh_stale: bool = True
) -> List[schemas.DeliverableJiraLinkRead]:
    return _list_owner_links(db, _DELIVERABLE_LINKS, deliverable_id, refresh_stale)


def link_issue_to_deliverable(
    db: Session, deliverable_id: int, payload: schemas.JiraLinkCreate
) -> schemas.DeliverableJiraLinkRead:
    return _link_one(db, _DELIVERABLE_LINKS, deliverable_id, payload)


def link_issues_to_deliverable(
    db: Session, deliverable_id: int, jira_keys: Sequence[str]
) -> schemas.JiraBulkLinkResult:
    return _link_many(db, _DELIVERABLE_LINKS, deliverable_id, jira_keys)


def list_project_deliverable_links(
    db: Session, project_id: int, refresh_stale: bool = True
) -> schemas.ProjectDeliverableJiraLinks:
    grouped, stale, synced_at = _group_project_links(
        db,
        _DELIVERABLE_LINKS,
        project_id,
        [
            (
                models.Deliverable,
                models.Deliverable.id == models.DeliverableJiraLink.deliverable_id,
            )
        ],
        refresh_stale,
    )
    return schemas.ProjectDeliverableJiraLinks(
        project_id=project_id,
        links_by_deliverable=grouped,
        stale=stale,
        synced_at=synced_at,
    )


def unlink_deliverable_link(db: Session, deliverable_id: int, link_id: int) -> None:
    _unlink(db, _DELIVERABLE_LINKS, deliverable_id, link_id)


# ------------------------------------------------------------- milestone links


def list_milestone_links(
    db: Session, milestone_id: int, refresh_stale: bool = True
) -> List[schemas.MilestoneJiraLinkRead]:
    return _list_owner_links(db, _MILESTONE_LINKS, milestone_id, refresh_stale)


def link_issue_to_milestone(
    db: Session, milestone_id: int, payload: schemas.JiraLinkCreate
) -> schemas.MilestoneJiraLinkRead:
    return _link_one(db, _MILESTONE_LINKS, milestone_id, payload)


def link_issues_to_milestone(
    db: Session, milestone_id: int, jira_keys: Sequence[str]
) -> schemas.JiraBulkLinkResult:
    return _link_many(db, _MILESTONE_LINKS, milestone_id, jira_keys)


def list_project_milestone_links(
    db: Session, project_id: int, refresh_stale: bool = True
) -> schemas.ProjectMilestoneJiraLinks:
    # One join deeper than the deliverable case: a milestone reaches its project
    # through its parent deliverable.
    grouped, stale, synced_at = _group_project_links(
        db,
        _MILESTONE_LINKS,
        project_id,
        [
            (models.Milestone, models.Milestone.id == models.MilestoneJiraLink.milestone_id),
            (models.Deliverable, models.Deliverable.id == models.Milestone.deliverable_id),
        ],
        refresh_stale,
    )
    return schemas.ProjectMilestoneJiraLinks(
        project_id=project_id,
        links_by_milestone=grouped,
        stale=stale,
        synced_at=synced_at,
    )


def unlink_milestone_link(db: Session, milestone_id: int, link_id: int) -> None:
    _unlink(db, _MILESTONE_LINKS, milestone_id, link_id)
