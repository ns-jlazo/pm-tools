from typing import Dict, List, Optional

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    color: str = Field(default="#0f766e", min_length=4, max_length=20)
    is_example: bool = False
    status: str = Field(default="active", pattern="^(active|inactive)$")
    # Seeds the workspace's first release (see `services.create_project`).
    release_name: Optional[str] = Field(default=None, max_length=160)
    release_date: Optional[date] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = None
    color: Optional[str] = Field(default=None, min_length=4, max_length=20)
    is_example: Optional[bool] = None
    status: Optional[str] = Field(default=None, pattern="^(active|inactive)$")
    # Only honored when is_example flips true -> false: drop the sample data.
    clear_sample_data: bool = False


class ProjectRead(BaseModel):
    id: int
    name: str
    description: str = ""
    color: str
    is_example: bool = False
    status: str = "active"

    model_config = ConfigDict(from_attributes=True)


class ReleaseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    release_date: Optional[date] = None


class ReleaseUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = None
    # An explicit null clears the date — see `services.update_release`.
    release_date: Optional[date] = None


class ReleaseRead(ReleaseCreate):
    id: int
    project_id: int

    model_config = ConfigDict(from_attributes=True)


class ReleaseCard(ReleaseRead):
    total_deliverables: int = 0
    delayed_deliverables: int = 0
    at_risk_deliverables: int = 0


class ProjectCard(BaseModel):
    id: int
    name: str
    description: str
    color: str
    is_example: bool = False
    status: str = "active"
    total_deliverables: int
    delayed_deliverables: int
    at_risk_deliverables: int
    total_teams: int
    total_releases: int = 0
    next_release_date: Optional[date] = None


class ProjectKeyDateCreate(BaseModel):
    """One extra dated marker on the timeline, beside the release date."""

    name: str = Field(min_length=1, max_length=120)
    color: str = Field(default="#7c3aed", min_length=4, max_length=20)
    event_date: date
    # Defaults to the workspace's latest release when omitted.
    release_id: Optional[int] = None


class ProjectKeyDateUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    color: Optional[str] = Field(default=None, min_length=4, max_length=20)
    event_date: Optional[date] = None


class ProjectKeyDateRead(ProjectKeyDateCreate):
    id: int
    project_id: int
    release_id: Optional[int] = None

    model_config = ConfigDict(from_attributes=True)


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
    """Minimal team payload embedded in DeliverableRead for contributor rendering."""

    id: int
    name: str
    color: str

    model_config = ConfigDict(from_attributes=True)


class MilestoneBase(BaseModel):
    """A piece of a deliverable. One target date, not a planned/current window."""

    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    team_id: int
    target_date: date
    actual_date: Optional[date] = None
    status: str = Field(default="planned", max_length=30)
    progress: int = Field(default=0, ge=0, le=100)


class MilestoneCreate(MilestoneBase):
    jira_keys: List[str] = Field(default_factory=list)


class MilestoneUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = None
    team_id: Optional[int] = None
    target_date: Optional[date] = None
    # An explicit null clears the date — see `services.update_milestone`.
    actual_date: Optional[date] = None
    status: Optional[str] = Field(default=None, max_length=30)
    progress: Optional[int] = Field(default=None, ge=0, le=100)


class MilestoneRead(BaseModel):
    id: int
    deliverable_id: int
    project_id: int
    title: str
    description: str
    team_id: int
    # Denormalized like DeliverableRead so the timeline can color a milestone
    # marker by its owning team without a second lookup.
    team_name: str
    team_color: str
    target_date: date
    actual_date: Optional[date]
    status: str
    progress: int
    slipped: bool
    slip_days: int
    risk_level: str


