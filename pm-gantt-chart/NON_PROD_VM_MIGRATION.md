# PM Gantt Chart Non-Prod VM Migration Runbook

This runbook describes how to move the PM Gantt Chart app from the current VM to another non-prod VM without losing data, and how to run it there as a systemd user service.

The current production-style instance runs as:

- App directory: `/home/jlazo/workspace/pm-tools/pm-gantt-chart`
- Service file: `/home/jlazo/.config/systemd/user/pm-gantt-chart.service`
- Service type: systemd user service
- App command: `/usr/bin/python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8765`
- Database: SQLite file `pm_tool.db` in the app working directory
- Runtime config/secrets: `.env` in the app working directory

## What Must Be Preserved

Copy these from the current VM before starting the app on the new VM:

- `pm_tool.db` - the SQLite database containing projects, teams, deliverables, milestones, Jira links, and cached Jira issue data.
- `.env` - Jira configuration and API credentials. Treat this as a secret; do not commit it to git or paste it into tickets/chat.
- The deployed app code - preferably from git at the same commit currently running, or by copying the full app directory if the current VM has uncommitted production changes.

Do not start the app on the new VM before restoring `pm_tool.db`. If the app starts with no database present, it can create a fresh empty database in the working directory.

## 1. Capture Current Instance Details

On the current VM:

```bash
cd /home/jlazo/workspace/pm-tools/pm-gantt-chart

git status --short
git rev-parse HEAD
systemctl --user status pm-gantt-chart.service
systemctl --user cat pm-gantt-chart.service
ls -lah pm_tool.db .env requirements.txt
```

Record the git commit and any uncommitted changes. If `git status --short` is not clean, either commit those changes before migration or copy the working tree exactly to the new VM.

## 2. Back Up The Data Safely

The safest approach is to briefly stop the service, copy the SQLite database, verify it, then restart the service.

On the current VM:

```bash
systemctl --user stop pm-gantt-chart.service

cd /home/jlazo/workspace/pm-tools/pm-gantt-chart
mkdir -p /home/jlazo/backups/pm-gantt-chart

sqlite3 pm_tool.db ".backup '/home/jlazo/backups/pm-gantt-chart/pm_tool.db'"
sqlite3 /home/jlazo/backups/pm-gantt-chart/pm_tool.db "PRAGMA integrity_check;"

cp .env /home/jlazo/backups/pm-gantt-chart/.env
chmod 600 /home/jlazo/backups/pm-gantt-chart/.env

systemctl --user start pm-gantt-chart.service
systemctl --user status pm-gantt-chart.service
```

The integrity check should return `ok`. Do not continue with migration if it reports corruption.

If downtime is not acceptable, SQLite online backup can usually run while the app is live, but verify the backup with `PRAGMA integrity_check` before relying on it.

## 3. Prepare The New Non-Prod VM

Create or choose the Linux user that will own and run the app. The examples below use `jlazo` to mirror the current VM. Adjust paths if the target user is different.

Install OS packages:

```bash
sudo apt-get update
sudo apt-get install -y git python3 python3-venv python3-pip sqlite3
```

Create the target directory:

```bash
mkdir -p /home/jlazo/workspace/pm-tools
cd /home/jlazo/workspace/pm-tools
```

Get the app code using one of these approaches.

Preferred, if the current code is committed:

```bash
git clone <repo-url> pm-gantt-chart
cd pm-gantt-chart
git checkout <commit-from-current-vm>
```

Alternative, if the current VM has uncommitted changes that must be preserved:

```bash
rsync -a --delete \
  --exclude '.venv/' \
  --exclude '__pycache__/' \
  --exclude '.pytest_cache/' \
  current-vm:/home/jlazo/workspace/pm-tools/pm-gantt-chart/ \
  /home/jlazo/workspace/pm-tools/pm-gantt-chart/
```

## 4. Restore Database And Environment

Copy the backup artifacts from the current VM to the new VM:

```bash
rsync -a current-vm:/home/jlazo/backups/pm-gantt-chart/pm_tool.db \
  /home/jlazo/workspace/pm-tools/pm-gantt-chart/pm_tool.db

rsync -a current-vm:/home/jlazo/backups/pm-gantt-chart/.env \
  /home/jlazo/workspace/pm-tools/pm-gantt-chart/.env
```

Set ownership and restrictive permissions:

```bash
chown jlazo:jlazo /home/jlazo/workspace/pm-tools/pm-gantt-chart/pm_tool.db \
  /home/jlazo/workspace/pm-tools/pm-gantt-chart/.env
chmod 600 /home/jlazo/workspace/pm-tools/pm-gantt-chart/.env
chmod 660 /home/jlazo/workspace/pm-tools/pm-gantt-chart/pm_tool.db
```

Verify the restored database before starting the app:

```bash
cd /home/jlazo/workspace/pm-tools/pm-gantt-chart
sqlite3 pm_tool.db "PRAGMA integrity_check;"
sqlite3 pm_tool.db ".tables"
```

