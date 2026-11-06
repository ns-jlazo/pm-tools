from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


# Contributing teams (many-to-many); the primary owner remains Deliverable.team_id.
deliverable_contributor_teams = Table(
    "deliverable_contributor_teams",
    Base.metadata,
    Column(
        "deliverable_id",
        ForeignKey("deliverables.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "team_id",
        ForeignKey("teams.id", ondelete="CASCADE"),
        primary_key=True,
    ),
)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(160), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    color: Mapped[str] = mapped_column(String(20), default="#0f766e", nullable=False)
    # Example workspaces are guidance/demo material, listed apart from real work.
    is_example: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default=text("0")
    )
    # When the software reaches customers. Optional: most workspaces are onboarded
    # before a release is committed to.
    release_date: Mapped[Optional[Date]] = mapped_column(Date)

    teams: Mapped[List["Team"]] = relationship(
        "Team", back_populates="project", cascade="all, delete-orphan"
    )
    deliverables: Mapped[List["Deliverable"]] = relationship(
        "Deliverable", back_populates="project", cascade="all, delete-orphan"
    )
    key_dates: Mapped[List["ProjectKeyDate"]] = relationship(
        "ProjectKeyDate", back_populates="project", cascade="all, delete-orphan"
    )


class ProjectKeyDate(Base):
    """An extra dated marker on the timeline — kickoff, code freeze, beta, …

    A workspace's release date has a field of its own on Project; this is for the
    other dates a plan is read against, each with its own name and color.
    """

    __tablename__ = "project_key_dates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    color: Mapped[str] = mapped_column(String(20), default="#7c3aed", nullable=False)
    # `event_date`, not `date`, so the column never reads as `datetime.date`.
    event_date: Mapped[Date] = mapped_column(Date, nullable=False)

    project: Mapped[Project] = relationship("Project", back_populates="key_dates")


class Team(Base):
    __tablename__ = "teams"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_team_project_name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    color: Mapped[str] = mapped_column(String(20), nullable=False)

    project: Mapped[Project] = relationship("Project", back_populates="teams")
    deliverables: Mapped[List["Deliverable"]] = relationship(
        "Deliverable", back_populates="team"
    )
    contributing_deliverables: Mapped[List["Deliverable"]] = relationship(
        "Deliverable",
        secondary=deliverable_contributor_teams,
        back_populates="contributor_teams",
    )
    milestones: Mapped[List["Milestone"]] = relationship(
        "Milestone", back_populates="team"
    )


class DeliverableDependency(Base):
    __tablename__ = "deliverable_dependencies"

    upstream_deliverable_id: Mapped[int] = mapped_column(
        ForeignKey("deliverables.id", ondelete="CASCADE"), primary_key=True
    )
    downstream_deliverable_id: Mapped[int] = mapped_column(
        ForeignKey("deliverables.id", ondelete="CASCADE"), primary_key=True
    )

    upstream_deliverable: Mapped["Deliverable"] = relationship(
        "Deliverable",
        foreign_keys=[upstream_deliverable_id],
        back_populates="outgoing_links",
    )
    downstream_deliverable: Mapped["Deliverable"] = relationship(
        "Deliverable",
        foreign_keys=[downstream_deliverable_id],
        back_populates="incoming_links",
    )


class Deliverable(Base):
    """A project feature or enhancement tracked on the timeline."""

    __tablename__ = "deliverables"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"), nullable=False)
    planned_start: Mapped[Date] = mapped_column(Date, nullable=False)
    planned_end: Mapped[Date] = mapped_column(Date, nullable=False)
    current_start: Mapped[Optional[Date]] = mapped_column(Date)
    current_end: Mapped[Optional[Date]] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(30), default="planned", nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Jira label that tags this deliverable's stories, plus the optional project
    # and date window it was searched with. One label per deliverable.
    jira_label: Mapped[Optional[str]] = mapped_column(String(100))
    jira_label_project_key: Mapped[Optional[str]] = mapped_column(String(50))
    jira_label_from: Mapped[Optional[Date]] = mapped_column(Date)
    jira_label_to: Mapped[Optional[Date]] = mapped_column(Date)

    project: Mapped[Project] = relationship("Project", back_populates="deliverables")
    team: Mapped[Team] = relationship("Team", back_populates="deliverables")
    outgoing_links: Mapped[List[DeliverableDependency]] = relationship(
        "DeliverableDependency",
        foreign_keys=[DeliverableDependency.upstream_deliverable_id],
        back_populates="upstream_deliverable",
        cascade="all, delete-orphan",
    )
    incoming_links: Mapped[List[DeliverableDependency]] = relationship(
        "DeliverableDependency",
        foreign_keys=[DeliverableDependency.downstream_deliverable_id],
        back_populates="downstream_deliverable",
        cascade="all, delete-orphan",
    )
    jira_links: Mapped[List["DeliverableJiraLink"]] = relationship(
        "DeliverableJiraLink", back_populates="deliverable", cascade="all, delete-orphan"
    )
    contributor_teams: Mapped[List[Team]] = relationship(
        "Team",
        secondary=deliverable_contributor_teams,
        back_populates="contributing_deliverables",
    )
    milestones: Mapped[List["Milestone"]] = relationship(
        "Milestone", back_populates="deliverable", cascade="all, delete-orphan"
    )


