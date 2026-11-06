# Jira Integration — Implementation Status

Read-only Jira integration for the pm-gantt-chart UI, letting users link Jira **epics** to projects/teams and **stories** to individual Gantt deliverables. Sync direction: Jira → Gantt only. Auth: shared server-side env vars (`JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`).

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

- [x] `app/models.py` — new `JiraIssue`, `ProjectJiraLink`, `DeliverableJiraLink` tables (Python 3.8-safe typing per repo memory).
- [x] `app/schemas.py` — Pydantic v2 schemas: `JiraSearchResult`, `JiraSearchResponse`, `JiraIssueRead`, `JiraLinkCreate`, `ProjectJiraLinkRead`, `DeliverableJiraLinkRead`, `ProjectJiraLinksGrouped`, `JiraHealth`.
- [x] Auto-migration on startup — verified `Base.metadata.create_all` in `_ensure_v2_schema` picks up the new tables.

## Phase 3 — Service + routes

- [x] `app/jira/service.py`:
  - [x] `get_client()` — env-driven `JiraClient` factory.
  - [x] `search()`, `get_issue_by_key()`, `fetch_children()` (for the "stories under a linked epic" sidebar).
  - [x] `sync_keys()` — batched `issuekey in (...)` upsert (batch size 50).
  - [x] `link_epic_to_project()` / `link_issue_to_deliverable()` / `unlink_*`.
  - [x] `list_project_links()` / `list_deliverable_links()` with TTL-based lazy refresh via `JIRA_SYNC_TTL_SECONDS` (default 300s).
  - [x] `force_sync_project()` — hard refresh from the Refresh button.
- [x] `app/jira/routes.py` — `/api/jira/health`, `/api/jira/search`, `/api/jira/issues/{key}`, `/api/jira/issues/{epic_key}/children`, project-scoped `/api/projects/{id}/jira*`, deliverable-scoped `/api/deliverables/{id}/jira*`. Uniform error mapping: `JiraNotConfigured` → 503, Jira 401/403 → 502 with actionable message, Jira 404 → 404.
- [x] `app/main.py` — router registered, no other startup changes required.

## Phase 4 — Frontend (static React SPA)

- [x] `static/app.js`:
  - [x] `JiraPickerModal` — Search tab (keyword or JQL) + Paste-key tab, optional team assignment.
  - [x] `JiraProjectPanel` — linked epics grouped by team (with `null` bucket for Unassigned), status pills, per-row Unlink, panel-wide Refresh.
  - [x] `JiraEpicChildren` — on-demand collapsible sidebar hitting `/api/jira/issues/{epic}/children`.
  - [x] `JiraDeliverableLinks` — chip strip under the Update-deliverable form and inside the Gantt inline popover; per-deliverable Link/Unlink modal.
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
  - deliverable link roundtrip
  - `JiraNotConfigured` when env is missing
  - `get_client()` builds a client from env
- [x] `python3 -m pytest tests -q` → **20 passed** (12 pre-existing + 8 new; see Phase 7).

## Phase 7 — Fixes found during verification (2026-08-12)

Verification against the `netskope.atlassian.net` tenant surfaced two defects that
made every Jira lookup (e.g. `SNA-28969`) fail, plus one blind spot:

- [x] **`.env` was never loaded.** `app/jira/auth.py` reads `os.environ`, but
  `uvicorn app.main:app` only inherits the shell environment — a `.env` file was
  ignored and all Jira routes returned 503. Added `app/env.py` (stdlib loader, no
  new dependency; real env vars win) called from `app/main.py` before the Jira
  imports and from `scripts/jira-search.py`. Path is resolved from `__file__`, so it
  works regardless of the working directory uvicorn starts in.
- [x] **Keyword search couldn't find an issue key.** The picker built
  `text ~ "SNA-28969"`, which Jira never matches against keys → silent zero results.
  `static/app.js` now detects a key-shaped keyword and queries
  `issuekey = "SNA-28969"`; the empty state distinguishes "no matches" from
  "not searched yet".