The integrity check should return `ok`. Expected tables include `projects`, `teams`, `deliverables`, `milestones`, `jira_issues`, and related link tables.

For a non-prod environment, review `.env` before startup. At minimum confirm whether the non-prod VM should use the same Jira URL/token as prod, a separate non-prod Jira token, or Jira integration disabled by leaving credentials blank.

## 5. Install Python Dependencies

The current service uses `/usr/bin/python3` directly. For a cleaner non-prod install, use a project virtual environment and point systemd at it.

```bash
cd /home/jlazo/workspace/pm-tools/pm-gantt-chart
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Run a foreground smoke test before creating the service:

```bash
cd /home/jlazo/workspace/pm-tools/pm-gantt-chart
. .venv/bin/activate
python -m uvicorn app.main:app --host 0.0.0.0 --port 8765
```

In another shell, test:

```bash
curl -f http://127.0.0.1:8765/api/health
curl -f http://127.0.0.1:8765/
```

Stop the foreground uvicorn process after the smoke test.

## 6. Create The systemd User Service

Create the user systemd directory on the new VM:

```bash
mkdir -p /home/jlazo/.config/systemd/user
```

Create `/home/jlazo/.config/systemd/user/pm-gantt-chart.service`:

```ini
[Unit]
Description=PM Gantt Chart FastAPI UI - Non-Prod
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/jlazo/workspace/pm-tools/pm-gantt-chart
ExecStart=/home/jlazo/workspace/pm-tools/pm-gantt-chart/.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8765
Restart=on-failure
RestartSec=3
KillSignal=SIGINT
TimeoutStopSec=20
Environment=PYTHONUNBUFFERED=1
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pm-gantt-chart

[Install]
WantedBy=default.target
```

The important details are `WorkingDirectory` and `ExecStart`. The database path is `sqlite:///./pm_tool.db`, so the service must start from the app directory or it will create/use the wrong database file.

Enable and start the user service:

```bash
systemctl --user daemon-reload
systemctl --user enable pm-gantt-chart.service
systemctl --user start pm-gantt-chart.service
systemctl --user status pm-gantt-chart.service
```

If the service should continue running after the user logs out, enable lingering from an admin shell:

```bash
sudo loginctl enable-linger jlazo
loginctl show-user jlazo | grep Linger
```

## 7. Network And Access

The app listens on all interfaces on port `8765`.

On the new VM, confirm it is listening:

```bash
ss -ltnp | grep 8765
curl -f http://127.0.0.1:8765/api/health
```

If users access the VM directly, open the port only to the required non-prod networks:

```bash
sudo ufw allow from <allowed-cidr> to any port 8765 proto tcp
```

If the environment uses a reverse proxy or load balancer, point it to `http://<new-vm>:8765` and configure TLS/authentication there. Keep prod and non-prod hostnames distinct so users can tell which environment they are editing.

## 8. Post-Migration Validation

Run these checks on the new VM:

```bash
systemctl --user status pm-gantt-chart.service
journalctl --user -u pm-gantt-chart.service -n 100 --no-pager
curl -f http://127.0.0.1:8765/api/health
curl -f http://127.0.0.1:8765/api/projects
```

Then validate in the browser:

- The app loads at the non-prod URL.
- Existing projects are present.
- Existing teams, deliverables, milestones, dependencies, and Jira links are present.
- Creating or editing a test non-prod item persists after `systemctl --user restart pm-gantt-chart.service`.
- Jira panel health works if `.env` contains valid Jira settings: `curl -f http://127.0.0.1:8765/api/jira/health`.

## 9. Rollback Plan

Keep the current VM unchanged until non-prod validation is complete.

If the new VM has problems:

```bash
systemctl --user stop pm-gantt-chart.service
journalctl --user -u pm-gantt-chart.service -n 200 --no-pager
```

Common fixes:

- Wrong or empty data: stop the service, restore the backed-up `pm_tool.db` again, verify `WorkingDirectory`, then start the service.
- Service starts but data is missing: search for accidental databases with `find /home/jlazo -name pm_tool.db -ls`; the service may have started from the wrong directory.
- Jira returns configuration errors: verify `.env` exists in the app directory and restart the service after changes.
- Port conflict: either stop the conflicting process or change the `--port` in the systemd service and update any firewall/proxy rules.

## 10. Final Cutover Checklist

- Current VM data backed up with SQLite `.backup`.
- Backup integrity check returned `ok`.
- App code on new VM matches the intended commit or copied working tree.
- `.env` restored with correct non-prod Jira settings and permissions.
- `pm_tool.db` restored before first service startup.
- Python dependencies installed successfully.
- systemd user service enabled and running.
- Lingering enabled if the service must survive logout/reboot.
- Health endpoint, index page, and projects API return successfully.
- Browser validation confirms existing data is present.
- Firewall, reverse proxy, DNS, and access controls are configured for non-prod.