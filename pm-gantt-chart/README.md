# PM Gantt Tool

Internal product and program management tool aligned to:

- `PM_Tool_Requirements_v1.md`
- `PM_Tool_Requirements_v2.md`

## Included in V2 Prototype

- Portfolio landing page with project cards
- Project-scoped workspaces (teams/deliverables isolated per project)
- Editable workspaces (rename, recolor, re-describe, delete) from the workspace hero
- Timeline-first workspace layout
- Inline timeline deliverable editing popover, including Jira story linking
- Dependency tracking and risk calculations
- Deliverable/team forms and CSV import below timeline
- Jira story status filter (Jira's `done` category is hidden by default, per project)
- Optional "Show Jira stories" timeline overlay with each story's Jira
  relationships (blocks / is blocked by / relates to / subtasks)

"Project deliverables" include project features and enhancements — the concept
was called "tasks" through V2.

## Run locally

```bash
pip install -r requirements.txt
python3 -m uvicorn app.main:app --reload
```

Open `http://127.0.0.1:8000`.

For the Jira panel, copy `.env.example` to `.env` and fill in `JIRA_URL`,
`JIRA_EMAIL`, and `JIRA_API_TOKEN`. The server loads `.env` at startup, so restart
uvicorn after editing it, then check `GET /api/jira/health`.

## Main API routes (V2)

- `GET /api/projects`
- `POST /api/projects`
- `PUT /api/projects/{project_id}`
- `DELETE /api/projects/{project_id}`
- `GET /api/projects/{project_id}/dashboard`
- `POST /api/projects/{project_id}/teams`
- `GET /api/projects/{project_id}/deliverables`
- `POST /api/projects/{project_id}/deliverables`
- `PUT /api/projects/{project_id}/deliverables/{deliverable_id}`
- `DELETE /api/projects/{project_id}/deliverables/{deliverable_id}`
- `POST /api/projects/{project_id}/import/csv`
- `GET /api/projects/{project_id}/jira/deliverable-links` (bulk, backs the timeline overlay)
- `GET|POST|DELETE /api/deliverables/{deliverable_id}/jira[/links[/{link_id}]]`

Legacy databases are migrated in place on startup: the `task*` tables and
columns are renamed to `deliverable*`.

## CSV columns

Use these headers for bulk import:

```text
title,team,description,planned_start,planned_end,current_start,current_end,status,progress,dependencies
```

`dependencies` accepts deliverable titles separated by commas or pipes. The CSV
headers are unchanged by the deliverables rename.