- [x] **Bad credentials were indistinguishable from "no results."** Jira Cloud
  treats a bad token as anonymous: `search/jql` → `200` with zero issues,
  `GET /issue/{key}` → `404`, so the documented `502` mapping was unreachable.
  Added `JiraClient.get_myself()` (returns a real `401`) plus
  `service.check_health()`; `/api/jira/health` now reports `authenticated` and
  `account`. The UI consults it whenever a search comes back empty or a key lookup
  fails, and the Jira panel shows a persistent banner.
- [x] Tests added for the `.env` loader (quotes/comments/`export`/precedence) and
  the three `check_health` outcomes.
- [x] `static/index.html` cache-busting bumped to `?v=20260812d`.

## Phase 8 — UX updates: deliverables rename + story filtering & visibility (2026-08-13)

- [x] **`task` → `deliverable` end-to-end.** Models, schemas, services, routes, UI
  copy, and the SQLite schema. `app/main.py::_migrate_deliverable_rename()` renames
  the legacy `task*` tables/columns in place on startup (idempotent; `tasks` is
  renamed first so SQLite rewrites the child FK clauses). Covered by
  `tests/test_migration.py`. CSV headers and the `/api/dashboard` v1 alias are
  unchanged on purpose.
- [x] **Jira story status filter.** Client-side over already-fetched issues
  (`status` / `status_category` come back on every result, so toggling never
  refetches). Anything in Jira's `done` category is hidden by default; explicit
  choices persist per project in `localStorage` under
  `pm-tool.jira-status-filter.<projectId>`. New `JiraStatusFilter` chip row, shared
  `useJiraStatusFilter` state in `WorkspaceView`. `GET
  /api/jira/issues/{epic_key}/children` default `limit` raised 50 → 200 so a busy
  epic isn't truncated before filtering.
- [x] **Link stories from every deliverable surface.** `JiraPickerModal` gained a
  "From linked epics" tab (groups each linked epic's children, honors the status
  filter, marks already-linked keys). Wired into the Create panel, the Update
  panel, and — new — the Gantt inline popover.
