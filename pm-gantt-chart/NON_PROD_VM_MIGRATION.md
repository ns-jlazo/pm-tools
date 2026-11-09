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

Expected: `LISTEN 0.0.0.0:8765` owned by the uvicorn `python` process, and HTTP 200 from the health endpoint.

### 7.1 This VM Is Reachable Only Through Teleport

Passing the checks above does **not** mean users can reach the app. On `pm-tools-01.iad0.netskope.com` (`10.38.12.54`), all access is brokered by Teleport. Verified on the VM:

- No host firewall of any kind: `ufw` is not installed, `iptables -S` has only `ACCEPT` policies with zero rules, the `nft` ruleset is empty, and `firewalld` is inactive.
- Teleport Enterprise v18.8.0 agent is `active` and `enabled`, joined to `teleport-iad0.netskope.io:443`, with `ssh_service` on `0.0.0.0:3022`.

From a laptop on the VPN, `ping 10.38.12.54`, `nc -z 10.38.12.54 8765`, and `nc -z 10.38.12.54 22` all fail, and `pm-tools-01.iad0.netskope.com` does not resolve on a non-corporate resolver. SSH still works because `~/.ssh/config` tunnels through Teleport:

```
Host pm-tools-01.iad0
  HostName pm-tools-01.iad0.netskope.com
  ProxyCommand /usr/local/bin/tsh proxy ssh --cluster=iad0 --proxy=teleport.netskope.io:443 %r@%h:%p
```

Consequences for this runbook:

- **Do not add a host firewall rule to "open" port 8765.** There is no firewall closing it. An earlier version of this step suggested `sudo ufw allow ... port 8765`; that command is wrong for this VM. `ufw` is not installed, so it would require an install, and enabling `ufw` defaults to denying inbound — which would break Teleport SSH on port 3022 and lock everyone out of the box.
- `http://10.38.12.54:8765` and `http://pm-tools-01.iad0.netskope.com:8765` will not work from a laptop and cannot be handed to coworkers.
- The app has no authentication of its own. Anyone who can route to port 8765 can edit non-prod data, so put authentication in front of it as part of exposing it.

### 7.2 Option A: Register As A Teleport Application (recommended for handover)

This is the only option that gives coworkers a plain URL with SSO, requires no VPN routing changes, and reuses the agent already running on the VM.

Prerequisites to confirm with the Teleport/infra owners **before** editing config — `tsh apps ls --cluster=iad0` currently returns zero apps, so this VM would be the first application registered on the `iad0` leaf cluster:

1. Whether the `iad0` proxy has wildcard DNS and a matching TLS cert for app access. In the root `commercial` cluster, 76 of 106 apps use `*.apps.netskope.io`; the leaf's equivalent domain is unconfirmed and determines the correct `public_addr`.
2. Which Teleport role grants coworkers access. Access is matched via `app_labels`, so an existing role needs to cover the labels below, or a new role needs to be granted to the intended users.

Back up the config first. Teleport is the only access path to this VM, so a bad edit that stops the agent locks you out with no fallback:

```bash
# Timestamped history, plus a fixed path the auto-revert below can rely on.
sudo cp /etc/teleport.yaml /etc/teleport.yaml.bak.$(date +%Y%m%d-%H%M%S)
sudo cp /etc/teleport.yaml /etc/teleport.yaml.known-good
```

Change the existing `app_service` block in `/etc/teleport.yaml` from `enabled: no` to:

```yaml
app_service:
  enabled: yes
  apps:
    - name: pm-gantt-chart-nonprod
      description: "PM Gantt Chart - Non-Prod"
      uri: http://127.0.0.1:8765
      # public_addr must match the iad0 proxy's app-access wildcard domain.
      # Confirm the correct domain before setting this.
      public_addr: pm-gantt-chart-nonprod.<iad0-app-domain>
      labels:
        ns_env: "npe"
        app: "pm-gantt-chart"
```

Validate the YAML parses before reloading:

```bash
sudo python3 -c "import yaml,sys; yaml.safe_load(open('/etc/teleport.yaml')); print('yaml ok')"
```

Open a second Teleport SSH session as a safety net, then optionally arm a timed auto-revert so a failed agent cannot strand you:

```bash
# Reverts config and reloads in 5 minutes unless cancelled.
sudo systemd-run --on-active=300 --unit=teleport-autorevert --collect \
  /bin/sh -c 'cp /etc/teleport.yaml.known-good /etc/teleport.yaml && systemctl reload teleport'
```

Reload the agent. The unit defines `ExecReload` as `SIGHUP`, which is a graceful reload and does not drop in-flight SSH sessions:

```bash
sudo systemctl reload teleport
systemctl is-active teleport
journalctl -u teleport -n 50 --no-pager
```

Cancel the auto-revert once the agent is healthy and the app is registered:

```bash
sudo systemctl stop teleport-autorevert.timer 2>/dev/null; sudo systemctl reset-failed teleport-autorevert.timer 2>/dev/null
```

Verify from a laptop:

```bash
tsh login --proxy=teleport.netskope.io:443
tsh apps ls --cluster=iad0
```

The app should appear with its public address. Coworkers then reach it in a browser at that address after `tsh login`, authenticated by SSO with no port forwarding.

Optional hardening once Teleport fronts the app: because `uri` points at `http://127.0.0.1:8765`, the app no longer needs to listen on all interfaces. Change `--host 0.0.0.0` to `--host 127.0.0.1` in the systemd unit from step 6 and restart the service. Skip this if you also want Option B to work.

### 7.3 Option B: Request Direct Network Access

Only if a routable URL is required instead of Teleport app access. This needs a netops change, not a change on the VM:

- Route and permit the VPN client pool (a laptop on the VPN gets an address in `10.60.150.0/23` on `utun0`) to `10.38.12.54:8765`.
- Add a DNS record resolvable by clients, or have users hit the IP.

Note that there is still no host firewall to open, and the app still has no authentication, so pair this with Option C.

### 7.4 Option C: Reverse Proxy Or Load Balancer

Point a proxy or LB at `http://<new-vm>:8765` and terminate TLS and authentication there. This complements Option B rather than replacing it, since the proxy itself must be able to route to the VM. Keep prod and non-prod hostnames distinct so users can tell which environment they are editing.

### 7.5 Interim Single-User Access

Adequate for your own validation in step 8, but it does not scale to coworkers — each person needs their own tunnel and Teleport access to the VM:

```bash
ssh -L 8765:localhost:8765 pm-tools-01.iad0
# then browse http://localhost:8765
```

If a host firewall is ever added to this VM, allow Teleport SSH on `3022` and OpenSSH on `22` in the same change, or you will lose access to the box.

## 8. Post-Migration Validation

Run these checks on the new VM:

```bash
systemctl --user status pm-gantt-chart.service
journalctl --user -u pm-gantt-chart.service -n 100 --no-pager
curl -f http://127.0.0.1:8765/api/health
curl -f http://127.0.0.1:8765/api/projects
```

Then validate in the browser. Reach the app using whichever access path you configured in step 7; a direct `http://10.38.12.54:8765` URL will not work from a laptop.

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
- Port conflict: either stop the conflicting process or change the `--port` in the systemd service, then update the Teleport app `uri` (step 7.2) or any proxy rules to match.
- App unreachable from a browser but `curl http://127.0.0.1:8765/api/health` returns 200 on the VM: this is an access-path problem, not an app problem. See step 7.1 before changing anything on the VM.

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
- Access path configured for non-prod per step 7, and confirmed working from another person's laptop, not just via your own port forward.
- Authentication is in front of the app before handing the URL to coworkers.