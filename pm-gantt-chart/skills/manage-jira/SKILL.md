---
name: manage-jira
description: Link Jira epics and stories to the pm-gantt-chart timeline. Use this skill whenever the user wants to connect Jira issues to a Gantt project, team, or project deliverable; refresh Jira status/dates; troubleshoot 401/403 errors from the Jira integration; or run JQL from the command line via `scripts/jira-search.py`.
---

# manage-jira — Jira integration workflow

The pm-gantt-chart app pulls Jira epics/stories via a read-only integration. Credentials are shared across the app via env vars; each user of the UI sees whatever the configured Jira account can see.

## Step 1 — Set env vars

Put the three required vars (Atlassian Cloud API token) in `pm-gantt-chart/.env`,
which the app loads on startup — copy `.env.example` as a starting point:

```bash
JIRA_URL=https://<your-domain>.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=<atlassian-api-token>
```

Shell exports also work and take precedence over `.env`:

```bash
export JIRA_URL="https://<your-domain>.atlassian.net"
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="<atlassian-api-token>"
```

Either way, **restart uvicorn after changing credentials** — they are read from
the server process environment.

Optional:
- `JIRA_SYNC_TTL_SECONDS` — freshness window for cached issues (default `300`).
- `JIRA_DISABLE_SSL_VERIFY=1` — only if you sit behind a TLS-intercepting proxy.

Generate a token at https://id.atlassian.com/manage-profile/security/api-tokens.

Verify:

```bash
curl -s http://localhost:8001/api/jira/health | python3 -m json.tool
```

Expected when everything works:

```json
{"configured": true, "authenticated": true, "account": "Your Name", "url": "https://<your-domain>.atlassian.net", "detail": null}
```

- `configured: false` → the server never saw the vars: check `.env` sits in
  `pm-gantt-chart/` (next to `requirements.txt`) and restart uvicorn.
- `configured: true, authenticated: false` → the token or email is wrong; `detail`
  says which vars to check. This is the only endpoint that detects a bad token:
  Jira Cloud answers searches anonymously (`200` with zero issues) and issue reads
  with `404`, so elsewhere bad credentials just look like "nothing found".

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
2. Scroll to the **Link Teams to Jira Work Items** panel.
3. Click **Link epic**.
4. Choose a team (optional) so the epic is grouped under that team's row.
5. Either search with a keyword / JQL, or paste an epic key on the "Search by Jira Ticket ID" tab.
6. Click **Link** on the row.

Programmatic equivalent:

```bash
curl -sX POST http://localhost:8001/api/projects/1/jira/links \
  -H 'content-type: application/json' \
  -d '{"jira_key": "ABC-123", "team_id": 4}'
```

## Step 4 — Link stories to individual project deliverables

Three surfaces do the same thing; pick whichever is closest to hand:

- **Update deliverable** panel — pick a deliverable, then click **Link story** in
  the Jira-stories section.
- **Create deliverable** panel — **Pick Jira story** queues keys that are linked
  automatically once the deliverable is saved.
- **Timeline** — click a deliverable bar and use the **Jira stories** section in
  the quick-edit popover.

In every picker, the **From linked epics** tab lists the stories under the
project's linked epics (honoring the status filter and marking keys already
linked); **Search** and **Search by Jira Ticket ID** work as before.

Programmatic:

```bash
curl -sX POST http://localhost:8001/api/deliverables/17/jira/links \
  -H 'content-type: application/json' \
  -d '{"jira_key": "ABC-456"}'
```

## Step 5 — Refresh cached data

- Cached issue metadata (status, summary, assignee, due date) is refreshed on-load once older than `JIRA_SYNC_TTL_SECONDS`.
- Click **Refresh** in the **Link Teams to Jira Work Items** panel to force a project-wide sync.
- Or hit `POST /api/projects/{id}/jira/sync`.

## Step 6 — See stories under a linked epic

Every linked epic exposes a **Show stories** toggle in the panel. It calls `/api/jira/issues/{EPIC-KEY}/children` and lists stories with status pills. Nothing is written back — this is a read-only sidebar. To connect a story to a deliverable, use Step 4 with the story's key.

Stories in Jira's `done` category (Closed, Done, Resolved) are hidden by default.
The **Story status** chip row toggles each status; the choice is remembered per
project in `localStorage`.

## Step 7 — See linked stories on the timeline

Tick **Show Jira stories** in the timeline toolbar. Each deliverable row then
lists its linked stories, and expanding a story (`+`) shows that story's Jira
relationships — blocks / is blocked by / relates to / parent / subtasks. The
whole overlay is one request, `GET /api/projects/{id}/jira/deliverable-links`,
served from cached issue data, and nothing is fetched while the toggle is off.
The toggle state persists per project.

## Step 8 — Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `503 Missing Jira env vars` | `.env` missing/elsewhere, or uvicorn started before the vars existed | put `.env` in `pm-gantt-chart/`, restart uvicorn |
| `502 Jira rejected the request` | Expired or wrong token/email | Regenerate token at Atlassian, update `.env`, restart |
| Search returns nothing for a key that exists | Bad token — Jira answered anonymously | check `/api/jira/health` for `authenticated: false` |
| Keyword search finds nothing for `ABC-123` | `text ~` doesn't index issue keys | the UI now auto-switches to `issuekey = "ABC-123"`; in the CLI, query `issuekey = "ABC-123"` |
| `404 Jira issue not found` | Typo in key, issue in another site, or bad token | Confirm key exists via `scripts/jira-search.py 'issuekey = "ABC-123"'` |
| Stories don't appear under an epic | Jira uses a non-standard parent link | Confirm `parent = "EPIC-KEY"` returns rows in the CLI |
| Timeout / connect errors | Atlassian edge incident | Retry; client backs off 0/3/6/12s automatically |

## Out of scope

- Writing back to Jira (comments, transitions, updates). Everything is read-only.
- OAuth / per-user tokens — planned but not implemented.
- Webhook receiver / background polling — not implemented.
