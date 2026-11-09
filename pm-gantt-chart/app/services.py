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
        date(2026, 8, 14),
    ),
    (
        "Atlas API Expansion",
        "Partner integration stream covering catalog and billing contracts.",
        "#1d4ed8",
        date(2026, 8, 28),
    ),
]


@dataclass
class DeliverableRisk:
    delayed: bool
    at_risk: bool
    risk_level: str
    delay_days: int
    dependency_slip_days: int
    milestone_slip_days: int
    risk_reasons: List[str]


@dataclass
class MilestoneRisk:
    slipped: bool
    slip_days: int
    risk_level: str


def seed_data(db: Session) -> None:
    existing_project = db.scalar(select(models.Project.id).limit(1))
    if existing_project is not None:
        return

    projects: List[models.Project] = []
    for name, description, color, release_date in DEFAULT_PROJECTS:
        # Seeded workspaces exist as guidance, so they land in the example section.
        project = models.Project(
            name=name,
            description=description,
            color=color,
            is_example=True,
        )
        db.add(project)
        projects.append(project)
    db.flush()
    seed_releases = {}
    for project, (_, _, _, release_date) in zip(projects, DEFAULT_PROJECTS):
        release = models.Release(
            project_id=project.id, name="Release 1", release_date=release_date
        )
        db.add(release)
        seed_releases[project.id] = release
    db.flush()

    for project_index, project in enumerate(projects):
        teams = [
            models.Team(project_id=project.id, name=name, color=color)
            for name, color in DEFAULT_TEAMS
        ]
        db.add_all(teams)
        db.flush()

        team_map = {team.name: team.id for team in teams}
        prefix = "A" if project_index == 0 else "B"
        start_offset = 0 if project_index == 0 else 14

        def d(value: date) -> date:
            return value + timedelta(days=start_offset)

        deliverables = [
            models.Deliverable(
                project_id=project.id,
                release_id=seed_releases[project.id].id,
                title=f"{prefix} Requirements Lock",
                description="Freeze scope and acceptance criteria for the quarter.",
                team_id=team_map["Core Platform"],
                planned_start=d(date(2026, 7, 7)),
                planned_end=d(date(2026, 7, 11)),
                current_start=d(date(2026, 7, 7)),
                current_end=d(date(2026, 7, 12)),
                status="in_progress",
                progress=80,
            ),
            models.Deliverable(
                project_id=project.id,
                release_id=seed_releases[project.id].id,
                title=f"{prefix} API Contracts",
                description="Finalize service contracts used by downstream teams.",
                team_id=team_map["Core Platform"],
                planned_start=d(date(2026, 7, 12)),
                planned_end=d(date(2026, 7, 18)),
                current_start=d(date(2026, 7, 13)),
                current_end=d(date(2026, 7, 20)),
                status="in_progress",
                progress=55,
            ),
            models.Deliverable(
                project_id=project.id,
                release_id=seed_releases[project.id].id,
                title=f"{prefix} Mobile UX Build",
                description="Implement the first feature wave in the mobile client.",
                team_id=team_map["Mobile Experience"],
                planned_start=d(date(2026, 7, 19)),
                planned_end=d(date(2026, 7, 29)),
                current_start=d(date(2026, 7, 19)),
                current_end=d(date(2026, 7, 30)),
                status="planned",
                progress=20,
            ),
            models.Deliverable(
                project_id=project.id,
                release_id=seed_releases[project.id].id,
                title=f"{prefix} Analytics Schema",
                description="Define the event schema that supports launch reporting.",
                team_id=team_map["Data & Analytics"],
                planned_start=d(date(2026, 7, 14)),
                planned_end=d(date(2026, 7, 22)),
                current_start=d(date(2026, 7, 14)),
                current_end=d(date(2026, 7, 22)),
                status="in_progress",
                progress=60,
            ),
            models.Deliverable(
                project_id=project.id,
                release_id=seed_releases[project.id].id,
                title=f"{prefix} Launch Readiness",
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
        db.add_all(deliverables)
        db.flush()

        title_to_id = {deliverable.title: deliverable.id for deliverable in deliverables}

        # Two milestones on one deliverable, showing both things milestones are
        # for: a piece owned by a team other than the parent's, and a slip that
        # rolls its risk up to the parent.
        db.add_all(
            [
                models.Milestone(
                    deliverable_id=title_to_id[f"{prefix} API Contracts"],
                    title=f"{prefix} Contract schema frozen",
                    description="Sign-off on the request/response shapes.",
                    team_id=team_map["Core Platform"],
                    target_date=d(date(2026, 7, 15)),
                    actual_date=d(date(2026, 7, 19)),
                    status="done",
                    progress=100,
                ),
                models.Milestone(
                    deliverable_id=title_to_id[f"{prefix} API Contracts"],
                    title=f"{prefix} Client SDK published",
                    description="Generated clients available to downstream teams.",
                    team_id=team_map["Mobile Experience"],
                    target_date=d(date(2026, 7, 18)),
                    status="in_progress",
                    progress=40,
                ),
            ]
        )

        db.add_all(
            [
                models.DeliverableDependency(
                    upstream_deliverable_id=title_to_id[f"{prefix} Requirements Lock"],
                    downstream_deliverable_id=title_to_id[f"{prefix} API Contracts"],
                ),
                models.DeliverableDependency(
                    upstream_deliverable_id=title_to_id[f"{prefix} API Contracts"],
                    downstream_deliverable_id=title_to_id[f"{prefix} Mobile UX Build"],
                ),
                models.DeliverableDependency(
                    upstream_deliverable_id=title_to_id[f"{prefix} Analytics Schema"],
                    downstream_deliverable_id=title_to_id[f"{prefix} Launch Readiness"],
                ),
                models.DeliverableDependency(
                    upstream_deliverable_id=title_to_id[f"{prefix} Mobile UX Build"],
                    downstream_deliverable_id=title_to_id[f"{prefix} Launch Readiness"],
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
        is_example=payload.is_example,
        status=payload.status,
    )
    db.add(project)
    db.flush()
    # Every workspace starts with one release so there is always somewhere to plan.
    db.add(
        models.Release(
            project_id=project.id,
            name=(payload.release_name or "").strip() or "Release 1",
            release_date=payload.release_date,
        )
    )
    db.commit()
    db.refresh(project)
    return project


def update_project(
    db: Session, project: models.Project, payload: schemas.ProjectUpdate
) -> models.Project:
    updates = payload.model_dump(exclude_unset=True)
    clear_sample_data = updates.pop("clear_sample_data", False)
    if "name" in updates and updates["name"] and updates["name"] != project.name:
        clash = db.scalar(
            select(models.Project).where(
                models.Project.name == updates["name"],
                models.Project.id != project.id,
            )
        )
        if clash is not None:
            raise ValueError("Another project already uses that name.")
    promoting = project.is_example and updates.get("is_example") is False
    for field, value in updates.items():
        # description may legitimately be cleared to "", so only skip None.
        if value is not None:
            setattr(project, field, value)
    if promoting and clear_sample_data:
        # Deleting through the ORM cascades milestones, links and dependencies.
        for deliverable in list(project.deliverables):
            db.delete(deliverable)
        for key_date in list(project.key_dates):
            db.delete(key_date)
    db.commit()
    db.refresh(project)
    return project


def delete_project(db: Session, project: models.Project) -> None:
    # Teams/deliverables (and their dependencies + Jira links) cascade via the ORM, but
    # project-level Jira links have no ORM cascade and SQLite does not enforce
    # the DB-level ON DELETE CASCADE, so clear them explicitly.
    db.query(models.ProjectJiraLink).filter(
        models.ProjectJiraLink.project_id == project.id
    ).delete(synchronize_session=False)
    db.delete(project)
    db.commit()


def list_releases(db: Session, project_id: int) -> List[models.Release]:
    stmt = (
        select(models.Release)
        .where(models.Release.project_id == project_id)
        .order_by(models.Release.release_date.is_(None), models.Release.release_date, models.Release.id)
    )
    return list(db.scalars(stmt).all())


def get_release(db: Session, release_id: int) -> Optional[models.Release]:
    return db.get(models.Release, release_id)


def default_release(db: Session, project_id: int) -> models.Release:
    """The release used when a caller does not name one: the latest, by id.

    A workspace with no releases gets "Release 1" created on the spot so
    deliverables and key dates always have a home.
    """
    release = db.scalar(
        select(models.Release)
        .where(models.Release.project_id == project_id)
        .order_by(models.Release.id.desc())
        .limit(1)
    )
    if release is None:
        release = models.Release(project_id=project_id, name="Release 1")
        db.add(release)
        db.flush()
    return release


def resolve_release_id(db: Session, project_id: int, release_id: Optional[int]) -> int:
    if release_id is None:
        return default_release(db, project_id).id
    release = db.get(models.Release, release_id)
    if release is None or release.project_id != project_id:
        raise ValueError("Release does not belong to the selected project.")
    return release.id


def _check_release_name(
    db: Session, project_id: int, name: str, exclude_id: Optional[int] = None
) -> None:
    stmt = select(models.Release).where(
        models.Release.project_id == project_id, models.Release.name == name
    )
    clash = db.scalar(stmt)
    if clash is not None and clash.id != exclude_id:
        raise ValueError("Another release in this workspace already uses that name.")


def create_release(
    db: Session, project_id: int, payload: schemas.ReleaseCreate
) -> models.Release:
    _check_release_name(db, project_id, payload.name)
    release = models.Release(
        project_id=project_id,
        name=payload.name,
        description=payload.description,
        release_date=payload.release_date,
        status=payload.status,
    )
    db.add(release)
    db.commit()
    db.refresh(release)
    return release


def update_release(
    db: Session, release: models.Release, payload: schemas.ReleaseUpdate
) -> models.Release:
    updates = payload.model_dump(exclude_unset=True)
    if updates.get("name"):
        _check_release_name(db, release.project_id, updates["name"], release.id)
    for field, value in updates.items():
        # An explicit null is the cleared state only for the date.
        if value is not None or field == "release_date":
            setattr(release, field, value)
    db.commit()
    db.refresh(release)
    return release


def delete_release(db: Session, release: models.Release) -> None:
    db.delete(release)
    db.commit()


def list_key_dates(
    db: Session, project_id: int, release_id: Optional[int] = None
) -> List[models.ProjectKeyDate]:
    stmt = select(models.ProjectKeyDate).where(
        models.ProjectKeyDate.project_id == project_id
    )
    if release_id is not None:
        stmt = stmt.where(models.ProjectKeyDate.release_id == release_id)
    return list(db.scalars(stmt.order_by(models.ProjectKeyDate.event_date)).all())


def get_key_date(db: Session, key_date_id: int) -> Optional[models.ProjectKeyDate]:
    return db.get(models.ProjectKeyDate, key_date_id)


def create_key_date(
    db: Session, project_id: int, payload: schemas.ProjectKeyDateCreate
) -> models.ProjectKeyDate:
    key_date = models.ProjectKeyDate(
        project_id=project_id,
        release_id=resolve_release_id(db, project_id, payload.release_id),
        name=payload.name,
        color=payload.color,
        event_date=payload.event_date,
    )
    db.add(key_date)
    db.commit()
    db.refresh(key_date)
    return key_date


def update_key_date(
    db: Session,
    project_id: int,
    key_date: models.ProjectKeyDate,
    payload: schemas.ProjectKeyDateUpdate,
) -> models.ProjectKeyDate:
    if key_date.project_id != project_id:
        raise ValueError("Date does not belong to the selected project.")
    # Every field is required on the model, so a null here means "leave alone".
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(key_date, field, value)
    db.commit()
    db.refresh(key_date)
    return key_date


def delete_key_date(
    db: Session, project_id: int, key_date: models.ProjectKeyDate
) -> None:
    if key_date.project_id != project_id:
        raise ValueError("Date does not belong to the selected project.")
    db.delete(key_date)
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
    """Raised when trying to delete a team that still owns or contributes to deliverables."""


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
    if team.deliverables:
        raise TeamInUseError(
            f"Team has {len(team.deliverables)} assigned deliverable(s); reassign them first."
        )
    if team.contributing_deliverables:
        raise TeamInUseError(
            f"Team is a contributor on {len(team.contributing_deliverables)} "
            "deliverable(s); remove it there first."
        )
    if team.milestones:
        raise TeamInUseError(
            f"Team owns {len(team.milestones)} milestone(s); reassign them first."
        )
    db.delete(team)
    db.commit()


def _deliverable_finish(deliverable: models.Deliverable) -> date:
    return deliverable.current_end or deliverable.planned_end


def _milestone_finish(milestone: models.Milestone) -> date:
    """The date the milestone actually landed on, or its target while open.

    Mirrors `_deliverable_finish`: with no actual date recorded there is nothing
    to compare against the target, so an open milestone never reads as slipped.
    """
    return milestone.actual_date or milestone.target_date


def calculate_milestone_risk(milestone: models.Milestone) -> MilestoneRisk:
    finish = _milestone_finish(milestone)
    slipped = finish > milestone.target_date
    slip_days = max((finish - milestone.target_date).days, 0)
    return MilestoneRisk(
        slipped=slipped,
        slip_days=slip_days,
        risk_level="high" if slipped else "none",
    )


def calculate_risk(deliverable: models.Deliverable) -> DeliverableRisk:
    actual_finish = _deliverable_finish(deliverable)
    delayed = actual_finish > deliverable.planned_end
    delay_days = max((actual_finish - deliverable.planned_end).days, 0)

    dependency_slip_days = 0
    risk_reasons: List[str] = []
    for link in deliverable.incoming_links:
        upstream = link.upstream_deliverable
        if upstream is None:
            continue
        dependency_finish = _deliverable_finish(upstream)
        if dependency_finish > deliverable.planned_start:
            slip = (dependency_finish - deliverable.planned_start).days
            dependency_slip_days = max(dependency_slip_days, slip)
            risk_reasons.append(
                f"Blocked by {upstream.title} until {dependency_finish.isoformat()}"
            )

    # Risk rolls up from the children, progress does not: a deliverable's own
    # progress stays whatever was entered or derived from its own Jira stories.
    milestone_slip_days = 0
    for milestone in deliverable.milestones:
        milestone_risk = calculate_milestone_risk(milestone)
        if not milestone_risk.slipped:
            continue
        milestone_slip_days = max(milestone_slip_days, milestone_risk.slip_days)
        risk_reasons.append(
            f"Milestone {milestone.title} slipped by {milestone_risk.slip_days} day(s)"
        )

    if delayed:
        risk_reasons.insert(0, f"Deliverable finish slipped by {delay_days} day(s)")

    at_risk = delayed or dependency_slip_days > 0 or milestone_slip_days > 0
    if delayed or dependency_slip_days >= 3 or milestone_slip_days >= 3:
        risk_level = "high"
    elif at_risk:
        risk_level = "medium"
    else:
        risk_level = "none"

    return DeliverableRisk(
        delayed=delayed,
        at_risk=at_risk,
        risk_level=risk_level,
        delay_days=delay_days,
        dependency_slip_days=dependency_slip_days,
        milestone_slip_days=milestone_slip_days,
        risk_reasons=risk_reasons,
    )


def list_deliverables(
    db: Session, project_id: int, release_id: Optional[int] = None
) -> List[models.Deliverable]:
    conditions = [models.Deliverable.project_id == project_id]
    if release_id is not None:
        conditions.append(models.Deliverable.release_id == release_id)
    stmt = (
        select(models.Deliverable)
        .where(*conditions)
        .options(
            selectinload(models.Deliverable.team),
            selectinload(models.Deliverable.contributor_teams),
            selectinload(models.Deliverable.incoming_links).selectinload(
                models.DeliverableDependency.upstream_deliverable
            ),
            # Risk rolls up from the milestones and they ride along in
            # DeliverableRead, so both are needed for every serialized row.
            selectinload(models.Deliverable.milestones).selectinload(
                models.Milestone.team
            ),
        )
        .order_by(models.Deliverable.planned_start, models.Deliverable.id)
    )
    return list(db.scalars(stmt).unique())


def serialize_milestone(milestone: models.Milestone) -> schemas.MilestoneRead:
    risk = calculate_milestone_risk(milestone)
    return schemas.MilestoneRead(
        id=milestone.id,
        deliverable_id=milestone.deliverable_id,
        project_id=milestone.team.project_id,
        title=milestone.title,
        description=milestone.description,
        team_id=milestone.team_id,
        team_name=milestone.team.name,
        team_color=milestone.team.color,
        target_date=milestone.target_date,
        actual_date=milestone.actual_date,
        status=milestone.status,
        progress=milestone.progress,
        slipped=risk.slipped,
        slip_days=risk.slip_days,
        risk_level=risk.risk_level,
    )


def _sorted_milestones(deliverable: models.Deliverable) -> List[models.Milestone]:
    return sorted(deliverable.milestones, key=lambda item: (item.target_date, item.id))


def serialize_deliverable(deliverable: models.Deliverable) -> schemas.DeliverableRead:
    risk = calculate_risk(deliverable)
    contributors = sorted(deliverable.contributor_teams, key=lambda team: team.name)
    return schemas.DeliverableRead(
        id=deliverable.id,
        project_id=deliverable.project_id,
        release_id=deliverable.release_id,
        title=deliverable.title,
        description=deliverable.description,
        team_id=deliverable.team_id,
        team_name=deliverable.team.name,
        team_color=deliverable.team.color,
        planned_start=deliverable.planned_start,
        planned_end=deliverable.planned_end,
        current_start=deliverable.current_start,
        current_end=deliverable.current_end,
        status=deliverable.status,
        progress=deliverable.progress,
        dependency_ids=[link.upstream_deliverable_id for link in deliverable.incoming_links],
        contributor_team_ids=[team.id for team in contributors],
        contributor_teams=[schemas.TeamRef.model_validate(team) for team in contributors],
        delayed=risk.delayed,
        at_risk=risk.at_risk,
        risk_level=risk.risk_level,
        delay_days=risk.delay_days,
        dependency_slip_days=risk.dependency_slip_days,
        milestone_slip_days=risk.milestone_slip_days,
        risk_reasons=risk.risk_reasons,
        jira_label=deliverable.jira_label,
        jira_label_project_key=deliverable.jira_label_project_key,
        jira_label_from=deliverable.jira_label_from,
        jira_label_to=deliverable.jira_label_to,
        milestones=[
            serialize_milestone(milestone)
            for milestone in _sorted_milestones(deliverable)
        ],
    )


def replace_dependencies(
    db: Session, deliverable: models.Deliverable, dependency_ids: Iterable[int]
) -> None:
    dependency_ids = list(dict.fromkeys(dependency_ids))
    if deliverable.id in dependency_ids:
        raise ValueError("A deliverable cannot depend on itself.")

    db.query(models.DeliverableDependency).filter(
        models.DeliverableDependency.downstream_deliverable_id == deliverable.id
    ).delete(synchronize_session=False)

    for dependency_id in dependency_ids:
        dependency = db.get(models.Deliverable, dependency_id)
        if dependency is None:
            raise ValueError(f"Dependency deliverable {dependency_id} does not exist.")
        if dependency.project_id != deliverable.project_id:
            raise ValueError("Dependencies must belong to the same project.")
        db.add(
            models.DeliverableDependency(
                upstream_deliverable_id=dependency_id,
                downstream_deliverable_id=deliverable.id,
            )
        )


def replace_contributor_teams(
    db: Session, deliverable: models.Deliverable, team_ids: Iterable[int]
) -> None:
    unique_ids = list(dict.fromkeys(team_ids))
    if not unique_ids:
        deliverable.contributor_teams = []
        return
    teams = list(
        db.scalars(select(models.Team).where(models.Team.id.in_(unique_ids))).all()
    )
    found = {team.id for team in teams}
    missing = [tid for tid in unique_ids if tid not in found]
    if missing:
        raise ValueError(f"Contributor team(s) not found: {missing}")
    for team in teams:
        if team.project_id != deliverable.project_id:
            raise ValueError("Contributor teams must belong to the same project.")
    if deliverable.team_id in unique_ids:
        raise ValueError("The owning team cannot also be listed as a contributor.")
    deliverable.contributor_teams = teams


def _check_label_range(start: Optional[date], end: Optional[date]) -> None:
    if start is not None and end is not None and start > end:
        raise ValueError("Jira label range start must be on or before its end.")


def _percent_done(rows) -> int:
    """Percent of non-epic (issue_type, status_category) rows that are done."""
    stories = [r for r in rows if (r[0] or "").strip().lower() != "epic"]
    if not stories:
        return 0
    done = sum(1 for r in stories if (r[1] or "").strip().lower() == "done")
    return round(done / len(stories) * 100)


def compute_deliverable_progress(db: Session, deliverable_id: int) -> int:
    """Percent of a deliverable's linked stories that are done.

    Epics are never counted as stories. With no stories the result is 0.
    """
    rows = db.execute(
        select(models.JiraIssue.issue_type, models.JiraIssue.status_category)
        .join(
            models.DeliverableJiraLink,
            models.DeliverableJiraLink.jira_issue_id == models.JiraIssue.id,
        )
        .where(models.DeliverableJiraLink.deliverable_id == deliverable_id)
    ).all()
    return _percent_done(rows)


def compute_milestone_progress(db: Session, milestone_id: int) -> int:
    """Percent of a milestone's linked stories that are done (epics ignored)."""
    rows = db.execute(
        select(models.JiraIssue.issue_type, models.JiraIssue.status_category)
        .join(
            models.MilestoneJiraLink,
            models.MilestoneJiraLink.jira_issue_id == models.JiraIssue.id,
        )
        .where(models.MilestoneJiraLink.milestone_id == milestone_id)
    ).all()
    return _percent_done(rows)


def recalc_milestone_progress(db: Session, milestone_id: int) -> None:
    """Recompute and store progress for one milestone (caller commits)."""
    milestone = db.get(models.Milestone, milestone_id)
    if milestone is None:
        return
    value = compute_milestone_progress(db, milestone_id)
    if milestone.progress != value:
        milestone.progress = value


def recalc_deliverable_progress(db: Session, deliverable_id: int) -> None:
    """Recompute and store progress for one deliverable (caller commits)."""
    deliverable = db.get(models.Deliverable, deliverable_id)
    if deliverable is None:
        return
    value = compute_deliverable_progress(db, deliverable_id)
    if deliverable.progress != value:
        deliverable.progress = value


def recalc_progress_for_issue(db: Session, jira_issue_id: int) -> None:
    """Recompute progress for every deliverable linked to a Jira issue."""
    db.flush()
    ids = db.scalars(
        select(models.DeliverableJiraLink.deliverable_id).where(
            models.DeliverableJiraLink.jira_issue_id == jira_issue_id
        )
    ).all()
    for deliverable_id in set(ids):
        recalc_deliverable_progress(db, deliverable_id)
    milestone_ids = db.scalars(
        select(models.MilestoneJiraLink.milestone_id).where(
            models.MilestoneJiraLink.jira_issue_id == jira_issue_id
        )
    ).all()
    for milestone_id in set(milestone_ids):
        recalc_milestone_progress(db, milestone_id)


def create_deliverable(
    db: Session, project_id: int, payload: schemas.DeliverableCreate
) -> models.Deliverable:
    team = db.get(models.Team, payload.team_id)
    if team is None or team.project_id != project_id:
        raise ValueError("Team does not belong to the selected project.")
    _check_label_range(payload.jira_label_from, payload.jira_label_to)

    deliverable = models.Deliverable(
        project_id=project_id,
        release_id=resolve_release_id(db, project_id, payload.release_id),
        title=payload.title,
        description=payload.description,
        team_id=payload.team_id,
        planned_start=payload.planned_start,
        planned_end=payload.planned_end,
        current_start=payload.current_start,
        current_end=payload.current_end,
        status=payload.status,
        progress=0,
        jira_label=payload.jira_label,
        jira_label_project_key=payload.jira_label_project_key,
        jira_label_from=payload.jira_label_from,
        jira_label_to=payload.jira_label_to,
    )
    db.add(deliverable)
    db.flush()
    replace_dependencies(db, deliverable, payload.dependency_ids)
    replace_contributor_teams(db, deliverable, payload.contributor_team_ids)
    db.commit()
    db.refresh(deliverable)
    return deliverable


def update_deliverable(
    db: Session,
    project_id: int,
    deliverable: models.Deliverable,
    payload: schemas.DeliverableUpdate,
) -> models.Deliverable:
    if deliverable.project_id != project_id:
        raise ValueError("Deliverable does not belong to the selected project.")

    updates = payload.model_dump(exclude_unset=True)
    dependency_ids = updates.pop("dependency_ids", None)
    contributor_ids = updates.pop("contributor_team_ids", None)
    # Progress is derived from linked Jira stories; never accept it from clients.
    updates.pop("progress", None)

    if "team_id" in updates:
        team = db.get(models.Team, updates["team_id"])
        if team is None or team.project_id != project_id:
            raise ValueError("Team does not belong to the selected project.")

    _check_label_range(
        updates.get("jira_label_from", deliverable.jira_label_from),
        updates.get("jira_label_to", deliverable.jira_label_to),
    )

    for field, value in updates.items():
        setattr(deliverable, field, value)

    db.flush()
    if dependency_ids is not None:
        replace_dependencies(db, deliverable, dependency_ids)
    if contributor_ids is not None:
        replace_contributor_teams(db, deliverable, contributor_ids)

    db.commit()
    db.refresh(deliverable)
    return deliverable


def get_milestone(db: Session, milestone_id: int) -> Optional[models.Milestone]:
    return db.get(models.Milestone, milestone_id)


def list_milestones(db: Session, deliverable_id: int) -> List[models.Milestone]:
    stmt = (
        select(models.Milestone)
        .where(models.Milestone.deliverable_id == deliverable_id)
        .options(selectinload(models.Milestone.team))
        .order_by(models.Milestone.target_date, models.Milestone.id)
    )
    return list(db.scalars(stmt).all())


def _validate_milestone_team(
    db: Session, deliverable: models.Deliverable, team_id: int
) -> None:
    """Any team on the project may own a milestone — but only those teams.

    Deliberately not restricted to the parent deliverable's team: splitting a
    deliverable across teams is the point of milestones.
    """
    team = db.get(models.Team, team_id)
    if team is None or team.project_id != deliverable.project_id:
        raise ValueError("Team does not belong to the selected project.")


def create_milestone(
    db: Session, deliverable: models.Deliverable, payload: schemas.MilestoneCreate
) -> models.Milestone:
    _validate_milestone_team(db, deliverable, payload.team_id)

    milestone = models.Milestone(
        deliverable_id=deliverable.id,
        title=payload.title,
        description=payload.description,
        team_id=payload.team_id,
        target_date=payload.target_date,
        actual_date=payload.actual_date,
        status=payload.status,
        # Derived from linked Jira stories; never accepted from clients.
        progress=0,
    )
    db.add(milestone)
    db.commit()
    db.refresh(milestone)
    return milestone


def update_milestone(
    db: Session, milestone: models.Milestone, payload: schemas.MilestoneUpdate
) -> models.Milestone:
    updates = payload.model_dump(exclude_unset=True)
    # Progress is derived from linked Jira stories; never accept it from clients.
    updates.pop("progress", None)

    if "team_id" in updates and updates["team_id"] is not None:
        _validate_milestone_team(db, milestone.deliverable, updates["team_id"])

    for field, value in updates.items():
        # actual_date is cleared by sending an explicit null, which is how a
        # milestone marked complete by mistake goes back to open.
        if value is not None or field == "actual_date":
            setattr(milestone, field, value)

    db.commit()
    db.refresh(milestone)
    return milestone


def delete_milestone(db: Session, milestone: models.Milestone) -> None:
    db.delete(milestone)
    db.commit()


def _parse_date(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    return date.fromisoformat(value.strip())


def _parse_dependencies(value: Optional[str]) -> List[str]:
    if not value:
        return []
    normalized = value.replace("|", ",")
    return [item.strip() for item in normalized.split(",") if item.strip()]


def import_csv(
    db: Session, project_id: int, raw_bytes: bytes, release_id: Optional[int] = None
) -> schemas.CsvImportResult:
    release_id = resolve_release_id(db, project_id, release_id)
    text = raw_bytes.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    errors: List[str] = []
    created_teams = 0
    imported_deliverables = 0

    team_map = {
        team.name: team
        for team in db.scalars(
            select(models.Team).where(models.Team.project_id == project_id)
        ).all()
    }
    pending_dependencies: List[Tuple[models.Deliverable, List[str]]] = []
    title_map: Dict[str, models.Deliverable] = {}

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
            deliverable = models.Deliverable(
                project_id=project_id,
                release_id=release_id,
                title=title,
                description=(row.get("description") or "").strip(),
                team_id=team.id,
                planned_start=_parse_date(row.get("planned_start")),
                planned_end=_parse_date(row.get("planned_end")),
                current_start=_parse_date(row.get("current_start")),
                current_end=_parse_date(row.get("current_end")),
                status=(row.get("status") or "planned").strip() or "planned",
                progress=0,
            )
        except ValueError as exc:
            errors.append(f"Row {index}: {exc}")
            continue

        if deliverable.planned_start is None or deliverable.planned_end is None:
            errors.append(f"Row {index}: planned_start and planned_end are required.")
            continue

        db.add(deliverable)
        db.flush()
        title_map[deliverable.title] = deliverable
        pending_dependencies.append((deliverable, _parse_dependencies(row.get("dependencies"))))
        imported_deliverables += 1

    for deliverable, dependency_titles in pending_dependencies:
        dependency_ids: List[int] = []
        for dependency_title in dependency_titles:
            dependency_deliverable = title_map.get(dependency_title)
            if dependency_deliverable is None:
                dependency_deliverable = db.scalar(
                    select(models.Deliverable).where(
                        models.Deliverable.project_id == project_id,
                        models.Deliverable.release_id == release_id,
                        models.Deliverable.title == dependency_title,
                    )
                )
            if dependency_deliverable is None:
                errors.append(
                    f"Deliverable '{deliverable.title}' references unknown dependency "
                    f"'{dependency_title}'."
                )
                continue
            dependency_ids.append(dependency_deliverable.id)
        replace_dependencies(db, deliverable, dependency_ids)

    db.commit()
    return schemas.CsvImportResult(
        imported_deliverables=imported_deliverables,
        created_teams=created_teams,
        errors=errors,
    )


def dashboard_payload(
    db: Session, project_id: int, release_id: Optional[int] = None
) -> schemas.DashboardData:
    project = get_project(db, project_id)
    if project is None:
        raise ValueError("Project not found.")

    releases = list_releases(db, project_id)
    if release_id is None:
        # Latest release by id, matching `default_release`.
        selected = max(releases, key=lambda item: item.id) if releases else None
    else:
        selected = next((item for item in releases if item.id == release_id), None)
        if selected is None:
            raise ValueError("Release not found.")
    scope_id = selected.id if selected is not None else -1

    teams = [
        schemas.TeamRead.model_validate(team)
        for team in list_teams(db, project_id)
    ]
    serialized_deliverables = [
        serialize_deliverable(deliverable)
        for deliverable in list_deliverables(db, project_id, scope_id)
    ]
    summary = schemas.DashboardSummary(
        total_deliverables=len(serialized_deliverables),
        delayed_deliverables=sum(1 for item in serialized_deliverables if item.delayed),
        at_risk_deliverables=sum(1 for item in serialized_deliverables if item.at_risk),
        total_teams=len(teams),
    )
    return schemas.DashboardData(
        project=schemas.ProjectRead.model_validate(project),
        release=schemas.ReleaseRead.model_validate(selected) if selected else None,
        releases=[schemas.ReleaseRead.model_validate(item) for item in releases],
        teams=teams,
        deliverables=serialized_deliverables,
        summary=summary,
        key_dates=[
            schemas.ProjectKeyDateRead.model_validate(key_date)
            for key_date in list_key_dates(db, project_id, scope_id)
        ],
    )


def release_cards(db: Session, project_id: int) -> List[schemas.ReleaseCard]:
    cards: List[schemas.ReleaseCard] = []
    for release in list_releases(db, project_id):
        items = [
            serialize_deliverable(deliverable)
            for deliverable in list_deliverables(db, project_id, release.id)
        ]
        cards.append(
            schemas.ReleaseCard(
                **schemas.ReleaseRead.model_validate(release).model_dump(),
                total_deliverables=len(items),
                delayed_deliverables=sum(1 for item in items if item.delayed),
                at_risk_deliverables=sum(1 for item in items if item.at_risk),
            )
        )
    return cards


def project_cards(db: Session) -> List[schemas.ProjectCard]:
    cards: List[schemas.ProjectCard] = []
    today = date.today()
    for project in list_projects(db):
        releases = list_releases(db, project.id)
        # Counts roll up across every release in the workspace.
        deliverables = [
            serialize_deliverable(deliverable)
            for deliverable in list_deliverables(db, project.id)
        ]
        dates = sorted(r.release_date for r in releases if r.release_date)
        upcoming = [d for d in dates if d >= today]
        cards.append(
            schemas.ProjectCard(
                id=project.id,
                name=project.name,
                description=project.description,
                color=project.color,
                is_example=project.is_example,
                status=project.status,
                created_at=project.created_at,
                total_deliverables=len(deliverables),
                delayed_deliverables=sum(1 for item in deliverables if item.delayed),
                at_risk_deliverables=sum(1 for item in deliverables if item.at_risk),
                total_teams=len(list_teams(db, project.id)),
                total_releases=len(releases),
                next_release_date=(upcoming or dates or [None])[0],
            )
        )
    return cards