- [x] **Optional timeline story overlay.** `Show Jira stories` toggle (persisted at
  `pm-tool.gantt-jira.<projectId>`; nothing is fetched while it's off) reads one
  bulk endpoint, `GET /api/projects/{id}/jira/deliverable-links`. Each row lists its
  stories; each story expands to its Jira relationships (blocks / is blocked by /
  relates to / parent / subtasks) parsed by `_parse_issue_links()` from the
  `raw_json` already stored by `sync_keys()` — no extra Jira calls.
- [x] New schemas: `JiraIssueLinkRef`, `JiraIssueRead.links`,
  `ProjectDeliverableJiraLinks`.
- [x] `static/styles.css` — `.jira-status-chip*`, `.jira-epic-picker*`,
  `.gantt-jira-toggle`, `.gantt-story*`; `.inline-popover` widened to 440px.
- [x] `static/index.html` cache-busting bumped to `?v=20260813a`.

---

## Phase 9 — UX updates: example workspaces, dependency picker, label linking (2026-08-13)

- [x] **Example vs. real workspaces.** New `projects.is_example` column
  (`Project.is_example`, on `ProjectCreate` / `ProjectUpdate` / `ProjectCard`).
  `app/main.py::_migrate_example_flag()` adds the column on startup and flags the
  workspaces that predate it by name (`_LEGACY_EXAMPLE_PROJECT_NAMES`: Atlas API
  Expansion, Phoenix Retail Refresh, V2 Smoke Project). `create_all` never adds
  columns, so the `ALTER TABLE` is explicit; the column check gates the backfill, so
  a workspace demoted later in the UI is never re-promoted. `seed_data()` creates the
  default workspaces with `is_example=True`.
- [x] **Split landing sections.** `LandingView` partitions on `is_example` into
  "Active project workspaces" (with a `No real workspaces yet` empty state) and
  "Example workspaces". Card markup extracted into a `ProjectCard` component; example
  cards get a dashed border and an `Example` pill. The flag is set in the
  "Onboard new project" form and stays editable in `ProjectSettingsDrawer`.
- [x] **Upstream dependencies show what's available.** The `<select multiple>` is now
  the same `.contrib-chips` toggle pattern as "Contributing teams", each chip showing
  the deliverable title and its planned window, plus an explicit
  `No other deliverables in this project yet` line. `form.dependency_ids` keeps its
  shape, so both submit handlers are unchanged. Dependencies remain
  deliverable→deliverable — no Jira dependency model.
- [x] **Link stories by Jira label.** Labels tag a project feature and live on
  stories, so the search is scoped to one Jira project (`JIRA_LABEL_PROJECT_KEY`,
  default `SNA`). New `GET /api/jira/labels` (typeahead via
  `/rest/api/3/jql/autocompletedata/suggestions`, falling back to labels derived from
  recent project issues when a tenant restricts it — reported as `source`),
  `GET /api/jira/labels/issues` (`project = ... AND labels = ...`, quote-escaped,
  reports `truncated`), and `POST /api/deliverables/{id}/jira/links/bulk`.
- [x] **Bulk linking is one round trip.** `link_issues_to_deliverable()` makes a
  single `sync_keys()` call for the whole list and returns
  `linked` / `skipped` / `not_found`. The Create panel's per-key loop in
  `create_project_deliverable` was replaced with it, so a 40-story label batch is one
  Jira fetch instead of 40.
- [x] Frontend: `JiraPickerModal` gained a `By label` tab (shown only where
  `onLinkMany` is passed) with a single `Link N stories` action that honors the shared
  status filter and reports hidden / truncated / already-linked counts. Wired through
  `JiraDeliverableLinks` (Update panel + Gantt inline popover) and `DeliverableForm`
  (pending keys linked on save).
- [x] New schemas: `JiraLabelSuggestions`, `JiraLabelSearchResponse`,
  `JiraBulkLinkCreate`, `JiraBulkLinkResult`.
- [x] `static/styles.css` — `.project-section*`, `.project-card.example`,
  `.project-example-pill`, `.checkbox-field`, `.jira-label-summary`.
- [x] `static/index.html` cache-busting bumped to `?v=20260813b`.
- [x] Tests: example-flag migration (backfill, idempotence, no re-promotion),
  `is_example` create/update/card round-trip, label JQL scoping + escaping,
  autocomplete fallback, and bulk-link linked/skipped/not-found in one fetch.

---

## Verification checklist — run 2026-08-12 against `netskope.atlassian.net`

Verified with `.venv` (Python 3.10; pydantic 2.9.2 has no cp314 wheel) on port 8010,
`JIRA_SYNC_TTL_SECONDS=15`, epic `SNA-28969`.

- [x] `.env` with `JIRA_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` → `/api/jira/health`
  returns `configured: true, authenticated: true, account: "Jocelyn Hernandez"`.
- [x] `curl "/api/jira/search?jql=issuekey = \"SNA-28969\"&limit=5"` → 1 row
  (Epic, In Progress, correct `browse/` URL).
- [x] Link epic: `POST /api/projects/1/jira/links {"jira_key":"SNA-28969","team_id":2}`
  → 201, and `GET /api/projects/1/jira` groups it under that team.
- [x] Show stories: `GET /api/jira/issues/SNA-28969/children` → 10 child issues with
  status categories (`indeterminate` / `done`).
- [x] Deliverable link: `POST /api/deliverables/2/jira/links {"jira_key":"SNA-38622"}` → 201 with
  `status_category: new` (drives the chip color).
- [x] TTL refresh: `synced_at` advanced `19:24:12` → `19:24:37` after crossing the
  TTL; `POST /api/projects/1/jira/sync` advances it on demand.
- [x] Bad key: `GET /api/jira/issues/FAKE-9999` → `404 {"detail":"Jira issue not found."}`;
  linking it → `400 "Jira issue FAKE-9999 was not found."`.
- [x] Bad creds: server started with an invalid token → health reports
  `authenticated: false` + "Jira rejected the credentials for … (check JIRA_EMAIL /
  JIRA_API_TOKEN)", which the UI surfaces. Note: `search` still returns `200`/empty
  and `issues/{key}` still `404` — Jira never sends `401` there, so the original
  "bad creds → 502" expectation was wrong; health is the reliable signal.
