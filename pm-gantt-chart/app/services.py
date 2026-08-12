from __future__ import annotations

import csv
import io
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from . import models, schemas


DEFAULT_TEAMS = [
    ("Core Platform", "#0f766e"),
    ("Mobile Experience", "#1d4ed8"),
    ("Data & Analytics", "#b45309"),
]

DEFAULT_PROJECTS = [
    (
        "Phoenix Retail Refresh",
        "Platform and app modernization stream for checkout and fulfillment.",
        "#0f766e",
    ),
    (
        "Atlas API Expansion",
        "Partner integration stream covering catalog and billing contracts.",
        "#1d4ed8",
    ),
]


@dataclass
class TaskRisk:
    delayed: bool
    at_risk: bool
    risk_level: str
    delay_days: int
    dependency_slip_days: int
    risk_reasons: List[str]


def seed_data(db: Session) -> None:
    existing_project = db.scalar(select(models.Project.id).limit(1))
    if existing_project is not None:
        return

    projects: List[models.Project] = []
    for name, description, color in DEFAULT_PROJECTS:
        project = models.Project(name=name, description=description, color=color)
        db.add(project)
        projects.append(project)
    db.flush()

    for project_index, project in enumerate(projects):
        teams = [
            models.Team(project_id=project.id, name=name, color=color)
            for name, color in DEFAULT_TEAMS
        ]
        db.add_all(teams)
        db.flush()

        team_map = {team.name: team.id for team in teams}
        task_prefix = "A" if project_index == 0 else "B"
        start_offset = 0 if project_index == 0 else 14

        def d(value: date) -> date:
            return value + timedelta(days=start_offset)

        tasks = [
            models.Task(
                project_id=project.id,
                title=f"{task_prefix} Requirements Lock",
                description="Freeze scope and acceptance criteria for the quarter.",
                team_id=team_map["Core Platform"],
                planned_start=d(date(2026, 7, 7)),
                planned_end=d(date(2026, 7, 11)),
                current_start=d(date(2026, 7, 7)),
                current_end=d(date(2026, 7, 12)),
                status="in_progress",
                progress=80,
            ),
            models.Task(
                project_id=project.id,
                title=f"{task_prefix} API Contracts",
                description="Finalize service contracts used by downstream teams.",
                team_id=team_map["Core Platform"],
                planned_start=d(date(2026, 7, 12)),
                planned_end=d(date(2026, 7, 18)),
                current_start=d(date(2026, 7, 13)),
                current_end=d(date(2026, 7, 20)),
                status="in_progress",
                progress=55,
            ),
            models.Task(
                project_id=project.id,
                title=f"{task_prefix} Mobile UX Build",
                description="Implement the first feature wave in the mobile client.",
                team_id=team_map["Mobile Experience"],
                planned_start=d(date(2026, 7, 19)),
                planned_end=d(date(2026, 7, 29)),
                current_start=d(date(2026, 7, 19)),
                current_end=d(date(2026, 7, 30)),
                status="planned",
                progress=20,
            ),
            models.Task(
                project_id=project.id,
                title=f"{task_prefix} Analytics Schema",
                description="Define the event schema that supports launch reporting.",
                team_id=team_map["Data & Analytics"],
                planned_start=d(date(2026, 7, 14)),
                planned_end=d(date(2026, 7, 22)),
                current_start=d(date(2026, 7, 14)),
                current_end=d(date(2026, 7, 22)),
                status="in_progress",
                progress=60,
            ),
            models.Task(
                project_id=project.id,
                title=f"{task_prefix} Launch Readiness",
                description="Cross-functional milestone for launch decisioning.",
                team_id=team_map["Data & Analytics"],
                planned_start=d(date(2026, 7, 31)),
                planned_end=d(date(2026, 8, 2)),
                current_start=d(date(2026, 7, 31)),
                current_end=d(date(2026, 8, 3)),
                status="planned",
                progress=0,
            ),
        ]
        db.add_all(tasks)
        db.flush()

        title_to_id = {task.title: task.id for task in tasks}
        db.add_all(
            [
                models.TaskDependency(
                    upstream_task_id=title_to_id[f"{task_prefix} Requirements Lock"],
                    downstream_task_id=title_to_id[f"{task_prefix} API Contracts"],
                ),
                models.TaskDependency(
                    upstream_task_id=title_to_id[f"{task_prefix} API Contracts"],
                    downstream_task_id=title_to_id[f"{task_prefix} Mobile UX Build"],
                ),
                models.TaskDependency(
                    upstream_task_id=title_to_id[f"{task_prefix} Analytics Schema"],
                    downstream_task_id=title_to_id[f"{task_prefix} Launch Readiness"],
                ),
                models.TaskDependency(
                    upstream_task_id=title_to_id[f"{task_prefix} Mobile UX Build"],
                    downstream_task_id=title_to_id[f"{task_prefix} Launch Readiness"],
                ),
            ]
        )

    db.commit()


