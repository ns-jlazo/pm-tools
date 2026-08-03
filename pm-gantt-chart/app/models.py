from __future__ import annotations

from typing import List, Optional

from sqlalchemy import Date, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(160), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    color: Mapped[str] = mapped_column(String(20), default="#0f766e", nullable=False)

    teams: Mapped[List["Team"]] = relationship(
        "Team", back_populates="project", cascade="all, delete-orphan"
    )
    tasks: Mapped[List["Task"]] = relationship(
        "Task", back_populates="project", cascade="all, delete-orphan"
    )


class Team(Base):
    __tablename__ = "teams"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_team_project_name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    color: Mapped[str] = mapped_column(String(20), nullable=False)

    project: Mapped[Project] = relationship("Project", back_populates="teams")
    tasks: Mapped[List["Task"]] = relationship("Task", back_populates="team")


class TaskDependency(Base):
    __tablename__ = "task_dependencies"

    upstream_task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    downstream_task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )

    upstream_task: Mapped["Task"] = relationship(
        "Task",
        foreign_keys=[upstream_task_id],
        back_populates="outgoing_links",
    )
    downstream_task: Mapped["Task"] = relationship(
        "Task",
        foreign_keys=[downstream_task_id],
        back_populates="incoming_links",
    )


class Task(Base):
    __tablename__ = "tasks"

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

    project: Mapped[Project] = relationship("Project", back_populates="tasks")
    team: Mapped[Team] = relationship("Team", back_populates="tasks")
    outgoing_links: Mapped[List[TaskDependency]] = relationship(
        "TaskDependency",
        foreign_keys=[TaskDependency.upstream_task_id],
        back_populates="upstream_task",
        cascade="all, delete-orphan",
    )
    incoming_links: Mapped[List[TaskDependency]] = relationship(
        "TaskDependency",
        foreign_keys=[TaskDependency.downstream_task_id],
        back_populates="downstream_task",
        cascade="all, delete-orphan",
    )