- [x] `python3 scripts/jira-search.py 'issuekey = "SNA-28969"'` prints the row;
  `--json` works via `parent = "SNA-28969"`.
- [ ] Browser click-through of the three UI flows (Link epic / Show stories / Link
  issue) — endpoints and request construction verified, DOM interaction not driven.

## Verification checklist — Phase 8, run 2026-08-13 against `netskope.atlassian.net`

- [x] `.venv/bin/python -m pytest tests -q` → **24 passed**; `node --check static/app.js` clean.
- [x] Fresh DB creates only `deliverable*` tables; `/api/projects` and
  `/api/projects/1/dashboard` return `deliverables` / `total_deliverables`;
  POST / PUT / DELETE on `/api/projects/1/deliverables` all work (PUT returned
  `in_progress 40 high ['Deliverable finish slipped by 4 day(s)']`).
- [x] **Migration on a real file DB.** Backed up to `/tmp/pm_tool.db.bak`, forced the
  schema back to the legacy `task*` names, restarted → all four tables and three
  columns renamed, `ix_tasks_id` dropped, 10 deliverables / 8 dependencies / 3 Jira
  links intact and still resolving. A second restart no-ops with 0 errors.
- [x] Status filter data path: epic `SNA-28969` returns **39** children
  (`Backlog`:24 `new`, `Closed`:12 `done`, `In Progress`:2, `Blocked`:1) — 12 hidden
  by default, and the raised `limit` default is what keeps all 39 in the response.
- [x] Link graph from cached `raw_json` (no extra Jira calls): `SNA-28969` parses to
  `clones SNA-26438`, `is cloned by SNA-31486`, `is blocked by DPE-19968`,
  `parent NPLAN-7849`, each with status, category, and a single-`/browse/` URL.
- [x] `GET /api/projects/1/jira/deliverable-links` returns the bulk map that backs
  the timeline overlay (deliverable 1 → SNA-37796, SNA-38622; deliverable 2 → SNA-28969).
- [ ] Browser click-through of the new flows (status chips, "From linked epics" tab,
  inline-popover linking, story overlay expand) — request construction and payloads
  verified, DOM interaction not driven.

## Verification checklist — Phase 9, run 2026-08-13 against `netskope.atlassian.net`

Run on port 8010 with `.venv` (Python 3.10). All test rows created below were deleted
afterwards; the local DB is back to 2 workspaces / 10 deliverables / 3 Jira links.

- [x] `.venv/bin/python -m pytest tests -q` → **42 passed** (24 → 42);
  `node --check static/app.js` clean.
- [x] **Migration on the real file DB.** Backed up to `/tmp/pm_tool.db.bak`, inserted a
  third `Real Work Check` project into the pre-migration schema, restarted → `is_example`
  added, `Atlas API Expansion` / `Phoenix Retail Refresh` = `1`, `Real Work Check` = `0`.
  A second restart no-ops (0 errors in the log, flags unchanged).
- [x] `PUT /api/projects/1 {"is_example": false}` → flag clears with name, description,
  and color intact; `true` restores it. `POST /api/projects` honors the flag both ways
  and defaults to `false`.
- [x] `GET /api/jira/labels?query=pay` → `{"project_key": "SNA", "labels":
  ["payload-capture"], "source": "suggestions"}` — the autocomplete endpoint is
  available on this tenant, so the derive-from-issues fallback is covered by unit test.
- [x] `GET /api/jira/labels/issues?label=CVE-2020-0601` → 11 SNA stories with status
  categories, `truncated: false`; `&limit=1` → `truncated: true`;
  `&project_key=DPE` → 0 rows, confirming the search is genuinely project-scoped.
  Omitting `label` → `422`.
