---
name: manage-jira
description: Link Jira epics and stories to the pm-gantt-chart timeline. Use this skill whenever the user wants to connect Jira issues to a Gantt project, team, or task; refresh Jira status/dates; troubleshoot 401/403 errors from the Jira integration; or run JQL from the command line via `scripts/jira-search.py`.
---

# manage-jira — Jira integration workflow

The pm-gantt-chart app pulls Jira epics/stories via a read-only integration. Credentials are shared across the app via env vars; each user of the UI sees whatever the configured Jira account can see.

## Step 1 — Set env vars

Export the three required vars (Atlassian Cloud API token):

```bash
export JIRA_URL="https://<your-domain>.atlassian.net"
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="<atlassian-api-token>"
```

Optional:
- `JIRA_SYNC_TTL_SECONDS` — freshness window for cached issues (default `300`).
- `JIRA_DISABLE_SSL_VERIFY=1` — only if you sit behind a TLS-intercepting proxy.

Generate a token at https://id.atlassian.com/manage-profile/security/api-tokens.

Verify:

```bash
curl -s http://localhost:8001/api/jira/health | python3 -m json.tool
```

`configured: true` → good. `configured: false` → check env vars are exported in the same shell that runs uvicorn.

## Step 2 — Sanity check with the CLI

```bash
python3 scripts/jira-search.py "project = <PROJECTKEY> AND issuetype = Epic ORDER BY updated DESC"
```

- Prints keys, statuses, summaries.
- Add `--json` for machine-readable output.
- 401/403 → token is expired or the email doesn't match; regenerate the token.
- Timeouts → check network / VPN; the client retries 4× with exponential backoff.

## Step 3 — Link epics to a project

In the UI:
1. Open a project workspace.
2. Scroll to the **Jira epics** panel.
3. Click **Link epic**.
4. Choose a team (optional) so the epic is grouped under that team's row.
5. Either search with a keyword / JQL, or paste an epic key on the "Paste key" tab.
6. Click **Link** on the row.

Programmatic equivalent:

```bash
curl -sX POST http://localhost:8001/api/projects/1/jira/links \
  -H 'content-type: application/json' \
  -d '{"jira_key": "ABC-123", "team_id": 4}'
```

## Step 4 — Link stories to individual tasks

1. Open the **Update task** panel and pick a task.
2. Under the form, click **Link issue** in the Jira-issues section.
3. Search or paste-key exactly like the epic flow.

Programmatic:

```bash
curl -sX POST http://localhost:8001/api/tasks/17/jira/links \
  -H 'content-type: application/json' \
  -d '{"jira_key": "ABC-456"}'
```

## Step 5 — Refresh cached data

- Cached issue metadata (status, summary, assignee, due date) is refreshed on-load once older than `JIRA_SYNC_TTL_SECONDS`.
- Click **Refresh** in the Jira epics panel to force a project-wide sync.
- Or hit `POST /api/projects/{id}/jira/sync`.

## Step 6 — See stories under a linked epic

Every linked epic exposes a **Show stories** toggle in the panel. It calls `/api/jira/issues/{EPIC-KEY}/children` and lists stories with status pills. Nothing is written back — this is a read-only sidebar. To connect a story to a Gantt task, use Step 4 with the story's key.

## Step 7 — Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `503 Missing Jira env vars` | uvicorn didn't inherit the export | export vars in the same shell before starting uvicorn |
| `502 Jira rejected the request` | Expired or wrong token/email | Regenerate token at Atlassian, re-export, restart |
| `404 Jira issue not found` | Typo in key or issue in another site | Confirm key exists via `scripts/jira-search.py "key = ABC-123"` |
| Stories don't appear under an epic | Jira uses a non-standard parent link | Confirm `parent = "EPIC-KEY"` returns rows in the CLI |
| Timeout / connect errors | Atlassian edge incident | Retry; client backs off 0/3/6/12s automatically |

## Out of scope

- Writing back to Jira (comments, transitions, updates). Everything is read-only.
- OAuth / per-user tokens — planned but not implemented.
- Webhook receiver / background polling — not implemented.
