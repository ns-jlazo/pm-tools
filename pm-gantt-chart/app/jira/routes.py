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


def _handle_jira_call(func, *args, **kwargs):
    """Uniform mapping of Jira/service errors to HTTP responses."""
    try:
        return func(*args, **kwargs)
    except JiraNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 502
        if status in (401, 403):
            raise HTTPException(
                status_code=502,
                detail="Jira rejected the request (check JIRA_EMAIL / JIRA_API_TOKEN).",
            ) from exc
        if status == 404:
            raise HTTPException(status_code=404, detail="Jira issue not found.") from exc
        raise HTTPException(status_code=502, detail=f"Jira error: {exc}") from exc
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


@router.get("/jira/issues/{key}", response_model=schemas.JiraSearchResult)
def jira_get_issue(key: str) -> schemas.JiraSearchResult:
    return _handle_jira_call(service.get_issue_by_key, key)


@router.get("/jira/issues/{epic_key}/children", response_model=List[schemas.JiraSearchResult])
def jira_epic_children(
    epic_key: str,
    limit: int = Query(50, ge=1, le=200),
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


# ---------------------------------------------------------------- task linking


@router.get("/tasks/{task_id}/jira", response_model=List[schemas.TaskJiraLinkRead])
def task_jira_links(
    task_id: int, db: Session = Depends(get_db)
) -> List[schemas.TaskJiraLinkRead]:
    return _handle_jira_call(service.list_task_links, db, task_id)


@router.post(
    "/tasks/{task_id}/jira/links",
    response_model=schemas.TaskJiraLinkRead,
    status_code=201,
)
def create_task_jira_link(
    task_id: int,
    payload: schemas.JiraLinkCreate,
    db: Session = Depends(get_db),
) -> schemas.TaskJiraLinkRead:
    return _handle_jira_call(service.link_issue_to_task, db, task_id, payload)


@router.delete(
    "/tasks/{task_id}/jira/links/{link_id}", status_code=204, response_class=Response
)
def delete_task_jira_link(
    task_id: int, link_id: int, db: Session = Depends(get_db)
) -> Response:
    _handle_jira_call(service.unlink_task_link, db, task_id, link_id)
    return Response(status_code=204)
