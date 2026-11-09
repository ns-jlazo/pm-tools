import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import { createPortal } from "https://esm.sh/react-dom@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";

// htm passes '' for <> fragments; React 18 requires React.Fragment
const html = htm.bind((type, props, ...children) =>
  React.createElement(type || React.Fragment, props, ...children)
);
const STATUS_OPTIONS = ["planned", "in_progress", "blocked", "done"];
// Keep in step with the `.toast.leaving` animation in styles.css.
const TOAST_FADE_MS = 400;
const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const STATUS_FILTER_PREFIX = "pm-tool.jira-status-filter.";
const DEFAULT_PROJECT = {
  name: "",
  description: "",
  color: "#1d4ed8",
  is_example: false,
  release_name: "Release 1",
  release_date: "",
};
// A named date drawn on the timeline beside the release marker.
const DEFAULT_KEY_DATE = {
  name: "",
  color: "#7c3aed",
  event_date: "",
};
const DEFAULT_DELIVERABLE = {
  title: "",
  description: "",
  team_id: "",
  planned_start: "",
  planned_end: "",
  current_start: "",
  current_end: "",
  status: "planned",
  progress: 0,
  dependency_ids: [],
  contributor_team_ids: [],
  jira_keys: [],
  jira_label: "",
  jira_label_project_key: "",
  jira_label_from: "",
  jira_label_to: "",
};
// A milestone is a piece of a deliverable: one target date instead of a
// planned/current window, and no dependencies or contributing teams.
const DEFAULT_MILESTONE = {
  title: "",
  description: "",
  team_id: "",
  target_date: "",
  actual_date: "",
  status: "planned",
  progress: 0,
  jira_keys: [],
};

function api(path, options = {}) {
  return fetch(path, {
    headers: {
      Accept: "application/json",
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
    ...options,
  }).then(async (response) => {
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      // A non-JSON body (proxy error, unhandled server crash) leaves us with
      // nothing to show, so fall back to the status instead of "Request failed".
      throw new Error(
        payload.detail || `Request failed: ${response.status} ${response.statusText}`.trim()
      );
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  });
}

// Takes an ISO date string from the API or a Date that is already local, so the
// timeline helpers can be handed either without every caller re-parsing.
function startOfDay(value) {
  if (value instanceof Date) {
    const next = new Date(value);
    next.setHours(0, 0, 0, 0);
    return next;
  }
  return new Date(`${value}T00:00:00`);
}

// Calendar quarters, as ISO dates (local — toISOString would shift the day).
function isoDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function quarterRange(year, quarter) {
  const firstMonth = (quarter - 1) * 3;
  return {
    from: isoDate(new Date(year, firstMonth, 1)),
    to: isoDate(new Date(year, firstMonth + 3, 0)),
  };
}

// "Q3 2026" for an ISO date, "" when there is none.
function quarterOf(value) {
  if (!value) return "";
  const date = startOfDay(value);
  return `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
}

// The window a saved from/to pair represents, for the picker's quarter control.
function quarterSelection(from, to) {
  if (!from && !to) return { mode: "all", year: new Date().getFullYear(), quarter: 0 };
  for (let quarter = 1; quarter <= 4; quarter += 1) {
    const year = from ? startOfDay(from).getFullYear() : new Date().getFullYear();
    const range = quarterRange(year, quarter);
    if (range.from === from && range.to === to) return { mode: "quarter", year, quarter };
  }
  return { mode: "custom", year: new Date().getFullYear(), quarter: 0 };
}

function differenceInDays(start, end) {
  return Math.round((end - start) / 86400000);
}

function addDays(dateValue, amount) {
  const next = new Date(dateValue);
  next.setDate(next.getDate() + amount);
  return next;
}

// Monday-based, so a week column always covers Monday through Sunday.
function startOfWeek(dateValue) {
  const next = startOfDay(dateValue);
  next.setDate(next.getDate() - ((next.getDay() + 6) % 7));
  return next;
}

function formatDisplayDate(value) {
  const dateValue = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(dateValue);
}

// A release date is read on its own, away from the timeline's day columns, so
// unlike `formatDisplayDate` it has to carry the year.
function formatReleaseDate(value) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(startOfDay(value));
}

function humanizeStatus(status) {
  return status.replaceAll("_", " ");
}

// A bad token looks exactly like "nothing matched": Jira answers searches
// anonymously with zero rows and issue reads with a 404. Ask the health
// endpoint (which probes /myself) so we can say what actually went wrong.
async function jiraTrouble() {
  try {
    const health = await api("/api/jira/health");
    if (!health.configured) {
      return health.detail || "Jira is not configured on the server.";
    }
    if (!health.authenticated) {
      return health.detail || "Jira rejected the server credentials.";
    }
  } catch (err) {
    return `Could not reach the Jira health check: ${err.message}`;
  }
  return "";
}

// Report what failed *and* whether Jira itself is the reason. `jiraTrouble`
// alone used to replace the real error, hiding e.g. a rejected JQL string.
async function describeJiraFailure(err) {
  const reason = (err && err.message) || "The request failed.";
  const trouble = await jiraTrouble();
  return trouble ? `${reason} (${trouble})` : reason;
}

function jiraStatusClass(category) {
  const key = (category || "").toLowerCase();
  if (key === "done") return "jira-status-pill done";
  if (key === "indeterminate" || key === "in-progress") return "jira-status-pill in-progress";
  return "jira-status-pill todo";
}

// Work that has started. Jira's `indeterminate` category is the primary signal
// — a workflow puts In Progress, Blocked, Scoping and Waiting for Customer
// there — and the name list catches a workflow that files one of those under
// To Do instead.
const IN_PROGRESS_STATUS_NAMES = new Set([
  "in progress",
  "blocked",
  "scoping",
  "waiting for customer",
]);

function isInProgressIssue(issue) {
  if (!issue) return false;
  if ((issue.status_category || "").toLowerCase() === "indeterminate") return true;
  return IN_PROGRESS_STATUS_NAMES.has((issue.status || "").trim().toLowerCase());
}

// Share of stories that are underway, for seeding a deliverable's progress from
// a Jira label search. Counts every story found, whatever its status.
function progressFromIssues(issues) {
  const all = issues || [];
  if (!all.length) return null;
  return Math.round((all.filter(isInProgressIssue).length / all.length) * 100);
}

// Deliverables and milestones both own Jira links, on endpoints that differ only
// in this path segment. Everything that reads or links stories takes the scope so
// one component can serve both.
const WORK_ITEM_SCOPES = {
  deliverables: { noun: "deliverable", label: "deliverable" },
  milestones: { noun: "milestone", label: "milestone" },
};

function scopeNoun(scope) {
  return (WORK_ITEM_SCOPES[scope] || WORK_ITEM_SCOPES.deliverables).noun;
}

// Progress from the stories linked to a saved work item *right now*. Same
// share-underway formula and the same denominator as the label prefill: every
// linked story counts, Done included.
async function progressFromWorkItemLinks(scope, itemId) {
  const links = await api(`/api/${scope}/${itemId}/jira`);
  return {
    total: links.length,
    progress: progressFromIssues(links.map((link) => link.issue)),
  };
}

function readStored(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Private mode or a full quota: the preference just won't survive a reload.
  }
}

// Shared Jira story status filter for one project. `overrides` holds only the
// statuses the user has explicitly toggled, so anything in Jira's `done`
// category is hidden with zero clicks and a status that shows up later still
// inherits that default.
// Surface-only label check: asks the server which labelled deliverables have
// Jira stories that are not linked yet. It never links anything; the badge it
// feeds just opens the picker. The server throttles by JIRA_SYNC_TTL_SECONDS, and
// every failure is soft — a missing Jira config must not break the app.
const LABEL_SYNC_REFOCUS_MS = 60 * 1000;

function useLabelSync(projectId, onMessage) {
  const [byDeliverable, setByDeliverable] = useState({});
  const [checking, setChecking] = useState(false);
  const lastRun = useRef(0);

  const run = async ({ force = false, deliverableId = null, announce = false } = {}) => {
    if (!projectId) return;
    lastRun.current = Date.now();
    setChecking(true);
    try {
      const query =
        `force=${force ? "true" : "false"}` + (deliverableId ? `&deliverable_id=${deliverableId}` : "");
      const payload = await api(`/api/projects/${projectId}/jira/label-sync?${query}`, {
        method: "POST",
      });
      if (payload.error) {
        if (announce) onMessage(payload.error, "error");
        return;
      }
      setByDeliverable((current) => {
        // A whole-project run is authoritative (labels may have been removed); a
        // single-deliverable run only updates its own entry.
        const next = deliverableId ? { ...current } : {};
        for (const item of payload.results || []) next[item.deliverable_id] = item;
        return next;
      });
      if (announce) {
        const total = (payload.results || []).reduce((sum, item) => sum + item.new_count, 0);
        onMessage(
          total
            ? `${total} new Jira ${total === 1 ? "story" : "stories"} found for labelled deliverables.`
            : "No new Jira stories for labelled deliverables.",
          "success"
        );
      }
    } catch (err) {
      if (announce) onMessage(err.message, "error");
    } finally {
      setChecking(false);
    }
  };

  // On opening a project the dashboard has already rendered; the badges fill
  // in when this resolves.
  useEffect(() => {
    setByDeliverable({});
    run();
  }, [projectId]);

  // People leave a project open all day: re-check when the tab comes back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRun.current > LABEL_SYNC_REFOCUS_MS) {
        run();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [projectId]);

  return { byDeliverable, checking, run };
}

function useJiraStatusFilter(projectId) {
  const storageKey = `${STATUS_FILTER_PREFIX}${projectId}`;
  const [overrides, setOverrides] = useState(() => readStored(storageKey, {}));
  // Discovered statuses, name -> status category, fed by every loader.
  const [statuses, setStatuses] = useState({});

  useEffect(() => {
    setOverrides(readStored(`${STATUS_FILTER_PREFIX}${projectId}`, {}));
    setStatuses({});
  }, [projectId]);

  const isVisible = (issue) => {
    const status = issue && issue.status;
    if (!status) return true;
    const override = overrides[status];
    return override === undefined ? (issue.status_category || "") !== "done" : override;
  };

  const registerStatuses = (issues) => {
    setStatuses((current) => {
      let next = current;
      for (const issue of issues || []) {
        if (!issue || !issue.status || next[issue.status] !== undefined) continue;
        if (next === current) next = { ...current };
        next[issue.status] = issue.status_category || "";
      }
      return next;
    });
  };

  const toggle = (status) => {
    const category = statuses[status] || "";
    const visible = isVisible({ status, status_category: category });
    const next = { ...overrides, [status]: !visible };
    writeStored(storageKey, next);
    setOverrides(next);
  };

  const apply = (issues) => (issues || []).filter(isVisible);

  return { statuses, isVisible, registerStatuses, toggle, apply };
}

function JiraStatusFilter({ filter, issues, compact }) {
  const names = Object.keys(filter.statuses).sort();
  if (!names.length) return null;

  const counts = {};
  for (const issue of issues || []) {
    if (issue && issue.status) counts[issue.status] = (counts[issue.status] || 0) + 1;
  }
  const hidden = (issues || []).length - filter.apply(issues).length;

  return html`
    <div className=${`jira-status-filter ${compact ? "compact" : ""}`}>
      <span className="help-text">Story status</span>
      ${names.map((name) => {
        const category = filter.statuses[name];
        const visible = filter.isVisible({ status: name, status_category: category });
        const count = counts[name];
        return html`
          <button
            key=${name}
            type="button"
            className=${`jira-status-chip ${category} ${visible ? "selected" : ""}`}
            aria-pressed=${visible}
            onClick=${() => filter.toggle(name)}
          >
            ${name}
            ${count ? html`<span className="jira-status-chip-count">${count}</span>` : null}
          </button>
        `;
      })}
      ${hidden ? html`<span className="help-text">${hidden} hidden</span>` : null}
    </div>
  `;
}

function PencilIcon() {
  return html`
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M14.5 6.5l3 3" />
    </svg>
  `;
}

function BackArrowIcon() {
  return html`
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h9a7 7 0 0 1 7 7v4" />
    </svg>
  `;
}

const JIRA_PAGE_SIZE = 10;
const JIRA_CHIPS_KEY = "pm-tool.jira-search-chips";
// Quick JQL scoping chips. Adding a project or issue type is one line here.
const JIRA_CHIPS = [
  { id: "project:SNA", kind: "project", value: "SNA", label: "project = SNA" },
  { id: "project:PESRE", kind: "project", value: "PESRE", label: "project = PESRE" },
  { id: "type:Epic", kind: "type", value: "Epic", label: "issueType = Epic" },
  { id: "type:Story", kind: "type", value: "Story", label: "issueType = Story" },
];
// SNA is the team's home Jira project, so it starts selected.
const JIRA_DEFAULT_CHIPS = ["project:SNA"];

function chipClause(kind, field, quote, activeIds) {
  const values = JIRA_CHIPS.filter(
    (chip) => chip.kind === kind && activeIds.includes(chip.id)
  ).map((chip) => (quote ? `"${chip.value}"` : chip.value));
  if (!values.length) return "";
  return values.length === 1 ? `${field} = ${values[0]}` : `${field} in (${values.join(", ")})`;
}

// Chips scope the search, so they AND with whatever the user typed. A typed
// JQL's trailing ORDER BY has to stay last, hence the split.
function buildJiraQuery(activeIds, rawJql, rawKeyword) {
  const jql = (rawJql || "").trim();
  const keyword = (rawKeyword || "").trim();
  // A pasted key is a direct lookup; scoping it to a project would hide it.
  if (!jql && keyword && ISSUE_KEY_PATTERN.test(keyword)) {
    return `issuekey = "${keyword.toUpperCase()}"`;
  }
  const scope = [
    chipClause("project", "project", true, activeIds),
    chipClause("type", "issuetype", false, activeIds),
  ].filter(Boolean);
  let order = "ORDER BY updated DESC";
  let base = "";
  if (jql) {
    const match = jql.match(/^(.*?)\s*\border\s+by\b(.*)$/is);
    base = match ? match[1].trim() : jql;
    if (match) order = `ORDER BY${match[2]}`;
  } else if (keyword) {
    base = `text ~ "${keyword.replace(/"/g, '\\"')}"`;
  }
  if (base) scope.push(scope.length ? `(${base})` : base);
  return scope.length ? `${scope.join(" AND ")} ${order}` : "";
}

function pageOf(items, page) {
  const last = Math.max(0, Math.ceil(items.length / JIRA_PAGE_SIZE) - 1);
  const index = Math.min(page, last);
  const from = index * JIRA_PAGE_SIZE;
  return { index, items: items.slice(from, from + JIRA_PAGE_SIZE), from, hasNext: index < last };
}

function JiraPager({ index, from, count, total, hasNext, busy, onPrev, onNext }) {
  if (index === 0 && !hasNext) return null;
  return html`
    <div className="jira-pager">
      <button type="button" className="button-secondary" disabled=${busy || index === 0} onClick=${onPrev}>
        ‹ Previous
      </button>
      <span className="help-text">Page ${index + 1} · showing ${from + 1}–${from + count}${total ? ` of ${Math.max(total, from + count)}` : ""}</span>
      <button type="button" className="button-primary" disabled=${busy || !hasNext} onClick=${onNext}>
        Next page ›
      </button>
    </div>
  `;
}

function JiraResultRow({ issue, linked, selected, onToggle, onLink, submitting }) {
  return html`
    <div className=${`jira-result-row ${selected ? "selected" : ""}`}>
      <div className="jira-result-main">
        ${onToggle
          ? html`<input
              type="checkbox"
              className="jira-select-box"
              aria-label=${`Select ${issue.key}`}
              checked=${selected}
              disabled=${linked}
              onChange=${() => onToggle(issue)}
            />`
          : null}
        <a className="jira-result-key" href=${issue.url} target="_blank" rel="noreferrer">${issue.key}</a>
        <span className=${jiraStatusClass(issue.status_category)}>${issue.status}</span>
        <span className="jira-result-type">${issue.issue_type}</span>
        ${linked ? html`<span className="tiny-pill">Linked</span>` : null}
      </div>
      <div className="jira-result-summary">${issue.summary}</div>
      ${onLink
        ? html`<div className="actions">
            <button className="button-primary" type="button" disabled=${submitting || linked} onClick=${() => onLink(issue)}>
              ${linked ? "Linked" : "Link"}
            </button>
          </div>`
        : null}
    </div>
  `;
}

// One "By label" result: selectable, with a pill saying whether the story is new,
// already on this deliverable, or held by another one (selectable, with a warning).
function JiraLabelRow({ issue, linkedHere, selected, onToggle }) {
  const elsewhere = issue.linked_in || [];
  const quarter = quarterOf(issue.effective_end);
  return html`
    <div className=${`jira-result-row ${selected ? "selected" : ""}`}>
      <div className="jira-result-main">
        <input
          type="checkbox"
          className="jira-select-box"
          aria-label=${`Select ${issue.key}`}
          checked=${selected}
          disabled=${linkedHere}
          onChange=${() => onToggle(issue)}
        />
        <a className="jira-result-key" href=${issue.url} target="_blank" rel="noreferrer">${issue.key}</a>
        <span className=${jiraStatusClass(issue.status_category)}>${issue.status}</span>
        ${linkedHere
          ? html`<span className="tiny-pill">Linked here</span>`
          : elsewhere.length
          ? html`<span
              className="tiny-pill jira-linked-elsewhere"
              title="Linking it here as well is allowed, but the story will count toward both."
            >Linked to “${elsewhere.map((item) => item.title).join("”, “")}”</span>`
          : html`<span className="tiny-pill jira-new-pill">New</span>`}
      </div>
      <div className="jira-result-summary">${issue.summary}</div>
      <div className="help-text">
        ${issue.epic_key ? html`<span>${issue.epic_key}${issue.epic_summary ? ` · ${issue.epic_summary}` : ""}</span>` : "No epic"}
        ${quarter ? html`<span> · ${quarter}</span>` : html`<span> · undated</span>`}
      </div>
    </div>
  `;
}

function JiraSelectionBar({ visible, selected, alreadyLinked, submitting, onSelectPage, onClear, onLink }) {
  const pageSelectable = visible.filter((issue) => !alreadyLinked.has(issue.key));
  const count = Object.keys(selected).length;
  if (!pageSelectable.length && !count) return null;
  return html`
    <div className="jira-selection-bar">
      <button type="button" className="button-secondary" disabled=${!pageSelectable.length} onClick=${() => onSelectPage(pageSelectable)}>
        Select all on this page
      </button>
      <button type="button" className="button-secondary" disabled=${!count} onClick=${onClear}>Clear</button>
      <span className="help-text">${count} selected</span>
      <button type="button" className="button-primary" disabled=${submitting || !count} onClick=${onLink}>
        Link ${count} selected
      </button>
    </div>
  `;
}

