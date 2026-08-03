# PM Gantt Tool — Usage Guide

## Prerequisites

- Python 3.8+
- `pip`

## Installation

From the project root (`pm-gantt-chart/`), install dependencies:

```bash
pip install -r requirements.txt
```

This installs FastAPI, Uvicorn, SQLAlchemy, Pydantic, and multipart support.

---

## Starting the UI

Run the server from the project root:

```bash
python3 -m uvicorn app.main:app --reload
```

The app is then available at `http://127.0.0.1:8000`.

If you need it accessible on your local network (e.g. for remote browser access):

```bash
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

Access it at `http://<your-machine-ip>:8001`.

On first startup, the database schema is created and sample seed data is loaded automatically.

---

## Using the UI

### Portfolio Landing Page

The default view lists all projects as cards. Each card shows the project name, description, and summary counts (tasks, teams, at-risk, delayed).

Click any project card to open its workspace.

### Project Workspace

Inside a project, the layout is:

1. **Hero bar** — project name and summary metrics at the top.
2. **Timeline** — the primary view showing task bars across a date range. Scroll horizontally to navigate time.
3. **Risk register** — a table of tasks flagged as at-risk or delayed.
4. **Management forms** — team setup, task creation, task update, and CSV import, below the timeline.

Use **Back to projects** (top-left) to return to the portfolio landing page.

### Inline Task Editing

Click any task bar on the timeline to open a popover editor. From there you can update:

- Status
- Progress (%)
- Current start date
- Current end date

Save to persist the change. Risk signals and timeline styling update immediately.

### Creating a Project

Click **New Project** on the portfolio page and fill in the name and description.

### Adding Teams and Tasks

Inside a project workspace, use the forms in the lower section to:

- **Add a team** — enter a team name.
- **Add a task** — fill in title, team, dates, status, and optional dependencies (comma-separated task titles).

### Bulk Import via CSV

Use the import form at the bottom of the workspace. The CSV must use these headers:

```
title,team,description,planned_start,planned_end,current_start,current_end,status,progress,dependencies
```

- Dates use `YYYY-MM-DD` format.
- `dependencies` accepts task titles separated by commas or pipes.
- The import is scoped to the current project.

---

## Taking Down the UI

To stop the server, press `Ctrl+C` in the terminal where Uvicorn is running.

To confirm the process is no longer listening:

```bash
lsof -iTCP:8000 -sTCP:LISTEN -n -P
```

Replace `8000` with `8001` if you started on that port. No output means the port is free.

---

## Bringing the UI Back Up

Restart the server the same way you started it:

```bash
python3 -m uvicorn app.main:app --reload
```

Or for network-accessible mode:

```bash
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

The SQLite database (`pm_tool.db`) persists between restarts — your projects, teams, and tasks are retained.

---

## Health Check

Verify the server is running and the API is responding:

```bash
curl http://127.0.0.1:8000/api/health
```

Expected response:

```json
{"status": "ok"}
```

---

## Troubleshooting

**"Address already in use" on startup**

Another Uvicorn process may still be running. Find and stop it:

```bash
lsof -iTCP:8000 -sTCP:LISTEN -n -P
kill <PID>
```

Then retry the start command.

**Blank page or missing data after restart**

The app seeds initial data only when the `projects` table is missing. If you need a clean slate, delete the database file and restart:

```bash
rm pm_tool.db
python3 -m uvicorn app.main:app --reload
```