def list_projects(db: Session) -> List[models.Project]:
    return list(db.scalars(select(models.Project).order_by(models.Project.name)).all())


def get_project(db: Session, project_id: int) -> Optional[models.Project]:
    return db.get(models.Project, project_id)


def create_project(db: Session, payload: schemas.ProjectCreate) -> models.Project:
    project = models.Project(
        name=payload.name,
        description=payload.description,
        color=payload.color,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def update_project(
    db: Session, project: models.Project, payload: schemas.ProjectUpdate
) -> models.Project:
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates and updates["name"] and updates["name"] != project.name:
        clash = db.scalar(
            select(models.Project).where(
                models.Project.name == updates["name"],
                models.Project.id != project.id,
            )
        )
        if clash is not None:
            raise ValueError("Another project already uses that name.")
    for field, value in updates.items():
        # description may legitimately be cleared to "", so only skip None.
        if value is not None:
            setattr(project, field, value)
    db.commit()
    db.refresh(project)
    return project


def delete_project(db: Session, project: models.Project) -> None:
    # Teams/tasks (and their dependencies + Jira links) cascade via the ORM, but
    # project-level Jira links have no ORM cascade and SQLite does not enforce
    # the DB-level ON DELETE CASCADE, so clear them explicitly.
    db.query(models.ProjectJiraLink).filter(
        models.ProjectJiraLink.project_id == project.id
    ).delete(synchronize_session=False)
    db.delete(project)
    db.commit()


def list_teams(db: Session, project_id: int) -> List[models.Team]:
    stmt = select(models.Team).where(models.Team.project_id == project_id).order_by(models.Team.name)
    return list(db.scalars(stmt).all())


def create_team(db: Session, project_id: int, payload: schemas.TeamCreate) -> models.Team:
    team = models.Team(project_id=project_id, name=payload.name, color=payload.color)
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


class TeamInUseError(ValueError):
    """Raised when trying to delete a team that still owns or contributes to tasks."""


def update_team(
    db: Session, project_id: int, team: models.Team, payload: schemas.TeamUpdate
) -> models.Team:
    if team.project_id != project_id:
        raise ValueError("Team does not belong to the selected project.")

    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates and updates["name"] and updates["name"] != team.name:
        clash = db.scalar(
            select(models.Team).where(
                models.Team.project_id == project_id,
                models.Team.name == updates["name"],
                models.Team.id != team.id,
            )
        )
        if clash is not None:
            raise ValueError("Another team in this project already uses that name.")
    for field, value in updates.items():
        if value is not None:
            setattr(team, field, value)
    db.commit()
    db.refresh(team)
    return team


def delete_team(db: Session, project_id: int, team: models.Team) -> None:
    if team.project_id != project_id:
        raise ValueError("Team does not belong to the selected project.")
    if team.tasks:
        raise TeamInUseError(
            f"Team has {len(team.tasks)} assigned task(s); reassign them first."
        )
    if team.contributing_tasks:
        raise TeamInUseError(
            f"Team is a contributor on {len(team.contributing_tasks)} task(s); remove it there first."
        )
    db.delete(team)
    db.commit()


def _task_finish(task: models.Task) -> date:
    return task.current_end or task.planned_end


def calculate_risk(task: models.Task) -> TaskRisk:
    actual_finish = _task_finish(task)
    delayed = actual_finish > task.planned_end
    delay_days = max((actual_finish - task.planned_end).days, 0)

    dependency_slip_days = 0
    risk_reasons: List[str] = []
    for link in task.incoming_links:
        upstream = link.upstream_task
        if upstream is None:
            continue
        dependency_finish = _task_finish(upstream)
        if dependency_finish > task.planned_start:
            slip = (dependency_finish - task.planned_start).days
            dependency_slip_days = max(dependency_slip_days, slip)
            risk_reasons.append(
                f"Blocked by {upstream.title} until {dependency_finish.isoformat()}"
            )

    if delayed:
        risk_reasons.insert(0, f"Task finish slipped by {delay_days} day(s)")

    at_risk = delayed or dependency_slip_days > 0
    if delayed or dependency_slip_days >= 3:
        risk_level = "high"
    elif at_risk:
        risk_level = "medium"
    else:
        risk_level = "none"

    return TaskRisk(
        delayed=delayed,
        at_risk=at_risk,
        risk_level=risk_level,
        delay_days=delay_days,
        dependency_slip_days=dependency_slip_days,
        risk_reasons=risk_reasons,
    )


def list_tasks(db: Session, project_id: int) -> List[models.Task]:
    stmt = (
        select(models.Task)
        .where(models.Task.project_id == project_id)
        .options(
            selectinload(models.Task.team),
            selectinload(models.Task.contributor_teams),
            selectinload(models.Task.incoming_links).selectinload(
                models.TaskDependency.upstream_task
            ),
        )
        .order_by(models.Task.planned_start, models.Task.id)
    )
    return list(db.scalars(stmt).unique())


def serialize_task(task: models.Task) -> schemas.TaskRead:
    risk = calculate_risk(task)
    contributors = sorted(task.contributor_teams, key=lambda team: team.name)
    return schemas.TaskRead(
        id=task.id,
        project_id=task.project_id,
        title=task.title,
        description=task.description,
        team_id=task.team_id,
        team_name=task.team.name,
        team_color=task.team.color,
        planned_start=task.planned_start,
        planned_end=task.planned_end,
        current_start=task.current_start,
        current_end=task.current_end,
        status=task.status,
        progress=task.progress,
        dependency_ids=[link.upstream_task_id for link in task.incoming_links],
        contributor_team_ids=[team.id for team in contributors],
        contributor_teams=[schemas.TeamRef.model_validate(team) for team in contributors],
        delayed=risk.delayed,
        at_risk=risk.at_risk,
        risk_level=risk.risk_level,
        delay_days=risk.delay_days,
        dependency_slip_days=risk.dependency_slip_days,
        risk_reasons=risk.risk_reasons,
    )


def replace_dependencies(db: Session, task: models.Task, dependency_ids: Iterable[int]) -> None:
    dependency_ids = list(dict.fromkeys(dependency_ids))
    if task.id in dependency_ids:
        raise ValueError("A task cannot depend on itself.")

    db.query(models.TaskDependency).filter(
        models.TaskDependency.downstream_task_id == task.id
    ).delete(synchronize_session=False)

    for dependency_id in dependency_ids:
        dependency = db.get(models.Task, dependency_id)
        if dependency is None:
            raise ValueError(f"Dependency task {dependency_id} does not exist.")
        if dependency.project_id != task.project_id:
            raise ValueError("Dependencies must belong to the same project.")
        db.add(
            models.TaskDependency(
                upstream_task_id=dependency_id,
                downstream_task_id=task.id,
            )
        )


def replace_contributor_teams(
    db: Session, task: models.Task, team_ids: Iterable[int]
) -> None:
    unique_ids = list(dict.fromkeys(team_ids))
    if not unique_ids:
        task.contributor_teams = []
        return
    teams = list(
        db.scalars(select(models.Team).where(models.Team.id.in_(unique_ids))).all()
    )
    found = {team.id for team in teams}
    missing = [tid for tid in unique_ids if tid not in found]
    if missing:
        raise ValueError(f"Contributor team(s) not found: {missing}")
    for team in teams:
        if team.project_id != task.project_id:
            raise ValueError("Contributor teams must belong to the same project.")
    if task.team_id in unique_ids:
        raise ValueError("The owning team cannot also be listed as a contributor.")
    task.contributor_teams = teams


def create_task(db: Session, project_id: int, payload: schemas.TaskCreate) -> models.Task:
    team = db.get(models.Team, payload.team_id)
    if team is None or team.project_id != project_id:
        raise ValueError("Team does not belong to the selected project.")

    task = models.Task(
        project_id=project_id,
        title=payload.title,
        description=payload.description,
        team_id=payload.team_id,
        planned_start=payload.planned_start,
        planned_end=payload.planned_end,
        current_start=payload.current_start,
        current_end=payload.current_end,
        status=payload.status,
        progress=payload.progress,
    )
    db.add(task)
    db.flush()
    replace_dependencies(db, task, payload.dependency_ids)
    replace_contributor_teams(db, task, payload.contributor_team_ids)
    db.commit()
    db.refresh(task)
    return task


def update_task(
    db: Session, project_id: int, task: models.Task, payload: schemas.TaskUpdate
) -> models.Task:
    if task.project_id != project_id:
        raise ValueError("Task does not belong to the selected project.")

    updates = payload.model_dump(exclude_unset=True)
    dependency_ids = updates.pop("dependency_ids", None)
    contributor_ids = updates.pop("contributor_team_ids", None)

    if "team_id" in updates:
        team = db.get(models.Team, updates["team_id"])
        if team is None or team.project_id != project_id:
            raise ValueError("Team does not belong to the selected project.")

    for field, value in updates.items():
        setattr(task, field, value)

    db.flush()
    if dependency_ids is not None:
        replace_dependencies(db, task, dependency_ids)
    if contributor_ids is not None:
        replace_contributor_teams(db, task, contributor_ids)

    db.commit()
    db.refresh(task)
    return task


def _parse_date(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    return date.fromisoformat(value.strip())


def _parse_dependencies(value: Optional[str]) -> List[str]:
    if not value:
        return []
    normalized = value.replace("|", ",")
    return [item.strip() for item in normalized.split(",") if item.strip()]


def import_csv(db: Session, project_id: int, raw_bytes: bytes) -> schemas.CsvImportResult:
    text = raw_bytes.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    errors: List[str] = []
    created_teams = 0
    imported_tasks = 0

    team_map = {
        team.name: team
        for team in db.scalars(
            select(models.Team).where(models.Team.project_id == project_id)
        ).all()
    }
    pending_dependencies: List[Tuple[models.Task, List[str]]] = []
    title_map: Dict[str, models.Task] = {}

    for index, row in enumerate(rows, start=2):
        title = (row.get("title") or "").strip()
        team_name = (row.get("team") or "").strip()
        if not title or not team_name:
            errors.append(f"Row {index}: title and team are required.")
            continue

        team = team_map.get(team_name)
        if team is None:
            color = DEFAULT_TEAMS[created_teams % len(DEFAULT_TEAMS)][1]
            team = models.Team(project_id=project_id, name=team_name, color=color)
            db.add(team)
            db.flush()
            team_map[team.name] = team
            created_teams += 1

        try:
            task = models.Task(
                project_id=project_id,
                title=title,
                description=(row.get("description") or "").strip(),
                team_id=team.id,
                planned_start=_parse_date(row.get("planned_start")),
                planned_end=_parse_date(row.get("planned_end")),
                current_start=_parse_date(row.get("current_start")),
                current_end=_parse_date(row.get("current_end")),
                status=(row.get("status") or "planned").strip() or "planned",
                progress=int((row.get("progress") or "0").strip() or "0"),
            )
        except ValueError as exc:
            errors.append(f"Row {index}: {exc}")
            continue

        if task.planned_start is None or task.planned_end is None:
            errors.append(f"Row {index}: planned_start and planned_end are required.")
            continue

        db.add(task)
        db.flush()
        title_map[task.title] = task
        pending_dependencies.append((task, _parse_dependencies(row.get("dependencies"))))
        imported_tasks += 1

    for task, dependency_titles in pending_dependencies:
        dependency_ids: List[int] = []
        for dependency_title in dependency_titles:
            dependency_task = title_map.get(dependency_title)
            if dependency_task is None:
                dependency_task = db.scalar(
                    select(models.Task).where(
                        models.Task.project_id == project_id,
                        models.Task.title == dependency_title,
                    )
                )
            if dependency_task is None:
                errors.append(
                    f"Task '{task.title}' references unknown dependency '{dependency_title}'."
                )
                continue
            dependency_ids.append(dependency_task.id)
        replace_dependencies(db, task, dependency_ids)

    db.commit()
    return schemas.CsvImportResult(
        imported_tasks=imported_tasks,
        created_teams=created_teams,
        errors=errors,
    )


def dashboard_payload(db: Session, project_id: int) -> schemas.DashboardData:
    project = get_project(db, project_id)
    if project is None:
        raise ValueError("Project not found.")

    teams = [
        schemas.TeamRead.model_validate(team)
        for team in list_teams(db, project_id)
    ]
    serialized_tasks = [serialize_task(task) for task in list_tasks(db, project_id)]
    summary = schemas.DashboardSummary(
        total_tasks=len(serialized_tasks),
        delayed_tasks=sum(1 for task in serialized_tasks if task.delayed),
        at_risk_tasks=sum(1 for task in serialized_tasks if task.at_risk),
        total_teams=len(teams),
    )
    return schemas.DashboardData(
        project=schemas.ProjectRead.model_validate(project),
        teams=teams,
        tasks=serialized_tasks,
        summary=summary,
    )


def project_cards(db: Session) -> List[schemas.ProjectCard]:
    cards: List[schemas.ProjectCard] = []
    for project in list_projects(db):
        payload = dashboard_payload(db, project.id)
        cards.append(
            schemas.ProjectCard(
                id=project.id,
                name=project.name,
                description=project.description,
                color=project.color,
                total_tasks=payload.summary.total_tasks,
                delayed_tasks=payload.summary.delayed_tasks,
                at_risk_tasks=payload.summary.at_risk_tasks,
                total_teams=payload.summary.total_teams,
            )
        )
    return cards
