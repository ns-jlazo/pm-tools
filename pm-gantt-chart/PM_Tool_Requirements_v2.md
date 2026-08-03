# Product and Program Management Tool
## Requirements Document - Version 2.0

### 1. Overview
Version 2 expands the PM Gantt Tool from a single-project timeline into a portfolio workflow that supports many projects, each with its own project-scoped teams, tasks, dependencies, and risk signals.

### 2. Architecture & Infrastructure
- Database: Continue with SQLite for prototype and PostgreSQL for production.
- Backend: FastAPI + SQLAlchemy + Pydantic.
- Frontend: React SPA.
- Hosting target: VM-hosted internal web app.

### 3. V2 Product Scope
#### 3.1 Portfolio Landing Page
- Add a landing page that lists all onboarded projects.
- Each project card shows:
  - Project name and description.
  - Task count, team count, at-risk count, and delayed count.
- Selecting a project opens its dedicated workspace view.
- If no project is selected, only landing cards are shown.

#### 3.2 Project-Scoped Workspace
- All teams and tasks are isolated by project.
- No cross-project dependencies are allowed.
- Project workspace includes:
  - Hero context and summary metrics.
  - Timeline overview as the primary focal area.
  - Risk register table.

#### 3.3 Timeline-First Layout
- Team setup, create task, update task, and bulk import must appear below the Timeline overview.
- The timeline remains above all edit forms to support review meetings.

#### 3.4 Inline Task Editing on Timeline
- Tasks are editable directly from the timeline.
- Clicking a task bar opens a popover editor on the timeline view.
- Inline editor supports quick updates for:
  - Status
  - Progress
  - Current start date
  - Current end date
- Saving inline edits recalculates risk and refreshes visuals.

### 4. Backend Functional Requirements
- Add first-class Project entity.
- Add project-aware endpoints:
  - List projects.
  - Create project.
  - Fetch dashboard data by project.
  - Project-scoped task/team CRUD.
  - Project-scoped CSV import.
- Maintain backward compatibility alias for v1 dashboard where practical.
- Enforce dependency validation within same project.

### 5. Frontend Functional Requirements
- Add two primary views:
  - Portfolio landing
  - Project workspace
- Project workspace behavior:
  - Timeline overview renders first.
  - Forms render in a lower section.
  - Inline timeline edit popovers for quick updates.
- Provide "Back to projects" navigation from workspace.

### 6. Prototype Acceptance Criteria
- Landing page lists multiple projects from seeded data.
- Selecting a project loads only that project's teams/tasks/risk summary.
- Timeline remains visually above all management forms.
- Clicking timeline task bar opens inline editor and persists changes.
- Risk register and timeline styling update after inline save.

### 7. Explicit V2 Decisions
- Teams are isolated per project.
- Landing page defaults to card list view until selection.
- Inline editing starts with click-to-popover interaction.

### 8. Out of Scope for V2 Prototype
- Authentication and RBAC.
- Drag-and-drop bar scheduling.
- Cross-project dependency modeling.
- Full migration engine for historical production data.
