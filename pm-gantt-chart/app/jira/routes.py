"""FastAPI routes for Jira integration."""

from __future__ import annotations

import logging
from typing import List

import requests
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from .. import schemas
from ..database import get_db
from . import service
from .auth import JiraNotConfigured


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["jira"])


def _jira_error_messages(exc: requests.HTTPError) -> str:
    """Pull Jira's own complaint out of an error response body.

    Jira answers a rejected search with `{"errorMessages": [...], "errors": {...}}`
    — e.g. why a JQL string would not parse. Without this the client only ever
    sees "502 Jira error: 400 Client Error", which says nothing actionable.
    """
    response = exc.response
    if response is None:
        return ""
    try:
        payload = response.json()
    except ValueError:
        return (response.text or "").strip()[:300]
    if not isinstance(payload, dict):
        return ""
    parts = [str(item) for item in payload.get("errorMessages") or [] if item]
    errors = payload.get("errors")
    if isinstance(errors, dict):
        parts.extend(f"{field}: {message}" for field, message in errors.items())
    return " ".join(parts).strip()[:300]


def _handle_jira_call(func, *args, **kwargs):
    """Uniform mapping of Jira/service errors to HTTP responses."""
    try:
        return func(*args, **kwargs)
    except JiraNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 502
        detail = _jira_error_messages(exc)
        if status in (401, 403):
            raise HTTPException(
                status_code=502,
                detail="Jira rejected the request (check JIRA_EMAIL / JIRA_API_TOKEN).",
            ) from exc
        if status == 404:
            raise HTTPException(status_code=404, detail="Jira issue not found.") from exc
        if status == 400:
            # Jira turned the query down (bad JQL, unknown project key): the
            # caller can fix it, so report it as a client error with the reason.
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Jira rejected the query: {detail}"
                    if detail
                    else "Jira rejected the query."
                ),
            ) from exc
        raise HTTPException(
            status_code=502,
            detail=(
                f"Jira error ({status}): {detail}" if detail else f"Jira error: {exc}"
            ),
        ) from exc
    except requests.RequestException as exc:
        # Timeouts, DNS and connection resets are not HTTPError, so without this
        # they escaped as an opaque 500 and the UI showed "Request failed".
        logger.warning("Jira request failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Could not reach Jira: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ------------------------------------------------------------------- discovery


@router.get("/jira/health", response_model=schemas.JiraHealth)
def jira_health() -> schemas.JiraHealth:
    return service.check_health()


@router.get("/jira/search", response_model=schemas.JiraSearchResponse)
def jira_search(
    jql: str = Query(..., min_length=1, description="JQL to execute"),
    limit: int = Query(25, ge=1, le=100),
) -> schemas.JiraSearchResponse:
    return _handle_jira_call(service.search, jql=jql, limit=limit)


@router.get("/jira/labels", response_model=schemas.JiraLabelSuggestions)
def jira_labels(
    query: str = Query("", description="Filter labels by substring"),
    project_key: str = Query("", description="Overrides JIRA_LABEL_PROJECT_KEY"),
    limit: int = Query(25, ge=1, le=100),
) -> schemas.JiraLabelSuggestions:
    return _handle_jira_call(
        service.suggest_labels, query=query, project_key=project_key, limit=limit
    )


@router.get("/jira/labels/issues", response_model=schemas.JiraLabelSearchResponse)
def jira_label_issues(
    label: str = Query(..., min_length=1, description="Exact Jira label"),
    project_key: str = Query("", description="Overrides JIRA_LABEL_PROJECT_KEY"),
    limit: int = Query(100, ge=1, le=100),
) -> schemas.JiraLabelSearchResponse:
    return _handle_jira_call(
        service.search_by_label, label=label, project_key=project_key, limit=limit
    )


@router.get("/jira/issues/{key}", response_model=schemas.JiraSearchResult)
def jira_get_issue(key: str) -> schemas.JiraSearchResult:
    return _handle_jira_call(service.get_issue_by_key, key)


@router.get("/jira/issues/{epic_key}/children", response_model=List[schemas.JiraSearchResult])
def jira_epic_children(
    epic_key: str,
    # High default so the client-side status filter sees the whole epic; a busy
    # epic's open stories would otherwise be cut off before filtering.
    limit: int = Query(200, ge=1, le=200),
) -> List[schemas.JiraSearchResult]:
    return _handle_jira_call(service.fetch_children, epic_key, limit=limit)


# ------------------------------------------------------------- project linking


@router.get("/projects/{project_id}/jira", response_model=schemas.ProjectJiraLinksGrouped)
def project_jira_links(
    project_id: int, db: Session = Depends(get_db)
) -> schemas.ProjectJiraLinksGrouped:
    return _handle_jira_call(service.list_project_links, db, project_id)


@router.post(
    "/projects/{project_id}/jira/links",
    response_model=schemas.ProjectJiraLinkRead,
    status_code=201,
)
def create_project_jira_link(
    project_id: int,
    payload: schemas.JiraLinkCreate,
    db: Session = Depends(get_db),
) -> schemas.ProjectJiraLinkRead:
    return _handle_jira_call(service.link_epic_to_project, db, project_id, payload)


@router.delete(
    "/projects/{project_id}/jira/links/{link_id}", status_code=204, response_class=Response
)
def delete_project_jira_link(
    project_id: int, link_id: int, db: Session = Depends(get_db)
) -> Response:
    _handle_jira_call(service.unlink_project_link, db, project_id, link_id)
    return Response(status_code=204)


@router.post(
    "/projects/{project_id}/jira/sync",
    response_model=schemas.ProjectJiraLinksGrouped,
)
def sync_project_jira(
    project_id: int, db: Session = Depends(get_db)
) -> schemas.ProjectJiraLinksGrouped:
    return _handle_jira_call(service.force_sync_project, db, project_id)


@router.get(
    "/projects/{project_id}/jira/deliverable-links",
    response_model=schemas.ProjectDeliverableJiraLinks,
)
def project_deliverable_jira_links(
    project_id: int, db: Session = Depends(get_db)
) -> schemas.ProjectDeliverableJiraLinks:
    """Backs the optional Gantt story overlay in one request."""
    return _handle_jira_call(service.list_project_deliverable_links, db, project_id)


# --------------------------------------------------------- deliverable linking


@router.get(
    "/deliverables/{deliverable_id}/jira",
    response_model=List[schemas.DeliverableJiraLinkRead],
)
def deliverable_jira_links(
    deliverable_id: int, db: Session = Depends(get_db)
) -> List[schemas.DeliverableJiraLinkRead]:
    return _handle_jira_call(service.list_deliverable_links, db, deliverable_id)


@router.post(
    "/deliverables/{deliverable_id}/jira/links",
    response_model=schemas.DeliverableJiraLinkRead,
    status_code=201,
)
def create_deliverable_jira_link(
    deliverable_id: int,
    payload: schemas.JiraLinkCreate,
    db: Session = Depends(get_db),
) -> schemas.DeliverableJiraLinkRead:
    return _handle_jira_call(
        service.link_issue_to_deliverable, db, deliverable_id, payload
    )


@router.post(
    "/deliverables/{deliverable_id}/jira/links/bulk",
    response_model=schemas.JiraBulkLinkResult,
)
def create_deliverable_jira_links_bulk(
    deliverable_id: int,
    payload: schemas.JiraBulkLinkCreate,
    db: Session = Depends(get_db),
) -> schemas.JiraBulkLinkResult:
    """Link every story matching a Jira label without a request per key."""
    return _handle_jira_call(
        service.link_issues_to_deliverable, db, deliverable_id, payload.jira_keys
    )


@router.delete(
    "/deliverables/{deliverable_id}/jira/links/{link_id}",
    status_code=204,
    response_class=Response,
)
def delete_deliverable_jira_link(
    deliverable_id: int, link_id: int, db: Session = Depends(get_db)
) -> Response:
    _handle_jira_call(service.unlink_deliverable_link, db, deliverable_id, link_id)
    return Response(status_code=204)