def _blank_to_none(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = value.strip()
    return value or None


class DeliverableBase(BaseModel):
    project_id: Optional[int] = None
    # Defaults to the workspace's latest release when omitted.
    release_id: Optional[int] = None
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
    jira_label: Optional[str] = Field(default=None, max_length=100)
    jira_label_project_key: Optional[str] = Field(default=None, max_length=50)
    jira_label_from: Optional[date] = None
    jira_label_to: Optional[date] = None

    @field_validator("jira_label", "jira_label_project_key")
    @classmethod
    def _blank_to_none(cls, value: Optional[str]) -> Optional[str]:
        return _blank_to_none(value)


class DeliverableCreate(DeliverableBase):
    jira_keys: List[str] = Field(default_factory=list)


class DeliverableUpdate(BaseModel):
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
    jira_label: Optional[str] = Field(default=None, max_length=100)
    jira_label_project_key: Optional[str] = Field(default=None, max_length=50)
    jira_label_from: Optional[date] = None
    jira_label_to: Optional[date] = None

    @field_validator("jira_label", "jira_label_project_key")
    @classmethod
    def _blank_to_none(cls, value: Optional[str]) -> Optional[str]:
        return _blank_to_none(value)


class DeliverableRead(BaseModel):
    id: int
    project_id: int
    release_id: Optional[int] = None
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
    milestone_slip_days: int
    risk_reasons: List[str]
    jira_label: Optional[str] = None
    jira_label_project_key: Optional[str] = None
    jira_label_from: Optional[date] = None
    jira_label_to: Optional[date] = None
    # Embedded rather than fetched per row: the timeline renders milestone
    # sub-rows straight from the dashboard payload.
    milestones: List[MilestoneRead] = Field(default_factory=list)


class DashboardSummary(BaseModel):
    total_deliverables: int
    delayed_deliverables: int
    at_risk_deliverables: int
    total_teams: int


class DashboardData(BaseModel):
    project: ProjectRead
    # The release the deliverables and key dates belong to (None: no releases yet).
    release: Optional[ReleaseRead] = None
    releases: List[ReleaseRead] = Field(default_factory=list)
    teams: List[TeamRead]
    deliverables: List[DeliverableRead]
    summary: DashboardSummary
    # Drawn as markers on the timeline alongside the project's release date.
    key_dates: List[ProjectKeyDateRead] = Field(default_factory=list)


class CsvImportResult(BaseModel):
    imported_deliverables: int
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
    total: Optional[int] = None
    issues: List[JiraSearchResult]
    next_page_token: Optional[str] = None
    is_last: bool = True


class JiraIssueLinkRef(BaseModel):
    """One Jira-side relationship of a linked story (issue link, subtask, parent)."""

    relation: str
    key: str
    url: str
    summary: str = ""
    status: str = ""
    status_category: str = ""
    issue_type: str = ""


class JiraIssueRead(JiraSearchResult):
    id: int
    synced_at: datetime
    links: List[JiraIssueLinkRef] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class JiraLinkCreate(BaseModel):
    jira_key: str = Field(min_length=1, max_length=60)
    team_id: Optional[int] = None


class JiraBulkLinkCreate(BaseModel):
    """Link every story carrying a Jira label in one request."""

    jira_keys: List[str] = Field(default_factory=list)


class JiraBulkLinkResult(BaseModel):
    linked: List[str] = Field(default_factory=list)
    skipped: List[str] = Field(default_factory=list)
    not_found: List[str] = Field(default_factory=list)


class JiraLabelSuggestions(BaseModel):
    """Label typeahead results, scoped to one Jira project."""

    project_key: str
    labels: List[str] = Field(default_factory=list)
    # "suggestions" (Jira's autocomplete endpoint) or "issues" (derived fallback).
    source: str = "suggestions"


class JiraLinkedIn(BaseModel):
    """A deliverable in the workspace that already has a story linked."""

    deliverable_id: int
    title: str


class JiraLabelIssue(JiraSearchResult):
    """A label-search hit, annotated for the deliverable label picker."""

    labels: List[str] = Field(default_factory=list)
    epic_key: Optional[str] = None
    epic_summary: str = ""
    # The epic's dates, else the story's due date. Both None means undated.
    effective_start: Optional[date] = None
    effective_end: Optional[date] = None
    undated: bool = False
    linked_in: List[JiraLinkedIn] = Field(default_factory=list)


class JiraLabelSearchResponse(BaseModel):
    project_key: str
    label: str
    issues: List[JiraLabelIssue] = Field(default_factory=list)
    truncated: bool = False


class JiraLabelSyncItem(BaseModel):
    deliverable_id: int
    label: str
    total: int = 0
    new_keys: List[str] = Field(default_factory=list)
    new_count: int = 0
    truncated: bool = False
    # True when served from the throttle cache rather than a fresh Jira search.
    cached: bool = False
    error: Optional[str] = None


class JiraLabelSyncResponse(BaseModel):
    """Surface-only: reports stories not yet linked, never links anything."""

    results: List[JiraLabelSyncItem] = Field(default_factory=list)
    error: Optional[str] = None


class ProjectJiraLinkRead(BaseModel):
    id: int
    project_id: int
    team_id: Optional[int]
    linked_at: datetime
    issue: JiraIssueRead


class DeliverableJiraLinkRead(BaseModel):
    id: int
    deliverable_id: int
    linked_at: datetime
    issue: JiraIssueRead


class ProjectJiraLinksGrouped(BaseModel):
    """Payload for the project Jira panel: links grouped by team_id (None => unassigned)."""

    project_id: int
    links: List[ProjectJiraLinkRead]
    stale: bool
    synced_at: Optional[datetime] = None


class MilestoneJiraLinkRead(BaseModel):
    id: int
    milestone_id: int
    linked_at: datetime
    issue: JiraIssueRead


class ProjectDeliverableJiraLinks(BaseModel):
    """Every deliverable's Jira links for one project, keyed by deliverable id.

    Powers the optional Gantt story overlay in a single request instead of one
    call per deliverable row.
    """

    project_id: int
    links_by_deliverable: Dict[int, List[DeliverableJiraLinkRead]] = Field(
        default_factory=dict
    )
    stale: bool = False
    synced_at: Optional[datetime] = None


class ProjectMilestoneJiraLinks(BaseModel):
    """Every milestone's Jira links for one project, keyed by milestone id.

    The milestone counterpart of ProjectDeliverableJiraLinks, so the timeline
    overlay stays at one request for the whole chart.
    """

    project_id: int
    links_by_milestone: Dict[int, List[MilestoneJiraLinkRead]] = Field(
        default_factory=dict
    )
    stale: bool = False
    synced_at: Optional[datetime] = None


class JiraHealth(BaseModel):
    configured: bool
    authenticated: bool = False
    account: Optional[str] = None
    url: Optional[str] = None
    detail: Optional[str] = None