# PM Gantt Tool — Team Access Guide

This guide is for team members who want to access the PM Gantt Tool. You do not need to install or configure anything if the tool is already running on a shared host.

---

## What You Need to Know Before Accessing

| Item | What it is | Where to get it |
|------|-----------|-----------------|
| **Host address** | The IP address or hostname of the machine running the server | Ask whoever manages the tool |
| **Port** | The network port the server listens on (default: `8001` for shared access) | Same as above |
| **Network access** | Your machine must be on the same network (or VPN) as the host | IT / network admin |
| **Browser** | Any modern browser (Chrome, Firefox, Edge, Safari) | Already installed |

You do **not** need Python, Git, or any development tools to use the UI.

---

## Step-by-Step: Accessing the UI

### 1. Confirm the server is running

Before opening a browser, verify the tool is up. Ask the person responsible for the host, or check by running this from any machine on the network:

```bash
curl http://<host-address>:8001/api/health
```

Expected response:

```json
{"status": "ok"}
```

If you get no response, the server may be down — see [What to do if you can't connect](#what-to-do-if-you-cant-connect).

### 2. Open the UI in your browser

Navigate to:

```
http://<host-address>:8001
```

Replace `<host-address>` with the actual IP or hostname provided to you (e.g. `http://192.168.1.50:8001`).

### 3. Browse the portfolio landing page

The first screen lists all active projects as cards. Each card shows:

- Project name and description
- Total task count
- Team count
- Number of at-risk and delayed tasks

### 4. Open a project workspace

Click any project card to open its workspace. The workspace contains:

1. **Hero bar** — project name and key summary metrics
2. **Timeline** — the main Gantt view; scroll horizontally to move through dates
3. **Risk register** — tasks flagged as at-risk or delayed
4. **Management forms** — add teams, add tasks, and import tasks via CSV (scroll down to reach these)

### 5. Edit a task inline on the timeline

Click any colored task bar on the timeline. A popover appears where you can update:

- Status
- Progress (%)
- Current start and end dates

Click **Save** to apply. The timeline and risk register update immediately.

### 6. Return to the project list

Click **Back to projects** in the top-left of the workspace to return to the portfolio landing page.

---

## What You Can Do in the UI

| Action | Where |
|--------|-------|
| View all projects | Portfolio landing page |
| Create a new project | **New Project** button on landing page |
| View timeline & risk register | Project workspace (top section) |
| Edit a task quickly | Click a task bar on the timeline |
| Add a team | Project workspace → Add Team form (scroll down) |
| Add a task manually | Project workspace → Add Task form (scroll down) |
| Import tasks in bulk | Project workspace → CSV Import form (scroll down) |
| Return to project list | **Back to projects** link (top-left) |

---

## What to Do if You Can't Connect

1. **Check your network** — Make sure you are on the same network or VPN as the host machine.
2. **Confirm the server is running** — Contact whoever manages the host and ask them to verify the server is up. They can refer to [USAGE.md](USAGE.md) for start/stop instructions.
3. **Try the health endpoint** — `http://<host-address>:8001/api/health` should return `{"status": "ok"}`. A timeout or connection refused means the server is down.
4. **Port mismatch** — If port `8001` doesn't work, confirm the correct port with the host manager. The default for local-only access is `8000`.

---

## If You Need to Run the Tool Yourself Locally

If no shared host is available, you can run the tool on your own machine. See [USAGE.md](USAGE.md) for full installation and startup instructions. You will need:

- Python 3.8+
- `pip`
- A copy of this repository
