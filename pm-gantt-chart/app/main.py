from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, List

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from .env import load_dotenv

# Must run before the Jira modules are imported: `app.jira.client` reads its
# retry tuning at import time, and every Jira route needs the credentials.
load_dotenv()

from . import models, schemas, services  # noqa: E402
from .database import Base, SessionLocal, engine, get_db  # noqa: E402
from .jira.auth import JiraNotConfigured  # noqa: E402
from .jira.routes import router as jira_router  # noqa: E402
from .jira import service as jira_service  # noqa: E402


logger = logging.getLogger(__name__)

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


# "task" was renamed to "deliverable" project-wide. Existing local databases
# carry real Jira links, so rename in place rather than recreating the schema.
_TABLE_RENAMES = [
    ("tasks", "deliverables"),
    ("task_dependencies", "deliverable_dependencies"),
    ("task_contributor_teams", "deliverable_contributor_teams"),
    ("task_jira_links", "deliverable_jira_links"),
]
_COLUMN_RENAMES = [
    ("task_dependencies", "upstream_task_id", "upstream_deliverable_id"),
    ("task_dependencies", "downstream_task_id", "downstream_deliverable_id"),
    ("task_contributor_teams", "task_id", "deliverable_id"),
    ("task_jira_links", "task_id", "deliverable_id"),
]


def _migrate_deliverable_rename(bind=None) -> None:
    """Rename the legacy `task*` tables/columns to `deliverable*`.

    Idempotent: every step checks the live schema first, so a fresh database and
    an already-migrated one both no-op. `tasks` is renamed before the child
    tables so SQLite rewrites their foreign-key clauses for us.
    """
    bind = bind if bind is not None else engine
    inspector = inspect(bind)
    tables = set(inspector.get_table_names())
    if not any(old in tables for old, _ in _TABLE_RENAMES):
        return

    with bind.begin() as connection:
        if "tasks" in tables and "deliverables" not in tables:
            connection.execute(text("ALTER TABLE tasks RENAME TO deliverables"))

        for table, old_column, new_column in _COLUMN_RENAMES:
            if table not in tables:
                continue
            columns = {column["name"] for column in inspector.get_columns(table)}
            if old_column in columns and new_column not in columns:
                connection.execute(
                    text(
                        f"ALTER TABLE {table} RENAME COLUMN {old_column} TO {new_column}"
                    )
                )

        for old_table, new_table in _TABLE_RENAMES[1:]:
            if old_table in tables and new_table not in tables:
                connection.execute(
                    text(f"ALTER TABLE {old_table} RENAME TO {new_table}")
                )

        # Stale after the table rename; create_all adds ix_deliverables_id.
        connection.execute(text("DROP INDEX IF EXISTS ix_tasks_id"))


# Workspaces that predate `Project.is_example` but were only ever demo material.
_LEGACY_EXAMPLE_PROJECT_NAMES = (
    "Atlas API Expansion",
    "Phoenix Retail Refresh",
    "V2 Smoke Project",
)


def _migrate_example_flag(bind=None) -> None:
    """Add `projects.is_example` and flag the pre-existing example workspaces.

    `create_all` only creates missing tables, never missing columns, so the add
    has to be explicit. Idempotent: the column check gates everything, so the
    name-based backfill runs exactly once and a workspace demoted later in the UI
    is never re-promoted.
    """
    bind = bind if bind is not None else engine
    inspector = inspect(bind)
    if "projects" not in set(inspector.get_table_names()):
        return
    columns = {column["name"] for column in inspector.get_columns("projects")}
    if "is_example" in columns:
        return

    with bind.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE projects ADD COLUMN is_example BOOLEAN NOT NULL DEFAULT 0"
            )
        )
        placeholders = ", ".join(
            f":name{index}" for index in range(len(_LEGACY_EXAMPLE_PROJECT_NAMES))
        )
        connection.execute(
            text(f"UPDATE projects SET is_example = 1 WHERE name IN ({placeholders})"),
            {
                f"name{index}": name
                for index, name in enumerate(_LEGACY_EXAMPLE_PROJECT_NAMES)
            },
        )


def _migrate_release_date(bind=None) -> None:
    """Add `projects.release_date` — the date the software reaches customers.

    Same reason as `_migrate_example_flag`: `create_all` adds missing tables but
    never missing columns. Nullable, so there is nothing to backfill. Idempotent
    via the column check.
    """
    bind = bind if bind is not None else engine
    inspector = inspect(bind)
    if "projects" not in set(inspector.get_table_names()):
        return
    columns = {column["name"] for column in inspector.get_columns("projects")}
    if "release_date" in columns:
        return

    with bind.begin() as connection:
        connection.execute(text("ALTER TABLE projects ADD COLUMN release_date DATE"))