function JiraPickerModal({
  title,
  teams,
  onClose,
  onLink,
  onLinkMany,
  submitting,
  error,
  setError,
  epicKeys,
  statusFilter,
  linkedKeys,
  projectId,
  initialLabel,
  initialMode,
  preselectKeys,
  onSetLabel,
}) {
  const hasEpics = Boolean(epicKeys && epicKeys.length);
  const canBulkLink = typeof onLinkMany === "function";
  const [mode, setMode] = useState(initialMode || (hasEpics ? "epics" : "search"));
  const [jql, setJql] = useState("");
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [pickedIssue, setPickedIssue] = useState(null);
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [searched, setSearched] = useState(false);
  const [epicGroups, setEpicGroups] = useState(null);
  const [loadingEpics, setLoadingEpics] = useState(false);
  const saved = initialLabel || {};
  const [label, setLabel] = useState(saved.label || "");
  const [labelProjectKey, setLabelProjectKey] = useState(saved.projectKey || "");
  // The quarter / custom window the label search is limited to. `range` is what
  // is sent (and later saved with the label); `quarterPick` is just the control.
  const [range, setRange] = useState({ from: saved.from || "", to: saved.to || "" });
  const [quarterPick, setQuarterPick] = useState(() =>
    quarterSelection(saved.from || "", saved.to || "")
  );
  const [hideUndated, setHideUndated] = useState(false);
  const [labelSelected, setLabelSelected] = useState({});
  const [labelSetNote, setLabelSetNote] = useState("");
  const [labelOptions, setLabelOptions] = useState([]);
  const [labelResult, setLabelResult] = useState(null);
  const [labelSearching, setLabelSearching] = useState(false);
  const [labelHint, setLabelHint] = useState("");
  const alreadyLinked = new Set(linkedKeys || []);
  const [chips, setChips] = useState(() => readStored(JIRA_CHIPS_KEY, JIRA_DEFAULT_CHIPS));
  // Search paging is token based (Jira's /search/jql has no offset): tokens[i]
  // fetches page i, so Previous is just a lower index.
  const [pageTokens, setPageTokens] = useState([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextToken, setNextToken] = useState(null);
  const [searchTotal, setSearchTotal] = useState(null);
  const [activeQuery, setActiveQuery] = useState("");
  const [epicPage, setEpicPage] = useState(0);
  const [labelPage, setLabelPage] = useState(0);
  // key -> issue, kept across pages until the query changes.
  const [selected, setSelected] = useState({});

  // Every search in here runs on a submit event, and one caller (the create
  // deliverable panel) renders this modal from inside its own <form>. Chrome
  // does not bubble a nested form's submit event out to React's delegated
  // listener, so onSubmit never fired, nothing called preventDefault, and the
  // browser did a native GET that reloaded the app back to the dashboard.
  // The modal is portalled out of the DOM tree below, which fixes the native
  // event; stopPropagation keeps the *synthetic* event — which still travels up
  // the React tree, portal or not — from also submitting that outer form.
  const takeOver = (event) => {
    if (!event) return;
    event.preventDefault();
    event.stopPropagation();
  };

  // Debounced label typeahead. The endpoint also reports the project it scoped
  // to, which seeds the editable project-key box on first load.
  useEffect(() => {
    if (mode !== "label") return undefined;
    const handle = window.setTimeout(async () => {
      try {
        const payload = await api(
          `/api/jira/labels?query=${encodeURIComponent(label.trim())}` +
            `&project_key=${encodeURIComponent(labelProjectKey.trim())}`
        );
        setLabelOptions(payload.labels || []);
        setLabelHint("");
        if (!labelProjectKey && payload.project_key) setLabelProjectKey(payload.project_key);
      } catch (err) {
        // Suggestions are a convenience, so this must not block the search —
        // but say so, otherwise an empty dropdown looks like "no such label".
        setLabelOptions([]);
        setLabelHint(`Label suggestions unavailable (${err.message}) — type the exact label.`);
      }
    }, 300);
    return () => window.clearTimeout(handle);
  }, [mode, label, labelProjectKey]);

  const runLabelSearch = async (event, rangeOverride) => {
    takeOver(event);
    const window_ = rangeOverride || range;
    const cleaned = label.trim();
    if (!cleaned) {
      setError("Pick or type a Jira label to search.");
      return;
    }
    setError("");
    setLabelSearching(true);
    try {
      const params =
        `label=${encodeURIComponent(cleaned)}` +
        `&project_key=${encodeURIComponent(labelProjectKey.trim())}&limit=500` +
        (window_.from ? `&date_from=${window_.from}` : "") +
        (window_.to ? `&date_to=${window_.to}` : "") +
        (projectId ? `&project_id=${projectId}` : "");
      const payload = await api(`/api/jira/labels/issues?${params}`);
      setLabelResult(payload);
      setLabelPage(0);
      if (statusFilter) statusFilter.registerStatuses(payload.issues || []);
      // Pre-select what the caller asked for (the "N new" badge), else nothing:
      // linking is always the user's explicit pick.
      const wanted = new Set(preselectKeys || []);
      const next = {};
      for (const issue of payload.issues || []) {
        if (wanted.has(issue.key) && !alreadyLinked.has(issue.key)) next[issue.key] = true;
      }
      setLabelSelected(next);
      if (!(payload.issues || []).length) {
        // A healthy Jira plus zero rows used to clear the error and say nothing.
        // The usual cause is a label that lives in another Jira project.
        setError(
          (await jiraTrouble()) ||
            `No issues in Jira project ${payload.project_key} carry the label “${payload.label}”` +
              `${window_.from || window_.to ? " in that date range" : ""}. ` +
              `Check the spelling, the date range, or change the Jira project if the label belongs to a different one.`
        );
      }
    } catch (err) {
      setError(await describeJiraFailure(err));
      setLabelResult(null);
    } finally {
      setLabelSearching(false);
    }
  };

  // Changing the window re-runs the search, so the list always matches the control.
  const applyRange = (nextPick, nextRange) => {
    setQuarterPick(nextPick);
    setRange(nextRange);
    setLabelSetNote("");
    if (label.trim()) runLabelSearch(null, nextRange);
  };
  const pickQuarter = (quarter) =>
    applyRange(
      { ...quarterPick, mode: "quarter", quarter },
      quarterRange(quarterPick.year, quarter)
    );
  const pickYear = (year) =>
    quarterPick.mode === "quarter"
      ? applyRange({ ...quarterPick, year }, quarterRange(year, quarterPick.quarter))
      : setQuarterPick({ ...quarterPick, year });

  // Opened from a deliverable that already has a label (or its "N new" badge):
  // show its stories straight away.
  useEffect(() => {
    if (initialMode === "label" && saved.label) runLabelSearch(null);
  }, []);

  const setAsDeliverableLabel = () => {
    const cleaned = label.trim();
    if (!cleaned || typeof onSetLabel !== "function") return;
    onSetLabel({
      label: cleaned,
      projectKey: labelProjectKey.trim(),
      from: range.from,
      to: range.to,
    });
    setLabelSetNote(`“${cleaned}” will be saved as this deliverable's label — save the deliverable to keep it.`);
  };

  const labelIssues = (labelResult && labelResult.issues) || [];
  const labelStatusVisible = statusFilter ? statusFilter.apply(labelIssues) : labelIssues;
  const labelUndatedCount = labelStatusVisible.filter((issue) => issue.undated).length;
  const labelVisible = hideUndated
    ? labelStatusVisible.filter((issue) => !issue.undated)
    : labelStatusVisible;
  const labelHidden = labelIssues.length - labelVisible.length;
  const labelToLink = labelVisible.filter((issue) => !alreadyLinked.has(issue.key));
  // "New" = not linked to this deliverable and not linked to another one either.
  const labelNew = labelToLink.filter((issue) => !(issue.linked_in || []).length);
  const labelSelectedKeys = Object.keys(labelSelected).filter((key) => labelSelected[key]);
  const toggleLabelIssue = (issue) =>
    setLabelSelected((current) => ({ ...current, [issue.key]: !current[issue.key] }));
  // Derived from every story the label returned, so toggling the status filter
  // does not move the number the deliverable's progress is seeded with.
  const labelInProgress = labelIssues.filter(isInProgressIssue).length;
  const labelProgress = progressFromIssues(labelIssues);

  const epicEntries = (epicGroups || []).flatMap((group) =>
    (statusFilter ? statusFilter.apply(group.issues) : group.issues).map((issue) => ({
      epicKey: group.epicKey,
      issue,
    }))
  );
  const epicPaged = pageOf(epicEntries, epicPage);
  const labelPaged = pageOf(labelVisible, labelPage);

  const loadEpicStories = async () => {
    setLoadingEpics(true);
    try {
      const groups = await Promise.all(
        epicKeys.map(async (key) => {
          try {
            const issues = await api(`/api/jira/issues/${encodeURIComponent(key)}/children`);
            return { epicKey: key, issues, error: "" };
          } catch (err) {
            return { epicKey: key, issues: [], error: err.message };
          }
        })
      );
      setEpicGroups(groups);
      setEpicPage(0);
      if (statusFilter) {
        statusFilter.registerStatuses(groups.flatMap((group) => group.issues));
      }
    } finally {
      setLoadingEpics(false);
    }
  };

  useEffect(() => {
    setSelected({});
  }, [mode]);

  useEffect(() => {
    if (mode === "epics" && epicGroups === null && hasEpics && !loadingEpics) {
      loadEpicStories();
    }
  }, [mode]);

  const fetchSearchPage = async (query, tokens, index) => {
    setError("");
    setSearching(true);
    try {
      const token = tokens[index];
      const payload = await api(
        `/api/jira/search?jql=${encodeURIComponent(query)}&limit=${JIRA_PAGE_SIZE}` +
          (token ? `&next_page_token=${encodeURIComponent(token)}` : "")
      );
      const issues = payload.issues || [];
      setResults(issues);
      setSearched(true);
      setPageIndex(index);
      if (index === 0) setSearchTotal(payload.total || null);
      setNextToken(payload.is_last ? null : payload.next_page_token || null);
      if (!issues.length && index === 0) setError(await jiraTrouble());
    } catch (err) {
      setError(await describeJiraFailure(err));
      setResults([]);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

  // A new query starts over: back to page 1 and nothing selected.
  const startSearch = (activeChips) => {
    const query = buildJiraQuery(activeChips, jql, keyword);
    if (!query) {
      setError("Enter a JQL query or a keyword, or select a project/type chip.");
      return;
    }
    setActiveQuery(query);
    setPageTokens([null]);
    setSearchTotal(null);
    setSelected({});
    return fetchSearchPage(query, [null], 0);
  };

  const runSearch = (event) => {
    takeOver(event);
    return startSearch(chips);
  };

  const toggleChip = (id) => {
    const next = chips.includes(id) ? chips.filter((chip) => chip !== id) : [...chips, id];
    writeStored(JIRA_CHIPS_KEY, next);
    setChips(next);
    if (searched) startSearch(next);
  };

  const goToSearchPage = (delta) => {
    const target = pageIndex + delta;
    const tokens = [...pageTokens];
    if (delta > 0) tokens[target] = nextToken;
    setPageTokens(tokens);
    return fetchSearchPage(activeQuery, tokens, target);
  };

  const toggleSelected = (issue) => {
    setSelected((current) => {
      const next = { ...current };
      if (next[issue.key]) delete next[issue.key];
      else next[issue.key] = issue;
      return next;
    });
  };
  const selectPage = (issues) =>
    setSelected((current) => {
      const next = { ...current };
      for (const issue of issues) next[issue.key] = issue;
      return next;
    });
  // Hand-picked stories do not seed the deliverable's progress (null), unlike
  // a whole-label link where "N in progress" is a meaningful signal.
  const linkSelected = () => onLinkMany(Object.keys(selected), null);

  const validateKey = async (event) => {
    takeOver(event);
    const key = keyInput.trim().toUpperCase();
    if (!key) {
      setError("Paste a Jira key like ABC-123.");
      return;
    }
    setError("");
    setSearching(true);
    try {
      const issue = await api(`/api/jira/issues/${encodeURIComponent(key)}`);
      setPickedIssue(issue);
    } catch (err) {
      setError(await describeJiraFailure(err));
      setPickedIssue(null);
    } finally {
      setSearching(false);
    }
  };

  const confirmLink = (issue) => {
    const payload = { jira_key: issue.key };
    if (teams && selectedTeamId) {
      payload.team_id = Number(selectedTeamId);
    }
    onLink(payload);
  };

  // Portalled to <body>: the backdrop is position: fixed anyway, and mounting
  // it outside the caller's markup keeps the picker's own forms from ever
  // becoming nested forms (see `takeOver`).
  return html`
    <${SideDrawer} title=${title} wide top onClose=${onClose}>
        <div className="jira-modal-tabs">
          ${hasEpics
            ? html`
                <button
                  type="button"
                  className=${`jira-tab ${mode === "epics" ? "active" : ""}`}
                  onClick=${() => setMode("epics")}
                >
                  From linked epics
                </button>
              `
            : null}
          ${canBulkLink
            ? html`
                <button
                  type="button"
                  className=${`jira-tab ${mode === "label" ? "active" : ""}`}
                  onClick=${() => setMode("label")}
                >
                  By label
                </button>
              `
            : null}
          <button
            type="button"
            className=${`jira-tab ${mode === "search" ? "active" : ""}`}
            onClick=${() => setMode("search")}
          >
            Search
          </button>
          <button
            type="button"
            className=${`jira-tab ${mode === "key" ? "active" : ""}`}
            onClick=${() => setMode("key")}
          >
            Search by Jira Ticket ID
          </button>
        </div>

        ${teams && teams.length
          ? html`
              <div className="field-wide jira-team-picker">
                <label htmlFor="jira-team-select">Assign to team (optional)</label>
                <select
                  id="jira-team-select"
                  value=${selectedTeamId}
                  onChange=${(event) => setSelectedTeamId(event.target.value)}
                >
                  <option value="">Unassigned</option>
                  ${teams.map(
                    (team) => html`<option key=${team.id} value=${team.id}>${team.name}</option>`
                  )}
                </select>
              </div>
            `
          : null}

        ${mode === "epics"
          ? html`
              ${statusFilter
                ? html`<${JiraStatusFilter}
                    filter=${statusFilter}
                    issues=${(epicGroups || []).flatMap((group) => group.issues)}
                  />`
                : null}
              ${loadingEpics
                ? html`<div className="help-text">Loading stories from linked epics…</div>`
                : html`
                    <div className="jira-epic-picker">
                      ${canBulkLink
                        ? html`<${JiraSelectionBar}
                            visible=${epicPaged.items.map((entry) => entry.issue)}
                            selected=${selected}
                            alreadyLinked=${alreadyLinked}
                            submitting=${submitting}
                            onSelectPage=${selectPage}
                            onClear=${() => setSelected({})}
                            onLink=${linkSelected}
                          />`
                        : null}
                      ${(epicGroups || []).map((group) => {
                        const pageRows = epicPaged.items.filter((entry) => entry.epicKey === group.epicKey);
                        const visibleCount = epicEntries.filter((entry) => entry.epicKey === group.epicKey).length;
                        const hidden = group.issues.length - visibleCount;
                        if (!pageRows.length && !group.error && visibleCount) return null;
                        return html`
                          <div className="jira-epic-picker-group" key=${group.epicKey}>
                            <div className="jira-epic-picker-heading">
                              <strong>${group.epicKey}</strong>
                              <span className="tiny-pill">${visibleCount}</span>
                              ${hidden
                                ? html`<span className="help-text">${hidden} hidden by filter</span>`
                                : null}
                            </div>
                            ${group.error
                              ? html`<div className="jira-modal-error">${group.error}</div>`
                              : pageRows.length
                                ? pageRows.map(
                                    ({ issue }) => html`
                                      <${JiraResultRow}
                                        key=${issue.key}
                                        issue=${issue}
                                        linked=${alreadyLinked.has(issue.key)}
                                        selected=${Boolean(selected[issue.key])}
                                        onToggle=${canBulkLink ? toggleSelected : null}
                                        onLink=${confirmLink}
                                        submitting=${submitting}
                                      />
                                    `
                                  )
                                : html`<div className="help-text">
                                    ${group.issues.length
                                      ? "Every story here is hidden by the status filter."
                                      : "No child stories in Jira."}
                                  </div>`}
                          </div>
                        `;
                      })}
                      <${JiraPager}
                        index=${epicPaged.index}
                        from=${epicPaged.from}
                        count=${epicPaged.items.length}
                        total=${epicEntries.length}
                        hasNext=${epicPaged.hasNext}
                        onPrev=${() => setEpicPage(epicPaged.index - 1)}
                        onNext=${() => setEpicPage(epicPaged.index + 1)}
                      />
                      ${epicGroups && !epicGroups.length
                        ? html`<div className="empty-state">No epics linked to this project yet.</div>`
                        : null}
                    </div>
                  `}
            `
          : mode === "label"
          ? html`
              <form onSubmit=${runLabelSearch} className="jira-search-form">
                <div className="field-wide">
                  <label htmlFor="jira-label-input">Jira label</label>
                  <input
                    id="jira-label-input"
                    list="jira-label-options"
                    placeholder="Start typing a label"
                    value=${label}
                    onInput=${(event) => setLabel(event.target.value)}
                  />
                  <datalist id="jira-label-options">
                    ${labelOptions.map(
                      (option) => html`<option key=${option} value=${option}></option>`
                    )}
                  </datalist>
                  <span className="help-text">
                    Optional — labels tag the stories that make up one project feature.
                  </span>
                  ${labelHint ? html`<span className="help-text">${labelHint}</span>` : null}
                </div>
                <div className="field">
                  <label htmlFor="jira-label-project">Jira project</label>
                  <input
                    id="jira-label-project"
                    placeholder="SNA"
                    value=${labelProjectKey}
                    onInput=${(event) => setLabelProjectKey(event.target.value)}
                  />
                  <span className="help-text">
                    Only stories in this Jira project are searched.
                  </span>
                </div>
                <div className="actions">
                  <button className="button-secondary" type="submit" disabled=${labelSearching}>
                    ${labelSearching ? "Searching…" : "Find stories"}
                  </button>
                  ${typeof onSetLabel === "function" && label.trim()
                    ? html`<button
                        className="button-secondary"
                        type="button"
                        onClick=${setAsDeliverableLabel}
                      >Set as deliverable label</button>`
                    : null}
                </div>
                ${labelSetNote ? html`<div className="field-wide help-text">${labelSetNote}</div>` : null}
                <div className="field-wide">
                  <label>Quarter</label>
                  <div className="jira-chip-picker">
                    <button
                      type="button"
                      className=${`jira-query-chip ${quarterPick.mode === "all" ? "selected" : ""}`}
                      aria-pressed=${quarterPick.mode === "all"}
                      onClick=${() => applyRange({ ...quarterPick, mode: "all", quarter: 0 }, { from: "", to: "" })}
                    >All</button>
                    <select
                      aria-label="Year"
                      value=${quarterPick.year}
                      onChange=${(event) => pickYear(Number(event.target.value))}
                    >
                      ${[-1, 0, 1, 2].map((offset) => {
                        const year = new Date().getFullYear() + offset;
                        return html`<option key=${year} value=${year}>${year}</option>`;
                      })}
                    </select>
                    ${[1, 2, 3, 4].map(
                      (quarter) => html`
                        <button
                          key=${quarter}
                          type="button"
                          className=${`jira-query-chip ${
                            quarterPick.mode === "quarter" && quarterPick.quarter === quarter ? "selected" : ""
                          }`}
                          aria-pressed=${quarterPick.mode === "quarter" && quarterPick.quarter === quarter}
                          onClick=${() => pickQuarter(quarter)}
                        >Q${quarter}</button>
                      `
                    )}
                    <button
                      type="button"
                      className=${`jira-query-chip ${quarterPick.mode === "custom" ? "selected" : ""}`}
                      aria-pressed=${quarterPick.mode === "custom"}
                      onClick=${() => setQuarterPick({ ...quarterPick, mode: "custom", quarter: 0 })}
                    >Custom range</button>
                  </div>
                  ${quarterPick.mode === "custom"
                    ? html`<div className="jira-chip-picker">
                        <input
                          type="date"
                          aria-label="From"
                          value=${range.from}
                          onChange=${(event) => applyRange(quarterPick, { ...range, from: event.target.value })}
                        />
                        <input
                          type="date"
                          aria-label="To"
                          value=${range.to}
                          onChange=${(event) => applyRange(quarterPick, { ...range, to: event.target.value })}
                        />
                      </div>`
                    : null}
                  <span className="help-text">
                    Stories are placed by their epic's dates, else their own due date. Saved with the label.
                  </span>
                </div>
              </form>
              ${statusFilter && labelIssues.length
                ? html`<${JiraStatusFilter} filter=${statusFilter} issues=${labelIssues} />`
                : null}
              ${labelIssues.length
                ? html`
                    <div className="jira-label-summary help-text">
                      ${labelVisible.length} of ${labelIssues.length} story(s) in
                      ${" "}${labelResult.project_key} labelled ${labelResult.label}
                      ${labelHidden ? html`<span> · ${labelHidden} hidden by the status filter</span>` : null}
                      ${labelResult.truncated
                        ? html`<span> · showing the first 500 matches</span>`
                        : null}
                      ${labelVisible.length && !labelToLink.length
                        ? html`<span> · all already linked</span>`
                        : null}
                      ${labelUndatedCount
                        ? html`<label className="jira-undated-toggle">
                            <input
                              type="checkbox"
                              checked=${hideUndated}
                              onChange=${(event) => setHideUndated(event.target.checked)}
                            />
                            Hide ${labelUndatedCount} undated
                          </label>`
                        : null}
                      ${labelProgress === null
                        ? null
                        : html`<span>
                            ${" "}· ${labelInProgress} in progress → seeds ${labelProgress}% progress
                          </span>`}
                    </div>
                    <div className="jira-selection-bar">
                      <button
                        type="button"
                        className="button-secondary"
                        disabled=${!labelNew.length}
                        onClick=${() =>
                          setLabelSelected(Object.fromEntries(labelNew.map((issue) => [issue.key, true])))}
                      >Select all new (${labelNew.length})</button>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled=${!labelSelectedKeys.length}
                        onClick=${() => setLabelSelected({})}
                      >Clear</button>
                      <span className="help-text">${labelSelectedKeys.length} selected</span>
                      <button
                        type="button"
                        className="button-primary"
                        disabled=${submitting || !labelSelectedKeys.length}
                        onClick=${() => onLinkMany(labelSelectedKeys, labelProgress)}
                      >Link selected (${labelSelectedKeys.length})</button>
                    </div>
                    <div className="jira-results">
                      ${labelPaged.items.map(
                        (issue) => html`
                          <${JiraLabelRow}
                            key=${issue.key}
                            issue=${issue}
                            linkedHere=${alreadyLinked.has(issue.key)}
                            selected=${Boolean(labelSelected[issue.key])}
                            onToggle=${toggleLabelIssue}
                          />
                        `
                      )}
                    </div>
                    <${JiraPager}
                      index=${labelPaged.index}
                      from=${labelPaged.from}
                      count=${labelPaged.items.length}
                      total=${labelVisible.length}
                      hasNext=${labelPaged.hasNext}
                      onPrev=${() => setLabelPage(labelPaged.index - 1)}
                      onNext=${() => setLabelPage(labelPaged.index + 1)}
                    />
                  `
                : html`<div className="empty-state">
                    ${labelResult
                      ? `No stories in ${labelResult.project_key} carry the label ${labelResult.label}.`
                      : "Pick a label, then link every story it tags in one click."}
                  </div>`}
            `
          : mode === "search"
          ? html`
              <form onSubmit=${runSearch} className="jira-search-form">
                <div className="field-wide">
                  <label>Quick filters</label>
                  <div className="jira-chip-picker">
                    ${JIRA_CHIPS.map((chip) => {
                      const on = chips.includes(chip.id);
                      return html`
                        <button
                          key=${chip.id}
                          type="button"
                          className=${`jira-query-chip ${on ? "selected" : ""}`}
                          aria-pressed=${on}
                          onClick=${() => toggleChip(chip.id)}
                        >${on ? "✓ " : ""}${chip.label}</button>
                      `;
                    })}
                  </div>
                  <span className="help-text">
                    Selected filters are ANDed with the keyword or JQL below.
                    ${buildJiraQuery(chips, jql, keyword)
                      ? html`Running: <code>${buildJiraQuery(chips, jql, keyword)}</code>`
                      : null}
                  </span>
                </div>
                <div className="field-wide">
                  <label htmlFor="jira-keyword">Keyword</label>
                  <input
                    id="jira-keyword"
                    placeholder="Search summary/description"
                    value=${keyword}
                    onInput=${(event) => setKeyword(event.target.value)}
                  />
                </div>
                <div className="field-wide">
                  <label htmlFor="jira-jql">JQL (advanced, used instead of keyword)</label>
                  <input
                    id="jira-jql"
                    placeholder='labels = "my-feature" ORDER BY created DESC'
                    value=${jql}
                    onInput=${(event) => setJql(event.target.value)}
                  />
                </div>
                <div className="actions">
                  <button className="button-primary" type="submit" disabled=${searching}>
                    ${searching ? "Searching…" : "Search Jira"}
                  </button>
                </div>
              </form>
              ${canBulkLink && results.length
                ? html`<${JiraSelectionBar}
                    visible=${results}
                    selected=${selected}
                    alreadyLinked=${alreadyLinked}
                    submitting=${submitting}
                    onSelectPage=${selectPage}
                    onClear=${() => setSelected({})}
                    onLink=${linkSelected}
                  />`
                : null}
              ${results.length
                ? html`
                    <${JiraPager}
                      index=${pageIndex}
                      from=${pageIndex * JIRA_PAGE_SIZE}
                      count=${results.length}
                      total=${searchTotal}
                      hasNext=${Boolean(nextToken)}
                      busy=${searching}
                      onPrev=${() => goToSearchPage(-1)}
                      onNext=${() => goToSearchPage(1)}
                    />
                    <div className="jira-results">
                      ${results.map(
                        (issue) => html`
                          <${JiraResultRow}
                            key=${issue.key}
                            issue=${issue}
                            linked=${alreadyLinked.has(issue.key)}
                            selected=${Boolean(selected[issue.key])}
                            onToggle=${canBulkLink ? toggleSelected : null}
                            onLink=${confirmLink}
                            submitting=${submitting}
                          />
                        `
                      )}
                    </div>
                    <${JiraPager}
                      index=${pageIndex}
                      from=${pageIndex * JIRA_PAGE_SIZE}
                      count=${results.length}
                      total=${searchTotal}
                      hasNext=${Boolean(nextToken)}
                      busy=${searching}
                      onPrev=${() => goToSearchPage(-1)}
                      onNext=${() => goToSearchPage(1)}
                    />
                  `
                : html`<div className="empty-state">
                    ${searched
                      ? "No issues matched that search."
                      : "No results yet — run a search."}
                  </div>`}
            `
          : html`
              <form onSubmit=${validateKey} className="jira-key-form">
                <div className="field-wide">
                  <label htmlFor="jira-key-input">Jira key</label>
                  <input
                    id="jira-key-input"
                    placeholder="ABC-123"
                    value=${keyInput}
                    onInput=${(event) => setKeyInput(event.target.value)}
                  />
                </div>
                <div className="actions">
                  <button className="button-secondary" type="submit" disabled=${searching}>
                    ${searching ? "Checking…" : "Validate"}
                  </button>
                  ${pickedIssue
                    ? html`
                        <button
                          className="button-primary"
                          type="button"
                          disabled=${submitting}
                          onClick=${() => confirmLink(pickedIssue)}
                        >
                          Link ${pickedIssue.key}
                        </button>
                      `
                    : null}
                </div>
              </form>
              ${pickedIssue
                ? html`
                    <div className="jira-result-row">
                      <div className="jira-result-main">
                        <a
                          className="jira-result-key"
                          href=${pickedIssue.url}
                          target="_blank"
                          rel="noreferrer"
                        >${pickedIssue.key}</a>
                        <span className=${jiraStatusClass(pickedIssue.status_category)}>
                          ${pickedIssue.status}
                        </span>
                        <span className="jira-result-type">${pickedIssue.issue_type}</span>
                      </div>
                      <div className="jira-result-summary">${pickedIssue.summary}</div>
                    </div>
                  `
                : null}
            `}
        ${error ? html`<div className="jira-modal-error">${error}</div>` : null}
    <//>
  `;
}

function JiraEpicChildren({ epicKey, statusFilter }) {
  const [children, setChildren] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api(`/api/jira/issues/${encodeURIComponent(epicKey)}/children`);
      setChildren(data);
      if (statusFilter) statusFilter.registerStatuses(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && children === null && !loading) {
      load();
    }
  };

  const visible = statusFilter && children ? statusFilter.apply(children) : children;
  const hidden = children ? children.length - (visible || []).length : 0;

  return html`
    <div className="jira-children">
      <button className="jira-children-toggle" type="button" onClick=${toggle}>
        ${open ? "Hide stories" : "Show stories"}
      </button>
      ${open
        ? loading
          ? html`<div className="help-text">Loading stories…</div>`
          : error
            ? html`<div className="jira-modal-error">${error}</div>`
            : visible && visible.length
              ? html`
                  <ul className="jira-children-list">
                    ${visible.map(
                      (child) => html`
                        <li key=${child.key}>
                          <a href=${child.url} target="_blank" rel="noreferrer">${child.key}</a>
                          <span className=${jiraStatusClass(child.status_category)}>
                            ${child.status}
                          </span>
                          <span>${child.summary}</span>
                        </li>
                      `
                    )}
                    ${hidden
                      ? html`<li className="help-text">
                          ${hidden} hidden by the status filter.
                        </li>`
                      : null}
                  </ul>
                `
              : html`<div className="help-text">
                  ${hidden
                    ? `All ${hidden} stories are hidden by the status filter.`
                    : "No child stories in Jira."}
                </div>`
        : null}
    </div>
  `;
}

// The one place teams are managed: each team is a group heading with the Jira
// epics it owns underneath, and the heading carries the rename/recolor/remove
// controls that used to live in a side drawer of their own.
function JiraProjectPanel({
  projectId,
  teams,
  onMessage,
  statusFilter,
  onEpicsLoaded,
  onTeamsChanged,
  onCheckLabels,
  checkingLabels,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [trouble, setTrouble] = useState("");
  const [editingTeamId, setEditingTeamId] = useState("");
  const [teamDraft, setTeamDraft] = useState({ name: "", color: "#2563eb" });
  const [teamError, setTeamError] = useState({ id: null, message: "" });
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState({ name: "", color: "#2563eb" });
  const [teamBusy, setTeamBusy] = useState(false);

  // The epic -> team assignment made here is also what buckets a deliverable's
  // stories by team on the timeline, so publish it alongside the keys.
  const publishEpicKeys = (payload) => {
    if (typeof onEpicsLoaded !== "function") return;
    const links = (payload && payload.links) || [];
    const teamsByEpic = {};
    for (const link of links) {
      teamsByEpic[link.issue.key] = link.team_id ?? null;
    }
    onEpicsLoaded(
      links.map((link) => link.issue.key),
      teamsByEpic
    );
  };

  const load = async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const payload = await api(`/api/projects/${projectId}/jira`);
      setData(payload);
      publishEpicKeys(payload);
    } catch (err) {
      onMessage(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setData(null);
    load();
    jiraTrouble().then(setTrouble);
  }, [projectId]);

  const forceSync = async () => {
    setLoading(true);
    try {
      const payload = await api(`/api/projects/${projectId}/jira/sync`, { method: "POST" });
      setData(payload);
      publishEpicKeys(payload);
      onMessage("Refreshed epics from Jira.", "success");
    } catch (err) {
      onMessage(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const linkEpic = async (payload) => {
    setSubmitting(true);
    setPickerError("");
    try {
      await api(`/api/projects/${projectId}/jira/links`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setShowPicker(false);
      onMessage(`Linked ${payload.jira_key} to project.`, "success");
      await load();
    } catch (err) {
      setPickerError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const unlink = async (link) => {
    setLoading(true);
    try {
      await api(`/api/projects/${projectId}/jira/links/${link.id}`, { method: "DELETE" });
      onMessage(`Unlinked ${link.issue.key}.`, "success");
      await load();
    } catch (err) {
      onMessage(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  // A team write changes the dashboard (team dropdowns, timeline colors) *and*
  // this panel's grouping, so both are refreshed.
  const afterTeamWrite = async () => {
    if (typeof onTeamsChanged === "function") await onTeamsChanged();
    await load();
  };

  const beginEditTeam = (team) => {
    setEditingTeamId(String(team.id));
    setTeamDraft({ name: team.name, color: team.color });
    setTeamError({ id: null, message: "" });
  };

  const cancelEditTeam = () => {
    setEditingTeamId("");
    setTeamError({ id: null, message: "" });
  };

  const saveTeam = async (team) => {
    setTeamBusy(true);
    setTeamError({ id: null, message: "" });
    try {
      await api(`/api/projects/${projectId}/teams/${team.id}`, {
        method: "PUT",
        body: JSON.stringify(teamDraft),
      });
      setEditingTeamId("");
      onMessage(`Team "${teamDraft.name}" updated.`, "success");
      await afterTeamWrite();
    } catch (err) {
      setTeamError({ id: team.id, message: err.message });
    } finally {
      setTeamBusy(false);
    }
  };

  // The API answers 409 with the reason a team is still in use (owned
  // deliverables, contributions, milestones), so it reads in the row itself.
  const removeTeam = async (team) => {
    setTeamBusy(true);
    setTeamError({ id: null, message: "" });
    try {
      await api(`/api/projects/${projectId}/teams/${team.id}`, { method: "DELETE" });
      onMessage(`Team "${team.name}" removed.`, "success");
      await afterTeamWrite();
    } catch (err) {
      setTeamError({ id: team.id, message: err.message });
    } finally {
      setTeamBusy(false);
    }
  };

  const addTeam = async (event) => {
    event.preventDefault();
    if (!addDraft.name.trim()) return;
    setTeamBusy(true);
    try {
      await api(`/api/projects/${projectId}/teams`, {
        method: "POST",
        body: JSON.stringify(addDraft),
      });
      onMessage(`Team "${addDraft.name}" added.`, "success");
      setAddDraft({ name: "", color: "#2563eb" });
      setAddOpen(false);
      await afterTeamWrite();
    } catch (err) {
      onMessage(err.message, "error");
    } finally {
      setTeamBusy(false);
    }
  };

  const groups = useMemo(() => {
    const bucket = new Map();
    for (const team of teams) bucket.set(team.id, { team, links: [] });
    bucket.set(null, { team: null, links: [] });
    for (const link of (data && data.links) || []) {
      const key = link.team_id ?? null;
      if (!bucket.has(key)) bucket.set(key, { team: null, links: [] });
      bucket.get(key).links.push(link);
    }
    return Array.from(bucket.values()).filter(
      (group) => group.team || group.links.length
    );
  }, [teams, data]);

  return html`
    <article className="panel jira-panel" id="teams-section">
      <div className="jira-panel-header">
        <div>
          <h2>Teams & Jira work items</h2>
          <p className="panel-copy">
            Every team on this project, with the Jira epics it owns. Rename or recolor a team from
            its heading; stories under each epic are visible in a read-only list.
          </p>
        </div>
        <div className="actions">
          <button
            className="button-secondary"
            type="button"
            aria-expanded=${addOpen}
            onClick=${() => setAddOpen(!addOpen)}
          >${addOpen ? "Cancel" : "+ Add team"}</button>
          <button className="button-secondary" type="button" onClick=${forceSync} disabled=${loading}>
            ${loading ? "Refreshing…" : "Refresh"}
          </button>
          ${onCheckLabels
            ? html`<button
                className="button-secondary"
                type="button"
                onClick=${onCheckLabels}
                disabled=${checkingLabels}
                title="Look for new Jira stories under each deliverable's label. Nothing is linked automatically."
              >${checkingLabels ? "Checking…" : "Check for new stories"}</button>`
            : null}
          <button className="button-primary" type="button" onClick=${() => { setPickerError(""); setShowPicker(true); }}>
            Link epic
          </button>
        </div>
      </div>

      ${addOpen
        ? html`
            <form className="jira-team-add" onSubmit=${addTeam}>
              <div className="jira-team-add-row">
                <input
                  placeholder="Team name"
                  value=${addDraft.name}
                  onInput=${(event) => setAddDraft({ ...addDraft, name: event.target.value })}
                  required
                  aria-label="New team name"
                />
                <input
                  type="color"
                  value=${addDraft.color}
                  onInput=${(event) => setAddDraft({ ...addDraft, color: event.target.value })}
                  aria-label="New team color"
                  title="Team color"
                />
                <button
                  className="button-primary"
                  type="submit"
                  disabled=${teamBusy || !addDraft.name.trim()}
                >Add team</button>
              </div>
              <span className="help-text">
                The color is what marks this team's deliverables and milestones on the timeline.
              </span>
            </form>
          `
        : null}

      ${trouble ? html`<div className="jira-modal-error">${trouble}</div>` : null}

      ${data && data.stale ? html`<div className="help-text">Showing cached data — refresh failed.</div>` : null}

      ${statusFilter ? html`<${JiraStatusFilter} filter=${statusFilter} />` : null}

      ${groups.map(
        (group) => html`
          <div className="jira-team-group" key=${group.team ? group.team.id : "unassigned"}>
            ${group.team && String(group.team.id) === editingTeamId
              ? html`
                  <div className="jira-team-edit-row">
                    <input
                      value=${teamDraft.name}
                      onInput=${(event) => setTeamDraft({ ...teamDraft, name: event.target.value })}
                      aria-label="Team name"
                    />
                    <input
                      type="color"
                      value=${teamDraft.color}
                      onInput=${(event) => setTeamDraft({ ...teamDraft, color: event.target.value })}
                      aria-label="Team color"
                      title="Team color"
                    />
                    <button
                      className="button-primary"
                      type="button"
                      onClick=${() => saveTeam(group.team)}
                      disabled=${teamBusy || !teamDraft.name.trim()}
                    >Save</button>
                    <button
                      className="button-secondary"
                      type="button"
                      onClick=${cancelEditTeam}
                      disabled=${teamBusy}
                    >Cancel</button>
                  </div>
                `
              : html`
                  <div className="jira-team-heading">
                    ${group.team
                      ? html`
                          <span className="team-dot" style=${{ background: group.team.color }}></span>
                          <strong>${group.team.name}</strong>
                        `
                      : html`<strong>Unassigned</strong>`}
                    <span className="tiny-pill">${group.links.length}</span>
                    ${group.team
                      ? html`
                          <div className="jira-team-heading-actions">
                            <button
                              className="button-secondary"
                              type="button"
                              onClick=${() => beginEditTeam(group.team)}
                              disabled=${teamBusy}
                            >Edit team</button>
                            <button
                              className="button-secondary"
                              type="button"
                              onClick=${() => removeTeam(group.team)}
                              disabled=${teamBusy}
                            >Remove</button>
                          </div>
                        `
                      : null}
                  </div>
                `}
            ${group.team && teamError.id === group.team.id
              ? html`<div className="side-drawer-row-error">${teamError.message}</div>`
              : null}
            ${group.links.length
              ? group.links.map(
                  (link) => html`
                    <div className="jira-link-row" key=${link.id}>
                      <div className="jira-link-main">
                        <a href=${link.issue.url} target="_blank" rel="noreferrer" className="jira-result-key">
                          ${link.issue.key}
                        </a>
                        <span className=${jiraStatusClass(link.issue.status_category)}>${link.issue.status}</span>
                        <span className="jira-result-type">${link.issue.issue_type}</span>
                        ${link.issue.assignee_name
                          ? html`<span className="help-text">${link.issue.assignee_name}</span>`
                          : null}
                      </div>
                      <div className="jira-link-summary">${link.issue.summary}</div>
                      <${JiraEpicChildren} epicKey=${link.issue.key} statusFilter=${statusFilter} />
                      <div className="actions">
                        <button className="button-secondary" type="button" onClick=${() => unlink(link)}>
                          Unlink
                        </button>
                      </div>
                    </div>
                  `
                )
              : html`<div className="empty-state">No epics linked yet.</div>`}
          </div>
        `
      )}

      ${showPicker
        ? html`
            <${JiraPickerModal}
              title="Link Jira epic to project"
              teams=${teams}
              onClose=${() => setShowPicker(false)}
              onLink=${linkEpic}
              submitting=${submitting}
              error=${pickerError}
              setError=${setPickerError}
            />
          `
        : null}
    </article>
  `;
}

// Bucket a deliverable's linked stories by the team that owns their parent epic
// in the project's Jira panel ("Link Teams to Jira Work Items"). `epicTeams`
// maps an epic key to a team id. Bucket order follows `teams` so the buckets
// read the same wherever they are rendered; stories whose epic is unlinked, has
// no team, or does not exist land in one trailing group with `team: null`.
function groupStoriesByTeam(links, teams, epicTeams) {
  const teamsById = new Map((teams || []).map((team) => [team.id, team]));
  const buckets = new Map();
  const unassigned = [];
  for (const link of links || []) {
    const parentKey = link.issue && link.issue.parent_key;
    const teamId = parentKey && epicTeams ? epicTeams[parentKey] : null;
    const team = teamId === null || teamId === undefined ? null : teamsById.get(teamId);
    if (!team) {
      unassigned.push(link);
      continue;
    }
    if (!buckets.has(team.id)) buckets.set(team.id, { team, links: [] });
    buckets.get(team.id).links.push(link);
  }
  const groups = (teams || [])
    .filter((team) => buckets.has(team.id))
    .map((team) => buckets.get(team.id));
  if (unassigned.length) groups.push({ team: null, links: unassigned });
  return groups;
}

// Nothing is mapped to a team, so headings would add noise instead of grouping.
function isFlatGrouping(groups) {
  return groups.length <= 1 && (!groups.length || groups[0].team === null);
}

// Serves both a deliverable (`scope="deliverables"`) and a milestone
// (`scope="milestones"`) — the link endpoints are identical apart from the path
// segment, and the picker below was already generic.
function JiraWorkItemLinks({
  scope = "deliverables",
  itemId,
  onMessage,
  epicKeys,
  statusFilter,
  onLinked,
  onProgressSuggested,
  teams,
  epicTeams,
  compact,
  projectId,
  labelContext,
  onSetLabel,
  autoOpen,
}) {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(false);
  // `autoOpen` ({preselectKeys}) comes from a deliverable's "N new" badge: land
  // straight in the label picker with the new stories ticked.
  const [showPicker, setShowPicker] = useState(Boolean(autoOpen));
  const [submitting, setSubmitting] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const noun = scopeNoun(scope);

  const load = async () => {
    if (!itemId) return;
    setLoading(true);
    try {
      const payload = await api(`/api/${scope}/${itemId}/jira`);
      setLinks(payload);
      if (statusFilter) statusFilter.registerStatuses(payload.map((link) => link.issue));
    } catch (err) {
      onMessage(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLinks([]);
    load();
  }, [scope, itemId]);

  const notifyLinked = () => {
    if (typeof onLinked === "function") onLinked();
  };

  const linkIssue = async (payload) => {
    setSubmitting(true);
    setPickerError("");
    try {
      await api(`/api/${scope}/${itemId}/jira/links`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setShowPicker(false);
      onMessage(`Linked ${payload.jira_key} to ${noun}.`, "success");
      await load();
      notifyLinked();
    } catch (err) {
      setPickerError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // One request for a whole label's worth of stories. `progress` is the share of
  // those stories that are underway, offered as a starting value for the work
  // item's editable progress field.
  const linkMany = async (keys, progress) => {
    setSubmitting(true);
    setPickerError("");
    try {
      const result = await api(`/api/${scope}/${itemId}/jira/links/bulk`, {
        method: "POST",
        body: JSON.stringify({ jira_keys: keys }),
      });
      setShowPicker(false);
      const parts = [`Linked ${result.linked.length} story(s) to ${noun}.`];
      if (result.skipped.length) parts.push(`${result.skipped.length} already linked.`);
      if (result.not_found.length) parts.push(`Not found: ${result.not_found.join(", ")}.`);
      if (progress !== null && progress !== undefined && typeof onProgressSuggested === "function") {
        onProgressSuggested(progress);
        parts.push(`Progress prefilled at ${progress}% — save to apply.`);
      }
      onMessage(parts.join(" "), result.not_found.length ? "error" : "success");
      await load();
      notifyLinked();
    } catch (err) {
      setPickerError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const unlink = async (link) => {
    setLoading(true);
    try {
      await api(`/api/${scope}/${itemId}/jira/links/${link.id}`, { method: "DELETE" });
      onMessage(`Unlinked ${link.issue.key}.`, "success");
      await load();
      notifyLinked();
    } catch (err) {
      onMessage(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const groups = groupStoriesByTeam(links, teams, epicTeams);
  const flat = isFlatGrouping(groups);
  const chipRow = (group) => html`
    <div className="jira-chip-row">
      ${group.links.map(
        (link) => html`
          <div className="jira-chip" key=${link.id}>
            <a href=${link.issue.url} target="_blank" rel="noreferrer">${link.issue.key}</a>
            <span className=${jiraStatusClass(link.issue.status_category)}>${link.issue.status}</span>
            <span className="jira-chip-summary">${link.issue.summary}</span>
            <button
              type="button"
              className="jira-chip-remove"
              onClick=${() => unlink(link)}
              aria-label=${`Unlink ${link.issue.key}`}
            >×</button>
          </div>
        `
      )}
    </div>
  `;

  return html`
    <div className=${`jira-task-links ${compact ? "compact" : ""}`}>
      <div className="jira-task-header">
        <strong>Jira stories</strong>
        <button className="button-secondary" type="button" onClick=${() => { setPickerError(""); setShowPicker(true); }}>
          Find & Link jira stories
        </button>
      </div>
      ${loading && !links.length
        ? html`<div className="help-text">Loading…</div>`
        : links.length
          ? flat
            ? chipRow(groups[0])
            : groups.map(
                (group) => html`
                  <div
                    className="jira-team-bucket"
                    key=${group.team ? group.team.id : "unassigned"}
                  >
                    <div className="jira-team-bucket-heading">
                      ${group.team
                        ? html`
                            <span className="team-dot" style=${{ background: group.team.color }}></span>
                            <strong>${group.team.name}</strong>
                          `
                        : html`<strong>Unassigned</strong>`}
                      <span className="tiny-pill">${group.links.length}</span>
                    </div>
                    ${chipRow(group)}
                  </div>
                `
              )
          : html`<div className="help-text">No Jira stories linked to this ${noun} yet.</div>`}
      ${showPicker
        ? html`
            <${JiraPickerModal}
              title=${`Link Jira story to ${noun}`}
              teams=${null}
              onClose=${() => setShowPicker(false)}
              onLink=${linkIssue}
              onLinkMany=${linkMany}
              submitting=${submitting}
              error=${pickerError}
              setError=${setPickerError}
              epicKeys=${epicKeys}
              statusFilter=${statusFilter}
              linkedKeys=${links.map((link) => link.issue.key)}
              projectId=${scope === "deliverables" ? projectId : null}
              initialLabel=${scope === "deliverables" ? labelContext : null}
              initialMode=${autoOpen || (labelContext && labelContext.label) ? "label" : null}
              preselectKeys=${autoOpen ? autoOpen.preselectKeys : null}
              onSetLabel=${scope === "deliverables" ? onSetLabel : null}
            />
          `
        : null}
    </div>
  `;
}

function deliverableToForm(deliverable) {
  return {
    title: deliverable.title,
    description: deliverable.description,
    team_id: String(deliverable.team_id),
    planned_start: deliverable.planned_start,
    planned_end: deliverable.planned_end,
    current_start: deliverable.current_start || "",
    current_end: deliverable.current_end || "",
    status: deliverable.status,
    progress: deliverable.progress,
    dependency_ids: deliverable.dependency_ids.map(String),
    contributor_team_ids: (deliverable.contributor_team_ids || []).map(String),
    jira_keys: [],
    jira_label: deliverable.jira_label || "",
    jira_label_project_key: deliverable.jira_label_project_key || "",
    jira_label_from: deliverable.jira_label_from || "",
    jira_label_to: deliverable.jira_label_to || "",
  };
}

// An empty date box means "no date yet", which the API reads as an explicit null.
// `jira_keys` is create-only — DeliverableUpdate has no such field, and the links
// of a saved deliverable are managed by JiraWorkItemLinks instead.
function deliverablePayload(form, { includeJiraKeys = false } = {}) {
  return {
    title: form.title,
    description: form.description || "",
    team_id: Number(form.team_id),
    planned_start: form.planned_start,
    planned_end: form.planned_end,
    current_start: form.current_start || null,
    current_end: form.current_end || null,
    status: form.status,
    progress: Number(form.progress),
    dependency_ids: (form.dependency_ids || []).map(Number),
    contributor_team_ids: (form.contributor_team_ids || []).map(Number),
    // Empty strings are "no label yet"; the API reads null as an explicit clear.
    jira_label: (form.jira_label || "").trim() || null,
    jira_label_project_key: (form.jira_label_project_key || "").trim() || null,
    jira_label_from: form.jira_label_from || null,
    jira_label_to: form.jira_label_to || null,
    ...(includeJiraKeys ? { jira_keys: form.jira_keys || [] } : {}),
  };
}

function milestoneToForm(milestone) {
  return {
    title: milestone.title,
    description: milestone.description || "",
    team_id: String(milestone.team_id),
    target_date: milestone.target_date,
    actual_date: milestone.actual_date || "",
    status: milestone.status,
    progress: milestone.progress,
    jira_keys: [],
  };
}

// An empty actual date means "not landed yet", which the API takes as an explicit
// null; a milestone with no actual date never reads as slipped.
function milestonePayload(form) {
  return {
    title: form.title,
    description: form.description || "",
    team_id: Number(form.team_id),
    target_date: form.target_date,
    actual_date: form.actual_date || null,
    status: form.status,
    progress: Number(form.progress),
  };
}

function LoadingShell({ copy }) {
  return html`
    <div className="loading-shell" role="status" aria-live="polite" aria-label="Loading">
      <div className="loading-card">
        <div className="eyebrow">Booting timeline dashboard</div>
        <h1 className="hero-title">${copy}</h1>
        <div className="skeleton-lines" aria-hidden="true">
          <div className="skeleton-line"></div>
          <div className="skeleton-line short"></div>
          <div className="skeleton-line"></div>
        </div>
      </div>
    </div>
  `;
}

function SummaryCard({ label, value, emphasis, onActivate }) {
  const body = html`
    <div className="summary-label">${label}</div>
    <div className="summary-value">${value}</div>
    <div className="summary-emphasis">${emphasis}</div>
  `;
  if (typeof onActivate === "function") {
    return html`
      <button
        type="button"
        className="summary-card summary-card-button"
        onClick=${onActivate}
        aria-label=${`${label}: ${value}. ${emphasis}`}
      >${body}</button>
    `;
  }
  return html`<div className="summary-card">${body}</div>`;
}

function flashScrollTarget(targetId) {
  const node = document.getElementById(targetId);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "start" });
  node.classList.remove("scroll-flash");
  // reflow so the animation restarts if triggered twice
  void node.offsetWidth;
  node.classList.add("scroll-flash");
  window.setTimeout(() => node.classList.remove("scroll-flash"), 1400);
}

// Descriptions are free text from a textarea: author line breaks survive via
// `white-space: pre-wrap` in styles.css, and [label](url) / bare http(s) URLs
// become real anchors. Elements are constructed, not HTML-injected, so pasted
// markup can never execute.
const RICH_LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;

// A URL that ends a sentence or sits in parentheses picks up characters that
// are punctuation, not part of the link.
function trimUrlTail(url) {
  let href = url;
  while (href.length > 1) {
    const last = href[href.length - 1];
    if (".,;:!?".includes(last)) {
      href = href.slice(0, -1);
      continue;
    }
    const opens = (href.match(/\(/g) || []).length;
    const closes = (href.match(/\)/g) || []).length;
    if (last === ")" && closes > opens) {
      href = href.slice(0, -1);
      continue;
    }
    break;
  }
  return href;
}

function RichText({ text }) {
  const source = typeof text === "string" ? text : "";
  const nodes = [];
  const pattern = new RegExp(RICH_LINK_PATTERN.source, "g");
  let cursor = 0;
  let match = pattern.exec(source);
  while (match) {
    if (match.index > cursor) {
      nodes.push(source.slice(cursor, match.index));
    }
    const [raw, mdLabel, mdHref, bareUrl] = match;
    let href = mdHref;
    let label = mdLabel;
    let consumed = raw.length;
    if (!href) {
      href = trimUrlTail(bareUrl);
      label = href;
      consumed = href.length;
    }
    nodes.push(html`
      <a key=${`link-${match.index}`} href=${href} target="_blank" rel="noopener noreferrer">${label}</a>
    `);
    cursor = match.index + consumed;
    pattern.lastIndex = cursor;
    match = pattern.exec(source);
  }
  if (cursor < source.length) {
    nodes.push(source.slice(cursor));
  }
  return html`<>${nodes}</>`;
}

const DESCRIPTION_HINT =
  "Line breaks are kept. Paste a URL to link it, or write [label](https://…) for a named link.";

function ProjectCard({ project, onOpenProject, onConvert }) {
  const inactive = project.status === "inactive";
  return html`
    <article
      className=${`project-card ${project.is_example ? "example" : ""} ${inactive ? "inactive" : ""}`}
      style=${{ "--project-color": project.color }}
    >
      <div className="project-card-header">
        <div className="project-dot"></div>
        <strong>${project.name}</strong>
        ${project.is_example
          ? html`<span className="tiny-pill project-example-pill">Example</span>`
          : null}
        ${inactive ? html`<span className="tiny-pill project-inactive-pill">Inactive</span>` : null}
      </div>
      <p className="panel-copy project-card-copy">${project.description || "No description yet."}</p>
      <div className="project-stats">
        <span className="tiny-pill">
          ${project.total_releases} ${project.total_releases === 1 ? "release" : "releases"}
        </span>
        <span className="tiny-pill">${project.total_deliverables} deliverables</span>
        <span className="tiny-pill">${project.at_risk_deliverables} at risk</span>
      </div>
      ${project.next_release_date
        ? html`<p className="help-text project-card-release">
            Next release · ${formatReleaseDate(project.next_release_date)}
          </p>`
        : null}
      <div className="actions">
        <button className="button-primary" type="button" onClick=${() => onOpenProject(project.id)}>
          Open project
        </button>
        ${project.is_example
          ? html`<button className="button-secondary" type="button" onClick=${() => onConvert(project)}>
              Make active
            </button>`
          : null}
      </div>
    </article>
  `;
}

function ProjectSection({ title, copy, projects, total, emptyText, onOpenProject, onConvert, className }) {
  return html`
    <section className=${`project-section ${className || ""}`}>
      <div className="project-section-heading">
        <h2>${title}</h2>
        <span className="tiny-pill">${total ?? projects.length}</span>
      </div>
      <p className="panel-copy">${copy}</p>
      ${projects.length
        ? html`
            <div className="project-grid">
              ${projects.map(
                (project) => html`<${ProjectCard}
                  key=${project.id}
                  project=${project}
                  onOpenProject=${onOpenProject}
                  onConvert=${onConvert}
                />`
              )}
            </div>
          `
        : emptyText
          ? html`<div className="empty-state">${emptyText}</div>`
          : null}
    </section>
  `;
}

// Inactive wins over everything: a finished project is out of the way whether or
// not it started life as an example. Real project work first; examples below.
// Shared by the dashboard and the sidebar so both group workspaces identically.
function groupProjects(projects) {
  const inactiveProjects = projects.filter((project) => project.status === "inactive");
  const liveProjects = projects.filter((project) => project.status !== "inactive");
  return {
    activeProjects: liveProjects.filter((project) => !project.is_example),
    exampleProjects: liveProjects.filter((project) => project.is_example),
    inactiveProjects,
  };
}

const DASHBOARD_PROJECTS_PER_GROUP = 3;

// The few projects whose next release is coming up soonest (today or later).
// Projects with no upcoming release date are left out of the dashboard lists.
function soonestByRelease(projects, limit = DASHBOARD_PROJECTS_PER_GROUP) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
  return projects
    .filter((project) => project.next_release_date && project.next_release_date >= today)
    .sort((a, b) => a.next_release_date.localeCompare(b.next_release_date))
    .slice(0, limit);
}

// The few most recently created projects. Example projects have no release dates
// to rank by; `id` breaks ties between rows that share a created_at (migrated ones).
function mostRecentlyCreated(projects, limit = DASHBOARD_PROJECTS_PER_GROUP) {
  const stamp = (project) => (project.created_at ? Date.parse(project.created_at) || 0 : 0);
  return [...projects].sort((a, b) => stamp(b) - stamp(a) || b.id - a.id).slice(0, limit);
}

function alphabetical(projects) {
  return [...projects].sort((a, b) => a.name.localeCompare(b.name));
}

function DashboardView({ projects, onOpenProject, onNewProject, onConvert }) {
  const grouped = groupProjects(projects);
  const activeProjects = soonestByRelease(grouped.activeProjects);
  const exampleProjects = mostRecentlyCreated(grouped.exampleProjects);
  const inactiveProjects = alphabetical(grouped.inactiveProjects);

  return html`
    <div className="app-shell">
      <section className="landing-hero hero-card landing-hero-row">
        <div>
          <div className="eyebrow">PM Tool v1</div>
          <h1 className="hero-title">PPM Dashboard</h1>
          <p className="hero-copy">
            Select an onboarded project to review timeline risk, dependencies, and delivery status.
          </p>
        </div>
        <button className="button-primary" type="button" onClick=${onNewProject}>
          + New Project
        </button>
      </section>

      <${ProjectSection}
        title="Active projects"
        copy="Projects tracking real delivery work — the 3 with the nearest upcoming release."
        total=${grouped.activeProjects.length}
        projects=${activeProjects}
        emptyText="No active projects yet — use “+ New Project” to create one."
        onOpenProject=${onOpenProject}
        onConvert=${onConvert}
      />

      ${grouped.exampleProjects.length
        ? html`<${ProjectSection}
            className="examples"
            title="Example projects"
            total=${grouped.exampleProjects.length}
            copy="Reference layouts for guidance — safe to experiment in. Showing the 3 most recently created. Use “Make active” to start real work in one."
            projects=${exampleProjects}
            onOpenProject=${onOpenProject}
            onConvert=${onConvert}
          />`
        : null}

      ${grouped.inactiveProjects.length
        ? html`
            <details className="inactive-group">
              <summary>
                Inactive projects <span className="tiny-pill">${grouped.inactiveProjects.length}</span>
              </summary>
              <p className="panel-copy">Projects no longer under way. Still viewable; set one back to active in its settings.</p>
              <div className="project-grid">
                ${inactiveProjects.map(
                  (project) => html`<${ProjectCard}
                    key=${project.id}
                    project=${project}
                    onOpenProject=${onOpenProject}
                    onConvert=${onConvert}
                  />`
                )}
              </div>
            </details>
          `
        : null}
    </div>
  `;
}

const PROJECT_TYPE_OPTIONS = [
  { value: "active", label: "Active project" },
  { value: "example", label: "Example project" },
];
const PROJECT_STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

// Creating a project is a side panel, not a form parked on the page. The type
// choice is explicit: example projects are demo material, listed apart.
function NewProjectDrawer({ onClose, onCreate, submitting }) {
  const [form, setForm] = useState(DEFAULT_PROJECT);

  const submit = async (event) => {
    event.preventDefault();
    if (!form.name.trim()) return;
    await onCreate({
      name: form.name.trim(),
      description: form.description,
      color: form.color,
      is_example: form.is_example,
      release_name: form.release_name.trim() || "Release 1",
      // An empty date box is "no release date yet", not an invalid date.
      release_date: form.release_date || null,
    });
  };

  return html`
    <${SideDrawer} title="New project" onClose=${onClose}>
      <form onSubmit=${submit}>
        <div className="form-grid">
          <div className="field-wide">
            <label>Project type</label>
            <${SegmentedControl}
              ariaLabel="Project type"
              value=${form.is_example ? "example" : "active"}
              options=${PROJECT_TYPE_OPTIONS}
              onChange=${(value) => setForm({ ...form, is_example: value === "example" })}
            />
            <span className="help-text">
              Active projects track real delivery work. Example projects are listed separately and can be made active later.
            </span>
          </div>
          <div className="field-wide">
            <label htmlFor="project-name">Project name</label>
            <div className="name-row-inputs">
              <input
                id="project-color"
                className="color-swatch"
                type="color"
                aria-label="Accent color"
                title="Accent color"
                value=${form.color}
                onInput=${(event) => setForm({ ...form, color: event.target.value })}
              />
              <input
                id="project-name"
                value=${form.name}
                onInput=${(event) => setForm({ ...form, name: event.target.value })}
                required
                autoFocus
              />
            </div>
            <span className="help-text">The square sets the project accent color.</span>
          </div>
          <div className="field-wide">
            <label htmlFor="project-description">Description</label>
            <textarea
              id="project-description"
              rows="5"
              value=${form.description}
              onInput=${(event) => setForm({ ...form, description: event.target.value })}
            ></textarea>
            <span className="help-text">${DESCRIPTION_HINT}</span>
          </div>
          <div className="field-wide">
            <label htmlFor="project-release-name">First release</label>
            <input
              id="project-release-name"
              value=${form.release_name}
              onInput=${(event) => setForm({ ...form, release_name: event.target.value })}
            />
          </div>
          <div className="field-wide">
            <label htmlFor="project-release-date">Release date</label>
            <input
              id="project-release-date"
              type="date"
              value=${form.release_date}
              onInput=${(event) => setForm({ ...form, release_date: event.target.value })}
            />
            <span className="help-text">
              Optional — when this release reaches customers. More releases can be added later.
            </span>
          </div>
        </div>
        <div className="actions">
          <button
            className="button-primary"
            type="submit"
            disabled=${submitting || !form.name.trim()}
            aria-busy=${submitting}
          >Create project</button>
          <button className="button-secondary" type="button" onClick=${onClose}>Cancel</button>
        </div>
      </form>
    <//>
  `;
}

// Promotes an example project to a real one. The sample deliverables are kept
// unless the user opts to clear them, so the project is not silently emptied.
function ConvertToActiveSection({ project, summary, onNotify, onDone }) {
  const [clearSamples, setClearSamples] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const convert = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/projects/${project.id}`, {
        method: "PUT",
        body: JSON.stringify({ is_example: false, clear_sample_data: clearSamples }),
      });
      onNotify(`"${project.name}" is now an active project.`, "success");
      await onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return html`
    <div className="convert-section">
      <strong>Example project</strong>
      <p className="panel-copy" style=${{ margin: 0 }}>
        This is sample material. Convert it to an active project to start tracking real delivery work in it.
      </p>
      <label className="checkbox-field" htmlFor=${`convert-clear-${project.id}`}>
        <input
          id=${`convert-clear-${project.id}`}
          type="checkbox"
          checked=${clearSamples}
          onChange=${(event) => setClearSamples(event.target.checked)}
        />
        Also remove the sample deliverables${summary ? ` (${summary.total_deliverables})` : ""}
      </label>
      <span className="help-text">Teams are kept either way.</span>
      <div className="actions">
        <button className="button-primary" type="button" onClick=${convert} disabled=${busy} aria-busy=${busy}>
          Convert to active project
        </button>
      </div>
      ${error ? html`<div className="side-drawer-row-error">${error}</div>` : null}
    </div>
  `;
}

function ConvertExampleDrawer({ project, onClose, onNotify, onDone }) {
  return html`
    <${SideDrawer} title=${`Make “${project.name}” active`} onClose=${onClose}>
      <${ConvertToActiveSection}
        project=${project}
        summary=${project}
        onNotify=${onNotify}
        onDone=${onDone}
      />
    <//>
  `;
}

// Re-derives Progress % from the work item's linked stories on demand — the
// "By label" prefill only fires at link time, so this is the way to pick up Jira
// movement afterwards. It fills the still-editable field; saving is up to the user.
// Render it as a sibling of the Progress label, never inside it: a button inside a
// <label> forwards its click to the labelled input.
function RecalcProgressButton({ scope = "deliverables", itemId, onProgress, onMessage }) {
  const [working, setWorking] = useState(false);
  const noun = scopeNoun(scope);

  const recalc = async () => {
    setWorking(true);
    try {
      const { total, progress } = await progressFromWorkItemLinks(scope, itemId);
      if (!total) {
        onMessage(`No Jira stories linked to this ${noun} yet — nothing to recalculate.`, "error");
        return;
      }
      onProgress(progress);
      onMessage(
        `Progress recalculated to ${progress}% from ${total} linked story(s) — save to apply.`,
        "success"
      );
    } catch (err) {
      onMessage(await describeJiraFailure(err), "error");
    } finally {
      setWorking(false);
    }
  };

  return html`
    <button
      className="button-secondary recalc-progress"
      type="button"
      onClick=${recalc}
      disabled=${working}
      aria-busy=${working}
      title=${`Recalculate from the Jira stories linked to this ${noun}`}
    >${working ? "Recalculating…" : "Recalculate from Jira"}</button>
  `;
}

// Every editor and picker in the app is a drawer gliding in from the right; there
// are no centered pop-ups. Portalled to <body> so a drawer hosted inside a form
// never makes a nested form, and so its fixed backdrop is not clipped by the
// caller's layout. A drawer opened from another drawer (the story picker) passes
// `top` to stack above it.
const openDrawers = [];

function SideDrawer({ title, subtitle, ariaLabel, wide, top, onClose, children }) {
  // Esc closes only the top-most drawer: a document-level listener per drawer
  // would otherwise dismiss the editor out from under a picker opened above it.
  useEffect(() => {
    const token = {};
    openDrawers.push(token);
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (openDrawers[openDrawers.length - 1] !== token) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      openDrawers.splice(openDrawers.indexOf(token), 1);
    };
  }, [onClose]);

  return createPortal(
    html`
      <div
        className=${`side-drawer-backdrop ${top ? "top" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label=${ariaLabel || title}
        onClick=${onClose}
      >
        <div
          className=${`side-drawer ${wide ? "wide" : ""}`}
          onClick=${(event) => event.stopPropagation()}
        >
          <header className="side-drawer-header">
            <h2>${title}</h2>
            <${CloseButton} onClose=${onClose} />
          </header>
          ${subtitle ? html`<p className="help-text" style=${{ margin: 0 }}>${subtitle}</p>` : null}
          ${children}
        </div>
      </div>
    `,
    document.body
  );
}

function SegmentedControl({ value, options, onChange, ariaLabel }) {
  return html`
    <div className="segmented" role="radiogroup" aria-label=${ariaLabel}>
      ${options.map(
        (option) => html`
          <button
            key=${option.value}
            type="button"
            role="radio"
            aria-checked=${value === option.value}
            className=${`segmented-option ${value === option.value ? "active" : ""}`}
            onClick=${() => onChange(option.value)}
          >${option.label}</button>
        `
      )}
    </div>
  `;
}

function CloseButton({ onClose }) {
  return html`<button className="modal-close" type="button" aria-label="Close" onClick=${onClose}>×</button>`;
}

function DeliverableForm({
  formId,
  hideActions,
  teams,
  deliverables,
  form,
  setForm,
  onSubmit,
  submitLabel,
  submitting,
  idPrefix = "deliverable",
  showJiraPicker,
  epicKeys,
  statusFilter,
  deliverableId,
  onMessage,
  projectId,
}) {
  const handleField = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const fieldId = (name) => `${idPrefix}-${name}`;
  const dependencySet = new Set((form.dependency_ids || []).map(String));
  const toggleDependency = (deliverableId) => {
    const key = String(deliverableId);
    const next = new Set(dependencySet);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setForm({ ...form, dependency_ids: Array.from(next) });
  };
  const [showPicker, setShowPicker] = useState(false);
  const [pickerError, setPickerError] = useState("");

  const ownerId = form.team_id ? String(form.team_id) : "";
  const contributorSet = new Set((form.contributor_team_ids || []).map(String));
  const toggleContributor = (teamId) => {
    const key = String(teamId);
    const next = new Set(contributorSet);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setForm({ ...form, contributor_team_ids: Array.from(next) });
  };

  const pendingKeys = form.jira_keys || [];
  const appendPendingJira = (payload) => {
    const key = (payload.jira_key || "").trim().toUpperCase();
    if (!key) return;
    if (pendingKeys.includes(key)) {
      setShowPicker(false);
      return;
    }
    setForm({ ...form, jira_keys: [...pendingKeys, key] });
    setShowPicker(false);
  };
  // Label search hands over every matching key at once; they are linked after
  // save. It also reports how many of those stories are underway, which seeds
  // the still-editable progress field.
  const appendPendingJiraKeys = (keys, progress) => {
    const next = [...pendingKeys];
    for (const raw of keys || []) {
      const key = (raw || "").trim().toUpperCase();
      if (key && !next.includes(key)) next.push(key);
    }
    const seeded =
      progress === null || progress === undefined ? {} : { progress };
    setForm({ ...form, jira_keys: next, ...seeded });
    setShowPicker(false);
  };
  const removePendingJira = (key) => {
    setForm({ ...form, jira_keys: pendingKeys.filter((existing) => existing !== key) });
  };
  const setLabelFromPicker = ({ label, projectKey, from, to }) =>
    setForm({
      ...form,
      jira_label: label,
      jira_label_project_key: projectKey,
      jira_label_from: from,
      jira_label_to: to,
    });
  const clearLabel = () =>
    setForm({
      ...form,
      jira_label: "",
      jira_label_project_key: "",
      jira_label_from: "",
      jira_label_to: "",
    });

  return html`
    <form id=${formId} onSubmit=${onSubmit}>
      <div className="form-grid">
        <div className="field-wide">
          <label htmlFor=${fieldId("title")}>Title</label>
          <input id=${fieldId("title")} value=${form.title} onInput=${handleField("title")} required />
        </div>

        <div className="field">
          <label htmlFor=${fieldId("team")}>Owning team</label>
          <select id=${fieldId("team")} value=${form.team_id} onChange=${handleField("team_id")} required>
            <option value="">Select a team</option>
            ${teams.map((team) => html`<option key=${team.id} value=${team.id}>${team.name}</option>`)}
          </select>
        </div>

        <div className="field">
          <label htmlFor=${fieldId("status")}>Status</label>
          <select id=${fieldId("status")} value=${form.status} onChange=${handleField("status")}>
            ${STATUS_OPTIONS.map((status) => html`<option key=${status} value=${status}>${humanizeStatus(status)}</option>`) }
          </select>
        </div>

        <div className="field">
          <label htmlFor=${fieldId("planned-start")}>Planned start</label>
          <input id=${fieldId("planned-start")} type="date" value=${form.planned_start} onInput=${handleField("planned_start")} required />
        </div>

        <div className="field">
          <label htmlFor=${fieldId("planned-end")}>Planned end</label>
          <input id=${fieldId("planned-end")} type="date" value=${form.planned_end} onInput=${handleField("planned_end")} required />
        </div>

        <div className="field">
          <label htmlFor=${fieldId("current-start")}>Current start</label>
          <input id=${fieldId("current-start")} type="date" value=${form.current_start} onInput=${handleField("current_start")} />
        </div>

        <div className="field">
          <label htmlFor=${fieldId("current-end")}>Current end</label>
          <input id=${fieldId("current-end")} type="date" value=${form.current_end} onInput=${handleField("current_end")} />
        </div>

        <div className="field">
          <label htmlFor=${fieldId("progress")}>Progress %</label>
          <input id=${fieldId("progress")} type="number" min="0" max="100" value=${form.progress} onInput=${handleField("progress")} />
          ${deliverableId
            ? html`<${RecalcProgressButton}
                itemId=${deliverableId}
                onProgress=${(value) => setForm((current) => ({ ...current, progress: value }))}
                onMessage=${onMessage}
              />`
            : null}
        </div>

        <div className="field-wide">
          <label>Contributing teams</label>
          <div className="contrib-chips" role="group" aria-label="Contributing teams">
            ${teams
              .filter((team) => String(team.id) !== ownerId)
              .map((team) => {
                const selected = contributorSet.has(String(team.id));
                return html`
                  <button
                    key=${team.id}
                    type="button"
                    className=${`contrib-chip ${selected ? "selected" : ""}`}
                    aria-pressed=${selected}
                    onClick=${() => toggleContributor(team.id)}
                  >
                    <span className="team-dot" style=${{ background: team.color }}></span>
                    ${team.name}
                  </button>
                `;
              })}
            ${teams.filter((team) => String(team.id) !== ownerId).length === 0
              ? html`<span className="help-text">No other teams available.</span>`
              : null}
          </div>
        </div>

        <div className="field-wide">
          <label>Upstream dependencies</label>
          <div className="contrib-chips" role="group" aria-label="Upstream dependencies">
            ${deliverables.length
              ? deliverables.map((deliverable) => {
                  const selected = dependencySet.has(String(deliverable.id));
                  return html`
                    <button
                      key=${deliverable.id}
                      type="button"
                      className=${`contrib-chip ${selected ? "selected" : ""}`}
                      aria-pressed=${selected}
                      onClick=${() => toggleDependency(deliverable.id)}
                    >
                      ${deliverable.title}
                      <span className="help-text">
                        ${formatDisplayDate(deliverable.planned_start)} – ${formatDisplayDate(deliverable.planned_end)}
                      </span>
                    </button>
                  `;
                })
              : html`<span className="help-text">
                  No other deliverables in this project yet — create one first to set a
                  dependency.
                </span>`}
          </div>
        </div>

        <div className="field-wide">
          <label htmlFor=${fieldId("description")}>Description</label>
          <textarea id=${fieldId("description")} rows="6" value=${form.description} onInput=${handleField("description")}></textarea>
          <span className="help-text">${DESCRIPTION_HINT}</span>
        </div>
      </div>

      ${showJiraPicker
        ? html`
            <div className="jira-pending">
              <div className="jira-pending-header">
                <strong>Jira stories to link on create</strong>
                <button
                  className="button-secondary"
                  type="button"
                  onClick=${() => { setPickerError(""); setShowPicker(true); }}
                >Find & Link jira stories</button>
              </div>
              ${pendingKeys.length
                ? html`
                    <div className="jira-chip-row">
                      ${pendingKeys.map(
                        (key) => html`
                          <div className="jira-chip" key=${key}>
                            <span>${key}</span>
                            <button
                              type="button"
                              className="jira-chip-remove"
                              onClick=${() => removePendingJira(key)}
                              aria-label=${`Remove ${key}`}
                            >×</button>
                          </div>
                        `
                      )}
                    </div>
                  `
                : html`<div className="help-text">None yet — pick stories to link automatically after save.</div>`}
            </div>
          `
        : null}

      ${form.jira_label
        ? html`<div className="field-wide jira-label-field">
        <label>Jira label</label>
        <div className="jira-chip">
              <span>${form.jira_label}</span>
              ${form.jira_label_project_key
                ? html`<span className="tiny-pill">${form.jira_label_project_key}</span>`
                : null}
              ${form.jira_label_from || form.jira_label_to
                ? html`<span className="tiny-pill">
                    ${form.jira_label_from || "…"} – ${form.jira_label_to || "…"}
                  </span>`
                : null}
              <button
                type="button"
                className="jira-chip-remove"
                onClick=${clearLabel}
                aria-label="Clear Jira label"
              >×</button>
            </div>
      </div>`
        : null}

      ${hideActions
        ? null
        : html`<div className="actions">
            <button className="button-primary" type="submit" disabled=${submitting} aria-busy=${submitting}>${submitLabel}</button>
          </div>`}

      ${showPicker
        ? html`
            <${JiraPickerModal}
              title="Select Jira stories to link on create"
              teams=${null}
              onClose=${() => setShowPicker(false)}
              onLink=${appendPendingJira}
              onLinkMany=${appendPendingJiraKeys}
              submitting=${false}
              error=${pickerError}
              setError=${setPickerError}
              epicKeys=${epicKeys}
              statusFilter=${statusFilter}
              linkedKeys=${pendingKeys}
              projectId=${projectId}
              initialLabel=${{
                label: form.jira_label,
                projectKey: form.jira_label_project_key,
                from: form.jira_label_from,
                to: form.jira_label_to,
              }}
              initialMode=${form.jira_label ? "label" : null}
              onSetLabel=${setLabelFromPicker}
            />
          `
        : null}
    </form>
  `;
}

// Deliberately narrower than DeliverableForm: a milestone has one target date
// (plus the date it actually landed on), and no dependencies or contributing
// teams — those stay a property of the parent deliverable.
function MilestoneForm({
  teams,
  form,
  setForm,
  onSubmit,
  submitLabel,
  submitting,
  idPrefix,
  showJiraPicker,
  epicKeys,
  statusFilter,
  milestoneId,
  onMessage,
}) {
  const handleField = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const [showPicker, setShowPicker] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const fieldId = (name) => `${idPrefix}-${name}`;

  const pendingKeys = form.jira_keys || [];
  const appendPendingJira = (payload) => {
    const key = (payload.jira_key || "").trim().toUpperCase();
    if (!key) {
      setShowPicker(false);
      return;
    }
    if (!pendingKeys.includes(key)) setForm({ ...form, jira_keys: [...pendingKeys, key] });
    setShowPicker(false);
  };
  const appendPendingJiraKeys = (keys, progress) => {
    const next = [...pendingKeys];
    for (const raw of keys || []) {
      const key = (raw || "").trim().toUpperCase();
      if (key && !next.includes(key)) next.push(key);
    }
    const seeded = progress === null || progress === undefined ? {} : { progress };
    setForm({ ...form, jira_keys: next, ...seeded });
    setShowPicker(false);
  };
  const removePendingJira = (key) => {
    setForm({ ...form, jira_keys: pendingKeys.filter((existing) => existing !== key) });
  };

  return html`
    <form onSubmit=${onSubmit}>
      <div className="form-grid">
        <div className="field-wide">
          <label htmlFor=${fieldId("title")}>Title</label>
          <input id=${fieldId("title")} value=${form.title} onInput=${handleField("title")} required />
        </div>

        <div className="field">
          <label htmlFor=${fieldId("team")}>Owning team</label>
          <select id=${fieldId("team")} value=${form.team_id} onChange=${handleField("team_id")} required>
            <option value="">Select a team</option>
            ${teams.map((team) => html`<option key=${team.id} value=${team.id}>${team.name}</option>`)}
          </select>
          <span className="help-text">
            Any team on the project can own a milestone, not just the deliverable's own team.
          </span>
        </div>

        <div className="field">
          <label htmlFor=${fieldId("status")}>Status</label>
          <select id=${fieldId("status")} value=${form.status} onChange=${handleField("status")}>
            ${STATUS_OPTIONS.map(
              (status) => html`<option key=${status} value=${status}>${humanizeStatus(status)}</option>`
            )}
          </select>
        </div>

        <div className="field">
          <label htmlFor=${fieldId("target-date")}>Target date</label>
          <input
            id=${fieldId("target-date")}
            type="date"
            value=${form.target_date}
            onInput=${handleField("target_date")}
            required
          />
        </div>

        <div className="field">
          <label htmlFor=${fieldId("actual-date")}>Actual date</label>
          <input
            id=${fieldId("actual-date")}
            type="date"
            value=${form.actual_date}
            onInput=${handleField("actual_date")}
          />
          <span className="help-text">
            Leave empty while it is still open — an actual date after the target counts as a slip.
          </span>
        </div>

        <div className="field">
          <label htmlFor=${fieldId("progress")}>Progress %</label>
          <input
            id=${fieldId("progress")}
            type="number"
            min="0"
            max="100"
            value=${form.progress}
            onInput=${handleField("progress")}
          />
          ${milestoneId
            ? html`<${RecalcProgressButton}
                scope="milestones"
                itemId=${milestoneId}
                onProgress=${(value) => setForm((current) => ({ ...current, progress: value }))}
                onMessage=${onMessage}
              />`
            : null}
        </div>

        <div className="field-wide">
          <label htmlFor=${fieldId("description")}>Description</label>
          <textarea
            id=${fieldId("description")}
            rows="4"
            value=${form.description}
            onInput=${handleField("description")}
          ></textarea>
          <span className="help-text">${DESCRIPTION_HINT}</span>
        </div>
      </div>

      ${showJiraPicker
        ? html`
            <div className="jira-pending">
              <div className="jira-pending-header">
                <strong>Jira stories to link on create</strong>
                <button
                  className="button-secondary"
                  type="button"
                  onClick=${() => { setPickerError(""); setShowPicker(true); }}
                >Find & Link jira stories</button>
              </div>
              ${pendingKeys.length
                ? html`
                    <div className="jira-chip-row">
                      ${pendingKeys.map(
                        (key) => html`
                          <div className="jira-chip" key=${key}>
                            <span>${key}</span>
                            <button
                              type="button"
                              className="jira-chip-remove"
                              onClick=${() => removePendingJira(key)}
                              aria-label=${`Remove ${key}`}
                            >×</button>
                          </div>
                        `
                      )}
                    </div>
                  `
                : html`<div className="help-text">
                    None yet — pick stories to link automatically after save.
                  </div>`}
            </div>
          `
        : null}

      <div className="actions">
        <button className="button-primary" type="submit" disabled=${submitting} aria-busy=${submitting}>
          ${submitLabel}
        </button>
      </div>

      ${showPicker
        ? html`
            <${JiraPickerModal}
              title="Select Jira stories to link on create"
              teams=${null}
              onClose=${() => setShowPicker(false)}
              onLink=${appendPendingJira}
              onLinkMany=${appendPendingJiraKeys}
              submitting=${false}
              error=${pickerError}
              setError=${setPickerError}
              epicKeys=${epicKeys}
              statusFilter=${statusFilter}
              linkedKeys=${pendingKeys}
            />
          `
        : null}
    </form>
  `;
}

// CSV import is an occasional bulk action, so it hides behind a toggle in the
// roster header instead of holding a panel of its own open all the time.
function CsvImportForm({ csvFile, setCsvFile, onSubmit, submitting }) {
  return html`
    <form className="roster-import" onSubmit=${onSubmit}>
      <div className="field-wide">
        <label htmlFor="csv-file">CSV file</label>
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          onChange=${(event) =>
            setCsvFile(event.target.files && event.target.files[0] ? event.target.files[0] : null)}
        />
        <span className="help-text">
          Imports deliverables into this project only, creating any team the file names.
        </span>
      </div>
      <div className="actions">
        <button className="button-primary" type="submit" disabled=${submitting}>Import CSV</button>
        ${csvFile ? html`<span className="help-text">Selected: ${csvFile.name}</span>` : null}
      </div>
    </form>
  `;
}

// Replaces what used to be four always-open form panels (create deliverable,
// update deliverable, milestones, bulk import). This panel only *reads*: every
// form opens as a modal, so its height no longer grows with the form count. A
// milestone is created from its parent's row, which is where "a milestone cannot
// exist without a deliverable" now shows up in the UI.
function DeliverableRosterPanel({
  deliverables,
  teams,
  deliverableActions,
  milestoneActions,
  submitting,
  onMessage,
  epicKeys,
  epicTeams,
  statusFilter,
  csvFile,
  setCsvFile,
  onCsvSubmit,
  projectId,
  labelSync,
}) {
  // Collapsed by default, keyed by deliverable id — same call as the chart's
  // milestone sub-rows: detail, not the first thing to read.
  const [expanded, setExpanded] = useState({});
  const [importOpen, setImportOpen] = useState(false);
  // null | {kind: "deliverable-create"} | {kind: "deliverable-edit", id}
  //      | {kind: "milestone-create", deliverableId}
  //      | {kind: "milestone-edit", id, deliverableId}
  const [editor, setEditor] = useState(null);
  const [deliverableDraft, setDeliverableDraft] = useState(DEFAULT_DELIVERABLE);
  const [milestoneDraft, setMilestoneDraft] = useState(DEFAULT_MILESTONE);

  const findDeliverable = (id) => deliverables.find((item) => String(item.id) === String(id));
  const closeEditor = () => setEditor(null);
  const toggle = (deliverableId) =>
    setExpanded((current) => ({ ...current, [deliverableId]: !current[deliverableId] }));

  const openDeliverableCreate = () => {
    setDeliverableDraft({
      ...DEFAULT_DELIVERABLE,
      team_id: teams[0] ? String(teams[0].id) : "",
    });
    setEditor({ kind: "deliverable-create" });
  };

  // `newKeys` comes from the "N new" badge: the editor opens straight into the
  // label picker with those stories ticked. Nothing is linked until the user
  // clicks "Link selected".
  const openDeliverableEdit = (deliverable, newKeys) => {
    setDeliverableDraft(deliverableToForm(deliverable));
    setEditor({
      kind: "deliverable-edit",
      id: deliverable.id,
      ...(newKeys ? { autoOpen: { preselectKeys: newKeys } } : {}),
    });
    if (labelSync) labelSync.run({ deliverableId: deliverable.id, force: true });
  };

  // The new milestone inherits its parent's team as a starting point; any team on
  // the project can own it.
  const openMilestoneCreate = (deliverable) => {
    setMilestoneDraft({ ...DEFAULT_MILESTONE, team_id: String(deliverable.team_id) });
    setEditor({ kind: "milestone-create", deliverableId: deliverable.id });
    setExpanded((current) => ({ ...current, [deliverable.id]: true }));
  };

  const openMilestoneEdit = (deliverable, milestone) => {
    setMilestoneDraft(milestoneToForm(milestone));
    setEditor({ kind: "milestone-edit", id: milestone.id, deliverableId: deliverable.id });
  };

  // A refresh can delete the row an open editor points at — the Remove button
  // beside it, or another tab.
  useEffect(() => {
    if (!editor) return;
    if (editor.kind === "deliverable-edit" && !findDeliverable(editor.id)) {
      setEditor(null);
      return;
    }
    if (editor.kind === "milestone-create" && !findDeliverable(editor.deliverableId)) {
      setEditor(null);
      return;
    }
    if (editor.kind === "milestone-edit") {
      const parent = findDeliverable(editor.deliverableId);
      const stillThere =
        parent &&
        (parent.milestones || []).some((item) => String(item.id) === String(editor.id));
      if (!stillThere) setEditor(null);
    }
  }, [deliverables]);

  // Every submit closes only when the write actually landed, so a rejected save
  // keeps the typed values on screen.
  const submitDeliverableCreate = async (event) => {
    event.preventDefault();
    const ok = await deliverableActions.create(
      deliverablePayload(deliverableDraft, { includeJiraKeys: true })
    );
    if (ok) {
      closeEditor();
      if (labelSync) labelSync.run();
    }
  };

  const submitDeliverableEdit = async (event) => {
    event.preventDefault();
    const ok = await deliverableActions.update(
      Number(editor.id),
      deliverablePayload(deliverableDraft)
    );
    if (ok) {
      // A label saved or changed is checked straight away.
      if (labelSync) labelSync.run({ deliverableId: Number(editor.id), force: true });
      closeEditor();
    }
  };

  const submitMilestoneCreate = async (event) => {
    event.preventDefault();
    const ok = await milestoneActions.create(Number(editor.deliverableId), {
      ...milestonePayload(milestoneDraft),
      jira_keys: milestoneDraft.jira_keys || [],
    });
    if (ok) closeEditor();
  };

  const submitMilestoneEdit = async (event) => {
    event.preventDefault();
    const ok = await milestoneActions.update(Number(editor.id), milestonePayload(milestoneDraft));
    if (ok) closeEditor();
  };

  const milestoneRow = (deliverable, milestone) => html`
    <div className="milestone-list-row" key=${milestone.id}>
      <span className="team-dot" style=${{ background: milestone.team_color }}></span>
      <div>
        <strong>${milestone.title}</strong>
        <div className="task-meta">
          <span className="tiny-pill">${milestone.team_name}</span>
          <span className="tiny-pill">Target: ${formatDisplayDate(milestone.target_date)}</span>
          ${milestone.actual_date
            ? html`<span className="tiny-pill">
                Actual: ${formatDisplayDate(milestone.actual_date)}
              </span>`
            : null}
          <span className="tiny-pill">${humanizeStatus(milestone.status)}</span>
          <span className="tiny-pill">${milestone.progress}%</span>
          ${milestone.slipped
            ? html`<span className="risk-badge high">Slipped ${milestone.slip_days}d</span>`
            : null}
        </div>
      </div>
      <div className="milestone-list-actions">
        <button
          className="button-secondary"
          type="button"
          disabled=${submitting}
          onClick=${() => openMilestoneEdit(deliverable, milestone)}
        >Edit</button>
        <button
          className="button-secondary"
          type="button"
          disabled=${submitting}
          onClick=${() => milestoneActions.remove(milestone.id)}
        >Remove</button>
      </div>
    </div>
  `;

  const deliverableRow = (deliverable) => {
    const milestones = deliverable.milestones || [];
    const open = Boolean(expanded[deliverable.id]);
    return html`
      <div className="roster-item" key=${deliverable.id}>
        <div className="roster-row">
          <span className="team-dot" style=${{ background: deliverable.team_color }}></span>
          <div>
            <strong>${deliverable.title}</strong>
            <div className="task-meta">
              <span className="tiny-pill">${deliverable.team_name}</span>
              <span className="tiny-pill">
                Plan: ${formatDisplayDate(deliverable.planned_start)} –
                ${" "}${formatDisplayDate(deliverable.planned_end)}
              </span>
              <span className="tiny-pill">${humanizeStatus(deliverable.status)}</span>
              <span className="tiny-pill">${deliverable.progress}%</span>
              ${deliverable.jira_label
                ? html`<span className="tiny-pill" title="Jira label">🏷 ${deliverable.jira_label}</span>`
                : null}
              ${labelSync &&
              labelSync.byDeliverable[deliverable.id] &&
              labelSync.byDeliverable[deliverable.id].new_count
                ? html`<button
                    type="button"
                    className="tiny-pill jira-new-badge"
                    title="Jira stories with this label that are not linked yet — click to review"
                    onClick=${() =>
                      openDeliverableEdit(deliverable, labelSync.byDeliverable[deliverable.id].new_keys)}
                  >${labelSync.byDeliverable[deliverable.id].new_count} new</button>`
                : null}
              ${deliverable.at_risk
                ? html`<span className=${`risk-badge ${deliverable.risk_level}`}>
                    ${deliverable.risk_level}
                  </span>`
                : null}
            </div>
            ${milestones.length
              ? html`
                  <button
                    type="button"
                    className="milestone-toggle"
                    aria-expanded=${open}
                    onClick=${() => toggle(deliverable.id)}
                  >
                    ${open ? "▾" : "▸"} ${milestones.length}
                    ${milestones.length === 1 ? "milestone" : "milestones"}
                  </button>
                `
              : html`<span className="help-text">No milestones yet.</span>`}
          </div>
          <div className="roster-row-actions">
            <button
              className="button-secondary"
              type="button"
              disabled=${submitting}
              onClick=${() => openDeliverableEdit(deliverable)}
            >Edit</button>
            <button
              className="button-secondary"
              type="button"
              disabled=${submitting}
              onClick=${() => openMilestoneCreate(deliverable)}
            >+ Milestone</button>
          </div>
        </div>
        ${open && milestones.length
          ? html`<div className="roster-milestones">
              ${milestones.map((milestone) => milestoneRow(deliverable, milestone))}
            </div>`
          : null}
      </div>
    `;
  };

  const editingDeliverable =
    editor && editor.kind === "deliverable-edit" ? findDeliverable(editor.id) : null;
  const milestoneParent =
    editor && editor.deliverableId ? findDeliverable(editor.deliverableId) : null;
  const editingMilestone =
    editor && editor.kind === "milestone-edit" && milestoneParent
      ? (milestoneParent.milestones || []).find((item) => String(item.id) === String(editor.id))
      : null;

  return html`
    <article className="panel roster-panel" id="deliverables-section">
      <div className="roster-header">
        <div>
          <h2>Deliverables & milestones</h2>
          <p className="panel-copy">
            Deliverables are this project's features and enhancements; a milestone is one dated
            piece of a deliverable that any team can own. Editing opens a dialog, so the timeline
            above stays what you read.
          </p>
        </div>
        <div className="actions">
          <button
            className="button-primary"
            type="button"
            disabled=${!teams.length || submitting}
            onClick=${openDeliverableCreate}
          >+ New deliverable</button>
          <button
            className="button-secondary"
            type="button"
            aria-expanded=${importOpen}
            onClick=${() => setImportOpen(!importOpen)}
          >${importOpen ? "Hide import" : "Import CSV"}</button>
        </div>
      </div>

      ${teams.length
        ? null
        : html`<div className="help-text">
            Add a team before the first deliverable — open the Teams card at the top of the
            release overview.
          </div>`}

      ${importOpen
        ? html`<${CsvImportForm}
            csvFile=${csvFile}
            setCsvFile=${setCsvFile}
            onSubmit=${onCsvSubmit}
            submitting=${submitting}
          />`
        : null}

      ${deliverables.length
        ? html`<div className="roster-list">${deliverables.map(deliverableRow)}</div>`
        : html`<div className="empty-state">
            No deliverables yet — create the first one to start the timeline.
          </div>`}

      ${editor && editor.kind === "deliverable-create"
        ? html`
            <${DeliverableEditorModal}
              mode="create"
              teams=${teams}
              deliverables=${deliverables}
              form=${deliverableDraft}
              setForm=${setDeliverableDraft}
              onSave=${submitDeliverableCreate}
              onCancel=${closeEditor}
              submitting=${submitting}
              onMessage=${onMessage}
              epicKeys=${epicKeys}
              statusFilter=${statusFilter}
              epicTeams=${epicTeams}
              projectId=${projectId}
            />
          `
        : null}

      ${editingDeliverable
        ? html`
            <${DeliverableEditorModal}
              mode="edit"
              deliverableId=${Number(editingDeliverable.id)}
              title=${editingDeliverable.title}
              teams=${teams}
              deliverables=${deliverables.filter(
                (item) => String(item.id) !== String(editingDeliverable.id)
              )}
              form=${deliverableDraft}
              setForm=${setDeliverableDraft}
              onSave=${submitDeliverableEdit}
              onCancel=${closeEditor}
              submitting=${submitting}
              onMessage=${onMessage}
              epicKeys=${epicKeys}
              statusFilter=${statusFilter}
              epicTeams=${epicTeams}
              projectId=${projectId}
              autoOpen=${editor.autoOpen}
              onLinked=${() =>
                labelSync && labelSync.run({ deliverableId: Number(editingDeliverable.id), force: true })}
            />
          `
        : null}

      ${editor && editor.kind === "milestone-create" && milestoneParent
        ? html`
            <${MilestoneEditorModal}
              mode="create"
              parentTitle=${milestoneParent.title}
              teams=${teams}
              form=${milestoneDraft}
              setForm=${setMilestoneDraft}
              onSave=${submitMilestoneCreate}
              onCancel=${closeEditor}
              submitting=${submitting}
              onMessage=${onMessage}
              epicKeys=${epicKeys}
              statusFilter=${statusFilter}
              epicTeams=${epicTeams}
            />
          `
        : null}

      ${editingMilestone
        ? html`
            <${MilestoneEditorModal}
              milestone=${editingMilestone}
              parentTitle=${milestoneParent.title}
              teams=${teams}
              form=${milestoneDraft}
              setForm=${setMilestoneDraft}
              onSave=${submitMilestoneEdit}
              onCancel=${closeEditor}
              submitting=${submitting}
              onMessage=${onMessage}
              epicKeys=${epicKeys}
              statusFilter=${statusFilter}
              epicTeams=${epicTeams}
            />
          `
        : null}
    </article>
  `;
}

// Shell every editor shares. Portalled to <body> because as an in-row element an
// editor stretched the timeline grid and scrolled with the chart, and because
// mounting outside the caller's markup keeps the story picker it may host from
// ever becoming a nested form. A plain div, not a form, for the same reason.
function EditorModal({ title, subtitle, wide, onClose, children }) {
  return html`<${SideDrawer} title=${title} subtitle=${subtitle} wide=${wide} onClose=${onClose}>
    ${children}
  <//>`;
}

// The chart's own editor: deliberately narrower than the roster's full form, for
// the status/progress/date nudges that make up most timeline edits.
function InlineEditPopover({
  deliverable,
  form,
  setForm,
  onSave,
  onCancel,
  submitting,
  onMessage,
  epicKeys,
  statusFilter,
  teams,
  epicTeams,
}) {
  const handleField = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  return html`
    <${EditorModal} title=${`Quick edit: ${deliverable.title}`} onClose=${onCancel}>
        <div className="inline-grid">
          <label>
            Status
            <select value=${form.status} onChange=${handleField("status")}>
              ${STATUS_OPTIONS.map((status) => html`<option key=${status} value=${status}>${humanizeStatus(status)}</option>`) }
            </select>
          </label>
          <label>
            Progress
            <input type="number" min="0" max="100" value=${form.progress} onInput=${handleField("progress")} />
          </label>
          <${RecalcProgressButton}
            itemId=${deliverable.id}
            onProgress=${(value) => setForm((current) => ({ ...current, progress: value }))}
            onMessage=${onMessage}
          />
          <label>
            Current start
            <input type="date" value=${form.current_start || ""} onInput=${handleField("current_start")} />
          </label>
          <label>
            Current end
            <input type="date" value=${form.current_end || ""} onInput=${handleField("current_end")} />
          </label>
        </div>
        <div className="actions">
          <button
            className="button-primary"
            type="button"
            onClick=${onSave}
            disabled=${submitting}
            aria-busy=${submitting}
          >Save</button>
          <button className="button-secondary" type="button" onClick=${onCancel}>Cancel</button>
        </div>
        <${JiraWorkItemLinks}
          itemId=${deliverable.id}
          onMessage=${onMessage}
          epicKeys=${epicKeys}
          statusFilter=${statusFilter}
          onProgressSuggested=${(value) =>
            setForm((current) => ({ ...current, progress: value }))}
          teams=${teams}
          epicTeams=${epicTeams}
          compact=${true}
        />
    <//>
  `;
}

// One milestone editor for both the timeline diamonds and the roster panel. In
// create mode there is no id yet, so it offers the pre-save story picker instead
// of the live links strip.
function MilestoneEditorModal({
  mode = "edit",
  milestone,
  parentTitle,
  teams,
  form,
  setForm,
  onSave,
  onCancel,
  submitting,
  onMessage,
  epicKeys,
  statusFilter,
  epicTeams,
  projectId,
  autoOpen,
  onLinked,
}) {
  const creating = mode === "create";
  const setLabel = ({ label, projectKey, from, to }) =>
    setForm((current) => ({
      ...current,
      jira_label: label,
      jira_label_project_key: projectKey,
      jira_label_from: from,
      jira_label_to: to,
    }));

  return html`
    <${EditorModal}
      title=${creating ? `New milestone in “${parentTitle}”` : `Milestone: ${milestone.title}`}
      subtitle=${creating
        ? "A milestone is one dated piece of this deliverable, and any team on the project can own it."
        : `Part of ${parentTitle || "its deliverable"} — a slip here raises that deliverable's risk, but its progress % stays its own.`}
      onClose=${onCancel}
    >
        <${MilestoneForm}
          teams=${teams}
          form=${form}
          setForm=${setForm}
          onSubmit=${onSave}
          submitLabel=${creating ? "Create milestone" : "Save milestone"}
          submitting=${submitting}
          idPrefix=${creating ? "milestone-create" : "milestone-edit"}
          showJiraPicker=${creating}
          epicKeys=${epicKeys}
          statusFilter=${statusFilter}
          milestoneId=${creating ? null : milestone.id}
          onMessage=${onMessage}
        />
        ${creating
          ? null
          : html`
              <${JiraWorkItemLinks}
                scope="milestones"
                itemId=${milestone.id}
                onMessage=${onMessage}
                epicKeys=${epicKeys}
                statusFilter=${statusFilter}
                onProgressSuggested=${(value) =>
                  setForm((current) => ({ ...current, progress: value }))}
                teams=${teams}
                epicTeams=${epicTeams}
                compact=${true}
                projectId=${projectId}
                onLinked=${onLinked}
                autoOpen=${autoOpen}
                onSetLabel=${setLabel}
                labelContext=${{
                  label: form.jira_label,
                  projectKey: form.jira_label_project_key,
                  from: form.jira_label_from,
                  to: form.jira_label_to,
                }}
              />
            `}
    <//>
  `;
}

// The full deliverable editor, opened from the roster. Wider than the other
// editors because DeliverableForm lays its fields out in two columns.
function DeliverableEditorModal({
  mode = "edit",
  deliverableId,
  title,
  teams,
  deliverables,
  form,
  setForm,
  onSave,
  onCancel,
  submitting,
  onMessage,
  epicKeys,
  statusFilter,
  epicTeams,
  projectId,
  autoOpen,
  onLinked,
}) {
  const creating = mode === "create";
  const setLabel = ({ label, projectKey, from, to }) =>
    setForm((current) => ({
      ...current,
      jira_label: label,
      jira_label_project_key: projectKey,
      jira_label_from: from,
      jira_label_to: to,
    }));

  return html`
    <${EditorModal}
      title=${creating ? "New deliverable" : `Edit: ${title}`}
      wide=${true}
      onClose=${onCancel}
    >
        <${DeliverableForm}
          teams=${teams}
          deliverables=${deliverables}
          form=${form}
          setForm=${setForm}
          onSubmit=${onSave}
          formId="deliverable-form"
          hideActions=${true}
          submitLabel=${creating ? "Create deliverable" : "Save deliverable"}
          submitting=${submitting}
          idPrefix=${creating ? "deliverable-create" : "deliverable-edit"}
          showJiraPicker=${creating}
          epicKeys=${epicKeys}
          statusFilter=${statusFilter}
          deliverableId=${creating ? null : deliverableId}
          onMessage=${onMessage}
          projectId=${projectId}
        />
        ${creating
          ? null
          : html`
              <${JiraWorkItemLinks}
                itemId=${deliverableId}
                onMessage=${onMessage}
                epicKeys=${epicKeys}
                statusFilter=${statusFilter}
                onProgressSuggested=${(value) =>
                  setForm((current) => ({ ...current, progress: value }))}
                teams=${teams}
                epicTeams=${epicTeams}
                compact=${true}
                projectId=${projectId}
                onLinked=${onLinked}
                autoOpen=${autoOpen}
                onSetLabel=${setLabel}
                labelContext=${{
                  label: form.jira_label,
                  projectKey: form.jira_label_project_key,
                  from: form.jira_label_from,
                  to: form.jira_label_to,
                }}
              />
            `}
        <div className="actions">
          <button
            className="button-primary"
            type="submit"
            form="deliverable-form"
            disabled=${submitting}
            aria-busy=${submitting}
          >${creating ? "Create deliverable" : "Save deliverable"}</button>
        </div>
    <//>
  `;
}

// One column per day reads well for a short project but turns a multi-month plan
// into a wall of unreadable columns, so past this many days the chart switches to
// one column per week and leans on the month band for orientation.
const DAY_COLUMN_LIMIT = 45;

// The single source of column geometry: the header cells, the row grids, the
// release layer and every bar are all laid out from this one span, which is what
// keeps a bar under its own calendar date. `spanDays` counts both endpoints, so
// each day is a slice of the grid rather than a fencepost — divide by
// `end - start` instead and every bar drifts left by up to a whole column.
function buildTimeline(dates) {
  if (!dates.length) {
    const today = startOfDay(new Date());
    return buildTimeline([today, addDays(today, 14)]);
  }
  const min = dates.reduce((current, value) => (value < current ? value : current), dates[0]);
  const max = dates.reduce((current, value) => (value > current ? value : current), dates[0]);
  const unit = differenceInDays(min, max) > DAY_COLUMN_LIMIT ? "week" : "day";
  // Week mode snaps to whole weeks: the span has to divide evenly into columns or
  // the headings and the bars would describe different amounts of time.
  const start = unit === "week" ? startOfWeek(min) : addDays(min, -1);
  const end = unit === "week" ? addDays(startOfWeek(max), 6) : addDays(max, 2);
  const step = unit === "week" ? 7 : 1;
  const spanDays = differenceInDays(start, end) + 1;
  const columns = Array.from({ length: Math.round(spanDays / step) }, (_, index) =>
    addDays(start, index * step)
  );
  // A plan that crosses new year needs the year spelled out to stay readable.
  const monthFormat = new Intl.DateTimeFormat(
    "en",
    start.getFullYear() === end.getFullYear()
      ? { month: "short" }
      : { month: "short", year: "numeric" }
  );
  const months = [];
  for (const column of columns) {
    const key = `${column.getFullYear()}-${column.getMonth()}`;
    const last = months[months.length - 1];
    if (last && last.key === key) {
      last.span += 1;
    } else {
      months.push({ key, label: monthFormat.format(column), span: 1 });
    }
  }
  return { start, end, unit, step, spanDays, columns, months };
}

// Where a date's own column starts — used for the left edge of a bar.
function edgePercent(timeline, value) {
  return (differenceInDays(timeline.start, startOfDay(value)) / timeline.spanDays) * 100;
}

// Mid-day, for the things that mark a moment rather than a stretch: a milestone
// diamond and the release line read as sitting *on* their date this way.
function pointPercent(timeline, value) {
  return ((differenceInDays(timeline.start, startOfDay(value)) + 0.5) / timeline.spanDays) * 100;
}

// A milestone has one date, so it draws a marker rather than a bar. When it
// landed on a different day than planned both markers are drawn with a connector
// between them, which is what makes the slip readable at a glance.
function GanttMilestoneRow({ milestone, timeline, isEditing, onOpen }) {
  const targetLeft = pointPercent(timeline, milestone.target_date);
  const actualLeft = milestone.actual_date ? pointPercent(timeline, milestone.actual_date) : null;
  const drift = actualLeft !== null && Math.abs(actualLeft - targetLeft) > 0.01;
  const dates = milestone.actual_date
    ? `${formatDisplayDate(milestone.target_date)} → ${formatDisplayDate(milestone.actual_date)}`
    : formatDisplayDate(milestone.target_date);
  const tooltip = milestone.slipped
    ? `${milestone.title} — slipped by ${milestone.slip_days} day(s) (${dates})`
    : `${milestone.title} — ${dates}`;

  return html`
    <div className=${`gantt-row milestone-row ${isEditing ? "editing" : ""}`}>
      <div className="task-cell milestone-cell">
        <div className="milestone-cell-title">
          <span className="milestone-swatch" style=${{ background: milestone.team_color }}></span>
          <strong>${milestone.title}</strong>
        </div>
        <div className="task-meta">
          <span className="tiny-pill">${milestone.team_name}</span>
          <span className="tiny-pill">${dates}</span>
          <span className="tiny-pill">${milestone.progress}%</span>
          ${milestone.slipped
            ? html`<span className="risk-badge high">Slipped ${milestone.slip_days}d</span>`
            : null}
        </div>
      </div>
      <div className="timeline-grid milestone-grid">
        ${drift
          ? html`<div
              className="milestone-connector"
              style=${{
                left: `${Math.min(targetLeft, actualLeft)}%`,
                width: `${Math.abs(actualLeft - targetLeft)}%`,
              }}
            ></div>`
          : null}
        <button
          type="button"
          className="milestone-marker target"
          style=${{ left: `${targetLeft}%`, background: milestone.team_color }}
          title=${tooltip}
          aria-label=${tooltip}
          onClick=${() => onOpen(milestone)}
        ></button>
        ${drift
          ? html`<button
              type="button"
              className=${`milestone-marker actual ${milestone.slipped ? "slipped" : ""}`}
              style=${{ left: `${actualLeft}%` }}
              title=${tooltip}
              aria-label=${`${tooltip} (actual)`}
              onClick=${() => onOpen(milestone)}
            ></button>`
          : null}
      </div>
    </div>
  `;
}

function GanttRow({
  deliverable,
  timeline,
  barRefs,
  isEditing,
  onOpenInline,
  milestonesExpanded,
  onToggleMilestones,
  editingMilestoneId,
  onOpenMilestone,
  contributorsExpanded,
  onToggleContributors,
}) {
  const start = startOfDay(deliverable.current_start || deliverable.planned_start);
  const end = startOfDay(deliverable.current_end || deliverable.planned_end);
  const durationDays = Math.max(differenceInDays(start, end) + 1, 1);
  const left = edgePercent(timeline, start);
  const width = (durationDays / timeline.spanDays) * 100;
  const contributors = deliverable.contributor_teams || [];
  const gradient = deliverable.delayed
    ? "linear-gradient(120deg, #b91c1c, #dc2626)"
    : deliverable.at_risk
      ? "linear-gradient(120deg, #b45309, #ea580c)"
      : `linear-gradient(120deg, ${deliverable.team_color}, #0f172a)`;
  const milestones = deliverable.milestones || [];

  return html`
    <>
    <div className="gantt-row">
      <div className="task-cell">
        <strong>${deliverable.title}</strong>
        <div className="task-description"><${RichText} text=${deliverable.description} /></div>
        <div className="task-teams">
          <span className="task-team-owner">
            <span className="team-dot" style=${{ background: deliverable.team_color }}></span>
            ${deliverable.team_name}
          </span>
          ${contributors.length
            ? html`<button
                type="button"
                className="team-plus-pill"
                aria-expanded=${Boolean(contributorsExpanded)}
                title=${contributorsExpanded ? "Hide contributing teams" : "Show contributing teams"}
                onClick=${() => onToggleContributors(deliverable.id)}
              >+${contributors.length}</button>`
            : null}
        </div>
        ${contributors.length && contributorsExpanded
          ? html`
              <div className="team-contrib-list">
                ${contributors.map(
                  (team) => html`
                    <div className="team-contrib-row" key=${team.id}>
                      <span className="team-dot" style=${{ background: team.color }}></span>
                      ${team.name}
                    </div>
                  `
                )}
              </div>
            `
          : null}
        <div className="task-meta">
          <span className="tiny-pill">${humanizeStatus(deliverable.status)}</span>
          <span className="tiny-pill">Plan: ${formatDisplayDate(deliverable.planned_start)} - ${formatDisplayDate(deliverable.planned_end)}</span>
          ${deliverable.at_risk ? html`<span className="tiny-pill">Risk: ${deliverable.risk_level}</span>` : null}
        </div>
        ${milestones.length
          ? html`
              <button
                type="button"
                className="milestone-toggle"
                aria-expanded=${Boolean(milestonesExpanded)}
                onClick=${() => onToggleMilestones(deliverable.id)}
              >
                ${milestonesExpanded ? "▾" : "▸"} ${milestones.length}
                ${milestones.length === 1 ? "milestone" : "milestones"}
              </button>
            `
          : null}
      </div>
      <div className="timeline-grid">
        <button
          ref=${(node) => { if (node) { barRefs.current[deliverable.id] = node; } }}
          className=${`task-bar ${deliverable.risk_level} ${isEditing ? "editing" : ""}`}
          style=${{ left: `${left}%`, width: `${width}%`, background: gradient }}
          title=${deliverable.risk_reasons.join(" | ") || "On track"}
          onClick=${() => onOpenInline(deliverable)}
          type="button"
        >
          <span className="bar-title">${deliverable.title}</span>
          <span className="bar-progress">${deliverable.progress}%</span>
        </button>
      </div>
    </div>
    ${milestonesExpanded
      ? milestones.map(
          (milestone) => html`
            <${GanttMilestoneRow}
              key=${milestone.id}
              milestone=${milestone}
              timeline=${timeline}
              isEditing=${String(milestone.id) === editingMilestoneId}
              onOpen=${onOpenMilestone}
            />
          `
        )
      : null}
    </>
  `;
}

function GanttChart({
  teams,
  deliverables,
  releaseDate,
  keyDates,
  onInlineSave,
  onMilestoneSave,
  submitting,
  statusFilter,
  epicKeys,
  epicTeams,
  onMessage,
}) {
  const barRefs = useRef({});
  const bodyRef = useRef(null);
  const [lines, setLines] = useState([]);
  const [editingDeliverableId, setEditingDeliverableId] = useState("");
  const [inlineForm, setInlineForm] = useState({ status: "planned", progress: 0, current_start: "", current_end: "" });
  // Collapsed by default, keyed by deliverable id: the sub-rows are detail, not
  // the first thing to read on the chart.
  const [expandedMilestones, setExpandedMilestones] = useState({});
  // Kept here rather than inside the row: expanding the list changes the row's
  // height, and the dependency curves are measured from this component.
  const [expandedContributors, setExpandedContributors] = useState({});
  const [editingMilestoneId, setEditingMilestoneId] = useState("");
  const [milestoneForm, setMilestoneForm] = useState(DEFAULT_MILESTONE);

  // Milestone markers and the dated lines are percentages of this same span, so
  // every date that gets drawn has to be inside it or it would land off the chart.
  const timeline = useMemo(() => {
    const dates = [];
    for (const item of deliverables) {
      dates.push(startOfDay(item.current_start || item.planned_start));
      dates.push(startOfDay(item.current_end || item.planned_end));
      for (const milestone of item.milestones || []) {
        dates.push(startOfDay(milestone.target_date));
        if (milestone.actual_date) dates.push(startOfDay(milestone.actual_date));
      }
    }
    if (releaseDate) dates.push(startOfDay(releaseDate));
    for (const keyDate of keyDates || []) {
      if (keyDate.event_date) dates.push(startOfDay(keyDate.event_date));
    }
    return buildTimeline(dates);
  }, [deliverables, releaseDate, keyDates]);

  // Column count and width live on the board, so the header, every row and the
  // date layer are laid out from one set of numbers. They used to size
  // themselves independently, which is what pulled the bars off their dates.
  const boardStyle = {
    "--cols": timeline.columns.length,
    "--col-width": timeline.unit === "week" ? "56px" : "34px",
  };

  // The release date and every other named date the project carries. Each one
  // draws a vertical line down the chart body, and a label in the band that sits
  // between the day headings and the first row — the band is reserved space, so a
  // label can never be covered by a deliverable bar. Labels of dates that fall
  // close together would still overlap each other, so they are packed into lanes
  // and the band grows a row per lane.
  const { markers, markerLanes } = useMemo(() => {
    const raw = [];
    if (releaseDate) {
      raw.push({
        id: "release",
        label: `Release ${formatDisplayDate(releaseDate)}`,
        color: "#1d4ed8",
        date: releaseDate,
      });
    }
    for (const keyDate of keyDates || []) {
      if (!keyDate.event_date) continue;
      raw.push({
        id: `key-${keyDate.id}`,
        label: `${keyDate.name} ${formatDisplayDate(keyDate.event_date)}`,
        color: keyDate.color,
        date: keyDate.event_date,
      });
    }
    const placed = raw
      .map((marker) => ({ ...marker, percent: pointPercent(timeline, marker.date) }))
      .filter((marker) => marker.percent >= 0 && marker.percent <= 100)
      .sort((a, b) => a.percent - b.percent);

    // Lanes are packed against the labels' own widths, and a label's width is a
    // share of the track it is positioned in, so the track's pixel width has to
    // be reconstructed from the same numbers the board grid is laid out from.
    const trackWidth = Math.max(
      timeline.columns.length * (timeline.unit === "week" ? 56 : 34),
      1
    );
    // Enough for the bold 0.7rem pill text plus its padding, and a gap so two
    // labels in one lane never touch.
    const labelWidth = (label) => ((label.length * 6.4 + 20 + 10) / trackWidth) * 100;

    // Highest percent each lane is occupied up to; `placed` is sorted, so a label
    // takes the first lane that is clear where it starts.
    const laneEnds = [];
    const laid = placed.map((marker) => {
      const width = labelWidth(marker.label);
      // Centred on its date, unless that would run off an edge of the track — then
      // it reads inward from the line instead.
      let align = "center";
      let start = marker.percent - width / 2;
      if (start < 0) {
        align = "start";
        start = marker.percent;
      } else if (marker.percent + width / 2 > 100) {
        align = "end";
        start = marker.percent - width;
      }
      let lane = laneEnds.findIndex((end) => end <= start);
      if (lane === -1) {
        lane = laneEnds.length;
      }
      laneEnds[lane] = start + width;
      return { ...marker, lane, align };
    });

    return { markers: laid, markerLanes: Math.max(laneEnds.length, 1) };
  }, [releaseDate, keyDates, timeline]);

  useLayoutEffect(() => {
    function redrawLines() {
      if (!bodyRef.current) {
        return;
      }
      const bodyRect = bodyRef.current.getBoundingClientRect();
      const nextLines = [];
      deliverables.forEach((deliverable) => {
        const target = barRefs.current[deliverable.id];
        if (!target) {
          return;
        }
        const targetRect = target.getBoundingClientRect();
        deliverable.dependency_ids.forEach((dependencyId) => {
          const source = barRefs.current[dependencyId];
          if (!source) {
            return;
          }
          const sourceRect = source.getBoundingClientRect();
          const startX = sourceRect.right - bodyRect.left;
          const startY = sourceRect.top - bodyRect.top + sourceRect.height / 2;
          const endX = targetRect.left - bodyRect.left;
          const endY = targetRect.top - bodyRect.top + targetRect.height / 2;
          const bend = Math.max((endX - startX) / 2, 24);
          nextLines.push({
            id: `${dependencyId}-${deliverable.id}`,
            level: deliverable.risk_level === "none" ? "medium" : deliverable.risk_level,
            path: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
          });
        });
      });
      setLines(nextLines);
    }

    redrawLines();
    window.addEventListener("resize", redrawLines);
    return () => window.removeEventListener("resize", redrawLines);
    // The milestone sub-rows and the contributing-team list both change row
    // heights, so the curves have to be redrawn whenever one is toggled.
  }, [deliverables, timeline.columns.length, expandedMilestones, expandedContributors]);

  const openInline = (deliverable) => {
    setEditingDeliverableId(String(deliverable.id));
    setInlineForm({
      status: deliverable.status,
      progress: deliverable.progress,
      current_start: deliverable.current_start || "",
      current_end: deliverable.current_end || "",
    });
  };

  // One modal for the whole chart, rendered outside the rows: only one deliverable
  // is ever being edited, and keeping it out of a row's markup is what stops it
  // from stretching the timeline grid.
  const editingDeliverable = deliverables.find(
    (deliverable) => String(deliverable.id) === editingDeliverableId
  );

  const saveInline = () => {
    if (!editingDeliverableId) {
      return;
    }
    onInlineSave(Number(editingDeliverableId), {
      status: inlineForm.status,
      progress: Number(inlineForm.progress),
      current_start: inlineForm.current_start || null,
      current_end: inlineForm.current_end || null,
    });
    setEditingDeliverableId("");
  };

  const toggleMilestones = (deliverableId) =>
    setExpandedMilestones((current) => ({
      ...current,
      [deliverableId]: !current[deliverableId],
    }));

  const toggleContributors = (deliverableId) =>
    setExpandedContributors((current) => ({
      ...current,
      [deliverableId]: !current[deliverableId],
    }));

  // Carries the parent's title so the popover can say which deliverable this is
  // a piece of.
  const editingMilestone = useMemo(() => {
    for (const deliverable of deliverables) {
      for (const milestone of deliverable.milestones || []) {
        if (String(milestone.id) === editingMilestoneId) {
          return { ...milestone, deliverable_title: deliverable.title };
        }
      }
    }
    return null;
  }, [deliverables, editingMilestoneId]);

  const openMilestone = (milestone) => {
    setEditingMilestoneId(String(milestone.id));
    setMilestoneForm(milestoneToForm(milestone));
  };

  const saveMilestone = (event) => {
    if (event) event.preventDefault();
    if (!editingMilestoneId) return;
    onMilestoneSave(Number(editingMilestoneId), milestonePayload(milestoneForm));
    setEditingMilestoneId("");
  };

  return html`
    <section className="gantt-shell">
      <div className="gantt-toolbar">
        <div>
          <h2>Timeline overview</h2>
          <p className="gantt-caption">
            Click any deliverable bar — or a milestone diamond — to edit it and link Jira stories
            without leaving the timeline view.
            ${releaseDate
              ? html`<span>
                  ${" "}Customer release: ${formatDisplayDate(releaseDate)}.
                </span>`
              : null}
          </p>
        </div>
        <div className="risk-key">
          <div className="legend-pill"><span className="legend-swatch" style=${{ background: "#166534" }}></span>No risk</div>
          <div className="legend-pill"><span className="legend-swatch" style=${{ background: "#b45309" }}></span>Dependency pressure</div>
          <div className="legend-pill"><span className="legend-swatch" style=${{ background: "#b91c1c" }}></span>Date slipped</div>
        </div>
      </div>

      <div className="gantt-board" style=${boardStyle}>
        <div className="gantt-header">
          <div className="task-cell"><strong>Deliverable</strong></div>
          <div className="timeline-header">
            ${timeline.months.map(
              (month) => html`
                <div
                  className="month-band-cell"
                  key=${month.key}
                  style=${{ gridColumn: `span ${month.span}` }}
                >${month.label}</div>
              `
            )}
            ${timeline.columns.map(
              (column) => html`
                <div className="day-cell" key=${column.toISOString()}>
                  <strong>${column.getDate()}</strong>
                </div>
              `
            )}
          </div>
        </div>

        ${markers.length
          ? html`
              <div className="release-band" style=${{ "--marker-lanes": markerLanes }}>
                <div className="release-band-gutter">Key dates</div>
                <div className="release-band-track">
                  ${markers.map(
                    (marker) => html`
                      <div key=${marker.id} className="release-band-entry">
                        <div
                          className=${`release-band-item align-${marker.align}`}
                          style=${{ left: `${marker.percent}%`, top: `${marker.lane * 22}px` }}
                        >
                          <span
                            className="release-pill"
                            style=${{ background: marker.color }}
                          >${marker.label}</span>
                        </div>
                        <span
                          className="release-band-stem"
                          aria-hidden="true"
                          style=${{
                            left: `${marker.percent}%`,
                            top: `${marker.lane * 22 + 26}px`,
                            borderLeftColor: marker.color,
                          }}
                        ></span>
                      </div>
                    `
                  )}
                </div>
              </div>
            `
          : null}

        <div className="gantt-body" ref=${bodyRef}>
          <svg className="dependency-layer">
            ${lines.map(
              (line) => html`
                <path
                  key=${line.id}
                  d=${line.path}
                  className=${line.level === "high" ? "line-high" : "line-medium"}
                  strokeWidth="3"
                  fill="none"
                  strokeDasharray=${line.level === "high" ? "0" : "8 6"}
                />
              `
            )}
          </svg>

          ${markers.length
            ? html`
                <div className="release-layer" aria-hidden="true">
                  <div className="release-layer-gutter"></div>
                  <div className="release-layer-track">
                    ${markers.map(
                      (marker) => html`
                        <div
                          key=${marker.id}
                          className="release-marker"
                          style=${{
                            left: `${marker.percent}%`,
                            borderLeftColor: marker.color,
                          }}
                        ></div>
                      `
                    )}
                  </div>
                </div>
              `
            : null}

          ${deliverables.length
            ? deliverables.map(
                (deliverable) => html`
                  <${GanttRow}
                    key=${deliverable.id}
                    deliverable=${deliverable}
                    timeline=${timeline}
                    barRefs=${barRefs}
                    isEditing=${String(deliverable.id) === editingDeliverableId}
                    onOpenInline=${openInline}
                    milestonesExpanded=${Boolean(expandedMilestones[deliverable.id])}
                    onToggleMilestones=${toggleMilestones}
                    editingMilestoneId=${editingMilestoneId}
                    onOpenMilestone=${openMilestone}
                    contributorsExpanded=${Boolean(expandedContributors[deliverable.id])}
                    onToggleContributors=${toggleContributors}
                  />
                `
              )
            : html`<div className="empty-state">
                No deliverables yet — create the first one to start the timeline.
              </div>`}
        </div>
      </div>

      ${editingDeliverable
        ? html`
            <${InlineEditPopover}
              deliverable=${editingDeliverable}
              form=${inlineForm}
              setForm=${setInlineForm}
              onSave=${saveInline}
              onCancel=${() => setEditingDeliverableId("")}
              submitting=${submitting}
              onMessage=${onMessage}
              epicKeys=${epicKeys}
              statusFilter=${statusFilter}
              teams=${teams}
              epicTeams=${epicTeams}
            />
          `
        : null}

      ${editingMilestone
        ? html`
            <${MilestoneEditorModal}
              milestone=${editingMilestone}
              parentTitle=${editingMilestone.deliverable_title}
              teams=${teams}
              form=${milestoneForm}
              setForm=${setMilestoneForm}
              onSave=${saveMilestone}
              onCancel=${() => setEditingMilestoneId("")}
              submitting=${submitting}
              onMessage=${onMessage}
              epicKeys=${epicKeys}
              statusFilter=${statusFilter}
              epicTeams=${epicTeams}
            />
          `
        : null}
    </section>
  `;
}

// Named dates a plan is read against — kickoff, code freeze, beta — each drawn
// on the timeline in its own color. The release date keeps its own field above;
// this is everything else. Writes land immediately, like the team rows in the
// Jira panel, so a marker moves as soon as its row is saved.
function TimelineDatesEditor({ projectId, releaseId, keyDates, onNotify, onChanged }) {
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState(DEFAULT_KEY_DATE);
  const [addDraft, setAddDraft] = useState(DEFAULT_KEY_DATE);
  const [rowError, setRowError] = useState({ id: null, message: "" });
  const [busy, setBusy] = useState(false);
  const rows = keyDates || [];

  const beginEdit = (keyDate) => {
    setEditingId(String(keyDate.id));
    setDraft({ name: keyDate.name, color: keyDate.color, event_date: keyDate.event_date });
    setRowError({ id: null, message: "" });
  };

  const cancelEdit = () => {
    setEditingId("");
    setRowError({ id: null, message: "" });
  };

  const save = async (keyDate) => {
    setBusy(true);
    setRowError({ id: null, message: "" });
    try {
      await api(`/api/projects/${projectId}/key-dates/${keyDate.id}`, {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      setEditingId("");
      onNotify(`Date "${draft.name}" updated.`, "success");
      await onChanged();
    } catch (err) {
      setRowError({ id: keyDate.id, message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (keyDate) => {
    setBusy(true);
    setRowError({ id: null, message: "" });
    try {
      await api(`/api/projects/${projectId}/key-dates/${keyDate.id}`, { method: "DELETE" });
      onNotify(`Date "${keyDate.name}" removed.`, "success");
      await onChanged();
    } catch (err) {
      setRowError({ id: keyDate.id, message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const add = async (event) => {
    event.preventDefault();
    if (!addDraft.name.trim() || !addDraft.event_date) return;
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}/key-dates`, {
        method: "POST",
        body: JSON.stringify({ ...addDraft, release_id: releaseId }),
      });
      onNotify(`Date "${addDraft.name}" added.`, "success");
      setAddDraft(DEFAULT_KEY_DATE);
      await onChanged();
    } catch (err) {
      onNotify(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const colorInput = (value, onPick, label) => html`
    <input
      className="color-swatch"
      type="color"
      value=${value}
      onInput=${(event) => onPick(event.target.value)}
      aria-label=${label}
      title=${label}
    />
  `;

  return html`
    <div className="key-dates-section">
      <strong>Other timeline dates</strong>
      <p className="panel-copy" style=${{ margin: 0 }}>
        Any other date this plan is read against — kickoff, code freeze, beta. Each one is drawn
        as a marker on the Timeline Overview in the color you pick.
      </p>

      ${rows.length
        ? rows.map((keyDate) => {
            if (String(keyDate.id) === editingId) {
              return html`
                <div className="key-date-row editing" key=${keyDate.id}>
                  ${colorInput(draft.color, (color) => setDraft({ ...draft, color }), "Date color")}
                  <input
                    value=${draft.name}
                    onInput=${(event) => setDraft({ ...draft, name: event.target.value })}
                    aria-label="Date name"
                  />
                  <input
                    type="date"
                    value=${draft.event_date}
                    onInput=${(event) => setDraft({ ...draft, event_date: event.target.value })}
                    aria-label="Date"
                  />
                  <button
                    className="button-primary"
                    type="button"
                    onClick=${() => save(keyDate)}
                    disabled=${busy || !draft.name.trim() || !draft.event_date}
                  >Save</button>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick=${cancelEdit}
                    disabled=${busy}
                  >Cancel</button>
                  ${rowError.id === keyDate.id
                    ? html`<div className="side-drawer-row-error">${rowError.message}</div>`
                    : null}
                </div>
              `;
            }
            return html`
              <div className="key-date-row" key=${keyDate.id}>
                <span className="key-date-dot" style=${{ background: keyDate.color }}></span>
                <div>
                  <strong>${keyDate.name}</strong>
                  <div className="help-text">${formatReleaseDate(keyDate.event_date)}</div>
                </div>
                <div className="key-date-row-actions">
                  <button
                    className="button-secondary"
                    type="button"
                    onClick=${() => beginEdit(keyDate)}
                    disabled=${busy}
                  >Edit</button>
                  <button
                    className="button-secondary"
                    type="button"
                    onClick=${() => remove(keyDate)}
                    disabled=${busy}
                  >Remove</button>
                </div>
                ${rowError.id === keyDate.id
                  ? html`<div className="side-drawer-row-error">${rowError.message}</div>`
                  : null}
              </div>
            `;
          })
        : html`<div className="help-text">No other dates yet — add one below.</div>`}

      <form className="key-date-add" onSubmit=${add}>
        <div className="key-date-add-row">
          ${colorInput(
            addDraft.color,
            (color) => setAddDraft({ ...addDraft, color }),
            "New date color"
          )}
          <input
            placeholder="Date name"
            value=${addDraft.name}
            onInput=${(event) => setAddDraft({ ...addDraft, name: event.target.value })}
            required
            aria-label="New date name"
          />
          <input
            type="date"
            value=${addDraft.event_date}
            onInput=${(event) => setAddDraft({ ...addDraft, event_date: event.target.value })}
            required
            aria-label="New date"
          />
          <button
            className="button-primary"
            type="submit"
            disabled=${busy || !addDraft.name.trim() || !addDraft.event_date}
          >Add date</button>
        </div>
      </form>
    </div>
  `;
}

function ProjectSettingsDrawer({ project, summary, onClose, onNotify, onSaved, onDeleted }) {
  const [draft, setDraft] = useState({
    name: project.name,
    description: project.description || "",
    color: project.color,
    status: project.status || "active",
  });
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canDelete = confirmName.trim() === project.name;

  const save = async (event) => {
    event.preventDefault();
    if (!draft.name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/projects/${project.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...draft, name: draft.name.trim() }),
      });
      onNotify(`Project "${draft.name.trim()}" updated.`, "success");
      await onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async () => {
    if (!canDelete) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE" });
      onNotify(`Project "${project.name}" deleted.`, "success");
      await onDeleted();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return html`
    <${SideDrawer} title="Edit project" ariaLabel="Edit project" onClose=${onClose}>
        ${project.is_example
          ? html`<${ConvertToActiveSection}
              project=${project}
              summary=${summary}
              onNotify=${onNotify}
              onDone=${async () => {
                await onSaved();
                onClose();
              }}
            />`
          : null}

        <form onSubmit=${save}>
          <div className="form-grid">
            <div className="field-wide">
              <label htmlFor="project-edit-name">Project name</label>
              <div className="name-row-inputs">
                <input
                  id="project-edit-color"
                  className="color-swatch"
                  type="color"
                  aria-label="Accent color"
                  title="Accent color"
                  value=${draft.color}
                  onInput=${(event) => setDraft({ ...draft, color: event.target.value })}
                />
                <input
                  id="project-edit-name"
                  value=${draft.name}
                  onInput=${(event) => setDraft({ ...draft, name: event.target.value })}
                  required
                />
              </div>
              <span className="help-text">The swatch is this project's accent color.</span>
            </div>
            <div className="field-wide">
              <label htmlFor="project-edit-description">Description</label>
              <textarea
                id="project-edit-description"
                rows="6"
                value=${draft.description}
                onInput=${(event) => setDraft({ ...draft, description: event.target.value })}
              ></textarea>
              <span className="help-text">${DESCRIPTION_HINT}</span>
            </div>
            <div className="field-wide">
              <label>Status</label>
              <${SegmentedControl}
                ariaLabel="Project status"
                value=${draft.status}
                options=${PROJECT_STATUS_OPTIONS}
                onChange=${(value) => setDraft({ ...draft, status: value })}
              />
              <span className="help-text">
                Mark a project inactive when the project is no longer on-going. It moves to the Inactive section of the dashboard and stays viewable.
              </span>
            </div>
          </div>
          <div className="actions">
            <button
              className="button-primary"
              type="submit"
              disabled=${busy || !draft.name.trim()}
              aria-busy=${busy}
            >Save changes</button>
          </div>
        </form>

        <div className="project-drawer-danger">
          <strong>Danger zone</strong>
          <p className="panel-copy" style=${{ margin: 0 }}>
            Deleting this project also removes its releases, ${summary.total_deliverables} deliverable(s), ${summary.total_teams} team(s), and every Jira link on them. This cannot be undone.
          </p>
          <div className="field-wide">
            <label htmlFor="project-delete-confirm">
              Type “${project.name}” to confirm
            </label>
            <input
              id="project-delete-confirm"
              value=${confirmName}
              onInput=${(event) => setConfirmName(event.target.value)}
              placeholder=${project.name}
              autoComplete="off"
            />
          </div>
          <div className="actions">
            <button
              className="button-danger"
              type="button"
              onClick=${removeProject}
              disabled=${busy || !canDelete}
            >Delete project</button>
          </div>
        </div>

        ${error ? html`<div className="side-drawer-row-error">${error}</div>` : null}
    <//>
  `;
}

// Create or edit one release. Its timeline dates ride along when editing: key
// dates belong to a release, so they are managed here rather than per project.
function ReleaseDrawer({ projectId, release, keyDates, onClose, onNotify, onSaved, onDeleted }) {
  const editing = Boolean(release);
  const [draft, setDraft] = useState({
    name: release ? release.name : "",
    description: release ? release.description || "" : "",
    release_date: release ? release.release_date || "" : "",
  });
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async (event) => {
    event.preventDefault();
    if (!draft.name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const body = JSON.stringify({
        ...draft,
        name: draft.name.trim(),
        // An empty date box clears the date; the API reads an explicit null so.
        release_date: draft.release_date || null,
      });
      const saved = await api(
        editing ? `/api/releases/${release.id}` : `/api/projects/${projectId}/releases`,
        { method: editing ? "PUT" : "POST", body }
      );
      onNotify(editing ? `Release "${saved.name}" updated.` : `Release "${saved.name}" created.`, "success");
      await onSaved(saved, !editing);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/releases/${release.id}`, { method: "DELETE" });
      onNotify(`Release "${release.name}" deleted.`, "success");
      await onDeleted();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return html`
    <${SideDrawer} title=${editing ? "Edit release" : "New release"} onClose=${onClose}>
      <form onSubmit=${save}>
        <div className="form-grid">
          <div className="field-wide">
            <label htmlFor="release-name">Release name</label>
            <input
              id="release-name"
              value=${draft.name}
              onInput=${(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="e.g. 2.0 or Q1 launch"
              required
              autoFocus
            />
          </div>
          <div className="field-wide">
            <label htmlFor="release-date">Release date</label>
            <input
              id="release-date"
              type="date"
              value=${draft.release_date}
              onInput=${(event) => setDraft({ ...draft, release_date: event.target.value })}
            />
            <span className="help-text">
              Optional — when this release reaches customers. Drawn as a marker on the timeline.
            </span>
          </div>
          <div className="field-wide">
            <label htmlFor="release-description">Description</label>
            <textarea
              id="release-description"
              rows="4"
              value=${draft.description}
              onInput=${(event) => setDraft({ ...draft, description: event.target.value })}
            ></textarea>
            <span className="help-text">${DESCRIPTION_HINT}</span>
          </div>
        </div>
        <div className="actions">
          <button
            className="button-primary"
            type="submit"
            disabled=${busy || !draft.name.trim()}
            aria-busy=${busy}
          >${editing ? "Save changes" : "Create release"}</button>
        </div>
      </form>

      ${editing && keyDates
        ? html`<${TimelineDatesEditor}
            projectId=${projectId}
            releaseId=${release.id}
            keyDates=${keyDates}
            onNotify=${onNotify}
            onChanged=${() => onSaved(release, false)}
          />`
        : null}

      ${editing
        ? html`
            <div className="project-drawer-danger">
              <strong>Danger zone</strong>
              <p className="panel-copy" style=${{ margin: 0 }}>
                Deleting this release also removes its deliverables, milestones, and timeline dates. Teams are kept. This cannot be undone.
              </p>
              <div className="field-wide">
                <label htmlFor="release-delete-confirm">Type “${release.name}” to confirm</label>
                <input
                  id="release-delete-confirm"
                  value=${confirmName}
                  onInput=${(event) => setConfirmName(event.target.value)}
                  placeholder=${release.name}
                  autoComplete="off"
                />
              </div>
              <div className="actions">
                <button
                  className="button-danger"
                  type="button"
                  onClick=${remove}
                  disabled=${busy || confirmName.trim() !== release.name}
                >Delete release</button>
              </div>
            </div>
          `
        : null}

      ${error ? html`<div className="side-drawer-row-error">${error}</div>` : null}
    <//>
  `;
}

// A project workspace's front door: its releases as cards. Opening one shows that
// release's timeline.
function ProjectWorkspaceView({ project, onBack, onOpenRelease, onNotify, onProjectChanged, onProjectDeleted, onReleasesChanged }) {
  const [releases, setReleases] = useState(null);
  const [drawer, setDrawer] = useState(null); // "settings" | "new-release"

  const loadReleases = async () => {
    try {
      setReleases(await api(`/api/projects/${project.id}/releases`));
    } catch (error) {
      onNotify(error.message, "error");
      setReleases([]);
    }
  };

  useEffect(() => {
    loadReleases();
  }, [project.id]);

  const inactive = project.status === "inactive";

  return html`
    <div className="app-shell">
      <div className="workspace-topbar">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <button className="back-link" type="button" onClick=${onBack}>Dashboard</button>
          <span className="breadcrumb-sep" aria-hidden="true">›</span>
          <span className="breadcrumb-current">${project.name}</span>
        </nav>
      </div>

      <section className="hero">
        <div className="hero-card" style=${{ "--project-color": project.color }}>
          <div className="eyebrow">
            Project
            ${project.is_example ? html` · <span className="project-example-pill tiny-pill">Example</span>` : null}
            ${inactive ? html` · <span className="project-inactive-pill tiny-pill">Inactive</span>` : null}
          </div>
          <div className="hero-title-row">
            <h1 className="hero-title">${project.name}</h1>
            <button
              className="icon-button"
              type="button"
              onClick=${() => setDrawer("settings")}
              aria-label="Edit project"
              title="Edit project"
            ><${PencilIcon} /></button>
          </div>
          <p className="hero-copy">
            <${RichText} text=${project.description || "No description yet."} />
          </p>
        </div>
      </section>

      <section className="project-section">
        <div className="dashboard-header compact">
          <div className="project-section-heading">
            <h2>Releases</h2>
            <span className="tiny-pill">${releases ? releases.length : "…"}</span>
          </div>
          <button className="button-primary" type="button" onClick=${() => setDrawer("new-release")}>
            + New Release
          </button>
        </div>
        <p className="panel-copy">Select a release to view its timeline, deliverables, and risk.</p>
        ${releases && releases.length
          ? html`
              <div className="project-grid">
                ${releases.map(
                  (release) => html`
                    <article className="project-card release-card" key=${release.id} style=${{ "--project-color": project.color }}>
                      <div className="project-card-header">
                        <div className="project-dot"></div>
                        <strong>${release.name}</strong>
                      </div>
                      <p className="panel-copy project-card-copy">${release.description || "No description yet."}</p>
                      <p className="help-text project-card-release">
                        ${release.release_date
                          ? `Release · ${formatReleaseDate(release.release_date)}`
                          : "No release date yet"}
                      </p>
                      <div className="actions">
                        <button className="button-primary" type="button" onClick=${() => onOpenRelease(release.id)}>
                          View release
                        </button>
                      </div>
                    </article>
                  `
                )}
              </div>
            `
          : releases
            ? html`<div className="empty-state">No releases yet — use “+ New Release” to add one.</div>`
            : null}
      </section>

      ${drawer === "settings"
        ? html`<${ProjectSettingsDrawer}
            project=${project}
            summary=${project}
            onClose=${() => setDrawer(null)}
            onNotify=${onNotify}
            onSaved=${onProjectChanged}
            onDeleted=${onProjectDeleted}
          />`
        : null}
      ${drawer === "new-release"
        ? html`<${ReleaseDrawer}
            projectId=${project.id}
            release=${null}
            onClose=${() => setDrawer(null)}
            onNotify=${onNotify}
            onSaved=${async () => {
              await loadReleases();
              await onProjectChanged();
              if (onReleasesChanged) onReleasesChanged();
            }}
            onDeleted=${async () => {}}
          />`
        : null}
    </div>
  `;
}

function DeliverableTable({ deliverables }) {
  // The `+N` pill expands the contributing teams in place; a title attribute
  // hid them behind a hover-only tooltip.
  const [openContributors, setOpenContributors] = useState({});
  const toggleContributors = (deliverableId) =>
    setOpenContributors((current) => ({
      ...current,
      [deliverableId]: !current[deliverableId],
    }));

  return html`
    <section className="table-shell" id="risk-register">
      <h2>Risk register</h2>
      <p className="panel-copy">The backend calculates delay and dependency pressure from the current schedule state.</p>
      <table>
        <thead>
          <tr>
            <th>Deliverable</th>
            <th>Team</th>
            <th>Status</th>
            <th>Risk</th>
            <th>Reasons</th>
          </tr>
        </thead>
        <tbody>
          ${deliverables.map(
            (deliverable) => {
              const contributors = deliverable.contributor_teams || [];
              const showContributors = Boolean(openContributors[deliverable.id]);
              return html`
                <tr key=${deliverable.id}>
                  <td>
                    <strong>${deliverable.title}</strong>
                    <div className="help-text">Current end: ${deliverable.current_end || deliverable.planned_end}</div>
                  </td>
                  <td>
                    ${deliverable.team_name}
                    ${contributors.length
                      ? html`<button
                          type="button"
                          className="team-plus-pill"
                          aria-expanded=${showContributors}
                          title=${showContributors ? "Hide contributing teams" : "Show contributing teams"}
                          onClick=${() => toggleContributors(deliverable.id)}
                        >+${contributors.length}</button>`
                      : null}
                    ${contributors.length && showContributors
                      ? html`
                          <div className="team-contrib-list">
                            ${contributors.map(
                              (team) => html`
                                <div className="team-contrib-row" key=${team.id}>
                                  <span className="team-dot" style=${{ background: team.color }}></span>
                                  ${team.name}
                                </div>
                              `
                            )}
                          </div>
                        `
                      : null}
                  </td>
                  <td>${humanizeStatus(deliverable.status)}</td>
                  <td><span className=${`risk-badge ${deliverable.risk_level}`}>${deliverable.risk_level}</span></td>
                  <td>
                    ${deliverable.risk_reasons.length
                      ? deliverable.risk_reasons.map((reason) => html`<div key=${reason}>${reason}</div>`)
                      : html`<span className="help-text">No active risk signals.</span>`}
                  </td>
                </tr>
              `;
            }
          )}
        </tbody>
      </table>
    </section>
  `;
}

function ReleaseOverviewView({
  dashboard,
  onBack,
  onDashboard,
  onSwitchRelease,
  onReleaseDeleted,
  csvFile,
  setCsvFile,
  onCsvSubmit,
  deliverableActions,
  milestoneActions,
  onNotify,
  onProjectRefresh,
  submitting,
}) {
  const teams = dashboard.teams;
  const deliverables = dashboard.deliverables;
  const keyDates = dashboard.key_dates || [];
  const release = dashboard.release;
  const [drawer, setDrawer] = useState(null); // "release"
  // Epic keys come from the Jira panel's load; the pickers use them for the
  // "From linked epics" tab. The same load reports which team each epic belongs
  // to, which is how a deliverable's stories get bucketed by team.
  const [epicKeys, setEpicKeys] = useState([]);
  const [epicTeams, setEpicTeams] = useState({});
  const statusFilter = useJiraStatusFilter(dashboard.project.id);
  const labelSync = useLabelSync(dashboard.project.id, onNotify);

  return html`
    <div className="app-shell">
      <div className="workspace-topbar">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <button className="back-link" type="button" onClick=${onDashboard}>Dashboard</button>
          <span className="breadcrumb-sep" aria-hidden="true">›</span>
          <button className="back-link" type="button" onClick=${onBack}>${dashboard.project.name}</button>
          <span className="breadcrumb-sep" aria-hidden="true">›</span>
          <select
            className="release-switcher-select"
            value=${release.id}
            onChange=${(event) => onSwitchRelease(Number(event.target.value))}
            aria-label="Switch release"
          >
            ${dashboard.releases.map(
              (item) => html`<option key=${item.id} value=${item.id}>${item.name}</option>`
            )}
          </select>
        </nav>
      </div>

      <section className="hero">
        <div className="hero-card">
          <div className="eyebrow">Release overview</div>
          <div className="hero-title-row">
            <h1 className="hero-title">${dashboard.project.name}</h1>
          </div>
          <p className="hero-copy">
            <${RichText} text=${dashboard.project.description || "No description yet."} />
          </p>
          <p className="hero-release">
            ${release.name}
            ${release.release_date ? ` · ${formatReleaseDate(release.release_date)}` : " · no release date yet"}
            <button
              className="icon-button"
              type="button"
              onClick=${() => setDrawer("release")}
              aria-label="Edit release"
              title="Edit release"
            ><${PencilIcon} /></button>
          </p>
          <div className="hero-stats">
            <${SummaryCard}
              label="Teams"
              value=${dashboard.summary.total_teams}
              emphasis="Manage teams & Jira links"
              onActivate=${() => flashScrollTarget("teams-section")}
            />
            <${SummaryCard}
              label="Deliverables"
              value=${dashboard.summary.total_deliverables}
              emphasis="Manage deliverables & milestones"
              onActivate=${() => flashScrollTarget("deliverables-section")}
            />
            <${SummaryCard}
              label="At risk"
              value=${dashboard.summary.at_risk_deliverables}
              emphasis="Open the risk register"
              onActivate=${() => flashScrollTarget("risk-register")}
            />
            <${SummaryCard}
              label="Delayed"
              value=${dashboard.summary.delayed_deliverables}
              emphasis="Jump to the timeline"
              onActivate=${() => flashScrollTarget("gantt-section")}
            />
          </div>
        </div>
      </section>

      <section id="gantt-section">
        <${GanttChart}
          teams=${teams}
          deliverables=${deliverables}
          releaseDate=${release.release_date || ""}
          keyDates=${keyDates}
          onInlineSave=${deliverableActions.update}
          onMilestoneSave=${milestoneActions.update}
          submitting=${submitting}
          statusFilter=${statusFilter}
          epicKeys=${epicKeys}
          epicTeams=${epicTeams}
          onMessage=${onNotify}
        />
        <${DeliverableTable} deliverables=${deliverables} />
      </section>

      <${JiraProjectPanel}
        projectId=${dashboard.project.id}
        teams=${teams}
        onMessage=${onNotify}
        statusFilter=${statusFilter}
        onEpicsLoaded=${(keys, teamsByEpic) => {
          setEpicKeys(keys);
          setEpicTeams(teamsByEpic);
        }}
        onTeamsChanged=${onProjectRefresh}
        onCheckLabels=${() => labelSync.run({ force: true, announce: true })}
        checkingLabels=${labelSync.checking}
      />

      <section className="workspace-panels">
        <${DeliverableRosterPanel}
          deliverables=${deliverables}
          teams=${teams}
          deliverableActions=${deliverableActions}
          milestoneActions=${milestoneActions}
          submitting=${submitting}
          onMessage=${onNotify}
          epicKeys=${epicKeys}
          epicTeams=${epicTeams}
          statusFilter=${statusFilter}
          csvFile=${csvFile}
          setCsvFile=${setCsvFile}
          onCsvSubmit=${onCsvSubmit}
          projectId=${dashboard.project.id}
          labelSync=${labelSync}
        />
      </section>

      ${drawer === "release"
        ? html`<${ReleaseDrawer}
            projectId=${dashboard.project.id}
            release=${release}
            keyDates=${keyDates}
            onClose=${() => setDrawer(null)}
            onNotify=${onNotify}
            onSaved=${onProjectRefresh}
            onDeleted=${onReleaseDeleted}
          />`
        : null}
    </div>
  `;
}

const projectWorkspacePath = (projectId) => `/w/${projectId}`;
const releasePath = (projectId, releaseId) => `/w/${projectId}/r/${releaseId}`;

function parseRoute() {
  const match = window.location.hash.replace(/^#/, "").match(/^\/w\/(\d+)(?:\/r\/(\d+))?\/?$/);
  if (!match) return { projectId: null, releaseId: null };
  return { projectId: Number(match[1]), releaseId: match[2] ? Number(match[2]) : null };
}

function navigate(path, replace = false) {
  const target = `#${path}`;
  if (window.location.hash === target || (path === "/" && !window.location.hash)) return;
  if (replace) {
    window.history.replaceState(null, "", target);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = target;
  }
}

function AppSidebar({
  projects,
  selectedProjectId,
  selectedReleaseId,
  releases,
  onOpenProject,
  onOpenRelease,
  onGoDashboard,
  onCollapse,
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? projects.filter((project) => project.name.toLowerCase().includes(needle))
    : projects;
  const { activeProjects, exampleProjects, inactiveProjects } = groupProjects(matching);

  const renderProject = (project) => {
    const current = project.id === selectedProjectId;
    return html`
      <li key=${project.id}>
        <button
          type="button"
          className=${`sidebar-item ${current ? "current" : ""}`}
          aria-current=${current && !selectedReleaseId ? "page" : undefined}
          onClick=${() => onOpenProject(project.id)}
        >
          <span className="project-dot" style=${{ "--project-color": project.color }}></span>
          <span className="sidebar-item-label">${project.name}</span>
        </button>
        ${current && releases.length
          ? html`
              <ul className="sidebar-releases">
                ${releases.map(
                  (release) => html`
                    <li key=${release.id}>
                      <button
                        type="button"
                        className=${`sidebar-item sub ${release.id === selectedReleaseId ? "current" : ""}`}
                        aria-current=${release.id === selectedReleaseId ? "page" : undefined}
                        onClick=${() => onOpenRelease(release.id, project.id)}
                      ><span className="sidebar-item-label">${release.name}</span></button>
                    </li>
                  `
                )}
              </ul>
            `
          : null}
      </li>
    `;
  };

  const renderGroup = (title, list) =>
    list.length
      ? html`
          <div className="sidebar-group">
            <div className="sidebar-group-title">${title}</div>
            <ul>${list.map(renderProject)}</ul>
          </div>
        `
      : null;

  return html`
    <aside className="app-sidebar" aria-label="Projects">
      <div className="sidebar-head">
        <button type="button" className="sidebar-item" onClick=${onGoDashboard}>Dashboard</button>
        <button
          type="button"
          className="icon-button"
          onClick=${onCollapse}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
        >«</button>
      </div>
      <input
        type="search"
        className="sidebar-search"
        placeholder="Search projects"
        aria-label="Search projects"
        value=${query}
        onInput=${(event) => setQuery(event.target.value)}
      />
      <nav className="sidebar-scroll">
        ${renderGroup("Active", activeProjects)}
        ${renderGroup("Example", exampleProjects)}
        ${inactiveProjects.length
          ? html`
              <details className="sidebar-group" open=${Boolean(needle) || inactiveProjects.some((p) => p.id === selectedProjectId)}>
                <summary className="sidebar-group-title">Inactive (${inactiveProjects.length})</summary>
                <ul>${inactiveProjects.map(renderProject)}</ul>
              </details>
            `
          : null}
        ${matching.length ? null : html`<p className="help-text">No matching projects.</p>`}
      </nav>
    </aside>
  `;
}

// Cmd/Ctrl+K jump. Lists workspaces plus the open workspace's releases; no
// recents or ordering by use, since there is no per-user data separation.
function CommandPalette({ items, onPick, onClose }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const needle = query.trim().toLowerCase();
  const results = (needle ? items.filter((item) => item.label.toLowerCase().includes(needle)) : items).slice(0, 50);
  const active = Math.min(index, Math.max(results.length - 1, 0));

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex(Math.min(active + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (event.key === "Enter" && results[active]) {
      event.preventDefault();
      onPick(results[active]);
    }
  };

  return html`
    <div className="palette-backdrop" onClick=${onClose}>
      <div className="palette" role="dialog" aria-label="Jump to" onClick=${(event) => event.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder="Jump to a project or release…"
          value=${query}
          onInput=${(event) => { setQuery(event.target.value); setIndex(0); }}
          onKeyDown=${onKeyDown}
        />
        <ul className="palette-list">
          ${results.map(
            (item, position) => html`
              <li key=${item.key}>
                <button
                  type="button"
                  className=${`palette-item ${position === active ? "active" : ""}`}
                  onMouseEnter=${() => setIndex(position)}
                  onClick=${() => onPick(item)}
                >
                  <span>${item.label}</span>
                  <span className="help-text">${item.kind}</span>
                </button>
              </li>
            `
          )}
          ${results.length ? null : html`<li className="help-text palette-empty">No matches.</li>`}
        </ul>
      </div>
    </div>
  `;
}

function App() {
  const [projects, setProjects] = useState([]);
  // Session-only UI state (decisions 2 and 5): never written to storage.
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 820);
  const [sidebarReleases, setSidebarReleases] = useState([]);
  const [releasesVersion, setReleasesVersion] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  // null until a release is chosen: a project workspace opens on its release list first.
  const [selectedReleaseId, setSelectedReleaseId] = useState(null);
  const [dashboard, setDashboard] = useState(null);

  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [convertTarget, setConvertTarget] = useState(null);
  const [csvFile, setCsvFile] = useState(null);

  // One transient toast. `id` is monotonic so a fresh message restarts the fade
  // timer instead of inheriting the previous one's.
  const [toast, setToast] = useState(null);
  const toastSeq = useRef(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const notify = (text, tone) => {
    if (!text) return;
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone: tone || "success", leaving: false });
  };

  const dismissToast = () =>
    setToast((current) => (current ? { ...current, leaving: true } : current));

  // Errors get longer on screen than confirmations, but nothing stays for good —
  // the old banner had no timer at all and sat at the top of the page forever.
  useEffect(() => {
    if (!toast || toast.leaving) return undefined;
    const handle = window.setTimeout(dismissToast, toast.tone === "error" ? 8000 : 3500);
    return () => window.clearTimeout(handle);
  }, [toast && toast.id, toast && toast.leaving]);

  // Second stage: unmount once the fade-out animation has run.
  useEffect(() => {
    if (!toast || !toast.leaving) return undefined;
    const handle = window.setTimeout(() => {
      setToast((current) => (current && current.id === toast.id ? null : current));
    }, TOAST_FADE_MS);
    return () => window.clearTimeout(handle);
  }, [toast && toast.id, toast && toast.leaving]);

  const loadProjects = async () => {
    const data = await api("/api/projects");
    setProjects(data);
    return data;
  };

  const loadDashboard = async (projectId, releaseId) => {
    const data = await api(`/api/projects/${projectId}/dashboard?release_id=${releaseId}`);
    setDashboard(data);
    return data;
  };

  const bumpReleases = () => setReleasesVersion((value) => value + 1);

  // Sidebar release list for the open workspace; reloaded whenever releases change.
  useEffect(() => {
    if (!selectedProjectId) {
      setSidebarReleases([]);
      return undefined;
    }
    let stale = false;
    api(`/api/projects/${selectedProjectId}/releases`)
      .then((data) => {
        if (stale) return;
        setSidebarReleases(data);
      })
      .catch(() => {});
    return () => { stale = true; };
  }, [selectedProjectId, releasesVersion]);

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const paletteItems = [
    { key: "dash", kind: "Dashboard", label: "Dashboard", path: "/" },
    ...projects.map((project) => ({
      key: `p${project.id}`,
      kind: "Project",
      label: project.name,
      path: projectWorkspacePath(project.id),
    })),
    ...sidebarReleases.map((release) => ({
      key: `r${release.id}`,
      kind: "Release",
      label: release.name,
      path: releasePath(selectedProjectId, release.id),
    })),
  ];

  const refreshProject = async () => {
    if (!selectedProjectId) {
      return;
    }
    bumpReleases();
    await Promise.all([
      loadProjects(),
      selectedReleaseId ? loadDashboard(selectedProjectId, selectedReleaseId) : null,
    ]);
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await loadProjects();
        await applyRoute(parseRoute());
      } catch (error) {
        notify(error.message, "error");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Routing: the URL hash is the source of truth (#/w/:id, #/w/:id/r/:releaseId).
  // Handlers only change the hash; applyRoute mirrors it into state. Hash routing
  // needs no server change and gives links, refresh and back/forward for free.
  const routeSeq = useRef(0);

  const applyRoute = async (route) => {
    routeSeq.current += 1;
    const seq = routeSeq.current;
    setSelectedProjectId(route.projectId);
    if (!route.projectId || !route.releaseId) {
      setSelectedReleaseId(null);
      setDashboard(null);
      return;
    }
    setLoading(true);
    try {
      const data = await api(`/api/projects/${route.projectId}/dashboard?release_id=${route.releaseId}`);
      if (seq !== routeSeq.current) return;
      setDashboard(data);
      setSelectedReleaseId(route.releaseId);
    } catch (error) {
      if (seq !== routeSeq.current) return;
      notify(error.message, "error");
      setSelectedReleaseId(null);
      setDashboard(null);
      navigate(projectWorkspacePath(route.projectId), true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const onHashChange = () => applyRoute(parseRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const handleProjectDeleted = async () => {
    navigate("/");
    await loadProjects();
  };

  const openProject = (projectId) => navigate(projectWorkspacePath(projectId));

  const openRelease = (releaseId, projectId = selectedProjectId) =>
    navigate(releasePath(projectId, releaseId));

  const handleReleaseDeleted = async () => {
    navigate(projectWorkspacePath(selectedProjectId));
    bumpReleases();
    await loadProjects();
  };

  // Resolves true when the project was created, so the drawer stays open (with
  // the typed values) on failure.
  const handleCreateProject = async (payload) => {
    setSubmitting(true);
    try {
      const project = await api("/api/projects", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await loadProjects();
      setNewProjectOpen(false);
      notify("Project created.", "success");
      openProject(project.id);
      return true;
    } catch (error) {
      notify(error.message, "error");
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  // Every write reports success back to the caller, so a modal editor closes only
  // when the save actually landed and keeps the typed values on screen otherwise.
  const runRequest = async (path, method, payload, message) => {
    setSubmitting(true);
    try {
      await api(path, payload === null ? { method } : { method, body: JSON.stringify(payload) });
      notify(message, "success");
      await refreshProject();
      return true;
    } catch (error) {
      notify(error.message, "error");
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const deliverableActions = {
    create: (payload) =>
      runRequest(
        `/api/projects/${selectedProjectId}/deliverables`,
        "POST",
        { ...payload, release_id: selectedReleaseId },
        
        "Deliverable created."
      ),
    update: (deliverableId, payload) =>
      runRequest(
        `/api/projects/${selectedProjectId}/deliverables/${deliverableId}`,
        "PUT",
        payload,
        "Deliverable updated."
      ),
  };

  const milestoneActions = {
    create: (deliverableId, payload) =>
      runRequest(
        `/api/deliverables/${deliverableId}/milestones`,
        "POST",
        payload,
        "Milestone created."
      ),
    update: (milestoneId, payload) =>
      runRequest(
        `/api/milestones/${milestoneId}`,
        "PUT",
        payload,
        "Milestone updated."
      ),
    remove: (milestoneId) =>
      runRequest(
        `/api/milestones/${milestoneId}`,
        "DELETE",
        null,
        "Milestone removed."
      ),
  };

  const handleCsvSubmit = async (event) => {
    event.preventDefault();
    if (!csvFile) {
      notify("Choose a CSV file first.", "error");
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("file", csvFile);
      const result = await api(`/api/projects/${selectedProjectId}/import/csv?release_id=${selectedReleaseId}`, {
        method: "POST",
        body: formData,
      });
      setCsvFile(null);
      notify(
        `Imported ${result.imported_deliverables} deliverable(s), created ${result.created_teams} team(s)` +
          (result.errors.length ? `. ${result.errors.length} warning(s) logged.` : "."),
        result.errors.length ? "error" : "success"
      );
      await refreshProject();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !selectedProjectId) {
    return html`<${LoadingShell} copy="Loading dashboard" />`;
  }

  return html`
    <>
      ${toast
        ? html`
            <div
              className=${`toast ${toast.tone} ${toast.leaving ? "leaving" : ""}`}
              role=${toast.tone === "error" ? "alert" : "status"}
              aria-live="polite"
              onClick=${dismissToast}
              title="Dismiss"
            >${toast.text}</div>
          `
        : null}
      <div className=${`shell-layout ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      ${sidebarOpen
        ? html`<${AppSidebar}
            projects=${projects}
            selectedProjectId=${selectedProjectId}
            selectedReleaseId=${selectedReleaseId}
            releases=${sidebarReleases}
            onOpenProject=${(id) => { openProject(id); if (window.innerWidth <= 820) setSidebarOpen(false); }}
            onOpenRelease=${(id, projectId) => { openRelease(id, projectId); if (window.innerWidth <= 820) setSidebarOpen(false); }}
            onGoDashboard=${() => navigate("/")}
            onCollapse=${() => setSidebarOpen(false)}
          />`
        : html`<button
            type="button"
            className="sidebar-expand"
            onClick=${() => setSidebarOpen(true)}
            aria-label="Open sidebar"
            title="Open sidebar"
          >»</button>`}
      <main className="shell-main">
      ${selectedProjectId && selectedReleaseId && dashboard
        ? html`
            <${ReleaseOverviewView}
              dashboard=${dashboard}
              onBack=${() => navigate(projectWorkspacePath(selectedProjectId))}
              onDashboard=${() => navigate("/")}
              onSwitchRelease=${openRelease}
              onReleaseDeleted=${handleReleaseDeleted}
              csvFile=${csvFile}
              setCsvFile=${setCsvFile}
              onCsvSubmit=${handleCsvSubmit}
              deliverableActions=${deliverableActions}
              milestoneActions=${milestoneActions}
              onNotify=${notify}
              onProjectRefresh=${refreshProject}
              submitting=${submitting}
            />
          `
        : selectedProjectId && projects.some((item) => item.id === selectedProjectId)
          ? html`
              <${ProjectWorkspaceView}
                project=${projects.find((item) => item.id === selectedProjectId)}
                onBack=${() => navigate("/")}
                onOpenRelease=${openRelease}
                onNotify=${notify}
                onProjectChanged=${loadProjects}
                onProjectDeleted=${handleProjectDeleted}
                onReleasesChanged=${bumpReleases}
              />
            `
          : html`
              <${DashboardView}
                projects=${projects}
                onOpenProject=${openProject}
                onNewProject=${() => setNewProjectOpen(true)}
                onConvert=${setConvertTarget}
              />
            `}
      </main>
      </div>
      ${paletteOpen
        ? html`<${CommandPalette}
            items=${paletteItems}
            onClose=${() => setPaletteOpen(false)}
            onPick=${(item) => { setPaletteOpen(false); navigate(item.path); }}
          />`
        : null}
      ${newProjectOpen
        ? html`<${NewProjectDrawer}
            onClose=${() => setNewProjectOpen(false)}
            onCreate=${handleCreateProject}
            submitting=${submitting}
          />`
        : null}
      ${convertTarget
        ? html`<${ConvertExampleDrawer}
            project=${convertTarget}
            onClose=${() => setConvertTarget(null)}
            onNotify=${notify}
            onDone=${async () => {
              setConvertTarget(null);
              await loadProjects();
            }}
          />`
        : null}
    </>
  `;
}

createRoot(document.getElementById("root")).render(React.createElement(App));
