import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

// htm passes '' for <> fragments; React 18 requires React.Fragment
const html = htm.bind((type, props, ...children) =>
  React.createElement(type || React.Fragment, props, ...children)
);
const STATUS_OPTIONS = ["planned", "in_progress", "blocked", "done"];
const DEFAULT_PROJECT = { name: "", description: "", color: "#0f766e" };
const DEFAULT_TASK = {
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

function jiraStatusClass(category) {
  const key = (category || "").toLowerCase();
  if (key === "done") return "jira-status-pill done";
  if (key === "indeterminate" || key === "in-progress") return "jira-status-pill in-progress";
  return "jira-status-pill todo";
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

function JiraPickerModal({ title, teams, onClose, onLink, submitting, error, setError }) {
  const [mode, setMode] = useState("search");
  const [jql, setJql] = useState("");
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [pickedIssue, setPickedIssue] = useState(null);
  const [selectedTeamId, setSelectedTeamId] = useState("");

  const runSearch = async (event) => {
    if (event) event.preventDefault();
    const trimmedJql = jql.trim();
    const trimmedKeyword = keyword.trim();
    let query = trimmedJql;
    if (!query && trimmedKeyword) {
      const safe = trimmedKeyword.replace(/"/g, '\\"');
      query = `text ~ "${safe}" ORDER BY updated DESC`;
    }
    if (!query) {
      setError("Enter a JQL query or a keyword to search.");
      return;
    }
    setError("");
    setSearching(true);
    try {
      const payload = await api(`/api/jira/search?jql=${encodeURIComponent(query)}&limit=25`);
      setResults(payload.issues || []);
    } catch (err) {
      setError(err.message);
      setResults([]);
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
      setError(err.message);
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
            Paste key
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

        ${mode === "search"
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
                : html`<div className="empty-state">No results yet — run a search.</div>`}
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

function JiraEpicChildren({ epicKey }) {
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
            : children && children.length
              ? html`
                  <ul className="jira-children-list">
                    ${children.map(
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
                  </ul>
                `
              : html`<div className="help-text">No child stories in Jira.</div>`
        : null}
    </div>
  `;
}

function JiraProjectPanel({ projectId, teams, onMessage }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pickerError, setPickerError] = useState("");

  const load = async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const payload = await api(`/api/projects/${projectId}/jira`);
      setData(payload);
    } catch (err) {
      onMessage(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setData(null);
    load();
  }, [projectId]);

  const forceSync = async () => {
    setLoading(true);
    try {
      const payload = await api(`/api/projects/${projectId}/jira/sync`, { method: "POST" });
      setData(payload);
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
          <h2>Jira epics</h2>
          <p className="panel-copy">
            Link Jira epics to this project. Stories under each epic are visible in a read-only list.
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

      ${data && data.stale ? html`<div className="help-text">Showing cached data — refresh failed.</div>` : null}

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
                      <${JiraEpicChildren} epicKey=${link.issue.key} />
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

function JiraTaskLinks({ taskId, onMessage }) {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pickerError, setPickerError] = useState("");

  const load = async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const payload = await api(`/api/tasks/${taskId}/jira`);
      setLinks(payload);
    } catch (err) {
      onMessage(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLinks([]);
    load();
  }, [taskId]);

  const linkIssue = async (payload) => {
    setSubmitting(true);
    setPickerError("");
    try {
      await api(`/api/tasks/${taskId}/jira/links`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setShowPicker(false);
      onMessage(`Linked ${payload.jira_key} to task.`, "success");
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
      await api(`/api/tasks/${taskId}/jira/links/${link.id}`, { method: "DELETE" });
      onMessage(`Unlinked ${link.issue.key}.`, "success");
      await load();
    } catch (err) {
      onMessage(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return html`
    <div className="jira-task-links">
      <div className="jira-task-header">
        <strong>Jira issues</strong>
        <button className="button-secondary" type="button" onClick=${() => { setPickerError(""); setShowPicker(true); }}>
          Link issue
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
          : html`<div className="help-text">No Jira issues linked to this task yet.</div>`}
      ${showPicker
        ? html`
            <${JiraPickerModal}
              title="Link Jira issue to task"
              teams=${null}
              onClose=${() => setShowPicker(false)}
              onLink=${linkIssue}
              submitting=${submitting}
              error=${pickerError}
              setError=${setPickerError}
            />
          `
        : null}
    </div>
  `;
}

function taskToForm(task) {
  return {
    title: task.title,
    description: task.description,
    team_id: String(task.team_id),
    planned_start: task.planned_start,
    planned_end: task.planned_end,
    current_start: task.current_start || "",
    current_end: task.current_end || "",
    status: task.status,
    progress: task.progress,
    dependency_ids: task.dependency_ids.map(String),
    contributor_team_ids: (task.contributor_team_ids || []).map(String),
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
                <span className="tiny-pill">${project.total_tasks} tasks</span>
                <span className="tiny-pill">${project.total_teams} teams</span>
                <span className="tiny-pill">${project.at_risk_tasks} at risk</span>
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

function TaskForm({ teams, tasks, form, setForm, onSubmit, submitLabel, submitting, showJiraPicker }) {
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
            ${tasks.map((task) => html`<option key=${task.id} value=${task.id}>${task.title}</option>`)}
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
            />
          `
        : null}
    </form>
  `;
}

function InlineEditPopover({ task, form, setForm, onSave, onCancel, submitting }) {
  const handleField = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  return html`
    <form className="inline-popover" onSubmit=${(event) => { event.preventDefault(); onSave(); }}>
      <strong>Quick edit: ${task.title}</strong>
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
        <button className="button-primary" type="submit" disabled=${submitting} aria-busy=${submitting}>Save</button>
        <button className="button-secondary" type="button" onClick=${onCancel}>Cancel</button>
      </div>
    </form>
  `;
}

function GanttRow({ task, timeline, barRefs, isEditing, onOpenInline, inlineControls }) {
  const start = startOfDay(task.current_start || task.planned_start);
  const end = startOfDay(task.current_end || task.planned_end);
  const totalDays = Math.max(differenceInDays(timeline.start, timeline.end), 1);
  const offsetDays = differenceInDays(timeline.start, start);
  const durationDays = Math.max(differenceInDays(start, end) + 1, 1);
  const left = (offsetDays / totalDays) * 100;
  const width = (durationDays / totalDays) * 100;
  const gradient = task.delayed
    ? "linear-gradient(120deg, #b91c1c, #dc2626)"
    : task.at_risk
      ? "linear-gradient(120deg, #b45309, #ea580c)"
      : `linear-gradient(120deg, ${task.team_color}, #0f172a)`;

  return html`
    <div className="gantt-row">
      <div className="task-cell">
        <strong>${task.title}</strong>
        <div>${task.description}</div>
        <div className="task-meta">
          <span className="tiny-pill">${humanizeStatus(task.status)}</span>
          <span className="tiny-pill">Plan: ${formatDisplayDate(task.planned_start)} - ${formatDisplayDate(task.planned_end)}</span>
          ${task.at_risk ? html`<span className="tiny-pill">Risk: ${task.risk_level}</span>` : null}
        </div>
      </div>
      <div className="timeline-grid" style=${{ "--days": timeline.days.length }}>
        <button
          ref=${(node) => { if (node) { barRefs.current[task.id] = node; } }}
          className=${`task-bar ${task.risk_level} ${isEditing ? "editing" : ""}`}
          style=${{ left: `${left}%`, width: `${Math.max(width, 6)}%`, background: gradient }}
          title=${task.risk_reasons.join(" | ") || "On track"}
          onClick=${() => onOpenInline(task)}
          type="button"
        >
          <span className="bar-title">${task.title}</span>
          <span className="bar-progress">${task.progress}%</span>
        </button>
        ${isEditing
          ? html`
              <${InlineEditPopover}
                task=${task}
                form=${inlineControls.form}
                setForm=${inlineControls.setForm}
                onSave=${inlineControls.onSave}
                onCancel=${inlineControls.onCancel}
                submitting=${inlineControls.submitting}
              />
            `
          : null}
      </div>
    </div>
  `;
}

function GanttChart({ teams, tasks, onInlineSave, submitting }) {
  const barRefs = useRef({});
  const bodyRef = useRef(null);
  const [lines, setLines] = useState([]);
  const [editingTaskId, setEditingTaskId] = useState("");
  const [inlineForm, setInlineForm] = useState({ status: "planned", progress: 0, current_start: "", current_end: "" });

  const timeline = useMemo(() => {
    if (!tasks.length) {
      const today = new Date();
      return { start: today, end: addDays(today, 14), days: [today] };
    }
    const starts = tasks.map((task) => startOfDay(task.current_start || task.planned_start));
    const ends = tasks.map((task) => startOfDay(task.current_end || task.planned_end));
    const min = starts.reduce((current, value) => (value < current ? value : current), starts[0]);
    const max = ends.reduce((current, value) => (value > current ? value : current), ends[0]);
    const start = addDays(min, -1);
    const end = addDays(max, 2);
    const span = differenceInDays(start, end);
    const days = Array.from({ length: span + 1 }, (_, index) => addDays(start, index));
    return { start, end, days };
  }, [tasks]);

  useLayoutEffect(() => {
    function redrawLines() {
      if (!bodyRef.current) {
        return;
      }
      const bodyRect = bodyRef.current.getBoundingClientRect();
      const nextLines = [];
      tasks.forEach((task) => {
        const target = barRefs.current[task.id];
        if (!target) {
          return;
        }
        const targetRect = target.getBoundingClientRect();
        task.dependency_ids.forEach((dependencyId) => {
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
            id: `${dependencyId}-${task.id}`,
            level: task.risk_level === "none" ? "medium" : task.risk_level,
            path: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
          });
        });
      });
      setLines(nextLines);
    }

    redrawLines();
    window.addEventListener("resize", redrawLines);
    return () => window.removeEventListener("resize", redrawLines);
  }, [tasks, timeline.days.length]);

  const grouped = teams.map((team) => ({
    ...team,
    tasks: tasks.filter((task) => task.team_id === team.id),
  }));

  const openInline = (task) => {
    setEditingTaskId(String(task.id));
    setInlineForm({
      status: task.status,
      progress: task.progress,
      current_start: task.current_start || "",
      current_end: task.current_end || "",
    });
  };

  const saveInline = () => {
    if (!editingTaskId) {
      return;
    }
    onInlineSave(Number(editingTaskId), {
      status: inlineForm.status,
      progress: Number(inlineForm.progress),
      current_start: inlineForm.current_start || null,
      current_end: inlineForm.current_end || null,
    });
    setEditingTaskId("");
  };

  return html`
    <section className="gantt-shell">
      <div className="gantt-toolbar">
        <div>
          <h2>Timeline overview</h2>
          <p className="gantt-caption">Click any task bar to edit it inline without leaving the timeline view.</p>
        </div>
        <div className="risk-key">
          <div className="legend-pill"><span className="legend-swatch" style=${{ background: "#166534" }}></span>No risk</div>
          <div className="legend-pill"><span className="legend-swatch" style=${{ background: "#b45309" }}></span>Dependency pressure</div>
          <div className="legend-pill"><span className="legend-swatch" style=${{ background: "#b91c1c" }}></span>Date slipped</div>
        </div>
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
                ${team.tasks.length
                  ? team.tasks.map(
                      (task) => html`
                        <${GanttRow}
                          key=${task.id}
                          task=${task}
                          timeline=${timeline}
                          barRefs=${barRefs}
                          isEditing=${String(task.id) === editingTaskId}
                          onOpenInline=${openInline}
                          inlineControls=${{
                            form: inlineForm,
                            setForm: setInlineForm,
                            onSave: saveInline,
                            onCancel: () => setEditingTaskId(""),
                            submitting,
                          }}
                        />
                      `
                    )
                  : html`<div className="empty-state">No tasks for this team yet.</div>`}
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
          Add, rename, recolor, or remove teams for this project. Deletion is blocked while a team still owns or contributes to tasks.
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
            Deleting this workspace also removes ${summary.total_tasks} task(s), ${summary.total_teams} team(s), and every Jira link on them. This cannot be undone.
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

function TaskTable({ tasks }) {
  return html`
    <section className="table-shell" id="risk-register">
      <h2>Risk register</h2>
      <p className="panel-copy">The backend calculates delay and dependency pressure from the current schedule state.</p>
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Team</th>
            <th>Status</th>
            <th>Risk</th>
            <th>Reasons</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map(
            (task) => {
              const contributors = task.contributor_teams || [];
              return html`
                <tr key=${task.id}>
                  <td>
                    <strong>${task.title}</strong>
                    <div className="help-text">Current end: ${task.current_end || task.planned_end}</div>
                  </td>
                  <td>
                    ${task.team_name}
                    ${contributors.length
                      ? html`<span
                          className="team-plus-pill"
                          title=${`Contributors: ${contributors.map((c) => c.name).join(", ")}`}
                        >+${contributors.length}</span>`
                      : null}
                  </td>
                  <td>${humanizeStatus(task.status)}</td>
                  <td><span className=${`risk-badge ${task.risk_level}`}>${task.risk_level}</span></td>
                  <td>
                    ${task.risk_reasons.length
                      ? task.risk_reasons.map((reason) => html`<div key=${reason}>${reason}</div>`)
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
  taskForm,
  setTaskForm,
  editTaskId,
  setEditTaskId,
  editForm,
  setEditForm,
  csvFile,
  setCsvFile,
  onTaskSubmit,
  onUpdateSubmit,
  onCsvSubmit,
  onInlineSave,
  onNotify,
  onWorkspaceRefresh,
  onProjectDeleted,
  submitting,
}) {
  const teams = dashboard.teams;
  const tasks = dashboard.tasks;
  const [teamDrawerOpen, setTeamDrawerOpen] = useState(false);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);

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
            label="Tasks"
            value=${dashboard.summary.total_tasks}
            emphasis="Jump to the timeline"
            onActivate=${() => flashScrollTarget("gantt-section")}
          />
          <${SummaryCard}
            label="At risk"
            value=${dashboard.summary.at_risk_tasks}
            emphasis="Open the risk register"
            onActivate=${() => flashScrollTarget("risk-register")}
          />
          <${SummaryCard}
            label="Delayed"
            value=${dashboard.summary.delayed_tasks}
            emphasis="Jump to the timeline"
            onActivate=${() => flashScrollTarget("gantt-section")}
          />
        </div>
      </section>

      <section id="gantt-section">
        <${GanttChart} teams=${teams} tasks=${tasks} onInlineSave=${onInlineSave} submitting=${submitting} />
        <${TaskTable} tasks=${tasks} />
      </section>

      <${JiraProjectPanel} projectId=${dashboard.project.id} teams=${teams} onMessage=${onNotify} />

      <section className="workspace-panels">
        <article className="panel">
          <h2>Create task</h2>
          <p className="panel-copy">Create tasks beneath the timeline so review stays chart-first.</p>
          <${TaskForm}
            teams=${teams}
            tasks=${tasks}
            form=${taskForm}
            setForm=${setTaskForm}
            onSubmit=${onTaskSubmit}
            submitLabel="Create task"
            submitting=${submitting}
            showJiraPicker=${true}
          />
        </article>

        <article className="panel">
          <h2>Update task</h2>
          <div className="field-wide">
            <label htmlFor="edit-task">Task</label>
            <select id="edit-task" value=${editTaskId} onChange=${(event) => setEditTaskId(event.target.value)}>
              ${tasks.map((task) => html`<option key=${task.id} value=${task.id}>${task.title}</option>`)}
            </select>
          </div>
          ${editTaskId
            ? html`
                <${TaskForm}
                  teams=${teams}
                  tasks=${tasks.filter((task) => String(task.id) !== String(editTaskId))}
                  form=${editForm}
                  setForm=${setEditForm}
                  onSubmit=${onUpdateSubmit}
                  submitLabel="Save update"
                  submitting=${submitting}
                  showJiraPicker=${false}
                />
                <${JiraTaskLinks} taskId=${Number(editTaskId)} onMessage=${onNotify} />
              `
            : html`<div className="empty-state">Add a task first to start tracking updates.</div>`}
        </article>

        <article className="panel">
          <h2>Bulk import</h2>
          <p className="panel-copy">Import tasks for this selected project only.</p>
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
  const [taskForm, setTaskForm] = useState(DEFAULT_TASK);
  const [editTaskId, setEditTaskId] = useState("");
  const [editForm, setEditForm] = useState(DEFAULT_TASK);
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

    if (!taskForm.team_id && data.teams[0]) {
      setTaskForm((current) => ({ ...current, team_id: String(data.teams[0].id) }));
    }
    if (!editTaskId && data.tasks[0]) {
      setEditTaskId(String(data.tasks[0].id));
      setEditForm(taskToForm(data.tasks[0]));
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
    if (!dashboard || !editTaskId) {
      return;
    }
    const task = dashboard.tasks.find((item) => String(item.id) === String(editTaskId));
    if (task) {
      setEditForm(taskToForm(task));
    }
  }, [dashboard, editTaskId]);

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
    setEditTaskId("");
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
      setTaskForm({ ...DEFAULT_TASK, team_id: "" });
      setEditTaskId("");
      setEditForm(DEFAULT_TASK);
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

  const handleTaskSubmit = (event) => {
    event.preventDefault();
    submitJson(
      `/api/projects/${selectedProjectId}/tasks`,
      "POST",
      {
        ...taskForm,
        team_id: Number(taskForm.team_id),
        progress: Number(taskForm.progress),
        dependency_ids: taskForm.dependency_ids.map(Number),
        contributor_team_ids: (taskForm.contributor_team_ids || []).map(Number),
        jira_keys: taskForm.jira_keys || [],
        current_start: taskForm.current_start || null,
        current_end: taskForm.current_end || null,
      },
      {
        message: "Task created.",
        reset: () => setTaskForm({
          ...DEFAULT_TASK,
          team_id: dashboard.teams[0] ? String(dashboard.teams[0].id) : "",
        }),
      }
    );
  };

  const handleUpdateTask = (taskId, payload) => {
    submitJson(
      `/api/projects/${selectedProjectId}/tasks/${taskId}`,
      "PUT",
      payload,
      {
        message: "Task updated.",
        reset: () => {},
      }
    );
  };

  const handleUpdateSubmit = (event) => {
    event.preventDefault();
    if (!editTaskId) {
      return;
    }
    handleUpdateTask(Number(editTaskId), {
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
        `Imported ${result.imported_tasks} task(s), created ${result.created_teams} team(s)` +
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
              taskForm=${taskForm}
              setTaskForm=${setTaskForm}
              editTaskId=${editTaskId}
              setEditTaskId=${setEditTaskId}
              editForm=${editForm}
              setEditForm=${setEditForm}
              csvFile=${csvFile}
              setCsvFile=${setCsvFile}
              onTaskSubmit=${handleTaskSubmit}
              onUpdateSubmit=${handleUpdateSubmit}
              onCsvSubmit=${handleCsvSubmit}
              onInlineSave=${handleUpdateTask}
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
