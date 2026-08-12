from __future__ import annotations

from pathlib import Path
from typing import Dict, List

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect
from sqlalchemy.orm import Session

from . import models, schemas, services
from .database import Base, SessionLocal, engine, get_db
from .jira.auth import JiraNotConfigured
from .jira.routes import router as jira_router
from .jira import service as jira_service


ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "static"


app = FastAPI(title="PM Gantt Tool", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(jira_router)


def _ensure_v2_schema() -> None:
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    if "projects" not in existing_tables:
        Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


@app.on_event("startup")
def on_startup() -> None:
    _ensure_v2_schema()
    with SessionLocal() as db:
        services.seed_data(db)


@app.get("/")
def read_index() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "index.html",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@app.get("/api/health")
def healthcheck() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/api/projects", response_model=List[schemas.ProjectCard])
def get_projects(db: Session = Depends(get_db)) -> List[schemas.ProjectCard]:
    return services.project_cards(db)


@app.post("/api/projects", response_model=schemas.ProjectRead, status_code=201)
def create_project(
    payload: schemas.ProjectCreate, db: Session = Depends(get_db)
) -> schemas.ProjectRead:
    project = services.create_project(db, payload)
    return schemas.ProjectRead.model_validate(project)


@app.get("/api/projects/{project_id}/dashboard", response_model=schemas.DashboardData)
def get_project_dashboard(
    project_id: int, db: Session = Depends(get_db)
) -> schemas.DashboardData:
    try:
        return services.dashboard_payload(db, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/projects/{project_id}/teams", response_model=List[schemas.TeamRead])
def get_project_teams(
    project_id: int, db: Session = Depends(get_db)
) -> List[schemas.TeamRead]:
    project = services.get_project(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return [
        schemas.TeamRead.model_validate(team)
        for team in services.list_teams(db, project_id)
    ]


@app.post("/api/projects/{project_id}/teams", response_model=schemas.TeamRead, status_code=201)
def create_project_team(
    project_id: int,
    payload: schemas.TeamCreate,
    db: Session = Depends(get_db),
) -> schemas.TeamRead:
    project = services.get_project(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    team = services.create_team(db, project_id, payload)
    return schemas.TeamRead.model_validate(team)


@app.put(
    "/api/projects/{project_id}/teams/{team_id}",
    response_model=schemas.TeamRead,
)
def update_project_team(
    project_id: int,
    team_id: int,
    payload: schemas.TeamUpdate,
    db: Session = Depends(get_db),
) -> schemas.TeamRead:
    team = db.get(models.Team, team_id)
    if team is None or team.project_id != project_id:
        raise HTTPException(status_code=404, detail="Team not found.")
    try:
        services.update_team(db, project_id, team, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return schemas.TeamRead.model_validate(team)


@app.delete(
    "/api/projects/{project_id}/teams/{team_id}",
    status_code=204,
    response_class=Response,
)
def delete_project_team(
    project_id: int, team_id: int, db: Session = Depends(get_db)
) -> Response:
    team = db.get(models.Team, team_id)
    if team is None or team.project_id != project_id:
        raise HTTPException(status_code=404, detail="Team not found.")
    try:
        services.delete_team(db, project_id, team)
    except services.TeamInUseError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(status_code=204)


@app.get("/api/projects/{project_id}/tasks", response_model=List[schemas.TaskRead])
def get_project_tasks(
    project_id: int, db: Session = Depends(get_db)
) -> List[schemas.TaskRead]:
    project = services.get_project(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return [services.serialize_task(task) for task in services.list_tasks(db, project_id)]


@app.post("/api/projects/{project_id}/tasks", response_model=schemas.TaskRead, status_code=201)
def create_project_task(
    project_id: int, payload: schemas.TaskCreate, db: Session = Depends(get_db)
) -> schemas.TaskRead:
    if services.get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    payload_data = payload.model_dump()
    payload_data["project_id"] = project_id
    scoped_payload = schemas.TaskCreate(**payload_data)

    try:
        task = services.create_task(db, project_id, scoped_payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Best-effort: link any Jira keys the user picked at create time; skip failures.
    for raw_key in scoped_payload.jira_keys or []:
        key = (raw_key or "").strip()
        if not key:
            continue
        try:
            jira_service.link_issue_to_task(
                db, task.id, schemas.JiraLinkCreate(jira_key=key)
            )
        except JiraNotConfigured:
            break
        except Exception:  # noqa: BLE001 - link is best-effort
            continue

    refreshed = next(item for item in services.list_tasks(db, project_id) if item.id == task.id)
    return services.serialize_task(refreshed)


@app.put("/api/projects/{project_id}/tasks/{task_id}", response_model=schemas.TaskRead)
def update_project_task(
    project_id: int,
    task_id: int,
    payload: schemas.TaskUpdate,
    db: Session = Depends(get_db),
) -> schemas.TaskRead:
    task = db.get(models.Task, task_id)
    if task is None or task.project_id != project_id:
        raise HTTPException(status_code=404, detail="Task not found.")

    try:
        services.update_task(db, project_id, task, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    refreshed = next(item for item in services.list_tasks(db, project_id) if item.id == task_id)
    return services.serialize_task(refreshed)


@app.delete(
    "/api/projects/{project_id}/tasks/{task_id}",
    status_code=204,
    response_class=Response,
)
def delete_project_task(
    project_id: int, task_id: int, db: Session = Depends(get_db)
) -> Response:
    task = db.get(models.Task, task_id)
    if task is None or task.project_id != project_id:
        raise HTTPException(status_code=404, detail="Task not found.")
    db.delete(task)
    db.commit()
    return Response(status_code=204)


@app.post("/api/projects/{project_id}/import/csv", response_model=schemas.CsvImportResult)
async def upload_project_csv(
    project_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> schemas.CsvImportResult:
    if services.get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    content = await file.read()
    try:
        return services.import_csv(db, project_id, content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# Backward-compatible alias for existing v1 clients.
@app.get("/api/dashboard", response_model=schemas.DashboardData)
def get_dashboard(db: Session = Depends(get_db)) -> schemas.DashboardData:
    projects = services.list_projects(db)
    if not projects:
        raise HTTPException(status_code=404, detail="No projects found.")
    return services.dashboard_payload(db, projects[0].id)
