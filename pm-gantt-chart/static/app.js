import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

// htm passes '' for <> fragments; React 18 requires React.Fragment
const html = htm.bind((type, props, ...children) =>
  React.createElement(type || React.Fragment, props, ...children)
);
const STATUS_OPTIONS = ["planned", "in_progress", "blocked", "done"];
const DEFAULT_PROJECT = { name: "", description: "", color: "#0f766e" };
const DEFAULT_TEAM = { name: "", color: "#2563eb" };
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

function SummaryCard({ label, value, emphasis }) {
  return html`
    <div className="summary-card">
      <div className="summary-label">${label}</div>
      <div className="summary-value">${value}</div>
      <div className="summary-emphasis">${emphasis}</div>
    </div>
  `;
}

function LandingView({ projects, onOpenProject, projectForm, setProjectForm, onCreateProject, submitting }) {
  return html`
    <div className="app-shell">
      <section className="landing-hero hero-card">
        <div className="eyebrow">PM Tool v2</div>
        <h1 className="hero-title">Portfolio landing</h1>
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

function TaskForm({ teams, tasks, form, setForm, onSubmit, submitLabel, submitting }) {
  const handleField = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const handleDependencies = (event) => {
    const values = Array.from(event.target.selectedOptions).map((option) => option.value);
    setForm({ ...form, dependency_ids: values });
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
      <div className="actions">
            <button className="button-primary" type="submit" disabled=${submitting} aria-busy=${submitting}>${submitLabel}</button>
      </div>
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

function TaskTable({ tasks }) {
  return html`
    <section className="table-shell">
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
            (task) => html`
              <tr key=${task.id}>
                <td>
                  <strong>${task.title}</strong>
                  <div className="help-text">Current end: ${task.current_end || task.planned_end}</div>
                </td>
                <td>${task.team_name}</td>
                <td>${humanizeStatus(task.status)}</td>
                <td><span className=${`risk-badge ${task.risk_level}`}>${task.risk_level}</span></td>
                <td>
                  ${task.risk_reasons.length
                    ? task.risk_reasons.map((reason) => html`<div key=${reason}>${reason}</div>`)
                    : html`<span className="help-text">No active risk signals.</span>`}
                </td>
              </tr>
            `
          )}
        </tbody>
      </table>
    </section>
  `;
}

function WorkspaceView({
  dashboard,
  onBack,
  teamForm,
  setTeamForm,
  taskForm,
  setTaskForm,
  editTaskId,
  setEditTaskId,
  editForm,
  setEditForm,
  csvFile,
  setCsvFile,
  onTeamSubmit,
  onTaskSubmit,
  onUpdateSubmit,
  onCsvSubmit,
  onInlineSave,
  submitting,
}) {
  const teams = dashboard.teams;
  const tasks = dashboard.tasks;

  return html`
    <div className="app-shell">
      <section className="hero">
        <div className="hero-card">
          <div className="eyebrow">Project workspace</div>
          <h1 className="hero-title">${dashboard.project.name}</h1>
          <p className="hero-copy">${dashboard.project.description || "No description yet."}</p>
          <div className="actions">
            <button className="button-secondary" type="button" onClick=${onBack}>Back to projects</button>
          </div>
        </div>
        <div className="hero-side">
          <${SummaryCard} label="Teams" value=${dashboard.summary.total_teams} emphasis="Project-scoped ownership" />
          <${SummaryCard} label="Tasks" value=${dashboard.summary.total_tasks} emphasis="Current project delivery scope" />
          <${SummaryCard} label="At risk" value=${dashboard.summary.at_risk_tasks} emphasis="Needs schedule attention" />
          <${SummaryCard} label="Delayed" value=${dashboard.summary.delayed_tasks} emphasis="Plan date already breached" />
        </div>
      </section>

      <section>
        <${GanttChart} teams=${teams} tasks=${tasks} onInlineSave=${onInlineSave} submitting=${submitting} />
        <${TaskTable} tasks=${tasks} />
      </section>

      <section className="workspace-panels">
        <article className="panel">
          <h2>Team setup</h2>
          <p className="panel-copy">Add teams under this project only.</p>
          <form onSubmit=${onTeamSubmit}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="team-name">Team name</label>
                <input id="team-name" value=${teamForm.name} onInput=${(event) => setTeamForm({ ...teamForm, name: event.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="team-color">Color</label>
                <input id="team-color" type="color" value=${teamForm.color} onInput=${(event) => setTeamForm({ ...teamForm, color: event.target.value })} />
              </div>
            </div>
            <div className="actions">
              <button className="button-primary" type="submit" disabled=${submitting}>Add team</button>
            </div>
          </form>
        </article>

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
                />
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
    </div>
  `;
}

function App() {
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [dashboard, setDashboard] = useState(null);

  const [projectForm, setProjectForm] = useState(DEFAULT_PROJECT);
  const [teamForm, setTeamForm] = useState(DEFAULT_TEAM);
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

  const handleTeamSubmit = (event) => {
    event.preventDefault();
    submitJson(`/api/projects/${selectedProjectId}/teams`, "POST", teamForm, {
      message: "Team added.",
      reset: () => setTeamForm(DEFAULT_TEAM),
    });
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
        current_start: taskForm.current_start || null,
        current_end: taskForm.current_end || null,
      },
      {
        message: "Task created.",
        reset: () => setTaskForm({ ...DEFAULT_TASK, team_id: dashboard.teams[0] ? String(dashboard.teams[0].id) : "" }),
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
              onBack=${() => { setSelectedProjectId(null); setDashboard(null); setEditTaskId(""); }}
              teamForm=${teamForm}
              setTeamForm=${setTeamForm}
              taskForm=${taskForm}
              setTaskForm=${setTaskForm}
              editTaskId=${editTaskId}
              setEditTaskId=${setEditTaskId}
              editForm=${editForm}
              setEditForm=${setEditForm}
              csvFile=${csvFile}
              setCsvFile=${setCsvFile}
              onTeamSubmit=${handleTeamSubmit}
              onTaskSubmit=${handleTaskSubmit}
              onUpdateSubmit=${handleUpdateSubmit}
              onCsvSubmit=${handleCsvSubmit}
              onInlineSave=${handleUpdateTask}
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
