# PM Gantt Tool

Internal product and program management tool aligned to:

- `PM_Tool_Requirements_v1.md`
- `PM_Tool_Requirements_v2.md`

## Included in V2 Prototype

- Portfolio landing page with project cards
- Project-scoped workspaces (teams/tasks isolated per project)
- Editable workspaces (rename, recolor, re-describe, delete) from the workspace hero
- Timeline-first workspace layout
- Inline timeline task editing popover
- Dependency tracking and risk calculations
- Task/team forms and CSV import below timeline

## Run locally

```bash
pip install -r requirements.txt
python3 -m uvicorn app.main:app --reload
```

Open `http://127.0.0.1:8000`.

## Main API routes (V2)

- `GET /api/projects`
- `POST /api/projects`
- `PUT /api/projects/{project_id}`
- `DELETE /api/projects/{project_id}`
- `GET /api/projects/{project_id}/dashboard`
- `POST /api/projects/{project_id}/teams`
- `POST /api/projects/{project_id}/tasks`
- `PUT /api/projects/{project_id}/tasks/{task_id}`
- `POST /api/projects/{project_id}/import/csv`

## CSV columns

Use these headers for bulk import:

```text
title,team,description,planned_start,planned_end,current_start,current_end,status,progress,dependencies
```

`dependencies` accepts task titles separated by commas or pipes.