def _migrate_jira_label(bind=None) -> None:
    """Add the `deliverables.jira_label*` columns.

    Same reason as `_migrate_release_date`: `create_all` never adds columns to an
    existing table. All four are nullable, so existing rows stay untouched.
    Idempotent via the column check.
    """
    bind = bind if bind is not None else engine
    inspector = inspect(bind)
    if "deliverables" not in set(inspector.get_table_names()):
        return
    columns = {column["name"] for column in inspector.get_columns("deliverables")}
    wanted = {
        "jira_label": "VARCHAR(100)",
        "jira_label_project_key": "VARCHAR(50)",
        "jira_label_from": "DATE",
        "jira_label_to": "DATE",
    }
    missing = {name: ddl for name, ddl in wanted.items() if name not in columns}
    if not missing:
        return

    with bind.begin() as connection:
        for name, ddl in missing.items():
            connection.execute(text(f"ALTER TABLE deliverables ADD COLUMN {name} {ddl}"))


def _ensure_v2_schema() -> None:
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    if "projects" not in existing_tables:
        Base.metadata.drop_all(bind=engine)
    _migrate_deliverable_rename(engine)
    _migrate_example_flag(engine)
    _migrate_release_date(engine)
    _migrate_jira_label(engine)
    # Adds any table an existing database is missing — the milestone tables, and
    # `project_key_dates`. New *columns* still need an explicit migration above.
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