- [x] `POST /api/deliverables/2/jira/links/bulk` with
  `["SNA-34045","SNA-25208","SNA-31019"]` → `linked` the first two, `skipped` the
  already-linked third; `FAKE-1` comes back in `not_found`; re-running returns
  everything as `skipped`. Empty `jira_keys` is a no-op with no Jira call; an unknown
  deliverable → `400`.
- [x] Create-with-keys path: `POST /api/projects/1/deliverables` with three
  `jira_keys` returned a deliverable already carrying all three links — one batched
  `sync_keys()` call instead of one request per key.
- [x] Served assets are the busted versions (`?v=20260813b`, 200) and carry the new
  copy (`Active project workspaces`, `Example workspaces`,
  `No other deliverables in this project yet`, `By label`,
  `This is an example workspace`). A fresh project returns `[]` deliverables, which is
  the condition the dependency empty state renders on.
- [ ] Browser click-through (landing sections + pills, onboard/edit toggle moving a
  workspace between sections, dependency chips, `By label` → `Link N stories` from both
  the Update panel and the Gantt popover) — endpoints, payloads, and served markup
  verified, DOM interaction not driven.

## Phase 10 — UX updates: on-demand progress, real quick-edit modal, fading toasts (2026-08-13)

Frontend only — no schema, service, or route change. `GET /api/deliverables/{id}/jira`
already returns every link with its issue `status` / `status_category`, which is all the
recalculation needs.

- [x] **Progress % can be re-derived any time.** The `By label` prefill only fires at
  link time, so a deliverable's number went stale as soon as its stories moved in Jira.
  New `progressFromDeliverableLinks()` (fetches the deliverable's links fresh on every
  click, so it picks up Jira movement) feeding a shared `RecalcProgressButton`, rendered
  under the Progress % input in **both** the Update-deliverable panel and the timeline
  quick-edit. Same share-underway formula as the prefill — `progressFromIssues()`,
  unchanged — and the same denominator: every linked story counts, Done included. The
  button fills the still-editable field and says `save to apply`; it never writes to the
  server itself. Zero links reports an explicit "nothing to recalculate" message.
- [x] **The quick-edit is a real modal.** `InlineEditPopover` was an
  in-row `position: absolute` element, so it stretched the timeline row, scrolled with
  the chart, and fought the grid for width. It now `createPortal`s to `<body>` with the
  same backdrop/panel markup as `JiraPickerModal` (`.jira-modal-backdrop.inline-modal-backdrop`
  / `.jira-modal.inline-modal`, `overscroll-behavior: contain` so wheeling the story list
  leaves the timeline alone). Backdrop click, `Close`, and `Esc` all dismiss; the Esc
  handler ignores the key while a story picker is open above it (that picker is portalled
  too, so a document-level listener would otherwise close the editor underneath it). The
  render moved out of `GanttRow` — whose `inlineControls` prop is gone — into a single
  instance in `GanttChart`, since only one deliverable is ever edited.
- [x] **Notifications fade.** The old `.status-banner` was driven by `message` state that
  nothing ever cleared, so "Deliverable created." sat at the top of the page for the rest
  of the session and pushed the layout down. Replaced by one `toast` state
  (`{id, text, tone, leaving}`, monotonic `id` so a new message restarts the timer):
  auto-dismiss at 3.5s, errors at 8s, click to dismiss early, `toast-out` fade before
  unmount (`TOAST_FADE_MS` is kept in step with the CSS animation). Fixed position at
  top-right above both modal layers, so it no longer shifts the page. `onNotify(text, tone)`
  keeps its signature — every caller (drawers, Jira panel, pickers) is untouched.
- [x] `static/styles.css` — `.toast*` + `toast-in` / `toast-out` keyframes with a
  `prefers-reduced-motion` fallback, `.inline-modal*` replacing `.inline-popover`,
  `.recalc-progress`.
- [x] `static/index.html` cache-busting bumped to `?v=20260813d`.

## Verification checklist — Phase 10, run 2026-08-13 against `netskope.atlassian.net`

