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

    teams: Mapped[List["Team"]] = relationship(
        "Team", back_populates="project", cascade="all, delete-orphan"
    )
    deliverables: Mapped[List["Deliverable"]] = relationship(
        "Deliverable", back_populates="project", cascade="all, delete-orphan"
    )


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