@app.put("/api/projects/{project_id}", response_model=schemas.ProjectRead)
def update_project(
    project_id: int,
    payload: schemas.ProjectUpdate,
    db: Session = Depends(get_db),
) -> schemas.ProjectRead:
    project = services.get_project(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    try:
        services.update_project(db, project, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return schemas.ProjectRead.model_validate(project)


@app.delete("/api/projects/{project_id}", status_code=204, response_class=Response)
def delete_project(project_id: int, db: Session = Depends(get_db)) -> Response:
    project = services.get_project(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    services.delete_project(db, project)
    return Response(status_code=204)


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


# ------------------------------------------------------------------- key dates
# Extra named dates drawn on the timeline beside the project's release date.


@app.get(
    "/api/projects/{project_id}/key-dates",
    response_model=List[schemas.ProjectKeyDateRead],
)
def get_project_key_dates(
    project_id: int, db: Session = Depends(get_db)
) -> List[schemas.ProjectKeyDateRead]:
    if services.get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return [
        schemas.ProjectKeyDateRead.model_validate(key_date)
        for key_date in services.list_key_dates(db, project_id)
    ]


@app.post(
    "/api/projects/{project_id}/key-dates",
    response_model=schemas.ProjectKeyDateRead,
    status_code=201,
)
def create_project_key_date(
    project_id: int,
    payload: schemas.ProjectKeyDateCreate,
    db: Session = Depends(get_db),
) -> schemas.ProjectKeyDateRead:
    if services.get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    key_date = services.create_key_date(db, project_id, payload)
    return schemas.ProjectKeyDateRead.model_validate(key_date)


@app.put(
    "/api/projects/{project_id}/key-dates/{key_date_id}",
    response_model=schemas.ProjectKeyDateRead,
)
def update_project_key_date(
    project_id: int,
    key_date_id: int,
    payload: schemas.ProjectKeyDateUpdate,
    db: Session = Depends(get_db),
) -> schemas.ProjectKeyDateRead:
    key_date = services.get_key_date(db, key_date_id)
    if key_date is None or key_date.project_id != project_id:
        raise HTTPException(status_code=404, detail="Date not found.")
    try:
        services.update_key_date(db, project_id, key_date, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return schemas.ProjectKeyDateRead.model_validate(key_date)


@app.delete(
    "/api/projects/{project_id}/key-dates/{key_date_id}",
    status_code=204,
    response_class=Response,
)
def delete_project_key_date(
    project_id: int, key_date_id: int, db: Session = Depends(get_db)
) -> Response:
    key_date = services.get_key_date(db, key_date_id)
    if key_date is None or key_date.project_id != project_id:
        raise HTTPException(status_code=404, detail="Date not found.")
    try:
        services.delete_key_date(db, project_id, key_date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(status_code=204)


@app.get(
    "/api/projects/{project_id}/deliverables",
    response_model=List[schemas.DeliverableRead],
)
def get_project_deliverables(
    project_id: int, db: Session = Depends(get_db)
) -> List[schemas.DeliverableRead]:
    project = services.get_project(db, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return [
        services.serialize_deliverable(deliverable)
        for deliverable in services.list_deliverables(db, project_id)
    ]


@app.post(
    "/api/projects/{project_id}/deliverables",
    response_model=schemas.DeliverableRead,
    status_code=201,
)
def create_project_deliverable(
    project_id: int, payload: schemas.DeliverableCreate, db: Session = Depends(get_db)
) -> schemas.DeliverableRead:
    if services.get_project(db, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found.")

    payload_data = payload.model_dump()
    payload_data["project_id"] = project_id
    scoped_payload = schemas.DeliverableCreate(**payload_data)

    try:
        deliverable = services.create_deliverable(db, project_id, scoped_payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Best-effort: link any Jira keys the user picked at create time. One batched
    # call, so picking a whole label's worth of stories is still one Jira fetch.
    if scoped_payload.jira_keys:
        try:
            jira_service.link_issues_to_deliverable(
                db, deliverable.id, scoped_payload.jira_keys
            )
        except JiraNotConfigured:
            pass
        except Exception:  # noqa: BLE001 - link is best-effort
            logger.warning(
                "Jira linking failed for new deliverable %s", deliverable.id,
                exc_info=True,
            )

    refreshed = next(
        item
        for item in services.list_deliverables(db, project_id)
        if item.id == deliverable.id
    )
    return services.serialize_deliverable(refreshed)


@app.put(
    "/api/projects/{project_id}/deliverables/{deliverable_id}",
    response_model=schemas.DeliverableRead,
)
def update_project_deliverable(
    project_id: int,
    deliverable_id: int,
    payload: schemas.DeliverableUpdate,
    db: Session = Depends(get_db),
) -> schemas.DeliverableRead:
    deliverable = db.get(models.Deliverable, deliverable_id)
    if deliverable is None or deliverable.project_id != project_id:
        raise HTTPException(status_code=404, detail="Deliverable not found.")

    try:
        services.update_deliverable(db, project_id, deliverable, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    refreshed = next(
        item
        for item in services.list_deliverables(db, project_id)
        if item.id == deliverable_id
    )
    return services.serialize_deliverable(refreshed)


@app.delete(
    "/api/projects/{project_id}/deliverables/{deliverable_id}",
    status_code=204,
    response_class=Response,
)
def delete_project_deliverable(
    project_id: int, deliverable_id: int, db: Session = Depends(get_db)
) -> Response:
    deliverable = db.get(models.Deliverable, deliverable_id)
    if deliverable is None or deliverable.project_id != project_id:
        raise HTTPException(status_code=404, detail="Deliverable not found.")
    db.delete(deliverable)
    db.commit()
    return Response(status_code=204)


# ------------------------------------------------------------------- milestones
# Keyed off the deliverable, not the project: a milestone cannot exist without a
# parent deliverable, so the parent is what identifies where it belongs.


@app.get(
    "/api/deliverables/{deliverable_id}/milestones",
    response_model=List[schemas.MilestoneRead],
)
def get_deliverable_milestones(
    deliverable_id: int, db: Session = Depends(get_db)
) -> List[schemas.MilestoneRead]:
    deliverable = db.get(models.Deliverable, deliverable_id)
    if deliverable is None:
        raise HTTPException(status_code=404, detail="Deliverable not found.")
    return [
        services.serialize_milestone(milestone)
        for milestone in services.list_milestones(db, deliverable_id)
    ]


@app.post(
    "/api/deliverables/{deliverable_id}/milestones",
    response_model=schemas.MilestoneRead,
    status_code=201,
)
def create_deliverable_milestone(
    deliverable_id: int,
    payload: schemas.MilestoneCreate,
    db: Session = Depends(get_db),
) -> schemas.MilestoneRead:
    deliverable = db.get(models.Deliverable, deliverable_id)
    if deliverable is None:
        raise HTTPException(status_code=404, detail="Deliverable not found.")

    try:
        milestone = services.create_milestone(db, deliverable, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Best-effort, exactly as for a new deliverable: one batched Jira call so a
    # whole label's worth of stories still costs a single fetch.
    if payload.jira_keys:
        try:
            jira_service.link_issues_to_milestone(db, milestone.id, payload.jira_keys)
        except JiraNotConfigured:
            pass
        except Exception:  # noqa: BLE001 - link is best-effort
            logger.warning(
                "Jira linking failed for new milestone %s", milestone.id, exc_info=True
            )

    return services.serialize_milestone(milestone)


@app.put("/api/milestones/{milestone_id}", response_model=schemas.MilestoneRead)
def update_milestone(
    milestone_id: int,
    payload: schemas.MilestoneUpdate,
    db: Session = Depends(get_db),
) -> schemas.MilestoneRead:
    milestone = services.get_milestone(db, milestone_id)
    if milestone is None:
        raise HTTPException(status_code=404, detail="Milestone not found.")
    try:
        services.update_milestone(db, milestone, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return services.serialize_milestone(milestone)


@app.delete("/api/milestones/{milestone_id}", status_code=204, response_class=Response)
def delete_milestone(milestone_id: int, db: Session = Depends(get_db)) -> Response:
    milestone = services.get_milestone(db, milestone_id)
    if milestone is None:
        raise HTTPException(status_code=404, detail="Milestone not found.")
    services.delete_milestone(db, milestone)
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
