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
const GANTT_JIRA_PREFIX = "pm-tool.gantt-jira.";
const DEFAULT_PROJECT = {
  name: "",
  description: "",
  color: "#0f766e",
  is_example: false,
  release_date: "",
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

function startOfDay(value) {
  return new Date(`${value}T00:00:00`);
}

function differenceInDays(start, end) {
  return Math.round((end - start) / 86400000);
}

function addDays(dateValue, amount) {
  const next = new Date(dateValue);
  next.setDate(next.getDate() + amount);
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
}) {
  const hasEpics = Boolean(epicKeys && epicKeys.length);
  const canBulkLink = typeof onLinkMany === "function";
  const [mode, setMode] = useState(hasEpics ? "epics" : "search");
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
  const [label, setLabel] = useState("");
  const [labelProjectKey, setLabelProjectKey] = useState("");
  const [labelOptions, setLabelOptions] = useState([]);
  const [labelResult, setLabelResult] = useState(null);
  const [labelSearching, setLabelSearching] = useState(false);
  const [labelHint, setLabelHint] = useState("");
  const alreadyLinked = new Set(linkedKeys || []);

  // Every search in here runs on a submit event, and one caller (the create
  // deliverable panel) renders this modal from inside its own <form>. Chrome
  // does not bubble a nested form's submit event out to React's delegated
  // listener, so onSubmit never fired, nothing called preventDefault, and the
  // browser did a native GET that reloaded the app back to the landing page.
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

  const runLabelSearch = async (event) => {
    takeOver(event);
    const cleaned = label.trim();
    if (!cleaned) {
      setError("Pick or type a Jira label to search.");
      return;
    }
    setError("");
    setLabelSearching(true);
    try {
      const payload = await api(
        `/api/jira/labels/issues?label=${encodeURIComponent(cleaned)}` +
          `&project_key=${encodeURIComponent(labelProjectKey.trim())}&limit=100`
      );
      setLabelResult(payload);
      if (statusFilter) statusFilter.registerStatuses(payload.issues || []);
      if (!(payload.issues || []).length) {
        // A healthy Jira plus zero rows used to clear the error and say nothing.
        // The usual cause is a label that lives in another Jira project.
        setError(
          (await jiraTrouble()) ||
            `No issues in Jira project ${payload.project_key} carry the label “${payload.label}”. ` +
              `Check the spelling, or change the Jira project if the label belongs to a different one.`
        );
      }
    } catch (err) {
      setError(await describeJiraFailure(err));
      setLabelResult(null);
    } finally {
      setLabelSearching(false);
    }
  };

  const labelIssues = (labelResult && labelResult.issues) || [];
  const labelVisible = statusFilter ? statusFilter.apply(labelIssues) : labelIssues;
  const labelHidden = labelIssues.length - labelVisible.length;
  const labelToLink = labelVisible.filter((issue) => !alreadyLinked.has(issue.key));
  // Derived from every story the label returned, so toggling the status filter
  // does not move the number the deliverable's progress is seeded with.
  const labelInProgress = labelIssues.filter(isInProgressIssue).length;
  const labelProgress = progressFromIssues(labelIssues);

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
      if (statusFilter) {
        statusFilter.registerStatuses(groups.flatMap((group) => group.issues));
      }
    } finally {
      setLoadingEpics(false);
    }
  };

  useEffect(() => {
    if (mode === "epics" && epicGroups === null && hasEpics && !loadingEpics) {
      loadEpicStories();
    }
  }, [mode]);

  const runSearch = async (event) => {
    takeOver(event);
    const trimmedJql = jql.trim();
    const trimmedKeyword = keyword.trim();
    let query = trimmedJql;
    if (!query && trimmedKeyword) {
      const safe = trimmedKeyword.replace(/"/g, '\\"');
      // `text ~` never matches an issue key, so a pasted key like SNA-28969
      // would silently return zero rows. Detect that shape and look it up.
      query = ISSUE_KEY_PATTERN.test(trimmedKeyword)
        ? `issuekey = "${trimmedKeyword.toUpperCase()}"`
        : `text ~ "${safe}" ORDER BY updated DESC`;
    }
    if (!query) {
      setError("Enter a JQL query or a keyword to search.");
      return;
    }
    setError("");
    setSearching(true);
    try {
      const payload = await api(`/api/jira/search?jql=${encodeURIComponent(query)}&limit=25`);
      const issues = payload.issues || [];
      setResults(issues);
      setSearched(true);
      if (!issues.length) setError(await jiraTrouble());
    } catch (err) {
      setError(await describeJiraFailure(err));
      setResults([]);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

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
  return createPortal(
    html`
    <div className="jira-modal-backdrop" role="dialog" aria-modal="true" onClick=${onClose}>
      <div className="jira-modal" onClick=${(event) => event.stopPropagation()}>
        <header className="jira-modal-header">
          <h3>${title}</h3>
          <button className="button-secondary" type="button" onClick=${onClose}>Close</button>
        </header>

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
                      ${(epicGroups || []).map((group) => {
                        const visible = statusFilter
                          ? statusFilter.apply(group.issues)
                          : group.issues;
                        const hidden = group.issues.length - visible.length;
                        return html`
                          <div className="jira-epic-picker-group" key=${group.epicKey}>
                            <div className="jira-epic-picker-heading">
                              <strong>${group.epicKey}</strong>
                              <span className="tiny-pill">${visible.length}</span>
                              ${hidden
                                ? html`<span className="help-text">${hidden} hidden by filter</span>`
                                : null}
                            </div>
                            ${group.error
                              ? html`<div className="jira-modal-error">${group.error}</div>`
                              : visible.length
                                ? visible.map((issue) => {
                                    const linked = alreadyLinked.has(issue.key);
                                    return html`
                                      <div className="jira-result-row" key=${issue.key}>
                                        <div className="jira-result-main">
                                          <a
                                            className="jira-result-key"
                                            href=${issue.url}
                                            target="_blank"
                                            rel="noreferrer"
                                          >${issue.key}</a>
                                          <span className=${jiraStatusClass(issue.status_category)}>
                                            ${issue.status}
                                          </span>
                                          <span className="jira-result-type">${issue.issue_type}</span>
                                        </div>
                                        <div className="jira-result-summary">${issue.summary}</div>
                                        <div className="actions">
                                          <button
                                            className="button-primary"
                                            type="button"
                                            disabled=${submitting || linked}
                                            onClick=${() => confirmLink(issue)}
                                          >
                                            ${linked ? "Linked" : "Link"}
                                          </button>
                                        </div>
                                      </div>
                                    `;
                                  })
                                : html`<div className="help-text">
                                    ${group.issues.length
                                      ? "Every story here is hidden by the status filter."
                                      : "No child stories in Jira."}
                                  </div>`}
                          </div>
                        `;
                      })}
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
                  ${labelToLink.length
                    ? html`
                        <button
                          className="button-primary"
                          type="button"
                          disabled=${submitting}
                          onClick=${() => onLinkMany(labelToLink.map((issue) => issue.key), labelProgress)}
                        >
                          Link ${labelToLink.length} ${labelToLink.length === 1 ? "story" : "stories"}
                        </button>
                      `
                    : null}
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
                        ? html`<span> · showing the first 100 matches</span>`
                        : null}
                      ${labelVisible.length && !labelToLink.length
                        ? html`<span> · all already linked</span>`
                        : null}
                      ${labelProgress === null
                        ? null
                        : html`<span>
                            ${" "}· ${labelInProgress} in progress → seeds ${labelProgress}% progress
                          </span>`}
                    </div>
                    <div className="jira-results">
                      ${labelVisible.map((issue) => {
                        const linked = alreadyLinked.has(issue.key);
                        return html`
                          <div className="jira-result-row" key=${issue.key}>
                            <div className="jira-result-main">
                              <a
                                className="jira-result-key"
                                href=${issue.url}
                                target="_blank"
                                rel="noreferrer"
                              >${issue.key}</a>
                              <span className=${jiraStatusClass(issue.status_category)}>
                                ${issue.status}
                              </span>
                              <span className="jira-result-type">${issue.issue_type}</span>
                              ${linked ? html`<span className="tiny-pill">Linked</span>` : null}
                            </div>
                            <div className="jira-result-summary">${issue.summary}</div>
                          </div>
                        `;
                      })}
                    </div>
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
                  <label htmlFor="jira-keyword">Keyword</label>
                  <input
                    id="jira-keyword"
                    placeholder="Search summary/description"
                    value=${keyword}
                    onInput=${(event) => setKeyword(event.target.value)}
                  />
                </div>
                <div className="field-wide">
                  <label htmlFor="jira-jql">JQL (advanced, overrides keyword)</label>
                  <input
                    id="jira-jql"
                    placeholder='project = "PROJ" AND issuetype = Epic'
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
              ${results.length
                ? html`
                    <div className="jira-results">
                      ${results.map(
                        (issue) => html`
                          <div className="jira-result-row" key=${issue.key}>
                            <div className="jira-result-main">
                              <a
                                className="jira-result-key"
                                href=${issue.url}
                                target="_blank"
                                rel="noreferrer"
                              >${issue.key}</a>
                              <span className=${jiraStatusClass(issue.status_category)}>
                                ${issue.status}
                              </span>
                              <span className="jira-result-type">${issue.issue_type}</span>
                            </div>
                            <div className="jira-result-summary">${issue.summary}</div>
                            <div className="actions">
                              <button
                                className="button-primary"
                                type="button"
                                disabled=${submitting}
                                onClick=${() => confirmLink(issue)}
                              >
                                Link
                              </button>
                            </div>
                          </div>
                        `
                      )}
                    </div>
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
      </div>
    </div>
  `,
    document.body
  );
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

function JiraProjectPanel({ projectId, teams, onMessage, statusFilter, onEpicsLoaded }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [trouble, setTrouble] = useState("");

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
    <article className="panel jira-panel">
      <div className="jira-panel-header">
        <div>
          <h2>Link Teams to Jira Work Items</h2>
          <p className="panel-copy">
            Link Jira epics & stories to identified teams. Stories under each epic are visible in a read-only list.
          </p>
        </div>
        <div className="actions">
          <button className="button-secondary" type="button" onClick=${forceSync} disabled=${loading}>
            ${loading ? "Refreshing…" : "Refresh"}
          </button>
          <button className="button-primary" type="button" onClick=${() => { setPickerError(""); setShowPicker(true); }}>
            Link epic
          </button>
        </div>
      </div>

      ${trouble ? html`<div className="jira-modal-error">${trouble}</div>` : null}

      ${data && data.stale ? html`<div className="help-text">Showing cached data — refresh failed.</div>` : null}

      ${statusFilter ? html`<${JiraStatusFilter} filter=${statusFilter} />` : null}

      ${groups.map(
        (group) => html`
          <div className="jira-team-group" key=${group.team ? group.team.id : "unassigned"}>
            <div className="jira-team-heading">
              ${group.team
                ? html`
                    <span className="team-dot" style=${{ background: group.team.color }}></span>
                    <strong>${group.team.name}</strong>
                  `
                : html`<strong>Unassigned</strong>`}
              <span className="tiny-pill">${group.links.length}</span>
            </div>
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
}) {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
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
          Link story
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
        <div className="eyebrow">Booting timeline workspace</div>
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

function ProjectCard({ project, onOpenProject }) {
  return html`
    <article
      className=${`project-card ${project.is_example ? "example" : ""}`}
      style=${{ "--project-color": project.color }}
    >
      <div className="project-card-header">
        <div className="project-dot"></div>
        <strong>${project.name}</strong>
        ${project.is_example
          ? html`<span className="tiny-pill project-example-pill">Example</span>`
          : null}
      </div>
      <p className="panel-copy">${project.description || "No description yet."}</p>
      <div className="project-stats">
        <span className="tiny-pill">${project.total_deliverables} deliverables</span>
        <span className="tiny-pill">${project.total_teams} teams</span>
        <span className="tiny-pill">${project.at_risk_deliverables} at risk</span>
      </div>
      <div className="actions">
        <button className="button-primary" type="button" onClick=${() => onOpenProject(project.id)}>
          Open workspace
        </button>
      </div>
    </article>
  `;
}

function LandingView({ projects, onOpenProject, projectForm, setProjectForm, onCreateProject, submitting }) {
  // Real project work first; example workspaces are reference material and sit below.
  const realProjects = projects.filter((project) => !project.is_example);
  const exampleProjects = projects.filter((project) => project.is_example);

  return html`
    <div className="app-shell">
      <section className="landing-hero hero-card">
        <div className="eyebrow">PM Tool v1</div>
        <h1 className="hero-title">PPM Dashboard</h1>
        <p className="hero-copy">
          Select an onboarded project to review timeline risk, dependencies, and delivery status.
        </p>
      </section>

      <section className="project-section">
        <div className="project-section-heading">
          <h2>Active project workspaces</h2>
          <span className="tiny-pill">${realProjects.length}</span>
        </div>
        <p className="panel-copy">Workspaces tracking real delivery work.</p>
        ${realProjects.length
          ? html`
              <div className="project-grid">
                ${realProjects.map(
                  (project) => html`<${ProjectCard}
                    key=${project.id}
                    project=${project}
                    onOpenProject=${onOpenProject}
                  />`
                )}
              </div>
            `
          : html`<div className="empty-state">
              No real workspaces yet — onboard one below.
            </div>`}
      </section>

      ${exampleProjects.length
        ? html`
            <section className="project-section examples">
              <div className="project-section-heading">
                <h2>Example workspaces</h2>
                <span className="tiny-pill">${exampleProjects.length}</span>
              </div>
              <p className="panel-copy">
                Reference layouts for guidance — safe to experiment in.
              </p>
              <div className="project-grid">
                ${exampleProjects.map(
                  (project) => html`<${ProjectCard}
                    key=${project.id}
                    project=${project}
                    onOpenProject=${onOpenProject}
                  />`
                )}
              </div>
            </section>
          `
        : null}

      <section className="panel">
        <h2>Onboard new project</h2>
        <p className="panel-copy">Create a new project card and workspace in the PM tool.</p>
        <form onSubmit=${onCreateProject}>
          <div className="form-grid">
            <div className="field-wide">
              <label htmlFor="project-name">Project name</label>
              <input id="project-name" value=${projectForm.name} onInput=${(event) => setProjectForm({ ...projectForm, name: event.target.value })} required />
            </div>
            <div className="field-wide">
              <label htmlFor="project-description">Description</label>
              <textarea id="project-description" rows="6" value=${projectForm.description} onInput=${(event) => setProjectForm({ ...projectForm, description: event.target.value })}></textarea>
              <span className="help-text">${DESCRIPTION_HINT}</span>
            </div>
            <div className="field-wide">
              <label htmlFor="project-release-date">Release date</label>
              <div className="release-row-inputs">
                <input
                  id="project-color"
                  className="color-swatch"
                  type="color"
                  aria-label="Accent color"
                  title="Accent color"
                  value=${projectForm.color}
                  onInput=${(event) => setProjectForm({ ...projectForm, color: event.target.value })}
                />
                <input
                  id="project-release-date"
                  type="date"
                  value=${projectForm.release_date}
                  onInput=${(event) => setProjectForm({ ...projectForm, release_date: event.target.value })}
                />
              </div>
              <span className="help-text">
                The square sets the workspace accent color. The date is optional — it is when the
                software becomes available to customers, and is drawn as a marker on the Timeline
                Overview.
              </span>
            </div>
            <div className="field-wide">
              <label className="checkbox-field" htmlFor="project-is-example">
                <input
                  id="project-is-example"
                  type="checkbox"
                  checked=${Boolean(projectForm.is_example)}
                  onChange=${(event) => setProjectForm({ ...projectForm, is_example: event.target.checked })}
                />
                This is an example workspace
              </label>
              <span className="help-text">
                Example workspaces are listed separately from real project work.
              </span>
            </div>
          </div>
          <div className="actions">
              <button className="button-primary" type="submit" disabled=${submitting} aria-busy=${submitting}>Create project</button>
          </div>
        </form>
      </section>
    </div>
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

function DeliverableForm({
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
                >Pick Jira story</button>
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

      <div className="actions">
            <button className="button-primary" type="submit" disabled=${submitting} aria-busy=${submitting}>${submitLabel}</button>
      </div>

      ${showPicker
        ? html`
            <${JiraPickerModal}
              title="Pick a Jira story to link on create"
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
                >Pick Jira story</button>
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
              title="Pick a Jira story to link on create"
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

  const openDeliverableEdit = (deliverable) => {
    setDeliverableDraft(deliverableToForm(deliverable));
    setEditor({ kind: "deliverable-edit", id: deliverable.id });
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
    if (ok) closeEditor();
  };

  const submitDeliverableEdit = async (event) => {
    event.preventDefault();
    const ok = await deliverableActions.update(
      Number(editor.id),
      deliverablePayload(deliverableDraft)
    );
    if (ok) closeEditor();
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
    <article className="panel roster-panel">
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
            workspace.
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
  // Esc closes, but only when this modal is the top one: the story picker is
  // portalled to <body> as well, so a document-level listener would otherwise see
  // its Esc and dismiss the editor out from under it.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".jira-modal-backdrop:not(.inline-modal-backdrop)")) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    html`
    <div
      className="jira-modal-backdrop inline-modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick=${onClose}
    >
      <div
        className=${`jira-modal inline-modal ${wide ? "wide" : ""}`}
        onClick=${(event) => event.stopPropagation()}
      >
        <header className="jira-modal-header">
          <h3>${title}</h3>
          <button className="button-secondary" type="button" onClick=${onClose}>Close</button>
        </header>
        ${subtitle ? html`<p className="help-text">${subtitle}</p>` : null}
        ${children}
      </div>
    </div>
  `,
    document.body
  );
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
  onLinksChanged,
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
          onLinked=${onLinksChanged}
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
  onLinksChanged,
  epicTeams,
}) {
  const creating = mode === "create";

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
                onLinked=${onLinksChanged}
                onProgressSuggested=${(value) =>
                  setForm((current) => ({ ...current, progress: value }))}
                teams=${teams}
                epicTeams=${epicTeams}
                compact=${true}
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
  onLinksChanged,
  epicTeams,
}) {
  const creating = mode === "create";

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
          submitLabel=${creating ? "Create deliverable" : "Save deliverable"}
          submitting=${submitting}
          idPrefix=${creating ? "deliverable-create" : "deliverable-edit"}
          showJiraPicker=${creating}
          epicKeys=${epicKeys}
          statusFilter=${statusFilter}
          deliverableId=${creating ? null : deliverableId}
          onMessage=${onMessage}
        />
        ${creating
          ? null
          : html`
              <${JiraWorkItemLinks}
                itemId=${deliverableId}
                onMessage=${onMessage}
                epicKeys=${epicKeys}
                statusFilter=${statusFilter}
                onLinked=${onLinksChanged}
                onProgressSuggested=${(value) =>
                  setForm((current) => ({ ...current, progress: value }))}
                teams=${teams}
                epicTeams=${epicTeams}
                compact=${true}
              />
            `}
    <//>
  `;
}

function GanttStoryList({ links, statusFilter, teams, epicTeams }) {
  const [expanded, setExpanded] = useState({});
  const visible = statusFilter
    ? links.filter((link) => statusFilter.isVisible(link.issue))
    : links;
  const hidden = links.length - visible.length;

  const toggle = (key) =>
    setExpanded((current) => ({ ...current, [key]: !current[key] }));

  if (!links.length) {
    return html`<div className="gantt-story-list">
      <span className="help-text">No Jira stories linked.</span>
    </div>`;
  }

  const groups = groupStoriesByTeam(visible, teams, epicTeams);
  const flat = isFlatGrouping(groups);

  const story = (link) => {
    const issue = link.issue;
    const open = Boolean(expanded[issue.key]);
    const related = issue.links || [];
    return html`
      <div className="gantt-story" key=${link.id}>
        <div className="gantt-story-main">
          <button
            type="button"
            className="gantt-story-toggle"
            aria-expanded=${open}
            onClick=${() => toggle(issue.key)}
            title=${related.length ? "Show Jira relationships" : "No Jira relationships"}
          >${open ? "−" : "+"}</button>
          <a href=${issue.url} target="_blank" rel="noreferrer" className="jira-result-key">
            ${issue.key}
          </a>
          <span className=${jiraStatusClass(issue.status_category)}>${issue.status}</span>
          <span className="gantt-story-summary">${issue.summary}</span>
        </div>
        ${open
          ? related.length
            ? html`
                <ul className="gantt-story-links">
                  ${related.map(
                    (ref) => html`
                      <li key=${`${ref.relation}-${ref.key}`}>
                        <span className="gantt-story-relation">${ref.relation}</span>
                        <a href=${ref.url} target="_blank" rel="noreferrer">${ref.key}</a>
                        ${ref.status
                          ? html`<span className=${jiraStatusClass(ref.status_category)}>
                              ${ref.status}
                            </span>`
                          : null}
                        <span className="gantt-story-summary">${ref.summary}</span>
                      </li>
                    `
                  )}
                </ul>
              `
            : html`<div className="help-text">No linked issues or subtasks in Jira.</div>`
          : null}
      </div>
    `;
  };

  return html`
    <div className="gantt-story-list">
      <span className="tiny-pill">Jira ${visible.length}</span>
      ${flat
        ? (groups[0] ? groups[0].links : []).map(story)
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
                ${group.links.map(story)}
              </div>
            `
          )}
      ${hidden ? html`<span className="help-text">${hidden} hidden by the status filter.</span>` : null}
    </div>
  `;
}

// A milestone has one date, so it draws a marker rather than a bar. When it
// landed on a different day than planned both markers are drawn with a connector
// between them, which is what makes the slip readable at a glance.
function GanttMilestoneRow({ milestone, timeline, isEditing, onOpen }) {
  const totalDays = Math.max(differenceInDays(timeline.start, timeline.end), 1);
  const percentFor = (value) =>
    (differenceInDays(timeline.start, startOfDay(value)) / totalDays) * 100;
  const targetLeft = percentFor(milestone.target_date);
  const actualLeft = milestone.actual_date ? percentFor(milestone.actual_date) : null;
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
      <div className="timeline-grid milestone-grid" style=${{ "--days": timeline.days.length }}>
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
  stories,
  showStories,
  statusFilter,
  teams,
  epicTeams,
  milestonesExpanded,
  onToggleMilestones,
  editingMilestoneId,
  onOpenMilestone,
}) {
  const start = startOfDay(deliverable.current_start || deliverable.planned_start);
  const end = startOfDay(deliverable.current_end || deliverable.planned_end);
  const totalDays = Math.max(differenceInDays(timeline.start, timeline.end), 1);
  const offsetDays = differenceInDays(timeline.start, start);
  const durationDays = Math.max(differenceInDays(start, end) + 1, 1);
  const left = (offsetDays / totalDays) * 100;
  const width = (durationDays / totalDays) * 100;
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
        ${showStories
          ? html`<${GanttStoryList}
              links=${stories || []}
              statusFilter=${statusFilter}
              teams=${teams}
              epicTeams=${epicTeams}
            />`
          : null}
      </div>
      <div className="timeline-grid" style=${{ "--days": timeline.days.length }}>
        <button
          ref=${(node) => { if (node) { barRefs.current[deliverable.id] = node; } }}
          className=${`task-bar ${deliverable.risk_level} ${isEditing ? "editing" : ""}`}
          style=${{ left: `${left}%`, width: `${Math.max(width, 6)}%`, background: gradient }}
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
  projectId,
  teams,
  deliverables,
  releaseDate,
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
  const [editingMilestoneId, setEditingMilestoneId] = useState("");
  const [milestoneForm, setMilestoneForm] = useState(DEFAULT_MILESTONE);
  const storageKey = `${GANTT_JIRA_PREFIX}${projectId}`;
  const [showStories, setShowStories] = useState(() => readStored(storageKey, false));
  const [storyData, setStoryData] = useState(null);
  const [storyLoading, setStoryLoading] = useState(false);
  const [storyError, setStoryError] = useState("");

  const loadStories = async () => {
    setStoryLoading(true);
    setStoryError("");
    try {
      const payload = await api(`/api/projects/${projectId}/jira/deliverable-links`);
      setStoryData(payload);
      const issues = Object.values(payload.links_by_deliverable || {})
        .flat()
        .map((link) => link.issue);
      if (statusFilter) statusFilter.registerStatuses(issues);
    } catch (err) {
      setStoryError(err.message);
    } finally {
      setStoryLoading(false);
    }
  };

  useEffect(() => {
    setStoryData(null);
    setShowStories(readStored(`${GANTT_JIRA_PREFIX}${projectId}`, false));
  }, [projectId]);

  // Nothing is fetched until the toggle is on, so the default layout is untouched.
  useEffect(() => {
    if (showStories && storyData === null && !storyLoading) loadStories();
  }, [showStories, storyData]);

  const toggleStories = () => {
    const next = !showStories;
    writeStored(storageKey, next);
    setShowStories(next);
  };

  // Milestone markers and the release line are percentages of this same span, so
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
    if (!dates.length) {
      const today = new Date();
      return { start: today, end: addDays(today, 14), days: [today] };
    }
    const min = dates.reduce((current, value) => (value < current ? value : current), dates[0]);
    const max = dates.reduce((current, value) => (value > current ? value : current), dates[0]);
    const start = addDays(min, -1);
    const end = addDays(max, 2);
    const span = differenceInDays(start, end);
    const days = Array.from({ length: span + 1 }, (_, index) => addDays(start, index));
    return { start, end, days };
  }, [deliverables, releaseDate]);

  const releaseLeft = useMemo(() => {
    if (!releaseDate) return null;
    const totalDays = Math.max(differenceInDays(timeline.start, timeline.end), 1);
    const offset = differenceInDays(timeline.start, startOfDay(releaseDate));
    if (offset < 0 || offset > totalDays) return null;
    return (offset / totalDays) * 100;
  }, [releaseDate, timeline]);

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
    // The story overlay and the milestone sub-rows both change row heights, so
    // the curves have to be redrawn whenever either is toggled.
  }, [deliverables, timeline.days.length, showStories, storyData, expandedMilestones]);

  const grouped = teams.map((team) => ({
    ...team,
    deliverables: deliverables.filter((deliverable) => deliverable.team_id === team.id),
  }));

  const linksFor = (deliverableId) => {
    const byId = (storyData && storyData.links_by_deliverable) || {};
    return byId[deliverableId] || byId[String(deliverableId)] || [];
  };

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

      <div className="gantt-jira-toggle">
        <label>
          <input type="checkbox" checked=${showStories} onChange=${toggleStories} />
          Show Jira stories
        </label>
        ${showStories && storyLoading ? html`<span className="help-text">Loading stories…</span>` : null}
        ${showStories && storyData && storyData.stale
          ? html`<span className="help-text">Showing cached data — refresh failed.</span>`
          : null}
        ${showStories && storyError ? html`<span className="jira-modal-error">${storyError}</span>` : null}
        ${showStories && statusFilter
          ? html`<${JiraStatusFilter}
              filter=${statusFilter}
              compact=${true}
              issues=${Object.values((storyData && storyData.links_by_deliverable) || {})
                .flat()
                .map((link) => link.issue)}
            />`
          : null}
      </div>

      <div className="gantt-board">
        <div className="gantt-header">
          <div className="task-cell"><strong>Workstream</strong></div>
          <div className="timeline-header" style=${{ gridTemplateColumns: `repeat(${timeline.days.length}, minmax(30px, 1fr))` }}>
            ${timeline.days.map(
              (day) => html`
                <div className="day-cell" key=${day.toISOString()}>
                  <strong>${day.getDate()}</strong>
                  <span>${day.toLocaleDateString("en", { month: "short" })}</span>
                </div>
              `
            )}
          </div>
        </div>

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

          ${releaseLeft === null
            ? null
            : html`
                <div className="release-layer" aria-hidden="true">
                  <div className="release-layer-gutter"></div>
                  <div className="release-layer-track">
                    <div className="release-marker" style=${{ left: `${releaseLeft}%` }}>
                      <span className="release-marker-label">
                        Release ${formatDisplayDate(releaseDate)}
                      </span>
                    </div>
                  </div>
                </div>
              `}

          ${grouped.map(
            (team) => html`
              <div key=${team.id}>
                <div className="team-banner">
                  <span className="team-dot" style=${{ background: team.color }}></span>
                  <span>${team.name}</span>
                </div>
                ${team.deliverables.length
                  ? team.deliverables.map(
                      (deliverable) => html`
                        <${GanttRow}
                          key=${deliverable.id}
                          deliverable=${deliverable}
                          timeline=${timeline}
                          barRefs=${barRefs}
                          isEditing=${String(deliverable.id) === editingDeliverableId}
                          onOpenInline=${openInline}
                          stories=${linksFor(deliverable.id)}
                          showStories=${showStories}
                          statusFilter=${statusFilter}
                          teams=${teams}
                          epicTeams=${epicTeams}
                          milestonesExpanded=${Boolean(expandedMilestones[deliverable.id])}
                          onToggleMilestones=${toggleMilestones}
                          editingMilestoneId=${editingMilestoneId}
                          onOpenMilestone=${openMilestone}
                        />
                      `
                    )
                  : html`<div className="empty-state">No deliverables for this team yet.</div>`}
              </div>
            `
          )}
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
              onLinksChanged=${() => { if (showStories) loadStories(); }}
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
              onLinksChanged=${() => { if (showStories) loadStories(); }}
              epicTeams=${epicTeams}
            />
          `
        : null}
    </section>
  `;
}

function TeamManagerDrawer({ projectId, teams, onClose, onNotify, onChanged }) {
  const [rows, setRows] = useState(teams);
  const [editingId, setEditingId] = useState("");
  const [editDraft, setEditDraft] = useState({ name: "", color: "#2563eb" });
  const [rowError, setRowError] = useState({ id: null, message: "" });
  const [addDraft, setAddDraft] = useState({ name: "", color: "#2563eb" });
  const [busy, setBusy] = useState(false);

  useEffect(() => { setRows(teams); }, [teams]);

  const beginEdit = (team) => {
    setEditingId(String(team.id));
    setEditDraft({ name: team.name, color: team.color });
    setRowError({ id: null, message: "" });
  };
  const cancelEdit = () => {
    setEditingId("");
    setRowError({ id: null, message: "" });
  };

  const saveEdit = async (team) => {
    setBusy(true);
    setRowError({ id: null, message: "" });
    try {
      await api(`/api/projects/${projectId}/teams/${team.id}`, {
        method: "PUT",
        body: JSON.stringify(editDraft),
      });
      setEditingId("");
      onNotify(`Team "${editDraft.name}" updated.`, "success");
      await onChanged();
    } catch (err) {
      setRowError({ id: team.id, message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const removeTeam = async (team) => {
    setBusy(true);
    setRowError({ id: null, message: "" });
    try {
      await api(`/api/projects/${projectId}/teams/${team.id}`, { method: "DELETE" });
      onNotify(`Team "${team.name}" removed.`, "success");
      await onChanged();
    } catch (err) {
      setRowError({ id: team.id, message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const addTeam = async (event) => {
    event.preventDefault();
    if (!addDraft.name.trim()) return;
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}/teams`, {
        method: "POST",
        body: JSON.stringify(addDraft),
      });
      onNotify(`Team "${addDraft.name}" added.`, "success");
      setAddDraft({ name: "", color: "#2563eb" });
      await onChanged();
    } catch (err) {
      onNotify(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  return html`
    <div
      className="team-drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Manage teams"
      onClick=${onClose}
    >
      <div className="team-drawer" onClick=${(event) => event.stopPropagation()}>
        <header className="team-drawer-header">
          <h2 style=${{ margin: 0 }}>Teams</h2>
          <button className="button-secondary" type="button" onClick=${onClose}>Close</button>
        </header>
        <p className="panel-copy" style=${{ margin: 0 }}>
          Add, rename, recolor, or remove teams for this project. Deletion is blocked while a team still owns or contributes to deliverables.
        </p>

        <div className="team-drawer-list">
          ${rows.length === 0
            ? html`<div className="empty-state">No teams yet — add one below.</div>`
            : rows.map((team) => {
                const isEditing = String(team.id) === editingId;
                if (isEditing) {
                  return html`
                    <div className="team-drawer-edit" key=${team.id}>
                      <input
                        value=${editDraft.name}
                        onInput=${(event) => setEditDraft({ ...editDraft, name: event.target.value })}
                        aria-label="Team name"
                      />
                      <input
                        type="color"
                        value=${editDraft.color}
                        onInput=${(event) => setEditDraft({ ...editDraft, color: event.target.value })}
                        aria-label="Team color"
                      />
                      <button
                        className="button-primary"
                        type="button"
                        onClick=${() => saveEdit(team)}
                        disabled=${busy || !editDraft.name.trim()}
                      >Save</button>
                      <button
                        className="button-secondary"
                        type="button"
                        onClick=${cancelEdit}
                        disabled=${busy}
                      >Cancel</button>
                      ${rowError.id === team.id
                        ? html`<div className="team-drawer-row-error">${rowError.message}</div>`
                        : null}
                    </div>
                  `;
                }
                return html`
                  <div className="team-drawer-row" key=${team.id}>
                    <span className="team-dot" style=${{ background: team.color }}></span>
                    <div>
                      <strong>${team.name}</strong>
                      <div className="help-text">${team.color}</div>
                    </div>
                    <div className="team-drawer-row-actions">
                      <button
                        className="button-secondary"
                        type="button"
                        onClick=${() => beginEdit(team)}
                        disabled=${busy}
                      >Edit</button>
                      <button
                        className="button-secondary"
                        type="button"
                        onClick=${() => removeTeam(team)}
                        disabled=${busy}
                      >Remove</button>
                    </div>
                    ${rowError.id === team.id
                      ? html`<div className="team-drawer-row-error">${rowError.message}</div>`
                      : null}
                  </div>
                `;
              })}
        </div>

        <form className="team-drawer-add" onSubmit=${addTeam}>
          <strong>Add a team</strong>
          <div className="team-drawer-add-row">
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
            />
            <button className="button-primary" type="submit" disabled=${busy || !addDraft.name.trim()}>Add</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function ProjectSettingsDrawer({ project, summary, onClose, onNotify, onSaved, onDeleted }) {
  const [draft, setDraft] = useState({
    name: project.name,
    description: project.description || "",
    color: project.color,
    is_example: Boolean(project.is_example),
    release_date: project.release_date || "",
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
        // An empty date box means "no release committed to yet"; the API reads an
        // explicit null as clearing the field.
        body: JSON.stringify({
          ...draft,
          name: draft.name.trim(),
          release_date: draft.release_date || null,
        }),
      });
      onNotify(`Workspace "${draft.name.trim()}" updated.`, "success");
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
      onNotify(`Workspace "${project.name}" deleted.`, "success");
      await onDeleted();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return html`
    <div
      className="team-drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Edit project workspace"
      onClick=${onClose}
    >
      <div className="team-drawer" onClick=${(event) => event.stopPropagation()}>
        <header className="team-drawer-header">
          <h2 style=${{ margin: 0 }}>Edit workspace</h2>
          <button className="button-secondary" type="button" onClick=${onClose}>Close</button>
        </header>

        <form onSubmit=${save}>
          <div className="form-grid">
            <div className="field-wide">
              <label htmlFor="project-edit-name">Project name</label>
              <input
                id="project-edit-name"
                value=${draft.name}
                onInput=${(event) => setDraft({ ...draft, name: event.target.value })}
                required
              />
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
              <label htmlFor="project-edit-release-date">Release date</label>
              <div className="release-row-inputs">
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
                  id="project-edit-release-date"
                  type="date"
                  value=${draft.release_date}
                  onInput=${(event) => setDraft({ ...draft, release_date: event.target.value })}
                />
              </div>
              <span className="help-text">
                The square sets the workspace accent color. The date is when the software becomes
                available to customers — it reads on the project card and is drawn as a marker on
                the Timeline Overview; leave it empty if no release is committed to yet.
              </span>
            </div>
            <div className="field-wide">
              <label className="checkbox-field" htmlFor="project-edit-is-example">
                <input
                  id="project-edit-is-example"
                  type="checkbox"
                  checked=${draft.is_example}
                  onChange=${(event) => setDraft({ ...draft, is_example: event.target.checked })}
                />
                This is an example workspace
              </label>
              <span className="help-text">
                Moves this workspace between the active and example sections on the landing page.
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
            Deleting this workspace also removes ${summary.total_deliverables} deliverable(s), ${summary.total_teams} team(s), and every Jira link on them. This cannot be undone.
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
            >Delete workspace</button>
          </div>
        </div>

        ${error ? html`<div className="team-drawer-row-error">${error}</div>` : null}
      </div>
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

function WorkspaceView({
  dashboard,
  onBack,
  csvFile,
  setCsvFile,
  onCsvSubmit,
  deliverableActions,
  milestoneActions,
  onNotify,
  onWorkspaceRefresh,
  onProjectDeleted,
  submitting,
}) {
  const teams = dashboard.teams;
  const deliverables = dashboard.deliverables;
  const [teamDrawerOpen, setTeamDrawerOpen] = useState(false);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  // Epic keys come from the Jira panel's load; the pickers use them for the
  // "From linked epics" tab. The same load reports which team each epic belongs
  // to, which is how a deliverable's stories get bucketed by team.
  const [epicKeys, setEpicKeys] = useState([]);
  const [epicTeams, setEpicTeams] = useState({});
  const statusFilter = useJiraStatusFilter(dashboard.project.id);

  return html`
    <div className="app-shell">
      <div className="workspace-topbar">
        <button className="back-link" type="button" onClick=${onBack}>
          <${BackArrowIcon} />
          Back to projects
        </button>
      </div>

      <section className="hero">
        <div className="hero-card">
          <div className="eyebrow">Project workspace</div>
          <div className="hero-title-row">
            <h1 className="hero-title">${dashboard.project.name}</h1>
            <button
              className="icon-button"
              type="button"
              onClick=${() => setProjectDrawerOpen(true)}
              aria-label="Edit project workspace"
              title="Edit workspace"
            ><${PencilIcon} /></button>
          </div>
          <p className="hero-copy">
            <${RichText} text=${dashboard.project.description || "No description yet."} />
          </p>
          ${dashboard.project.release_date
            ? html`<p className="hero-release">
                Release · ${formatReleaseDate(dashboard.project.release_date)}
              </p>`
            : null}
          <div className="hero-stats">
            <${SummaryCard}
              label="Teams"
              value=${dashboard.summary.total_teams}
              emphasis="Manage project teams"
              onActivate=${() => setTeamDrawerOpen(true)}
            />
            <${SummaryCard}
              label="Deliverables"
              value=${dashboard.summary.total_deliverables}
              emphasis="Jump to the timeline"
              onActivate=${() => flashScrollTarget("gantt-section")}
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
          projectId=${dashboard.project.id}
          teams=${teams}
          deliverables=${deliverables}
          releaseDate=${dashboard.project.release_date || ""}
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
        />
      </section>

      ${teamDrawerOpen
        ? html`
            <${TeamManagerDrawer}
              projectId=${dashboard.project.id}
              teams=${teams}
              onClose=${() => setTeamDrawerOpen(false)}
              onNotify=${onNotify}
              onChanged=${onWorkspaceRefresh}
            />
          `
        : null}

      ${projectDrawerOpen
        ? html`
            <${ProjectSettingsDrawer}
              project=${dashboard.project}
              summary=${dashboard.summary}
              onClose=${() => setProjectDrawerOpen(false)}
              onNotify=${onNotify}
              onSaved=${onWorkspaceRefresh}
              onDeleted=${onProjectDeleted}
            />
          `
        : null}
    </div>
  `;
}

function App() {
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [dashboard, setDashboard] = useState(null);

  const [projectForm, setProjectForm] = useState(DEFAULT_PROJECT);
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

  const loadDashboard = async (projectId) => {
    const data = await api(`/api/projects/${projectId}/dashboard`);
    setDashboard(data);
    return data;
  };

  const refreshWorkspace = async () => {
    if (!selectedProjectId) {
      return;
    }
    await Promise.all([loadProjects(), loadDashboard(selectedProjectId)]);
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await loadProjects();
      } catch (error) {
        notify(error.message, "error");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const goToPortfolio = () => {
    setSelectedProjectId(null);
    setDashboard(null);
  };

  const handleProjectDeleted = async () => {
    goToPortfolio();
    await loadProjects();
  };

  const openProject = async (projectId) => {
    setLoading(true);
    try {
      await loadDashboard(projectId);
      setSelectedProjectId(projectId);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateProject = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const project = await api("/api/projects", {
        method: "POST",
        // An empty date box is "no release date yet", not an invalid date.
        body: JSON.stringify({
          ...projectForm,
          release_date: projectForm.release_date || null,
        }),
      });
      setProjectForm(DEFAULT_PROJECT);
      await loadProjects();
      notify("Project onboarded.", "success");
      await openProject(project.id);
    } catch (error) {
      notify(error.message, "error");
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
      await refreshWorkspace();
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
        payload,
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
      const result = await api(`/api/projects/${selectedProjectId}/import/csv`, {
        method: "POST",
        body: formData,
      });
      setCsvFile(null);
      notify(
        `Imported ${result.imported_deliverables} deliverable(s), created ${result.created_teams} team(s)` +
          (result.errors.length ? `. ${result.errors.length} warning(s) logged.` : "."),
        result.errors.length ? "error" : "success"
      );
      await refreshWorkspace();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !selectedProjectId) {
    return html`<${LoadingShell} copy="Loading project portfolio" />`;
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
      ${selectedProjectId && dashboard
        ? html`
            <${WorkspaceView}
              dashboard=${dashboard}
              onBack=${goToPortfolio}
              csvFile=${csvFile}
              setCsvFile=${setCsvFile}
              onCsvSubmit=${handleCsvSubmit}
              deliverableActions=${deliverableActions}
              milestoneActions=${milestoneActions}
              onNotify=${notify}
              onWorkspaceRefresh=${refreshWorkspace}
              onProjectDeleted=${handleProjectDeleted}
              submitting=${submitting}
            />
          `
        : html`
            <${LandingView}
              projects=${projects}
              onOpenProject=${openProject}
              projectForm=${projectForm}
              setProjectForm=${setProjectForm}
              onCreateProject=${handleCreateProject}
              submitting=${submitting}
            />
          `}
    </>
  `;
}

createRoot(document.getElementById("root")).render(React.createElement(App));