class Milestone(Base):
    """A piece of a deliverable, owned by any team on the project.

    Milestones exist only as children of a deliverable — there is no standalone
    form — and carry a single target date rather than a planned/current window,
    so the timeline draws them as markers instead of bars.
    """

    __tablename__ = "milestones"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    deliverable_id: Mapped[int] = mapped_column(
        ForeignKey("deliverables.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # Need not be the parent deliverable's owning team.
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"), nullable=False)
    target_date: Mapped[Date] = mapped_column(Date, nullable=False)
    actual_date: Mapped[Optional[Date]] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(30), default="planned", nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    deliverable: Mapped[Deliverable] = relationship(
        "Deliverable", back_populates="milestones"
    )
    team: Mapped[Team] = relationship("Team", back_populates="milestones")
    jira_links: Mapped[List["MilestoneJiraLink"]] = relationship(
        "MilestoneJiraLink", back_populates="milestone", cascade="all, delete-orphan"
    )


class JiraIssue(Base):
    __tablename__ = "jira_issues"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    jira_key: Mapped[str] = mapped_column(String(60), unique=True, index=True, nullable=False)
    jira_url: Mapped[str] = mapped_column(String(500), nullable=False)
    issue_type: Mapped[str] = mapped_column(String(60), default="", nullable=False)
    summary: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    status: Mapped[str] = mapped_column(String(80), default="", nullable=False)
    status_category: Mapped[str] = mapped_column(String(40), default="", nullable=False)
    assignee_name: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    assignee_email: Mapped[str] = mapped_column(String(160), default="", nullable=False)
    parent_key: Mapped[Optional[str]] = mapped_column(String(60), index=True)
    due_date: Mapped[Optional[Date]] = mapped_column(Date)
    raw_json: Mapped[str] = mapped_column(Text, default="", nullable=False)
    synced_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    project_links: Mapped[List["ProjectJiraLink"]] = relationship(
        "ProjectJiraLink", back_populates="issue", cascade="all, delete-orphan"
    )
    deliverable_links: Mapped[List["DeliverableJiraLink"]] = relationship(
        "DeliverableJiraLink", back_populates="issue", cascade="all, delete-orphan"
    )
    milestone_links: Mapped[List["MilestoneJiraLink"]] = relationship(
        "MilestoneJiraLink", back_populates="issue", cascade="all, delete-orphan"
    )


class ProjectJiraLink(Base):
    __tablename__ = "project_jira_links"
    __table_args__ = (
        UniqueConstraint("project_id", "jira_issue_id", name="uq_project_jira_link"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    # Nullable so an epic can belong to the project without a specific team owner.
    team_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("teams.id", ondelete="SET NULL")
    )
    jira_issue_id: Mapped[int] = mapped_column(
        ForeignKey("jira_issues.id", ondelete="CASCADE"), nullable=False
    )
    linked_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    project: Mapped[Project] = relationship("Project")
    team: Mapped[Optional[Team]] = relationship("Team")
    issue: Mapped[JiraIssue] = relationship("JiraIssue", back_populates="project_links")


class DeliverableJiraLink(Base):
    __tablename__ = "deliverable_jira_links"
    __table_args__ = (
        UniqueConstraint("deliverable_id", "jira_issue_id", name="uq_deliverable_jira_link"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    deliverable_id: Mapped[int] = mapped_column(
        ForeignKey("deliverables.id", ondelete="CASCADE"), nullable=False
    )
    jira_issue_id: Mapped[int] = mapped_column(
        ForeignKey("jira_issues.id", ondelete="CASCADE"), nullable=False
    )
    linked_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    deliverable: Mapped[Deliverable] = relationship(
        "Deliverable", back_populates="jira_links"
    )
    issue: Mapped[JiraIssue] = relationship(
        "JiraIssue", back_populates="deliverable_links"
    )


class MilestoneJiraLink(Base):
    __tablename__ = "milestone_jira_links"
    __table_args__ = (
        UniqueConstraint("milestone_id", "jira_issue_id", name="uq_milestone_jira_link"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    milestone_id: Mapped[int] = mapped_column(
        ForeignKey("milestones.id", ondelete="CASCADE"), nullable=False
    )
    jira_issue_id: Mapped[int] = mapped_column(
        ForeignKey("jira_issues.id", ondelete="CASCADE"), nullable=False
    )
    linked_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    milestone: Mapped[Milestone] = relationship("Milestone", back_populates="jira_links")
    issue: Mapped[JiraIssue] = relationship(
        "JiraIssue", back_populates="milestone_links"
    )
