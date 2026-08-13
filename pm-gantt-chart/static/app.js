import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

// htm passes '' for <> fragments; React 18 requires React.Fragment
const html = htm.bind((type, props, ...children) =>
  React.createElement(type || React.Fragment, props, ...children)
);
const STATUS_OPTIONS = ["planned", "in_progress", "blocked", "done"];
const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const STATUS_FILTER_PREFIX = "pm-tool.jira-status-filter.";
const GANTT_JIRA_PREFIX = "pm-tool.gantt-jira.";
const DEFAULT_PROJECT = { name: "", description: "", color: "#0f766e" };
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
      throw new Error(payload.detail || "Request failed");
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

function jiraStatusClass(category) {
  const key = (category || "").toLowerCase();
  if (key === "done") return "jira-status-pill done";
  if (key === "indeterminate" || key === "in-progress") return "jira-status-pill in-progress";
  return "jira-status-pill todo";
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
  submitting,
  error,
  setError,
  epicKeys,
  statusFilter,
  linkedKeys,
}) {
  const hasEpics = Boolean(epicKeys && epicKeys.length);
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
  const alreadyLinked = new Set(linkedKeys || []);

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
    if (event) event.preventDefault();
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
      setError((await jiraTrouble()) || err.message);
      setResults([]);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

  const validateKey = async (event) => {
    if (event) event.preventDefault();
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
      setError((await jiraTrouble()) || err.message);
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

  return html`
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

function JiraProjectPanel({ projectId, teams, onMessage, statusFilter, onEpicsLoaded }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [trouble, setTrouble] = useState("");

  const publishEpicKeys = (payload) => {
    if (typeof onEpicsLoaded !== "function") return;
    onEpicsLoaded(((payload && payload.links) || []).map((link) => link.issue.key));
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

function JiraDeliverableLinks({
  deliverableId,
  onMessage,
  epicKeys,
  statusFilter,
  onLinked,
  compact,
}) {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pickerError, setPickerError] = useState("");

  const load = async () => {
    if (!deliverableId) return;
    setLoading(true);
    try {
      const payload = await api(`/api/deliverables/${deliverableId}/jira`);
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
  }, [deliverableId]);

  const notifyLinked = () => {
    if (typeof onLinked === "function") onLinked();
  };

  const linkIssue = async (payload) => {
    setSubmitting(true);
    setPickerError("");
    try {
      await api(`/api/deliverables/${deliverableId}/jira/links`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setShowPicker(false);
      onMessage(`Linked ${payload.jira_key} to deliverable.`, "success");
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
      await api(`/api/deliverables/${deliverableId}/jira/links/${link.id}`, { method: "DELETE" });
      onMessage(`Unlinked ${link.issue.key}.`, "success");
      await load();
      notifyLinked();
    } catch (err) {
      onMessage(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

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
          ? html`
              <div className="jira-chip-row">
                ${links.map(
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
            `
          : html`<div className="help-text">No Jira stories linked to this deliverable yet.</div>`}
      ${showPicker
        ? html`
            <${JiraPickerModal}
              title="Link Jira story to deliverable"
              teams=${null}
              onClose=${() => setShowPicker(false)}
              onLink=${linkIssue}
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

function LandingView({ projects, onOpenProject, projectForm, setProjectForm, onCreateProject, submitting }) {
  return html`
    <div className="app-shell">
      <section className="landing-hero hero-card">
        <div className="eyebrow">PM Tool v1</div>
        <h1 className="hero-title">PPM Dashboard</h1>
        <p className="hero-copy">
          Select an onboarded project to review timeline risk, dependencies, and delivery status.
        </p>
      </section>

      <section className="project-grid">
        ${projects.map(
          (project) => html`
            <article className="project-card" key=${project.id} style=${{ "--project-color": project.color }}>
              <div className="project-card-header">
                <div className="project-dot"></div>
                <strong>${project.name}</strong>
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
          `
        )}
      </section>

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
              <textarea id="project-description" value=${projectForm.description} onInput=${(event) => setProjectForm({ ...projectForm, description: event.target.value })}></textarea>
            </div>
            <div className="field">
              <label htmlFor="project-color">Accent color</label>
              <input id="project-color" type="color" value=${projectForm.color} onInput=${(event) => setProjectForm({ ...projectForm, color: event.target.value })} />
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

function DeliverableForm({
  teams,
  deliverables,
  form,
  setForm,
  onSubmit,
  submitLabel,
  submitting,
  showJiraPicker,
  epicKeys,
  statusFilter,
}) {
  const handleField = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const handleDependencies = (event) => {
    const values = Array.from(event.target.selectedOptions).map((option) => option.value);
    setForm({ ...form, dependency_ids: values });
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
  const removePendingJira = (key) => {
    setForm({ ...form, jira_keys: pendingKeys.filter((existing) => existing !== key) });
  };

  return html`
    <form onSubmit=${onSubmit}>
      <div className="form-grid">
        <div className="field-wide">
          <label htmlFor=${`${submitLabel}-title`}>Title</label>
          <input id=${`${submitLabel}-title`} value=${form.title} onInput=${handleField("title")} required />
        </div>

        <div className="field">
          <label htmlFor=${`${submitLabel}-team`}>Owning team</label>
          <select id=${`${submitLabel}-team`} value=${form.team_id} onChange=${handleField("team_id")} required>
            <option value="">Select a team</option>
            ${teams.map((team) => html`<option key=${team.id} value=${team.id}>${team.name}</option>`)}
          </select>
        </div>

        <div className="field">
          <label htmlFor=${`${submitLabel}-status`}>Status</label>
          <select id=${`${submitLabel}-status`} value=${form.status} onChange=${handleField("status")}>
            ${STATUS_OPTIONS.map((status) => html`<option key=${status} value=${status}>${humanizeStatus(status)}</option>`) }
          </select>
        </div>

        <div className="field">
          <label htmlFor=${`${submitLabel}-planned-start`}>Planned start</label>
          <input id=${`${submitLabel}-planned-start`} type="date" value=${form.planned_start} onInput=${handleField("planned_start")} required />
        </div>

        <div className="field">
          <label htmlFor=${`${submitLabel}-planned-end`}>Planned end</label>
          <input id=${`${submitLabel}-planned-end`} type="date" value=${form.planned_end} onInput=${handleField("planned_end")} required />
        </div>

        <div className="field">
          <label htmlFor=${`${submitLabel}-current-start`}>Current start</label>
          <input id=${`${submitLabel}-current-start`} type="date" value=${form.current_start} onInput=${handleField("current_start")} />
        </div>

        <div className="field">
          <label htmlFor=${`${submitLabel}-current-end`}>Current end</label>
          <input id=${`${submitLabel}-current-end`} type="date" value=${form.current_end} onInput=${handleField("current_end")} />
        </div>

        <div className="field">
          <label htmlFor=${`${submitLabel}-progress`}>Progress %</label>
          <input id=${`${submitLabel}-progress`} type="number" min="0" max="100" value=${form.progress} onInput=${handleField("progress")} />
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
          <label htmlFor=${`${submitLabel}-dependencies`}>Upstream dependencies</label>
          <select id=${`${submitLabel}-dependencies`} multiple value=${form.dependency_ids} onChange=${handleDependencies}>
            ${deliverables.map(
              (deliverable) => html`
                <option key=${deliverable.id} value=${deliverable.id}>${deliverable.title}</option>
              `
            )}
          </select>
        </div>

        <div className="field-wide">
          <label htmlFor=${`${submitLabel}-description`}>Description</label>
          <textarea id=${`${submitLabel}-description`} value=${form.description} onInput=${handleField("description")}></textarea>
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
}) {
  const handleField = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  // A plain div, not a form: the story picker it now hosts renders its own
  // forms, and nesting forms is invalid.
  return html`
    <div className="inline-popover">
      <strong>Quick edit: ${deliverable.title}</strong>
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
      <${JiraDeliverableLinks}
        deliverableId=${deliverable.id}
        onMessage=${onMessage}
        epicKeys=${epicKeys}
        statusFilter=${statusFilter}
        onLinked=${onLinksChanged}
        compact=${true}
      />
    </div>
  `;
}

function GanttStoryList({ links, statusFilter }) {
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

  return html`
    <div className="gantt-story-list">
      <span className="tiny-pill">Jira ${visible.length}</span>
      ${visible.map((link) => {
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
      })}
      ${hidden ? html`<span className="help-text">${hidden} hidden by the status filter.</span>` : null}
    </div>
  `;
}

function GanttRow({
  deliverable,
  timeline,
  barRefs,
  isEditing,
  onOpenInline,
  inlineControls,
  stories,
  showStories,
  statusFilter,
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

  return html`
    <div className="gantt-row">
      <div className="task-cell">
        <strong>${deliverable.title}</strong>
        <div>${deliverable.description}</div>
        <div className="task-meta">
          <span className="tiny-pill">${humanizeStatus(deliverable.status)}</span>
          <span className="tiny-pill">Plan: ${formatDisplayDate(deliverable.planned_start)} - ${formatDisplayDate(deliverable.planned_end)}</span>
          ${deliverable.at_risk ? html`<span className="tiny-pill">Risk: ${deliverable.risk_level}</span>` : null}
        </div>
        ${showStories
          ? html`<${GanttStoryList} links=${stories || []} statusFilter=${statusFilter} />`
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
        ${isEditing
          ? html`
              <${InlineEditPopover}
                deliverable=${deliverable}
                form=${inlineControls.form}
                setForm=${inlineControls.setForm}
                onSave=${inlineControls.onSave}
                onCancel=${inlineControls.onCancel}
                submitting=${inlineControls.submitting}
                onMessage=${inlineControls.onMessage}
                epicKeys=${inlineControls.epicKeys}
                statusFilter=${statusFilter}
                onLinksChanged=${inlineControls.onLinksChanged}
              />
            `
          : null}
      </div>
    </div>
  `;
}

function GanttChart({
  projectId,
  teams,
  deliverables,
  onInlineSave,
  submitting,
  statusFilter,
  epicKeys,
  onMessage,
}) {
  const barRefs = useRef({});
  const bodyRef = useRef(null);
  const [lines, setLines] = useState([]);
  const [editingDeliverableId, setEditingDeliverableId] = useState("");
  const [inlineForm, setInlineForm] = useState({ status: "planned", progress: 0, current_start: "", current_end: "" });
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

  const timeline = useMemo(() => {
    if (!deliverables.length) {
      const today = new Date();
      return { start: today, end: addDays(today, 14), days: [today] };
    }
    const starts = deliverables.map((item) => startOfDay(item.current_start || item.planned_start));
    const ends = deliverables.map((item) => startOfDay(item.current_end || item.planned_end));
    const min = starts.reduce((current, value) => (value < current ? value : current), starts[0]);
    const max = ends.reduce((current, value) => (value > current ? value : current), ends[0]);
    const start = addDays(min, -1);
    const end = addDays(max, 2);
    const span = differenceInDays(start, end);
    const days = Array.from({ length: span + 1 }, (_, index) => addDays(start, index));
    return { start, end, days };
  }, [deliverables]);

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
    // The story overlay changes row heights, so the curves have to be redrawn.
  }, [deliverables, timeline.days.length, showStories, storyData]);

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

  return html`
    <section className="gantt-shell">
      <div className="gantt-toolbar">
        <div>
          <h2>Timeline overview</h2>
          <p className="gantt-caption">
            Click any deliverable bar to edit it — and link Jira stories — without leaving the timeline view.
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
                          inlineControls=${{
                            form: inlineForm,
                            setForm: setInlineForm,
                            onSave: saveInline,
                            onCancel: () => setEditingDeliverableId(""),
                            submitting,
                            onMessage,
                            epicKeys,
                            onLinksChanged: () => {
                              if (showStories) loadStories();
                            },
                          }}
                        />
                      `
                    )
                  : html`<div className="empty-state">No deliverables for this team yet.</div>`}
              </div>
            `
          )}
        </div>
      </div>
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
            <div className="field">
              <label htmlFor="project-edit-color">Accent color</label>
              <input
                id="project-edit-color"
                type="color"
                value=${draft.color}
                onInput=${(event) => setDraft({ ...draft, color: event.target.value })}
              />
            </div>
            <div className="field-wide">
              <label htmlFor="project-edit-description">Description</label>
              <textarea
                id="project-edit-description"
                value=${draft.description}
                onInput=${(event) => setDraft({ ...draft, description: event.target.value })}
              ></textarea>
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
              return html`
                <tr key=${deliverable.id}>
                  <td>
                    <strong>${deliverable.title}</strong>
                    <div className="help-text">Current end: ${deliverable.current_end || deliverable.planned_end}</div>
                  </td>
                  <td>
                    ${deliverable.team_name}
                    ${contributors.length
                      ? html`<span
                          className="team-plus-pill"
                          title=${`Contributors: ${contributors.map((c) => c.name).join(", ")}`}
                        >+${contributors.length}</span>`
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
  deliverableForm,
  setDeliverableForm,
  editDeliverableId,
  setEditDeliverableId,
  editForm,
  setEditForm,
  csvFile,
  setCsvFile,
  onDeliverableSubmit,
  onUpdateSubmit,
  onCsvSubmit,
  onInlineSave,
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
  // "From linked epics" tab.
  const [epicKeys, setEpicKeys] = useState([]);
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
          <p className="hero-copy">${dashboard.project.description || "No description yet."}</p>
        </div>
        <div className="hero-side">
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
      </section>

      <section id="gantt-section">
        <${GanttChart}
          projectId=${dashboard.project.id}
          teams=${teams}
          deliverables=${deliverables}
          onInlineSave=${onInlineSave}
          submitting=${submitting}
          statusFilter=${statusFilter}
          epicKeys=${epicKeys}
          onMessage=${onNotify}
        />
        <${DeliverableTable} deliverables=${deliverables} />
      </section>

      <${JiraProjectPanel}
        projectId=${dashboard.project.id}
        teams=${teams}
        onMessage=${onNotify}
        statusFilter=${statusFilter}
        onEpicsLoaded=${setEpicKeys}
      />

      <section className="workspace-panels">
        <article className="panel">
          <h2>Create deliverable</h2>
          <p className="panel-copy">
            Project deliverables include project features and enhancements. Create them beneath the
            timeline so review stays chart-first.
          </p>
          <${DeliverableForm}
            teams=${teams}
            deliverables=${deliverables}
            form=${deliverableForm}
            setForm=${setDeliverableForm}
            onSubmit=${onDeliverableSubmit}
            submitLabel="Create deliverable"
            submitting=${submitting}
            showJiraPicker=${true}
            epicKeys=${epicKeys}
            statusFilter=${statusFilter}
          />
        </article>

        <article className="panel">
          <h2>Update deliverable</h2>
          <div className="field-wide">
            <label htmlFor="edit-deliverable">Deliverable</label>
            <select
              id="edit-deliverable"
              value=${editDeliverableId}
              onChange=${(event) => setEditDeliverableId(event.target.value)}
            >
              ${deliverables.map(
                (deliverable) => html`
                  <option key=${deliverable.id} value=${deliverable.id}>${deliverable.title}</option>
                `
              )}
            </select>
          </div>
          ${editDeliverableId
            ? html`
                <${DeliverableForm}
                  teams=${teams}
                  deliverables=${deliverables.filter(
                    (deliverable) => String(deliverable.id) !== String(editDeliverableId)
                  )}
                  form=${editForm}
                  setForm=${setEditForm}
                  onSubmit=${onUpdateSubmit}
                  submitLabel="Save update"
                  submitting=${submitting}
                  showJiraPicker=${false}
                />
                <${JiraDeliverableLinks}
                  deliverableId=${Number(editDeliverableId)}
                  onMessage=${onNotify}
                  epicKeys=${epicKeys}
                  statusFilter=${statusFilter}
                />
              `
            : html`<div className="empty-state">Add a deliverable first to start tracking updates.</div>`}
        </article>

        <article className="panel">
          <h2>Bulk import</h2>
          <p className="panel-copy">Import deliverables for this selected project only.</p>
          <form onSubmit=${onCsvSubmit}>
            <div className="field-wide">
              <label htmlFor="csv-file">CSV file</label>
              <input id="csv-file" type="file" accept=".csv,text/csv" onChange=${(event) => setCsvFile(event.target.files && event.target.files[0] ? event.target.files[0] : null)} />
            </div>
            <div className="actions">
              <button className="button-primary" type="submit" disabled=${submitting}>Import CSV</button>
              ${csvFile ? html`<span className="help-text">Selected: ${csvFile.name}</span>` : null}
            </div>
          </form>
        </article>
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
  const [deliverableForm, setDeliverableForm] = useState(DEFAULT_DELIVERABLE);
  const [editDeliverableId, setEditDeliverableId] = useState("");
  const [editForm, setEditForm] = useState(DEFAULT_DELIVERABLE);
  const [csvFile, setCsvFile] = useState(null);

  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState("success");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const loadProjects = async () => {
    const data = await api("/api/projects");
    setProjects(data);
    return data;
  };

  const loadDashboard = async (projectId) => {
    const data = await api(`/api/projects/${projectId}/dashboard`);
    setDashboard(data);

    if (!deliverableForm.team_id && data.teams[0]) {
      setDeliverableForm((current) => ({ ...current, team_id: String(data.teams[0].id) }));
    }
    if (!editDeliverableId && data.deliverables[0]) {
      setEditDeliverableId(String(data.deliverables[0].id));
      setEditForm(deliverableToForm(data.deliverables[0]));
    }
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
        setMessage(error.message);
        setMessageTone("error");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!dashboard || !editDeliverableId) {
      return;
    }
    const deliverable = dashboard.deliverables.find(
      (item) => String(item.id) === String(editDeliverableId)
    );
    if (deliverable) {
      setEditForm(deliverableToForm(deliverable));
    }
  }, [dashboard, editDeliverableId]);

  const submitJson = async (path, method, payload, onDone) => {
    setSubmitting(true);
    try {
      await api(path, { method, body: JSON.stringify(payload) });
      setMessage(onDone.message);
      setMessageTone("success");
      onDone.reset();
      await refreshWorkspace();
    } catch (error) {
      setMessage(error.message);
      setMessageTone("error");
    } finally {
      setSubmitting(false);
    }
  };

  const goToPortfolio = () => {
    setSelectedProjectId(null);
    setDashboard(null);
    setEditDeliverableId("");
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
      setDeliverableForm({ ...DEFAULT_DELIVERABLE, team_id: "" });
      setEditDeliverableId("");
      setEditForm(DEFAULT_DELIVERABLE);
    } catch (error) {
      setMessage(error.message);
      setMessageTone("error");
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
        body: JSON.stringify(projectForm),
      });
      setProjectForm(DEFAULT_PROJECT);
      await loadProjects();
      setMessage("Project onboarded.");
      setMessageTone("success");
      await openProject(project.id);
    } catch (error) {
      setMessage(error.message);
      setMessageTone("error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeliverableSubmit = (event) => {
    event.preventDefault();
    submitJson(
      `/api/projects/${selectedProjectId}/deliverables`,
      "POST",
      {
        ...deliverableForm,
        team_id: Number(deliverableForm.team_id),
        progress: Number(deliverableForm.progress),
        dependency_ids: deliverableForm.dependency_ids.map(Number),
        contributor_team_ids: (deliverableForm.contributor_team_ids || []).map(Number),
        jira_keys: deliverableForm.jira_keys || [],
        current_start: deliverableForm.current_start || null,
        current_end: deliverableForm.current_end || null,
      },
      {
        message: "Deliverable created.",
        reset: () => setDeliverableForm({
          ...DEFAULT_DELIVERABLE,
          team_id: dashboard.teams[0] ? String(dashboard.teams[0].id) : "",
        }),
      }
    );
  };

  const handleUpdateDeliverable = (deliverableId, payload) => {
    submitJson(
      `/api/projects/${selectedProjectId}/deliverables/${deliverableId}`,
      "PUT",
      payload,
      {
        message: "Deliverable updated.",
        reset: () => {},
      }
    );
  };

  const handleUpdateSubmit = (event) => {
    event.preventDefault();
    if (!editDeliverableId) {
      return;
    }
    handleUpdateDeliverable(Number(editDeliverableId), {
      ...editForm,
      team_id: Number(editForm.team_id),
      progress: Number(editForm.progress),
      dependency_ids: editForm.dependency_ids.map(Number),
      contributor_team_ids: (editForm.contributor_team_ids || []).map(Number),
      current_start: editForm.current_start || null,
      current_end: editForm.current_end || null,
    });
  };

  const handleCsvSubmit = async (event) => {
    event.preventDefault();
    if (!csvFile) {
      setMessage("Choose a CSV file first.");
      setMessageTone("error");
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
      setMessage(
        `Imported ${result.imported_deliverables} deliverable(s), created ${result.created_teams} team(s)` +
          (result.errors.length ? `. ${result.errors.length} warning(s) logged.` : ".")
      );
      setMessageTone(result.errors.length ? "error" : "success");
      await refreshWorkspace();
    } catch (error) {
      setMessage(error.message);
      setMessageTone("error");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !selectedProjectId) {
    return html`<${LoadingShell} copy="Loading project portfolio" />`;
  }

  return html`
    <>
      ${message ? html`<div className=${`status-banner ${messageTone}`} role="status" aria-live="polite">${message}</div>` : null}
      ${selectedProjectId && dashboard
        ? html`
            <${WorkspaceView}
              dashboard=${dashboard}
              onBack=${goToPortfolio}
              deliverableForm=${deliverableForm}
              setDeliverableForm=${setDeliverableForm}
              editDeliverableId=${editDeliverableId}
              setEditDeliverableId=${setEditDeliverableId}
              editForm=${editForm}
              setEditForm=${setEditForm}
              csvFile=${csvFile}
              setCsvFile=${setCsvFile}
              onDeliverableSubmit=${handleDeliverableSubmit}
              onUpdateSubmit=${handleUpdateSubmit}
              onCsvSubmit=${handleCsvSubmit}
              onInlineSave=${handleUpdateDeliverable}
              onNotify=${(text, tone) => { setMessage(text); setMessageTone(tone || "success"); }}
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
