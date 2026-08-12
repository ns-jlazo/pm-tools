from typing import List, Optional

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    color: str = Field(default="#0f766e", min_length=4, max_length=20)


class ProjectUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = None
    color: Optional[str] = Field(default=None, min_length=4, max_length=20)


class ProjectRead(ProjectCreate):
    id: int

    model_config = ConfigDict(from_attributes=True)


class ProjectCard(BaseModel):
    id: int
    name: str
    description: str
    color: str
    total_tasks: int
    delayed_tasks: int
    at_risk_tasks: int
    total_teams: int


class TeamCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    color: str = Field(default="#2563eb", min_length=4, max_length=20)


class TeamUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    color: Optional[str] = Field(default=None, min_length=4, max_length=20)


class TeamRead(TeamCreate):
    id: int
    project_id: int

    model_config = ConfigDict(from_attributes=True)


class TeamRef(BaseModel):
    """Minimal team payload embedded in TaskRead for contributor rendering."""

    id: int
    name: str
    color: str

    model_config = ConfigDict(from_attributes=True)


class TaskBase(BaseModel):
    project_id: Optional[int] = None
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    team_id: int
    planned_start: date
    planned_end: date
    current_start: Optional[date] = None
    current_end: Optional[date] = None
    status: str = Field(default="planned", max_length=30)
    progress: int = Field(default=0, ge=0, le=100)
    dependency_ids: List[int] = Field(default_factory=list)
    contributor_team_ids: List[int] = Field(default_factory=list)


class TaskCreate(TaskBase):
    jira_keys: List[str] = Field(default_factory=list)


class TaskUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = None
    team_id: Optional[int] = None
    planned_start: Optional[date] = None
    planned_end: Optional[date] = None
    current_start: Optional[date] = None
    current_end: Optional[date] = None
    status: Optional[str] = Field(default=None, max_length=30)
    progress: Optional[int] = Field(default=None, ge=0, le=100)
    dependency_ids: Optional[List[int]] = None
    contributor_team_ids: Optional[List[int]] = None


class TaskRead(BaseModel):
    id: int
    project_id: int
    title: str
    description: str
    team_id: int
    team_name: str
    team_color: str
    planned_start: date
    planned_end: date
    current_start: Optional[date]
    current_end: Optional[date]
    status: str
    progress: int
    dependency_ids: List[int]
    contributor_team_ids: List[int]
    contributor_teams: List[TeamRef]
    delayed: bool
    at_risk: bool
    risk_level: str
    delay_days: int
    dependency_slip_days: int
    risk_reasons: List[str]


class DashboardSummary(BaseModel):
    total_tasks: int
    delayed_tasks: int
    at_risk_tasks: int
    total_teams: int


class DashboardData(BaseModel):
    project: ProjectRead
    teams: List[TeamRead]
    tasks: List[TaskRead]
    summary: DashboardSummary


class CsvImportResult(BaseModel):
    imported_tasks: int
    created_teams: int
    errors: List[str]


class JiraSearchResult(BaseModel):
    """Slimmed Jira issue payload used by search + link responses."""

    key: str
    url: str
    issue_type: str
    summary: str
    status: str
    status_category: str
    assignee_name: str = ""
    assignee_email: str = ""
    parent_key: Optional[str] = None
    due_date: Optional[date] = None


class JiraSearchResponse(BaseModel):
    total: int
    issues: List[JiraSearchResult]
    next_page_token: Optional[str] = None
    is_last: bool = True


class JiraIssueRead(JiraSearchResult):
    id: int
    synced_at: datetime

    model_config = ConfigDict(from_attributes=True)


class JiraLinkCreate(BaseModel):
    jira_key: str = Field(min_length=1, max_length=60)
    team_id: Optional[int] = None


class ProjectJiraLinkRead(BaseModel):
    id: int
    project_id: int
    team_id: Optional[int]
    linked_at: datetime
    issue: JiraIssueRead


class TaskJiraLinkRead(BaseModel):
    id: int
    task_id: int
    linked_at: datetime
    issue: JiraIssueRead


class ProjectJiraLinksGrouped(BaseModel):
    """Payload for the project Jira panel: links grouped by team_id (None => unassigned)."""

    project_id: int
    links: List[ProjectJiraLinkRead]
    stale: bool
    synced_at: Optional[datetime] = None


class JiraHealth(BaseModel):
    configured: bool
    url: Optional[str] = None
    detail: Optional[str] = None