Run on port 8010 with `.venv` (Python 3.10). All test links created below were removed
afterwards; the DB is back to 3 Jira links (deliverable 1 → SNA-37796, SNA-38622;
deliverable 2 → SNA-28969).

- [x] `node --check static/app.js` clean; `.venv/bin/python -m pytest tests -q` →
  **52 passed** (unchanged — the change is frontend-only).
- [x] Recalculation math checked by evaluating the shipped `progressFromIssues` /
  `isInProgressIssue` straight out of `static/app.js` against the live API: deliverable 1
  (Blocked + Backlog) → **50%**, deliverable 2 (In Progress) → **100%**, deliverable 3
  (no links) → the empty-state message path.
- [x] **Done counts in the denominator, not the numerator.** Bulk-linked 2 Closed stories
  (`SNA-35902`, `SNA-35958`) plus 1 Blocked (`SNA-37796`) to deliverable 3 → **33%**
  (1 of 3), then unlinked all three (`204` each, `GET .../jira` → `[]`).
- [x] Served assets are the busted versions (`?v=20260813d` → 200 for both `app.js` and
  `styles.css`, and `GET /` carries the new query strings); the served `app.js` contains
  `RecalcProgressButton`.
- [ ] Browser click-through (Recalculate in the Update panel then `Save update`;
  bar click → centered modal over a dimmed backdrop with the timeline row keeping its
  height, internal scrolling, backdrop / Close / Esc dismiss, `Link story` picker stacking
  above it; create + update a deliverable and watch the toasts fade) — endpoints, math,
  and served markup verified, DOM interaction not driven.

## Phase: Search upgrade (10/page, JQL chips, SNA default, multi-select)

- [x] "Pick Jira story" → "Select Jira stories" (`static/app.js`, `SKILL.md`).
- [x] `GET /api/jira/search` defaults to `limit=10` and accepts `next_page_token`;
  `scripts/jira-search.py` gets `--page-token` and a 10 default. Two service tests added.
- [x] Picker: 10 per page everywhere (Search = token stack, Label/Epics = client-side).
- [x] Search tab chips (`project = SNA/PESRE`, `issueType = Epic/Story`), SNA on by default,
  persisted in localStorage (`pm-tool.jira-search-chips`); chips AND with keyword/JQL.
- [x] Multi-select with cross-page selection and **Link N selected** (reuses the existing
  `/jira/links/bulk` endpoint). Epic→project picker stays single-link.
- [ ] Browser click-through not yet driven (needs live Jira): paging, chip toggle re-search,
  select across pages then bulk link.

## Phase: Deliverable Jira labels

- [x] `deliverables.jira_label`, `jira_label_project_key`, `jira_label_from`, `jira_label_to`
  (nullable; `_migrate_jira_label` adds them in place). Label trimmed, blank → null,
  `from <= to` enforced.
- [x] `GET /api/jira/labels/issues`: date window (parent epic dates → story due date →
  undated), up to 500 results, `labels`/`epic_*`/`effective_*`/`linked_in` per story.
  Optional `JIRA_EPIC_START_FIELD` for the tenant's epic start-date field.
- [x] `POST /api/projects/{id}/jira/label-sync`: surface-only "N new" counts, per-deliverable
  TTL throttle, soft failure.
- [x] Picker: quarter control, row list with New / Linked here / Linked to pills,
  **Link selected (N)**, **Set as deliverable label**; form label chip; roster badge;
  triggers on workspace open, label save, tab refocus, deliverable open and a manual button.
- [ ] Browser click-through not yet driven (needs live Jira).
- [~] Optional interval auto-check and a server-side scheduler — not built.

## Deferred / out of scope

- [~] Writing back to Jira (comments, status transitions, dates).
- [~] Native Jira `start_date` custom-field support — only `due_date` stored in v1 (per your decision).
- [~] Auto-creating Gantt deliverables from linked epic children — the sidebar is read-only by design.
- [~] Per-user Jira tokens / OAuth 3LO — server-side shared account for now.
- [~] Background poller / webhook receiver — refresh is on-demand + TTL only.
