# Jira Integration — Implementation Status

Read-only Jira integration for the pm-gantt-chart UI, letting users link Jira **epics** to projects/teams and **stories** to individual Gantt tasks. Sync direction: Jira → Gantt only. Auth: shared server-side env vars (`JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`).

## Legend

- [x] Complete
- [ ] Pending
- [~] Deferred / out of scope for this iteration

---

## Phase 1 — Adapt Jira client library

- [x] `app/jira/__init__.py` — package init exporting `JiraNotConfigured` + `get_jira_credentials`.
- [x] `app/jira/auth.py` — env-only credential loader (`JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, with `JIRA_API_KEY` legacy fallback). Netskope keychain code dropped.
- [x] `app/jira/client.py` — slim `JiraClient` ported from `examples/jira_client.py`. Keeps retry/backoff, timeouts, and `/rest/api/3/search/jql` token pagination; ADF-to-text helper preserved. Cross-version `urllib3` Retry compatibility (`allowed_methods` / `method_whitelist`).
- [x] `requirements.txt` — added `requests==2.32.3`.

## Phase 2 — Persistence

- [x] `app/models.py` — new `JiraIssue`, `ProjectJiraLink`, `TaskJiraLink` tables (Python 3.8-safe typing per repo memory).
- [x] `app/schemas.py` — Pydantic v2 schemas: `JiraSearchResult`, `JiraSearchResponse`, `JiraIssueRead`, `JiraLinkCreate`, `ProjectJiraLinkRead`, `TaskJiraLinkRead`, `ProjectJiraLinksGrouped`, `JiraHealth`.
- [x] Auto-migration on startup — verified `Base.metadata.create_all` in `_ensure_v2_schema` picks up the new tables.

## Phase 3 — Service + routes

- [x] `app/jira/service.py`:
  - [x] `get_client()` — env-driven `JiraClient` factory.
  - [x] `search()`, `get_issue_by_key()`, `fetch_children()` (for the "stories under a linked epic" sidebar).
  - [x] `sync_keys()` — batched `issuekey in (...)` upsert (batch size 50).
  - [x] `link_epic_to_project()` / `link_issue_to_task()` / `unlink_*`.
  - [x] `list_project_links()` / `list_task_links()` with TTL-based lazy refresh via `JIRA_SYNC_TTL_SECONDS` (default 300s).
  - [x] `force_sync_project()` — hard refresh from the Refresh button.
- [x] `app/jira/routes.py` — `/api/jira/health`, `/api/jira/search`, `/api/jira/issues/{key}`, `/api/jira/issues/{epic_key}/children`, project-scoped `/api/projects/{id}/jira*`, task-scoped `/api/tasks/{id}/jira*`. Uniform error mapping: `JiraNotConfigured` → 503, Jira 401/403 → 502 with actionable message, Jira 404 → 404.
- [x] `app/main.py` — router registered, no other startup changes required.

## Phase 4 — Frontend (static React SPA)

- [x] `static/app.js`:
  - [x] `JiraPickerModal` — Search tab (keyword or JQL) + Paste-key tab, optional team assignment.
  - [x] `JiraProjectPanel` — linked epics grouped by team (with `null` bucket for Unassigned), status pills, per-row Unlink, panel-wide Refresh.
  - [x] `JiraEpicChildren` — on-demand collapsible sidebar hitting `/api/jira/issues/{epic}/children`.
  - [x] `JiraTaskLinks` — chip strip under the Update-task form; per-task Link/Unlink modal.
  - [x] `WorkspaceView` extended with the Jira panel and `onNotify` bridge to the shared status banner.
- [x] `static/styles.css` — `.jira-panel`, `.jira-status-pill` (todo/in-progress/done color coding), `.jira-modal*`, `.jira-chip*`, `.jira-children*`.
- [x] `static/index.html` — cache-busting bumped to `?v=20260812`.

## Phase 5 — Tooling & docs

- [x] `scripts/jira-search.py` — standalone JQL CLI using the same `JiraClient` (no `auto_ops` deps); text or `--json` output.
- [x] `skills/manage-jira/SKILL.md` — env setup, linking flows, refresh, and 401/403 troubleshooting.
- [x] `.env.example` — documents all Jira env vars (required + optional).

## Phase 6 — Tests

- [x] `tests/test_jira_service.py` — 8 unit tests covering:
  - upsert on link
  - cross-project team rejection
  - TTL triggers refresh when stale
  - TTL skips refresh when fresh
  - unlink preserves cached issue
  - task link roundtrip
  - `JiraNotConfigured` when env is missing
  - `get_client()` builds a client from env
- [x] `python3 -m pytest tests -q` → **10 passed** (2 pre-existing + 8 new).

---

## Verification checklist (manual, still to run against a real Jira tenant)

- [ ] Export `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` and hit `/api/jira/health` → `configured: true`.
- [ ] `curl "/api/jira/search?jql=project=<KEY>&limit=5"` returns issue rows.
- [ ] UI: **Link epic** → search → link → epic appears under the correct team.
- [ ] UI: **Show stories** on a linked epic renders child issues.
- [ ] UI: Update-task panel → **Link issue** → chip appears with correct status color.
- [ ] TTL refresh: wait past `JIRA_SYNC_TTL_SECONDS`, reload dashboard, `synced_at` advances.
- [ ] Bad key (`FAKE-9999`) via Paste-key → clean 404 surfaced in the modal.
- [ ] Bad creds → 502 with "check JIRA_EMAIL / JIRA_API_TOKEN" surfaced in the UI.
- [ ] `python3 scripts/jira-search.py "project = <KEY>"` prints results.

## Deferred / out of scope

- [~] Writing back to Jira (comments, status transitions, dates).
- [~] Native Jira `start_date` custom-field support — only `due_date` stored in v1 (per your decision).
- [~] Auto-creating Gantt tasks from linked epic children — the sidebar is read-only by design.
- [~] Per-user Jira tokens / OAuth 3LO — server-side shared account for now.
- [~] Background poller / webhook receiver — refresh is on-demand + TTL only.
