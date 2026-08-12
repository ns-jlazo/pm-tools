"""Jira sync + linking service (read-only)."""

from __future__ import annotations

import json
import logging
import os
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


def _ttl_seconds() -> int:
    raw = os.environ.get("JIRA_SYNC_TTL_SECONDS")
    if not raw:
        return _DEFAULT_TTL_SECONDS
    try:
        return max(0, int(raw))
    except ValueError:
        return _DEFAULT_TTL_SECONDS


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


def search(jql: str, limit: int = 25) -> schemas.JiraSearchResponse:
    client = get_client()
    envelope = client.search_issues(jql=jql, max_results=limit)
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


# ------------------------------------------------------------------ task links


def list_task_links(
    db: Session, task_id: int, refresh_stale: bool = True
) -> List[schemas.TaskJiraLinkRead]:
    task = db.get(models.Task, task_id)
    if task is None:
        raise ValueError("Task not found.")

    links = _load_task_links(db, task_id)
    issues = [link.issue for link in links]
    if issues and refresh_stale and _link_stale(issues):
        try:
            sync_keys(db, [issue.jira_key for issue in issues])
        except JiraNotConfigured:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("Stale refresh for task %s failed: %s", task_id, exc)
        else:
            links = _load_task_links(db, task_id)

    return [_task_link_read(link) for link in links]


def _load_task_links(db: Session, task_id: int) -> List[models.TaskJiraLink]:
    stmt = (
        select(models.TaskJiraLink)
        .where(models.TaskJiraLink.task_id == task_id)
        .options(selectinload(models.TaskJiraLink.issue))
        .order_by(models.TaskJiraLink.id)
    )
    return list(db.scalars(stmt))


def _task_link_read(link: models.TaskJiraLink) -> schemas.TaskJiraLinkRead:
    return schemas.TaskJiraLinkRead(
        id=link.id,
        task_id=link.task_id,
        linked_at=link.linked_at,
        issue=_issue_to_read(link.issue),
    )


def link_issue_to_task(
    db: Session, task_id: int, payload: schemas.JiraLinkCreate
) -> schemas.TaskJiraLinkRead:
    task = db.get(models.Task, task_id)
    if task is None:
        raise ValueError("Task not found.")

    fetched = sync_keys(db, [payload.jira_key])
    issue = fetched.get(payload.jira_key.upper()) or fetched.get(payload.jira_key)
    if issue is None:
        raise ValueError(f"Jira issue {payload.jira_key} was not found.")

    existing = db.scalar(
        select(models.TaskJiraLink).where(
            models.TaskJiraLink.task_id == task_id,
            models.TaskJiraLink.jira_issue_id == issue.id,
        )
    )
    if existing is not None:
        return _task_link_read(existing)

    link = models.TaskJiraLink(
        task_id=task_id,
        jira_issue_id=issue.id,
        linked_at=datetime.utcnow(),
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return _task_link_read(link)


def unlink_task_link(db: Session, task_id: int, link_id: int) -> None:
    link = db.get(models.TaskJiraLink, link_id)
    if link is None or link.task_id != task_id:
        raise ValueError("Link not found.")
    db.delete(link)
    db.commit()
