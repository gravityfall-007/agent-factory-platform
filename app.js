"use strict";

/* ------------------------------------------------------------------ *
 * Agent Factory operator console
 * Same-origin API client, live run stream, approvals, and run history.
 * ------------------------------------------------------------------ */

const DEFAULT_BRANCHES = ["San Francisco", "Berlin", "Singapore", "Remote"];
const RUN_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.recovered",
  "run.snapshot",
  "plan",
  "assignment.started",
  "assignment.completed",
  "assignment.skipped",
  "approval.required",
  "approval.resolved",
  "approval.completed",
  "approval.error",
  "run.waiting_approval",
  "run.synthesizing",
  "run.completed",
  "run.failed",
  "run.canceled",
  "run.ended",
];
const RUN_STATUS = {
  queued: "Queued",
  running: "Running",
  waiting_approval: "Waiting for approval",
  done: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};
const ASSIGNMENT_STATUS = {
  pending: "Pending",
  working: "Working",
  awaiting_approval: "Awaiting approval",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};
const ACTIVE_STATUSES = new Set(["queued", "running", "waiting_approval"]);

let executive = { id: "exec", name: "Executive agent", role: "Executive agent · CEO", branch: "Executive", status: "active", tools: [] };
let state = {
  executive,
  agents: [],
  tools: [],
  approvals: [],
  activities: [],
  tasks: [],
  connectors: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
};
let gateway = { configured: false, mode: "unconfigured", model: null, budget: 100000 };
let stateReady = false;
let backendOutdated = false;
let workspaces = [];
let workspaceId = "";
let workspaceMeta = null;
let selectedBranch = "all";
let activityFilter = "all";
let showAllActivity = false;
let runFilter = "all";
const expandedRuns = new Set();
let refreshPromise = null;
let startInFlight = false;

/** @type {null | {runId:string, source:EventSource|null, events:object[], status:string, plan:object|null, started:Set<string>, results:Map<string,string>, pendingApproval:object|null, terminal:boolean, timer:number|null, poll:number|null, startedAtMs:number, endedAtMs:number|null, connectionLost:boolean}} */
let live = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const initials = (name) =>
  String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase();
const newId = (prefix) => {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 10) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${random}`;
};

const agentById = (id) => state.agents.find((agent) => agent.id === id);
const isActiveStatus = (status) => ACTIVE_STATUSES.has(status);
const branchMeta = { "San Francisco": "sf", Berlin: "berlin", Singapore: "singapore", Remote: "remote" };
const branchClass = (branch) => {
  if (branchMeta[branch]) return branchMeta[branch];
  return `branch-${String(branch || "other").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "other"}`;
};

function allBranches() {
  const configured = Array.isArray(state.branches) && state.branches.length ? state.branches : DEFAULT_BRANCHES;
  const set = new Set(configured);
  for (const agent of state.agents) if (agent.branch) set.add(agent.branch);
  return [...set];
}

function richText(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatFullDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function timeAgo(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
  if (number >= 10_000) return `${(number / 1000).toFixed(1)}k`;
  return number.toLocaleString("en-US");
}

function plural(count, singular, pluralWord = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function taskFor(runId) {
  return state.tasks.find((task) => task.id === runId);
}

const runStatusLabel = (status) => RUN_STATUS[status] || status || "Unknown";
const runStatusClass = (status) => (status === "waiting_approval" ? "waiting" : status || "queued");
const statusBadge = (status) => `<span class="run-status ${escapeHtml(runStatusClass(status))}">${escapeHtml(runStatusLabel(status))}</span>`;

function agentStats(agentId) {
  const assigned = state.tasks.filter((task) => (task.assignments || []).some((assignment) => assignment.employeeId === agentId));
  const completed = assigned.filter((task) => (task.assignments || []).some((assignment) => assignment.employeeId === agentId && assignment.status === "done"));
  const tokens = assigned.reduce(
    (sum, task) =>
      sum +
      (task.assignments || [])
        .filter((assignment) => assignment.employeeId === agentId)
        .reduce((inner, assignment) => inner + (assignment.usage?.totalTokens || 0), 0),
    0,
  );
  return { runs: assigned.length, completed: completed.length, tokens, last: assigned[0]?.createdAt || null };
}

async function apiRequest(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (workspaceId) headers["X-Workspace-Id"] = workspaceId;
  if (options.body) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  } catch {
    throw new Error("The Agent Factory server is unavailable. Start it with `node server.mjs`.");
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    /* handled below */
  }
  if (!response.ok) throw new Error(payload.error || payload.message || `Request failed (${response.status})`);
  return payload;
}

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  node.textContent = message;
  $("#toast-region").append(node);
  window.setTimeout(() => node.remove(), 3800);
}

function setSync(text) {
  $("#sync-status").innerHTML = `${escapeHtml(text)} <i class="sync-dot"></i>`;
}

function setTaskMessage(text) {
  $("#task-message").textContent = text;
}

/* ----------------------------- gateway ----------------------------- */

function updateGatewayChrome() {
  const badge = $("#gateway-status");
  if (!badge) return;
  badge.classList.remove("ready", "offline", "pending", "demo");
  const runButton = $("#run-task-button");
  if (!stateReady) {
    badge.classList.add("pending");
    badge.innerHTML = '<span class="demo-pulse"></span> CONNECTING TO LOCAL SERVER';
    runButton.disabled = true;
  } else if (backendOutdated) {
    badge.classList.add("offline");
    badge.innerHTML = '<span class="demo-pulse"></span> RESTART SERVER · OLD BACKEND';
    badge.title = "The UI is newer than the running server. Restart node server.mjs to enable live runs, usage, backups, and resets.";
    runButton.disabled = true;
  } else if (!gateway.configured) {
    badge.classList.add("offline");
    badge.innerHTML = '<span class="demo-pulse"></span> MODEL GATEWAY NOT CONFIGURED';
    runButton.disabled = true;
  } else if (gateway.mode === "demo") {
    badge.classList.add("ready", "demo");
    badge.innerHTML = `<span class="demo-pulse"></span> DEMO MODE · ${escapeHtml(gateway.model || "simulated")}`;
    badge.title = "Demo mode simulates every model and tool call. No external system is contacted.";
    runButton.disabled = false;
  } else {
    badge.classList.add("ready");
    badge.innerHTML = `<span class="demo-pulse"></span> MODEL READY · ${escapeHtml(gateway.model || "gateway")}`;
    badge.title = "Live model gateway configured. External MCP calls still require approval.";
    runButton.disabled = false;
  }
  if (startInFlight) runButton.disabled = true;
  if (!stateReady) {
    setTaskMessage("Waiting for the local server and workspace…");
  } else if (backendOutdated) {
    setTaskMessage("The running server is an older build. Stop it and start `node server.mjs` again to enable live runs, measured usage, approval streaming, backups, and resets.");
  } else if (!gateway.configured) {
    setTaskMessage("Model gateway is not configured. Set OPENAI_BASE_URL, OPENAI_API_KEY, and AGENT_FACTORY_MODEL, or start with AGENT_FACTORY_DEMO=1.");
  } else if (!live) {
    setTaskMessage(
      gateway.mode === "demo"
        ? "Demo mode: plans, results, and usage are simulated. No external model or tool is contacted."
        : `Model gateway ready · ${gateway.model}. Tool entries are permission labels only.`,
    );
  }
}

/* ------------------------------ boot ------------------------------- */

async function refreshWorkspace({ quiet = false } = {}) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    let knownDefault = "";
    try {
      let list = { workspaces: [], defaultId: "" };
      try {
        list = await apiRequest("/api/workspaces");
      } catch {
        backendOutdated = true;
      }
      workspaces = Array.isArray(list.workspaces) ? list.workspaces : [];
      knownDefault = list.defaultId || workspaces[0]?.id || "";
      let stored = "";
      try {
        stored = localStorage.getItem("agent-factory-workspace") || "";
      } catch {
        stored = "";
      }
      if (!workspaceId) workspaceId = stored;
      if (!workspaces.some((workspace) => workspace.id === workspaceId)) workspaceId = knownDefault;
      workspaceMeta = workspaces.find((workspace) => workspace.id === workspaceId) || null;

      const [status, workspace, active] = await Promise.all([
        apiRequest("/api/status"),
        apiRequest("/api/state"),
        apiRequest("/api/runs/active").catch(() => ({ runs: [] })),
      ]);
      gateway = status;
      backendOutdated = backendOutdated || status.mode === undefined;
      state = workspace;
      executive = workspace.executive;
      workspaces = list.workspaces;
      workspaceMeta = workspace.workspace || workspaceMeta;
      if (workspaceMeta) {
        workspaceId = workspaceMeta.id;
        try {
          localStorage.setItem("agent-factory-workspace", workspaceId);
        } catch {
          /* ignore storage failures */
        }
      }
      stateReady = true;
      render();
      updateGatewayChrome();
      setSync(quiet ? "Synced" : "Workspace loaded");
      if (!live && active.runs.length) attachRun(pickActiveRun(active.runs).runId);
      return true;
    } catch (error) {
      if (knownDefault && /workspace not found/i.test(error.message)) workspaceId = knownDefault;
      stateReady = false;
      gateway = { configured: false, mode: "unconfigured", model: null, budget: 100000 };
      updateGatewayChrome();
      setSync("Workspace not loaded");
      setTaskMessage(error.message);
      render();
      if (!quiet) toast(`Workspace could not load. ${error.message}`, true);
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

function pickActiveRun(runs) {
  const order = { running: 0, waiting_approval: 1, queued: 2 };
  return [...runs].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))[0];
}

/* ----------------------------- render ------------------------------ */

function render() {
  renderBranchList();
  renderOrgChart();
  renderApprovals();
  renderActivity();
  renderTasks();
  renderRuns();
  renderTools();
  renderConnectors();
  renderMetrics();
  renderWorkspaceChrome();
  renderLive();
}

function renderWorkspaceChrome() {
  const meta = workspaceMeta || state.workspace || { id: workspaceId, name: "Workspace", company: "" };
  const operator = state.operator || { name: "Jordan Davis", role: "Workspace admin" };
  const workspaceName = meta.name || "Workspace";
  const company = meta.company || meta.name || "Local workspace";
  $("#workspace-name").textContent = workspaceName;
  $("#workspace-company").textContent = company;
  $("#workspace-avatar").textContent = (initials(company).slice(0, 1) || "W");
  $("#profile-name").textContent = operator.name;
  $("#profile-role").textContent = operator.role;
  $("#profile-avatar").textContent = initials(operator.name) || "OP";
  $("#greeting-name").textContent = String(operator.name || "there").trim().split(/\s+/)[0] || "there";
  document.title = `Agent Factory — ${company}`;
  renderWorkspaceMenu();
}

function renderWorkspaceMenu() {
  const host = $("#workspace-menu-list");
  if (!host) return;
  host.innerHTML = workspaces
    .map((workspace) => {
      const active = workspace.id === workspaceId;
      return `<button type="button" role="menuitem" class="workspace-option ${active ? "active" : ""}" data-workspace-switch="${escapeHtml(workspace.id)}">
        <span class="workspace-option-avatar">${escapeHtml((initials(workspace.company || workspace.name).slice(0, 1) || "W"))}</span>
        <span class="workspace-option-copy"><strong>${escapeHtml(workspace.name)}</strong><small>${escapeHtml(workspace.company)}</small></span>
        ${active ? '<span class="workspace-check" aria-label="Current workspace">✓</span>' : ""}
      </button>`;
    })
    .join("");
}

function renderBranchList() {
  const branches = allBranches();
  if (selectedBranch !== "all" && !branches.includes(selectedBranch)) selectedBranch = "all";
  const rows = [
    `<a href="#employees" class="branch-item ${selectedBranch === "all" ? "selected" : ""}" data-branch="all"><span class="branch-dot all-dot" aria-hidden="true">✳</span>All branches <span class="branch-count">${state.agents.length}</span></a>`,
    ...branches.map((branch) => {
      const count = state.agents.filter((agent) => agent.branch === branch).length;
      return `<a href="#employees" class="branch-item ${selectedBranch === branch ? "selected" : ""}" data-branch="${escapeHtml(branch)}"><span class="branch-dot ${escapeHtml(branchClass(branch))}" aria-hidden="true"></span>${escapeHtml(branch)} <span class="branch-count">${count}</span></a>`;
    }),
  ];
  $("#branch-list").innerHTML = rows.join("");
}

function renderOrgChart() {
  const branches = allBranches();
  const visibleBranches = selectedBranch === "all" ? branches : branches.filter((branch) => branch === selectedBranch);
  const executiveTools = executive.tools.filter((name) => state.tools.some((tool) => tool.name === name && tool.connected)).length;
  const branchCards = visibleBranches
    .map((branch) => {
      const agents = state.agents.filter((agent) => agent.branch === branch);
      const renderAgentNode = (agent, nested, seen) => {
        if (seen.has(agent.id)) return "";
        const nextSeen = new Set(seen).add(agent.id);
        const manager = agent.managerId === "exec" ? executive.name : agentById(agent.managerId)?.name || executive.name;
        const children = agents.filter((child) => child.managerId === agent.id);
        const stats = agentStats(agent.id);
        const row = `<div class="branch-agent">
          <span class="agent-avatar" aria-hidden="true">${escapeHtml(initials(agent.name))}</span>
          <span class="agent-info"><span class="agent-name">${escapeHtml(agent.name)}</span><span class="agent-role">${escapeHtml(agent.role)} · reports to ${escapeHtml(manager)}</span><span class="agent-capabilities">${escapeHtml(agent.capabilities.join(", ") || "No capabilities listed")}${stats.runs ? ` · ${plural(stats.runs, "run")}` : ""}</span></span>
          <span class="agent-status" aria-label="${agent.status === "active" ? "Active" : "Idle"}">${agent.status === "active" ? "Active" : "Idle"}</span>
          <button class="agent-edit" type="button" data-edit-agent="${escapeHtml(agent.id)}" aria-label="Edit ${escapeHtml(agent.name)}" title="Edit employee">✎</button>
        </div>`;
        return `${nested ? `<div class="agent-children">${row}</div>` : row}${children.map((child) => renderAgentNode(child, true, nextSeen)).join("")}`;
      };
      const roots = agents.filter((agent) => agent.managerId === "exec" || !agents.some((candidate) => candidate.id === agent.managerId));
      return `<section class="branch-card" aria-label="${escapeHtml(branch)} branch">
        <div class="branch-card-head"><span class="branch-dot ${escapeHtml(branchClass(branch))}" aria-hidden="true"></span>${escapeHtml(branch)}<small>${plural(agents.length, "EMPLOYEE")}</small></div>
        ${agents.length ? roots.map((agent) => renderAgentNode(agent, false, new Set())).join("") : `<div class="empty-branch">No employees in this branch yet.</div>`}
      </section>`;
    })
    .join("");
  const emptyCta = state.agents.length
    ? ""
    : `<div class="org-empty"><div><strong>No employees yet</strong><p>This workspace is empty. Add your first specialist with a role, capabilities, tool labels, and optional MCP grants.</p></div><button class="button button-primary" type="button" data-add-first-employee><span aria-hidden="true">+</span> Create first employee</button></div>`;
  $("#org-chart").innerHTML = `<article class="ceo-card">
      <span class="agent-avatar ceo" aria-hidden="true">${escapeHtml(initials(executive.name))}</span>
      <span class="agent-info"><span class="agent-name-row"><span class="agent-name">${escapeHtml(executive.name)}</span><span class="ceo-label">EXECUTIVE</span></span><span class="agent-role">${escapeHtml(executive.role)} · coordinates all branches</span></span>
      <span class="agent-status">${executiveTools} labels</span>
      <button class="agent-edit ceo-edit" type="button" data-edit-executive aria-label="Edit the executive agent" title="Edit executive">✎</button>
    </article>${emptyCta}<div class="org-branches">${branchCards}</div>`;
}

function renderApprovals() {
  const approvals = state.approvals || [];
  const reviewApprovals = approvals.filter((item) => !item.mcp);
  const mcpApprovals = approvals.filter((item) => item.mcp);
  const list = $("#approval-list");
  if (!stateReady) {
    list.innerHTML = '<div class="approval-empty">Connect to the local server to load approval history.</div>';
  } else if (!reviewApprovals.length) {
    list.innerHTML = '<div class="approval-empty">No review examples are waiting.</div>';
  } else {
    list.innerHTML = reviewApprovals
      .map(
        (approval) => `<article class="approval-card">
        <div class="approval-meta"><span class="approval-avatar">${escapeHtml(approval.initials || initials(approval.agent))}</span><strong>${escapeHtml(approval.agent)}</strong><span>requested review</span><span class="approval-time">${escapeHtml(approval.time || timeAgo(approval.createdAt))}</span></div>
        <p class="approval-title">${escapeHtml(approval.action)}</p><p class="approval-desc">${escapeHtml(approval.detail)}</p>
        <div class="approval-actions"><button class="small-action approve" type="button" data-approval="${escapeHtml(approval.id)}" data-decision="approved">Approve</button><button class="small-action" type="button" data-approval="${escapeHtml(approval.id)}" data-decision="rejected">Reject</button></div>
      </article>`,
      )
      .join("");
  }
  $("#mcp-pending-list").innerHTML = mcpApprovals
    .map((approval) => {
      const call = approval.mcp;
      const run = taskFor(call.runId);
      return `<article class="mcp-approval-card" data-approval-card="${escapeHtml(approval.id)}">
        <div class="mcp-approval-meta"><span class="mcp-mark">MCP</span><div><strong>${escapeHtml(call.connectorLabel || "Remote MCP server")}</strong><small>${escapeHtml(approval.agent)} · ${escapeHtml(call.toolName)}${run ? ` · run ${escapeHtml(run.id.slice(-6))}` : ""}</small></div></div>
        <p class="mcp-approval-warning">Approving sends these exact arguments to the remote server and may trigger an external action. Rejecting resumes the run without contacting it.</p>
        <pre class="mcp-arguments">${escapeHtml(JSON.stringify(call.arguments || {}, null, 2))}</pre>
        <div class="approval-actions">
          <button class="small-action approve" type="button" data-mcp-approval="${escapeHtml(approval.id)}" data-decision="approved">Approve this call</button>
          <button class="small-action" type="button" data-mcp-approval="${escapeHtml(approval.id)}" data-decision="rejected">Reject</button>
          ${call.runId ? `<button class="small-action" type="button" data-open-run="${escapeHtml(call.runId)}">Open run</button>` : ""}
        </div>
      </article>`;
    })
    .join("");
  const count = approvals.length;
  $("#approval-count-badge").textContent = count;
  $("#approval-nav-count").textContent = count;
  $("#approval-nav-count").classList.toggle("attention", count > 0);
  $("#pending-approvals-metric").textContent = count ? String(count).padStart(2, "0") : "0";
  const employees = new Set(approvals.map((approval) => approval.agent)).size;
  $("#approval-employee-count").textContent = `across ${plural(employees, "employee")}`;
}

function renderActivity() {
  const filtered = (state.activities || []).filter((event) => {
    if (activityFilter === "all") return true;
    if (activityFilter === "runs") return event.kind === "complete" || event.kind === "reject";
    if (activityFilter === "approvals") return event.kind === "approval";
    if (activityFilter === "tools") return event.kind === "tool";
    return true;
  });
  const events = showAllActivity ? filtered : filtered.slice(0, 6);
  const host = $("#activity-feed");
  if (!stateReady) {
    host.innerHTML = '<div class="approval-empty">Workspace history is unavailable while the local server is offline.</div>';
  } else if (!filtered.length) {
    host.innerHTML = '<div class="approval-empty">No activity matches this filter yet.</div>';
  } else {
    host.innerHTML = events
      .map(
        (event) => `<article class="activity-item">
        <span class="activity-icon ${escapeHtml(event.kind)}" aria-hidden="true">${escapeHtml(event.icon)}</span>
        <span class="activity-copy"><strong>${escapeHtml(event.agent)}</strong> ${escapeHtml(event.action)} <strong>${escapeHtml(event.target)}</strong><small>${escapeHtml(event.detail)}</small></span>
        <time class="activity-time">${escapeHtml(event.time || "")}</time>
      </article>`,
      )
      .join("");
  }
  const footer = $("#load-activity");
  footer.hidden = filtered.length <= 6;
  footer.textContent = showAllActivity ? "Show recent activity ↑" : `View all ${filtered.length} events →`;
}

function renderTasks() {
  const host = $("#task-results");
  const tasks = state.tasks || [];
  if (!stateReady) {
    host.innerHTML = '<div class="task-empty">Start the local server to load saved task runs.</div>';
    return;
  }
  if (!tasks.length) {
    host.innerHTML = '<div class="task-empty">Completed and failed task runs will be saved here and in run history.</div>';
    return;
  }
  host.innerHTML = tasks.slice(0, 1).map((task) => taskCard(task, true)).join("");
}

function taskCard(task, compact = false) {
  const summary = task.summary
    ? `<p class="task-summary">${richText(task.summary)}</p>`
    : `<p class="task-summary">${task.status === "failed" ? escapeHtml(task.error || "The run failed. Check the gateway configuration and try again.") : task.status === "waiting_approval" ? "Paused until the requested MCP call is approved or rejected." : "No executive summary was returned."}</p>`;
  return `<article class="task-result ${escapeHtml(runStatusClass(task.status))}">
    <div class="task-result-head"><div><span class="task-result-label">${escapeHtml(task.status === "done" ? "EXECUTIVE SUMMARY" : runStatusLabel(task.status).toUpperCase())}</span><h3>${escapeHtml(task.prompt)}</h3></div><time>${escapeHtml(formatDate(task.createdAt))}</time></div>
    ${summary}
    ${compact
      ? `<div class="task-result-actions"><span>${task.assignments?.length ? `${plural(task.assignments.length, "employee")} · ${formatTokens(task.usage?.totalTokens || 0)} tokens` : "No assignments"}</span><button type="button" data-open-run="${escapeHtml(task.id)}">Open full run →</button></div>`
      : task.assignments?.length
        ? `<div class="assignment-list">${task.assignments.map((assignment) => `<div class="assignment-result"><div><strong>${escapeHtml(assignment.employeeName)}</strong><small>${escapeHtml(assignment.task)}</small></div><p>${escapeHtml(assignment.result || "No result returned.")}</p></div>`).join("")}</div>`
        : ""}
  </article>`;
}

function renderRuns() {
  const host = $("#run-list");
  if (!stateReady) {
    host.innerHTML = '<div class="approval-empty">Connect to the local server to load run history.</div>';
    return;
  }
  const all = state.tasks || [];
  const filtered = all.filter((task) => {
    if (runFilter === "all") return true;
    if (runFilter === "active") return isActiveStatus(task.status);
    return task.status === runFilter;
  });
  $("#run-count").textContent = runFilter === "all" ? plural(all.length, "run") : `${filtered.length} of ${plural(all.length, "run")}`;
  if (!filtered.length) {
    host.innerHTML = `<div class="approval-empty">${all.length ? "No runs match this filter." : "No runs yet. Give the executive a task above."}</div>`;
    return;
  }
  host.innerHTML = filtered.map(runCard).join("");
}

function runCard(task) {
  const expanded = expandedRuns.has(task.id);
  const active = isActiveStatus(task.status);
  const approval = (state.approvals || []).find((item) => item.mcp?.runId === task.id);
  const usage = task.usage?.totalTokens || 0;
  const duration = task.completedAt ? formatDuration(new Date(task.completedAt) - new Date(task.createdAt)) : null;
  const meta = [
    formatFullDate(task.createdAt),
    duration ? `took ${duration}` : active ? "in progress" : null,
    usage ? `${formatTokens(usage)} tokens` : null,
    task.assignments?.length ? plural(task.assignments.length, "employee") : null,
  ].filter(Boolean);
  const actions = [
    active ? `<button class="small-action" type="button" data-attach-run="${escapeHtml(task.id)}">View live</button>` : "",
    active ? `<button class="small-action" type="button" data-cancel-run="${escapeHtml(task.id)}">Cancel</button>` : "",
    !active ? `<button class="small-action" type="button" data-rerun="${escapeHtml(task.id)}">Re-run</button>` : "",
    `<button class="small-action" type="button" data-toggle-run="${escapeHtml(task.id)}" aria-expanded="${expanded}">${expanded ? "Hide details" : "Details"}</button>`,
    !active ? `<button class="small-action danger-link" type="button" data-delete-run="${escapeHtml(task.id)}">Delete</button>` : "",
  ].join("");
  const assignments = (task.assignments || [])
    .map(
      (assignment) => `<div class="run-assignment">
        <div class="run-assignment-head"><strong>${escapeHtml(assignment.employeeName)}</strong><span class="assignment-status ${escapeHtml(assignment.status)}">${escapeHtml(ASSIGNMENT_STATUS[assignment.status] || assignment.status)}</span>${assignment.usage?.totalTokens ? `<small>${formatTokens(assignment.usage.totalTokens)} tokens</small>` : ""}</div>
        <p class="run-assignment-task">${escapeHtml(assignment.task)}</p>
        ${assignment.result ? `<div class="run-assignment-result">${richText(assignment.result)}</div>` : assignment.error ? `<p class="inline-error">${escapeHtml(assignment.error)}</p>` : `<p class="run-assignment-waiting">No result yet.</p>`}
      </div>`,
    )
    .join("");
  const timeline = (task.log || [])
    .slice(-18)
    .map((entry) => `<li><time>${escapeHtml(new Date(entry.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }))}</time><span>${escapeHtml(entry.message)}</span></li>`)
    .join("");
  return `<article class="run-card ${escapeHtml(runStatusClass(task.status))}">
    <div class="run-card-head">
      <div class="run-card-title">${statusBadge(task.status)}<h3>${escapeHtml(task.prompt)}</h3><p class="run-meta">${escapeHtml(meta.join(" · "))}</p></div>
      <div class="run-card-actions">${actions}</div>
    </div>
    ${expanded
      ? `<div class="run-details">
          ${task.summary ? `<div class="run-summary">${richText(task.summary)}</div>` : ""}
          ${approval ? `<div class="run-approval-note">Paused for approval: <strong>${escapeHtml(approval.mcp.toolName)}</strong> on ${escapeHtml(approval.mcp.connectorLabel)}. Open <a href="#approvals">Approvals</a> to review the exact arguments.</div>` : ""}
          ${assignments ? `<div class="run-assignments">${assignments}</div>` : '<p class="run-assignment-waiting">No assignments yet.</p>'}
          ${timeline ? `<details class="run-timeline"><summary>Timeline (${(task.log || []).length} events)</summary><ol>${timeline}</ol></details>` : ""}
          <div class="run-footnote">Run ID <code>${escapeHtml(task.id)}</code>${task.model ? ` · model <code>${escapeHtml(task.model)}</code>` : ""}${task.error && task.error !== "failed" && task.error !== "canceled" ? ` · error <code>${escapeHtml(task.error)}</code>` : ""}</div>
        </div>`
      : ""}
  </article>`;
}

function renderTools() {
  const enabled = state.tools.filter((tool) => tool.connected).length;
  $("#tool-count").textContent = plural(enabled, "label");
  $("#tool-list").innerHTML = state.tools
    .map(
      (tool, index) => `<div class="tool-row">
      <span class="tool-logo ${escapeHtml(tool.style)}" aria-hidden="true">${escapeHtml(tool.glyph)}</span>
      <span class="tool-copy"><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.category)} · not connected</small></span>
      <span class="tool-state ${tool.connected ? "" : "off"}">${tool.connected ? "Listed" : "Disabled"}</span>
      <span class="tool-actions"><button class="tool-icon" type="button" data-edit-tool="${index}" aria-label="Edit ${escapeHtml(tool.name)} label" title="Edit label">✎</button><button class="tool-icon danger" type="button" data-delete-tool="${index}" aria-label="Delete ${escapeHtml(tool.name)} label" title="Delete label">×</button></span>
      <button class="toggle" type="button" role="switch" aria-checked="${tool.connected}" aria-label="${tool.connected ? "Disable" : "Enable"} ${escapeHtml(tool.name)} permission label; not connected" data-toggle-tool="${index}"></button>
    </div>`,
    )
    .join("");
}

function renderConnectors() {
  const host = $("#mcp-connector-list");
  const connectors = state.connectors || [];
  if (!stateReady) {
    host.innerHTML = '<div class="approval-empty">Connector settings require the local server.</div>';
    return;
  }
  if (!connectors.length) {
    host.innerHTML = '<div class="approval-empty">No MCP servers configured. Add one to make explicitly granted tools available.</div>';
    return;
  }
  host.innerHTML = connectors
    .map(
      (connector) => `<article class="mcp-connector-card ${connector.enabled ? "" : "disabled"}">
      <div class="mcp-connector-heading"><span class="mcp-mark">MCP</span><div><strong>${escapeHtml(connector.label)}</strong><small>${escapeHtml(connector.url)}</small></div><span class="connector-badge">${connector.enabled ? "ENABLED" : "DISABLED"}</span></div>
      <p>${escapeHtml(connector.description || "No description")}</p><div class="connector-tools">${(connector.allowedTools || []).map((tool) => `<span>${escapeHtml(tool)}</span>`).join("")}</div>
      <small class="token-state">${connector.hasBearerToken ? "Server-held bearer token saved" : "No bearer token saved"}</small>
      <div class="connector-actions"><button type="button" data-edit-connector="${escapeHtml(connector.id)}">Edit</button><button type="button" data-toggle-connector="${escapeHtml(connector.id)}">${connector.enabled ? "Disable" : "Enable"}</button><button type="button" class="danger-link" data-delete-connector="${escapeHtml(connector.id)}">Remove</button></div>
    </article>`,
    )
    .join("");
}

function renderMetrics() {
  if (!stateReady) {
    $("#active-agents-metric").textContent = "—";
    $("#agent-nav-count").textContent = "—";
    return;
  }
  const active = state.agents.filter((agent) => agent.status === "active").length + (executive.status === "active" ? 1 : 0);
  $("#active-agents-metric").innerHTML = `${active}<span class="metric-total"> / ${state.agents.length + 1}</span>`;
  $("#active-agents-foot").textContent = `${plural(state.agents.length, "employee")} + executive`;
  $("#agent-nav-count").textContent = state.agents.length;

  const completed = state.tasks.filter((task) => task.status === "done");
  const stopped = state.tasks.filter((task) => task.status === "failed" || task.status === "canceled");
  const recent = completed.filter((task) => Date.now() - new Date(task.createdAt).getTime() < 7 * 86_400_000).length;
  $("#completed-runs-metric").textContent = completed.length.toLocaleString("en-US");
  $("#completed-runs-foot").textContent = `${recent} in last 7 days${stopped.length ? ` · ${stopped.length} stopped` : ""}`;

  const budget = gateway.budget || 100000;
  const used = state.usage?.totalTokens || 0;
  const percent = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  $("#tokens-metric").innerHTML = `${formatTokens(used)}<span class="metric-total"> tokens</span>`;
  $("#tokens-foot").textContent = `${percent}% of ${formatTokens(budget)} budget`;
  $("#tokens-foot").classList.toggle("budget-warning", percent >= 80);
  $("#usage-percent").textContent = `${percent}%`;
  $("#usage-fill").style.width = `${percent}%`;
  $("#usage-track").setAttribute("aria-valuenow", String(percent));
  $("#usage-card").classList.toggle("over-budget", percent >= 80);
  $("#usage-copy").textContent = `${used.toLocaleString("en-US")} of ${budget.toLocaleString("en-US")} tokens · ${plural(state.tasks.length, "run")}`;
  $("#runs-nav-count").textContent = state.tasks.length;
  $("#notification-button").classList.toggle("has-pending", state.approvals.length > 0);
}

/* --------------------------- live stream --------------------------- */

function pickLiveStatus(eventType, fallback) {
  if (eventType === "run.queued") return "queued";
  if (eventType === "approval.required" || eventType === "run.waiting_approval") return "waiting_approval";
  if (eventType === "run.completed") return "done";
  if (eventType === "run.failed") return "failed";
  if (eventType === "run.canceled") return "canceled";
  if (["run.started", "plan", "assignment.started", "assignment.completed", "approval.resolved", "approval.completed", "run.synthesizing"].includes(eventType)) return "running";
  return fallback;
}

function attachRun(runId) {
  if (!runId) return;
  if (live?.runId === runId && live.source) {
    renderLive();
    return;
  }
  detachRun();
  const task = taskFor(runId);
  live = {
    runId,
    source: null,
    events: [],
    status: task?.status || "queued",
    plan: null,
    started: new Set(),
    results: new Map(),
    pendingApproval: null,
    terminal: false,
    timer: null,
    poll: null,
    startedAtMs: task ? new Date(task.createdAt).getTime() : Date.now(),
    endedAtMs: null,
    connectionLost: false,
  };
  if (task && !isActiveStatus(task.status)) {
    live.terminal = true;
    live.endedAtMs = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
  }
  renderLive();
  startLiveClock();
  if (live.terminal) {
    scheduleRefresh();
    return;
  }
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?workspace=${encodeURIComponent(workspaceId)}`);
  live.source = source;
  for (const type of RUN_EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      if (!live || live.runId !== runId) return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      handleRunEvent(type, payload);
    });
  }
  source.onerror = () => {
    if (!live || live.runId !== runId) return;
    if (live.terminal) return;
    live.connectionLost = true;
    renderLive();
  };
  live.poll = window.setInterval(async () => {
    if (!live || live.terminal) return;
    await refreshWorkspace({ quiet: true });
    if (!live || live.terminal) return;
    const current = taskFor(runId);
    if (current && !isActiveStatus(current.status)) {
      live.status = current.status;
      live.terminal = true;
      live.endedAtMs = current.completedAt ? new Date(current.completedAt).getTime() : Date.now();
      stopLivePolling();
      renderLive();
    }
  }, 4000);
}

function detachRun() {
  if (!live) return;
  if (live.source) live.source.close();
  if (live.timer) window.clearInterval(live.timer);
  if (live.poll) window.clearInterval(live.poll);
  live = null;
}

function stopLivePolling() {
  if (!live) return;
  if (live.poll) window.clearInterval(live.poll);
  live.poll = null;
  if (live.source) {
    live.source.close();
    live.source = null;
  }
}

function handleRunEvent(type, payload) {
  if (!live) return;
  live.connectionLost = false;
  live.events.push(payload);
  live.status = pickLiveStatus(type, live.status);
  const data = payload.data || {};
  if (type === "run.snapshot" && data.task) {
    live.status = data.task.status;
    if (!isActiveStatus(data.task.status)) {
      live.terminal = true;
      live.endedAtMs = Date.now();
    }
  }
  if (type === "run.recovered" && data.status) live.status = data.status;
  if (type === "plan") live.plan = data;
  if (type === "assignment.started") live.started.add(data.employeeId);
  if (type === "assignment.completed") {
    live.started.add(data.employeeId);
    live.results.set(data.employeeId, data.result || "");
  }
  if (type === "approval.required") {
    live.pendingApproval = data;
    toast(`${data.employeeName} requested ${data.toolName}. Review the exact arguments in Approvals.`);
  }
  if (type === "approval.error") toast(`Approval failed. ${data.message || ""}`, true);
  if (["run.completed", "run.failed", "run.canceled"].includes(type)) {
    live.terminal = true;
    live.endedAtMs = Date.now();
    stopLivePolling();
    if (type === "run.completed") {
      toast("Run completed. Results are saved in run history.");
      setTaskMessage("Run completed. The executive summary and measured usage are saved in run history.");
    }
    if (type === "run.failed") {
      toast(`Run failed. ${data.message || ""}`, true);
      setTaskMessage(`Run failed: ${data.message || "check the gateway and run history"}`);
    }
    if (type === "run.canceled") {
      toast("Run canceled.");
      setTaskMessage("Run canceled. Partial results are saved in run history.");
    }
  }
  if (type === "run.ended") {
    live.terminal = true;
    stopLivePolling();
    live.endedAtMs ||= Date.now();
  }
  renderLive();
  scheduleRefresh();
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = window.setTimeout(async () => {
    refreshTimer = null;
    await refreshWorkspace({ quiet: true });
    renderLive();
  }, 280);
}

function startLiveClock() {
  if (!live) return;
  if (live.timer) window.clearInterval(live.timer);
  live.timer = window.setInterval(updateLiveClock, 1000);
  updateLiveClock();
}

function updateLiveClock() {
  if (!live) return;
  const node = $("#live-elapsed");
  if (!node) return;
  const end = live.endedAtMs || Date.now();
  node.textContent = formatDuration(end - live.startedAtMs);
}

function renderLive() {
  const host = $("#live-run");
  if (!live) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  const task = taskFor(live.runId);
  const status = live.status || task?.status || "queued";
  const assignments = task?.assignments?.length ? task.assignments : live.plan?.assignments || [];
  const approval = live.pendingApproval || (state.approvals || []).find((item) => item.mcp?.runId === live.runId);
  const planSummary = live.plan?.summary || "";
  const planningDone = Boolean(live.plan) || assignments.length > 0;
  const allAssignmentsDone = assignments.length > 0 && assignments.every((assignment) => assignment.status === "done" || assignment.status === "skipped" || live.results.has(assignment.employeeId));
  const synthesizing = live.events.some((event) => event.type === "run.synthesizing") && !live.terminal;
  const usage = task?.usage?.totalTokens || 0;
  const rows = [];
  const planningCopy = planSummary
    || (planningDone ? "Delegation plan restored from the saved run." : status === "queued" ? "Waiting for a free run slot." : "Choosing employees and writing assignments…");
  rows.push(`<li class="live-step ${planningDone ? "done" : status === "queued" ? "waiting" : "working"}">
    <span class="live-step-icon" aria-hidden="true">${planningDone ? "✓" : status === "queued" ? "◷" : "◌"}</span>
    <div><strong>Executive plans the task</strong><small>${escapeHtml(planningCopy)}</small></div>
  </li>`);
  for (const assignment of assignments) {
    const result = live.results.get(assignment.employeeId) || assignment.result || "";
    const stepStatus = result
      ? "done"
      : assignment.status === "awaiting_approval" || (approval && assignment.employeeName === (approval.employeeName || approval.agent))
        ? "waiting"
        : live.started.has(assignment.employeeId)
          ? "working"
          : "pending";
    rows.push(`<li class="live-step ${stepStatus}">
      <span class="live-step-icon" aria-hidden="true">${stepStatus === "done" ? "✓" : stepStatus === "working" ? "◌" : stepStatus === "waiting" ? "◷" : "·"}</span>
      <div>
        <strong>${escapeHtml(assignment.employeeName)}</strong>
        <small>${escapeHtml(assignment.task)}</small>
        ${result ? `<details class="live-result"><summary>Result</summary><div>${richText(result)}</div></details>` : `<span class="live-wait-hint">${stepStatus === "waiting" ? "Waiting for your approval" : stepStatus === "working" ? "Working…" : "Queued"}</span>`}
      </div>
    </li>`);
  }
  if (assignments.length) {
    rows.push(`<li class="live-step ${live.status === "done" ? "done" : synthesizing || allAssignmentsDone ? "working" : "pending"}">
      <span class="live-step-icon" aria-hidden="true">${live.status === "done" ? "✓" : synthesizing || allAssignmentsDone ? "◌" : "·"}</span>
      <div><strong>Executive synthesis</strong><small>${live.status === "done" ? "Summary saved to run history." : synthesizing || allAssignmentsDone ? "Combining employee results…" : "Starts after employee results."}</small></div>
    </li>`);
  }
  host.innerHTML = `<div class="live-run-card ${escapeHtml(runStatusClass(status))}">
    <div class="live-run-head">
      <div class="live-run-title">${statusBadge(status)}<h3>${escapeHtml(task?.prompt || "Executive run")}</h3><p class="live-run-meta"><span>Run <code>${escapeHtml(live.runId.slice(-8))}</code></span><span id="live-elapsed">—</span>${usage ? `<span>${formatTokens(usage)} tokens</span>` : ""}${live.connectionLost && !live.terminal ? '<span class="live-connection">Reconnecting…</span>' : ""}</p></div>
      <div class="live-run-actions">
        ${isActiveStatus(status) ? `<button class="small-action" type="button" data-cancel-run="${escapeHtml(live.runId)}">Cancel run</button>` : ""}
        <button class="small-action" type="button" data-open-run="${escapeHtml(live.runId)}">Open run</button>
        ${!isActiveStatus(status) ? '<button class="small-action" type="button" data-dismiss-live>Dismiss</button>' : ""}
      </div>
    </div>
    <ol class="live-steps">${rows.join("")}</ol>
    ${approval ? `<div class="live-approval"><span class="mcp-mark">MCP</span><div><strong>Approval required</strong><small>${escapeHtml(approval.employeeName || approval.agent)} wants to call <code>${escapeHtml(approval.toolName || approval.mcp?.toolName)}</code> on ${escapeHtml(approval.connectorLabel || approval.mcp?.connectorLabel)}. Exact arguments are in Approvals.</small></div><button class="small-action" type="button" data-scroll-approvals>Review</button></div>` : ""}
    ${live.terminal && task?.summary ? `<div class="live-summary">${richText(task.summary)}</div>` : ""}
    ${live.terminal && !task ? '<p class="live-wait-hint">The run finished. Refreshing saved results…</p>' : ""}
  </div>`;
  updateLiveClock();
}

/* --------------------------- workspace ----------------------------- */

async function commitWorkspace(mutator, successMessage) {
  if (!stateReady) {
    toast("Workspace is not connected to the local server", true);
    return false;
  }
  const before = structuredClone(state);
  mutator();
  render();
  try {
    const saved = await apiRequest("/api/state", { method: "PUT", body: JSON.stringify(state) });
    state = saved;
    executive = saved.executive;
    render();
    setSync("Saved just now");
    if (successMessage) toast(successMessage);
    return true;
  } catch (error) {
    state = before;
    executive = before.executive;
    render();
    toast(`Changes were not saved. ${error.message}`, true);
    return false;
  }
}

function logActivity(kind, icon, agent, action, target, detail) {
  state.activities.unshift({ id: `evt-${Date.now()}`, kind, icon, agent, action, target, detail, time: "just now" });
  state.activities = state.activities.slice(0, 500);
}

async function startRun(prompt) {
  if (backendOutdated) {
    setTaskMessage("Restart the server to load the run engine. The running process is an older build.");
    toast("Restart `node server.mjs` before starting a run", true);
    return false;
  }
  try {
    setTaskMessage("Starting run…");
    const response = await apiRequest("/api/workflows", { method: "POST", body: JSON.stringify({ prompt }) });
    await refreshWorkspace({ quiet: true });
    attachRun(response.runId);
    setTaskMessage("Run started. Progress below streams live; the saved result also appears in run history.");
    $("#live-run").scrollIntoView({ behavior: "smooth", block: "center" });
    toast(gateway.mode === "demo" ? "Demo run started (simulated)" : "Run started");
    return true;
  } catch (error) {
    setTaskMessage(`Task did not start: ${error.message}`);
    toast(error.message, true);
    return false;
  }
}

async function cancelRun(runId) {
  if (!window.confirm("Cancel this run? Pending tool approvals for it will be discarded.")) return;
  try {
    await apiRequest(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    await refreshWorkspace({ quiet: true });
    if (live?.runId === runId) {
      live.terminal = true;
      live.status = "canceled";
      live.endedAtMs = Date.now();
      stopLivePolling();
      renderLive();
    }
    toast("Run canceled.");
  } catch (error) {
    toast(`Run was not canceled. ${error.message}`, true);
  }
}

async function decideMcpApproval(approvalId, decision, button) {
  if (button) button.disabled = true;
  try {
    const response = await apiRequest(`/api/mcp/approvals/${encodeURIComponent(approvalId)}`, { method: "POST", body: JSON.stringify({ decision }) });
    await refreshWorkspace({ quiet: true });
    if (response.runId) attachRun(response.runId);
    if (response.pendingApproval) toast(`Another MCP call needs review: ${response.pendingApproval.toolName}`);
    else toast(decision === "approved" ? "Call approved; the workflow resumed." : "Call rejected; the workflow resumed.");
  } catch (error) {
    if (button) button.disabled = false;
    toast(`Approval decision was not completed. ${error.message}`, true);
  }
}

async function decideSeedApproval(approvalId, decision) {
  const approval = state.approvals.find((item) => item.id === approvalId);
  if (!approval) return;
  const approved = decision === "approved";
  await commitWorkspace(() => {
    state.approvals = state.approvals.filter((item) => item.id !== approvalId);
    logActivity(approved ? "complete" : "reject", approved ? "✓" : "×", approval.agent, approved ? "received approval to" : "had a request rejected for", approval.action, "Local workspace · review example");
  }, `${approved ? "Approved" : "Rejected"}: ${approval.action}`);
}

/* ----------------------------- dialogs ----------------------------- */

function openAgentDialog(agent = null) {
  const form = $("#agent-form");
  form.reset();
  const branches = allBranches();
  const branch = agent?.branch || branches[0] || "Remote";
  if (!branches.includes(branch)) branches.push(branch);
  $("#agent-branch").innerHTML = branches.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("");
  $("#agent-id").value = agent?.id || "";
  $("#agent-name").value = agent?.name || "";
  $("#agent-role").value = agent?.role || "";
  $("#agent-branch").value = branch;
  $("#agent-capabilities").value = agent?.capabilities?.join(", ") || "";
  $("#agent-status").value = agent?.status || "active";
  renderManagerOptions(branch, agent?.managerId || "exec", agent?.id || "");
  $("#agent-dialog-title").textContent = agent ? "Edit employee" : "Create employee";
  $("#save-agent-button").textContent = agent ? "Save changes" : "Create employee";
  const stats = agent ? agentStats(agent.id) : null;
  const statsNode = $("#agent-stats");
  if (stats) {
    statsNode.hidden = false;
    statsNode.innerHTML = `<strong>${plural(stats.runs, "run")}</strong> · ${stats.completed} completed${stats.tokens ? ` · ${formatTokens(stats.tokens)} tokens` : ""}${stats.last ? ` · last ${timeAgo(stats.last)}` : ""}`;
  } else {
    statsNode.hidden = true;
    statsNode.textContent = "";
  }
  $("#form-tool-options").innerHTML = state.tools.length
    ? state.tools
        .map(
          (tool) => `<label class="tool-option"><input type="checkbox" name="agent-tool" value="${escapeHtml(tool.name)}" ${agent?.tools?.includes(tool.name) ? "checked" : ""} ${tool.connected ? "" : "disabled"}><span>${escapeHtml(tool.name)}${tool.connected ? "" : " · disabled"}</span></label>`,
        )
        .join("")
    : '<small class="field-hint">No tool labels yet. Add one under Integrations.</small>';
  const grants = agent?.mcpGrants || [];
  const grantOptions = (state.connectors || [])
    .filter((connector) => connector.enabled)
    .map((connector) => {
      const selected = grants.find((grant) => grant.connectorId === connector.id)?.tools || [];
      return `<fieldset class="mcp-grant-group"><legend>${escapeHtml(connector.label)}</legend>${connector.allowedTools
        .map((tool) => `<label class="tool-option"><input type="checkbox" name="mcp-grant" data-connector-id="${escapeHtml(connector.id)}" value="${escapeHtml(tool)}" ${selected.includes(tool) ? "checked" : ""}><span>${escapeHtml(tool)}</span></label>`)
        .join("")}</fieldset>`;
    })
    .join("");
  $("#form-mcp-options").innerHTML = grantOptions || '<small class="field-hint">No enabled MCP servers. Add one in Integrations first.</small>';
  let remove = $("#remove-agent-button");
  if (agent && !remove) {
    remove = document.createElement("button");
    remove.type = "button";
    remove.id = "remove-agent-button";
    remove.className = "delete-agent-button";
    remove.textContent = "Remove employee";
    $("#agent-form .dialog-actions").prepend(remove);
  }
  if (remove) remove.hidden = !agent;
  $("#agent-dialog").showModal();
  $("#agent-name").focus();
}

function renderManagerOptions(branch, selectedId = "exec", currentId = "") {
  const managers = state.agents.filter((agent) => agent.branch === branch && (agent.managerId === "exec" || agent.id === selectedId) && agent.id !== currentId);
  const options = [{ id: "exec", name: `${executive.name} · Executive` }, ...managers.map((agent) => ({ id: agent.id, name: `${agent.name} · ${agent.role}` }))];
  $("#agent-manager").innerHTML = options.map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name)}</option>`).join("");
  $("#agent-manager").value = options.some((option) => option.id === selectedId) ? selectedId : "exec";
}

function openConnectorDialog(connector = null) {
  $("#mcp-form").reset();
  $("#mcp-connector-id").value = connector?.id || "";
  $("#mcp-label").value = connector?.label || "";
  $("#mcp-url").value = connector?.url || "";
  $("#mcp-description").value = connector?.description || "";
  $("#mcp-tools").value = (connector?.allowedTools || []).join("\n");
  $("#mcp-enabled").checked = connector?.enabled ?? true;
  $("#mcp-token").value = "";
  $("#mcp-token").placeholder = connector?.hasBearerToken ? "Saved token · leave blank to keep it" : "Optional bearer token";
  $("#mcp-clear-token-row").hidden = !connector?.hasBearerToken;
  $("#mcp-clear-token").checked = false;
  $("#mcp-dialog-title").textContent = connector ? "Edit MCP server" : "Add MCP server";
  $("#save-mcp-button").textContent = connector ? "Save changes" : "Save connector";
  $("#mcp-dialog").showModal();
  $("#mcp-label").focus();
}

async function saveConnector(data, isNew = false, idOverride = "") {
  try {
    const id = idOverride || $("#mcp-connector-id").value;
    const endpoint = id ? `/api/connectors/${encodeURIComponent(id)}` : "/api/connectors";
    await apiRequest(endpoint, { method: id ? "PUT" : "POST", body: JSON.stringify(data) });
    await refreshWorkspace({ quiet: true });
    $("#mcp-dialog").close();
    toast(isNew ? "MCP server saved. Grant tools to employees before use." : "MCP server updated");
    return true;
  } catch (error) {
    toast(`Connector was not saved. ${error.message}`, true);
    return false;
  }
}

function openUsage() {
  const budget = gateway.budget || 100000;
  const used = state.usage?.totalTokens || 0;
  const input = state.usage?.inputTokens || 0;
  const output = state.usage?.outputTokens || 0;
  const percent = budget ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  const tasks = state.tasks || [];
  const perEmployee = new Map();
  for (const task of tasks) {
    for (const assignment of task.assignments || []) {
      const current = perEmployee.get(assignment.employeeName) || { tokens: 0, runs: 0 };
      current.tokens += assignment.usage?.totalTokens || 0;
      current.runs += 1;
      perEmployee.set(assignment.employeeName, current);
    }
  }
  const employeeRows = [...perEmployee.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([name, value]) => `<tr><td>${escapeHtml(name)}</td><td>${plural(value.runs, "assignment")}</td><td class="numeric">${formatTokens(value.tokens)}</td></tr>`)
    .join("");
  const runRows = tasks
    .slice(0, 12)
    .map(
      (task) =>
        `<tr><td><span class="usage-run-prompt">${escapeHtml(task.prompt.slice(0, 70))}</span><small>${escapeHtml(formatDate(task.createdAt))}</small></td><td>${statusBadge(task.status)}</td><td class="numeric">${formatTokens(task.usage?.totalTokens || 0)}</td></tr>`,
    )
    .join("");
  $("#usage-report").innerHTML = `
    <div class="usage-hero"><div><span class="usage-hero-label">Total tokens</span><strong>${used.toLocaleString("en-US")}</strong><small>${percent}% of a ${budget.toLocaleString("en-US")} local budget</small></div><div class="usage-hero-split"><span>Input<strong>${formatTokens(input)}</strong></span><span>Output<strong>${formatTokens(output)}</strong></span></div></div>
    <progress class="usage-progress" max="100" value="${percent}" aria-label="Local token budget used"></progress>
    <p class="usage-note">${gateway.mode === "demo" ? "Demo mode reports simulated usage; no provider was contacted." : "Totals come from provider-reported usage when the gateway returns it. Requests without usage metadata count as zero."} Cumulative totals reflect the ${plural(tasks.length, "run")} kept in history; deleting a run does not refund spent tokens.</p>
    <h3>By employee</h3>
    ${employeeRows ? `<table class="usage-table"><thead><tr><th>Employee</th><th>Work</th><th class="numeric">Tokens</th></tr></thead><tbody>${employeeRows}</tbody></table>` : '<p class="field-hint">No assignments recorded yet.</p>'}
    <h3>Recent runs</h3>
    ${runRows ? `<table class="usage-table"><thead><tr><th>Run</th><th>Status</th><th class="numeric">Tokens</th></tr></thead><tbody>${runRows}</tbody></table>` : '<p class="field-hint">No runs recorded yet.</p>'}
  `;
  $("#usage-dialog").showModal();
}

function openHelp() {
  $("#help-dialog").showModal();
}

/* --------------------------- workspaces ---------------------------- */

function blankState() {
  const exec = { id: "exec", name: "Executive agent", role: "Executive agent · CEO", branch: "Executive", status: "active", tools: [] };
  return {
    executive: exec,
    agents: [],
    tools: [],
    approvals: [],
    activities: [],
    tasks: [],
    connectors: [],
    branches: [],
    operator: { name: "Operator", role: "Workspace admin" },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

function parseBranches(value) {
  return [...new Set(String(value || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function openWorkspaceDialog() {
  if (backendOutdated) {
    toast("Restart the server before creating a workspace", true);
    return;
  }
  $("#workspace-form").reset();
  const operator = state.operator || { name: "Jordan Davis" };
  $("#new-workspace-company").value = "";
  $("#new-workspace-name").value = "";
  $("#new-workspace-operator").value = operator.name || "";
  $("#new-workspace-executive").value = "Avery Morgan";
  $("#new-workspace-role").value = "Executive agent · CEO";
  $("#new-workspace-branches").value = (allBranches().length ? allBranches() : DEFAULT_BRANCHES).join("\n");
  $("#workspace-menu").hidden = true;
  $("#workspace-switcher").setAttribute("aria-expanded", "false");
  $("#workspace-dialog").showModal();
  $("#new-workspace-company").focus();
}

async function createWorkspace(event) {
  event.preventDefault();
  if (backendOutdated) {
    toast("Restart the server before creating a workspace", true);
    return;
  }
  const branches = parseBranches($("#new-workspace-branches").value);
  if (!branches.length) {
    toast("Add at least one branch", true);
    return;
  }
  const button = $("#create-workspace-button");
  button.disabled = true;
  try {
    const response = await apiRequest("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({
        company: $("#new-workspace-company").value.trim(),
        name: $("#new-workspace-name").value.trim(),
        operatorName: $("#new-workspace-operator").value.trim(),
        executiveName: $("#new-workspace-executive").value.trim(),
        executiveRole: $("#new-workspace-role").value.trim(),
        branches,
      }),
    });
    workspaces = response.workspaces || workspaces;
    $("#workspace-dialog").close();
    await switchWorkspace(response.workspace.id, { force: true, announce: false });
    toast(`${response.workspace.company} workspace created`);
  } catch (error) {
    toast(`Workspace was not created. ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

async function switchWorkspace(id, { force = false, announce = true } = {}) {
  if (!id || id === workspaceId) {
    $("#workspace-menu").hidden = true;
    $("#workspace-switcher").setAttribute("aria-expanded", "false");
    return;
  }
  if (live && !live.terminal && !force) {
    if (!window.confirm("A run is active in this workspace. Switch anyway? The run continues in the background.")) return;
  }
  const next = workspaces.find((workspace) => workspace.id === id);
  detachRun();
  workspaceId = id;
  workspaceMeta = next || null;
  try {
    localStorage.setItem("agent-factory-workspace", id);
  } catch {
    /* ignore */
  }
  selectedBranch = "all";
  activityFilter = "all";
  showAllActivity = false;
  runFilter = "all";
  expandedRuns.clear();
  stateReady = false;
  state = blankState();
  executive = state.executive;
  $("#workspace-menu").hidden = true;
  $("#workspace-switcher").setAttribute("aria-expanded", "false");
  $("#run-filter").value = "all";
  $("#activity-filter").value = "all";
  render();
  if (refreshPromise) await refreshPromise.catch(() => {});
  const ok = await refreshWorkspace({ quiet: true });
  if (ok && announce) toast(`Switched to ${workspaceMeta?.name || next?.name || "workspace"}`);
}

function openSettingsDialog() {
  if (backendOutdated) {
    toast("Restart the server to edit workspace settings", true);
    return;
  }
  const meta = workspaceMeta || state.workspace || { name: "", company: "" };
  const operator = state.operator || { name: "", role: "Workspace admin" };
  $("#settings-company").value = meta.company || "";
  $("#settings-name").value = meta.name || "";
  $("#settings-operator").value = operator.name || "";
  $("#settings-operator-role").value = operator.role || "";
  $("#settings-branches").value = (allBranches().length ? allBranches() : DEFAULT_BRANCHES).join("\n");
  $("#delete-workspace-button").hidden = workspaces.length <= 1;
  $("#workspace-menu").hidden = true;
  $("#workspace-switcher").setAttribute("aria-expanded", "false");
  $("#settings-dialog").showModal();
  $("#settings-company").focus();
}

async function saveSettings(event) {
  event.preventDefault();
  if (!stateReady) {
    toast("Workspace is not loaded", true);
    return;
  }
  const branches = parseBranches($("#settings-branches").value);
  if (!branches.length) {
    toast("Add at least one branch", true);
    return;
  }
  const missing = state.agents.filter((agent) => !branches.includes(agent.branch));
  if (missing.length) {
    toast(`Move ${missing[0].name} out of “${missing[0].branch}” before removing that branch`, true);
    return;
  }
  const name = $("#settings-name").value.trim();
  const company = $("#settings-company").value.trim();
  if (!name || !company) {
    toast("Workspace and company names are required", true);
    return;
  }
  const operator = { name: $("#settings-operator").value.trim(), role: $("#settings-operator-role").value.trim() };
  if (!operator.name || !operator.role) {
    toast("Operator name and role are required", true);
    return;
  }
  const saved = await commitWorkspace(() => {
    state.branches = branches;
    state.operator = operator;
    logActivity("tool", "⚙", operator.name, "updated workspace settings for", company, "Local workspace · company settings");
  }, "Workspace settings saved");
  if (!saved) return;
  try {
    const response = await apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: "PUT",
      body: JSON.stringify({ name, company }),
    });
    workspaceMeta = response.workspace;
    workspaces = response.workspaces || workspaces;
    renderWorkspaceChrome();
    $("#settings-dialog").close();
    toast(`${company} workspace updated`);
  } catch (error) {
    toast(`Workspace name was not updated. ${error.message}`, true);
  }
}

async function deleteWorkspace() {
  if (!workspaceMeta) return;
  if (workspaces.length <= 1) {
    toast("Keep at least one workspace", true);
    return;
  }
  if (!window.confirm(`Delete the “${workspaceMeta.name}” workspace?

Employees, runs, approvals, and connector tokens for ${workspaceMeta.company} will be removed. This cannot be undone.`)) return;
  try {
    const response = await apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
    workspaces = response.workspaces || [];
    $("#settings-dialog").close();
    detachRun();
    workspaceId = "";
    try {
      localStorage.removeItem("agent-factory-workspace");
    } catch {
      /* ignore */
    }
    await switchWorkspace(response.defaultId, { force: true, announce: false });
    toast("Workspace deleted");
  } catch (error) {
    toast(`Workspace was not deleted. ${error.message}`, true);
  }
}

function openExecutiveDialog() {
  $("#executive-form").reset();
  $("#executive-name").value = executive.name || "";
  $("#executive-role").value = executive.role || "";
  $("#executive-status").value = executive.status || "active";
  $("#executive-tool-options").innerHTML = state.tools.length
    ? state.tools
        .map(
          (tool) => `<label class="tool-option"><input type="checkbox" name="executive-tool" value="${escapeHtml(tool.name)}" ${executive.tools?.includes(tool.name) ? "checked" : ""}><span>${escapeHtml(tool.name)}${tool.connected ? "" : " · disabled"}</span></label>`,
        )
        .join("")
    : '<small class="field-hint">No tool labels yet. Add one under Integrations.</small>';
  $("#executive-dialog").showModal();
  $("#executive-name").focus();
}

async function saveExecutive(event) {
  event.preventDefault();
  const name = $("#executive-name").value.trim();
  const role = $("#executive-role").value.trim();
  if (!name || !role) return;
  const tools = $$('input[name="executive-tool"]:checked').map((input) => input.value);
  const saved = await commitWorkspace(() => {
    executive.name = name;
    executive.role = role;
    executive.status = $("#executive-status").value;
    executive.tools = tools;
    state.executive = executive;
    logActivity("tool", "✦", name, "updated the executive agent profile for", workspaceMeta?.company || "the workspace", "Local workspace · executive change");
  }, "Executive agent updated");
  if (saved) $("#executive-dialog").close();
}

function openToolDialog(tool = null) {
  $("#tool-form").reset();
  $("#tool-original-name").value = tool?.name || "";
  $("#tool-name").value = tool?.name || "";
  const select = $("#tool-category");
  if (tool?.category && ![...select.options].some((option) => option.value === tool.category)) {
    select.add(new Option(tool.category, tool.category));
  }
  if (tool?.category) select.value = tool.category;
  $("#tool-dialog-title").textContent = tool ? "Edit tool label" : "Add a tool label";
  $("#save-tool-button").textContent = tool ? "Save label" : "Add tool label";
  $("#tool-dialog").showModal();
  $("#tool-name").focus();
}

async function saveTool(event) {
  event.preventDefault();
  const name = $("#tool-name").value.trim();
  const category = $("#tool-category").value;
  const original = $("#tool-original-name").value;
  if (!name) return;
  const duplicate = state.tools.find((tool) => tool.name.toLowerCase() === name.toLowerCase() && tool.name !== original);
  if (duplicate) {
    toast("That tool label already exists", true);
    return;
  }
  const existing = original ? state.tools.find((tool) => tool.name === original) : null;
  if (original && !existing) {
    toast("That tool label no longer exists", true);
    return;
  }
  const saved = await commitWorkspace(() => {
    if (existing) {
      if (original !== name) {
        executive.tools = (executive.tools || []).map((item) => (item === original ? name : item));
        state.executive = executive;
        for (const agent of state.agents) agent.tools = agent.tools.map((item) => (item === original ? name : item));
      }
      existing.name = name;
      existing.category = category;
      logActivity("tool", "✎", state.operator?.name || "Workspace admin", "edited a tool permission label for", name, "Local workspace · account not connected");
    } else {
      state.tools.push({ name, category, connected: true, glyph: initials(name).slice(0, 1), style: "" });
      logActivity("tool", "＋", state.operator?.name || "Workspace admin", "added a tool permission label for", name, "Local workspace · account not connected");
    }
  }, existing ? `${name} label updated` : `${name} permission label added`);
  if (saved) $("#tool-dialog").close();
}

async function deleteTool(index) {
  const tool = state.tools[index];
  if (!tool) return;
  const employeeUses = state.agents.filter((agent) => agent.tools.includes(tool.name)).length + (executive.tools?.includes(tool.name) ? 1 : 0);
  if (!window.confirm(`Delete the “${tool.name}” label?${employeeUses ? `\n\nIt is assigned to ${employeeUses} profile${employeeUses === 1 ? "" : "s"}; those assignments will be removed.` : ""}`)) return;
  const saved = await commitWorkspace(() => {
    state.tools = state.tools.filter((item) => item.name !== tool.name);
    if (executive.tools) {
      executive.tools = executive.tools.filter((item) => item !== tool.name);
      state.executive = executive;
    }
    for (const agent of state.agents) agent.tools = agent.tools.filter((item) => item !== tool.name);
    logActivity("tool", "−", state.operator?.name || "Workspace admin", "deleted the tool permission label", tool.name, "Local workspace · account not connected");
  }, `${tool.name} label deleted`);
  if (saved) render();
}

/* ------------------------------ theme ------------------------------ */

function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("agent-factory-theme", theme);
  } catch {
    /* storage can be unavailable in private windows */
  }
  document.documentElement.dataset.themePreference = theme;
  updateThemeButton();
}

function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  toast(`${next === "dark" ? "Dark" : "Light"} theme applied`);
}

function updateThemeButton() {
  const button = $("#theme-toggle");
  if (!button) return;
  const dark = currentTheme() === "dark";
  button.textContent = dark ? "☀" : "◐";
  button.title = `Switch to ${dark ? "light" : "dark"} theme`;
  button.setAttribute("aria-label", button.title);
}

/* ---------------------------- palette ------------------------------ */

let paletteItems = [];
let paletteIndex = 0;

function paletteAction(label, hint, group, run) {
  return { label, hint, group, run };
}

function buildPaletteItems() {
  const items = [];
  const scrollTo = (selector) => $(selector)?.scrollIntoView({ behavior: "smooth", block: "start" });
  items.push(
    paletteAction("Overview", "Go to workspace overview", "Navigate", () => scrollTo("#overview")),
    paletteAction("Employees", "Organization structure", "Navigate", () => scrollTo("#employees")),
    paletteAction("Runs", "Run history and results", "Navigate", () => scrollTo("#runs")),
    paletteAction("Approvals", "Review requested actions", "Navigate", () => scrollTo("#approvals")),
    paletteAction("Integrations", "MCP servers and tool labels", "Navigate", () => scrollTo("#integrations")),
    paletteAction("Activity", "Workspace activity feed", "Navigate", () => scrollTo("#activity")),
    paletteAction("Run a task", "Focus the executive workbench", "Actions", () => {
      scrollTo("#workbench");
      $("#task-prompt").focus();
    }),
    paletteAction("Create employee", "Add a digital employee", "Actions", () => openAgentDialog()),
    paletteAction("Add MCP server", "Register a remote tool server", "Actions", () => openConnectorDialog()),
    paletteAction("Add tool label", "Add a permission label", "Actions", () => openToolDialog()),
    paletteAction("New company workspace", "Create a separate workspace for another company", "Workspaces", () => openWorkspaceDialog()),
    paletteAction("Workspace settings", "Rename the company/workspace, branches, and operator", "Workspaces", () => openSettingsDialog()),
    paletteAction("Edit executive agent", "Change the planner's name, role, and labels", "Workspaces", () => openExecutiveDialog()),
    paletteAction("Export roster CSV", "Download employees and grants", "Actions", () => exportRoster()),
    paletteAction("Download workspace backup", "JSON backup without connector tokens", "Actions", () => downloadBackup()),
    paletteAction("Restore workspace backup", "Load a previously downloaded JSON file", "Actions", () => $("#restore-file").click()),
    paletteAction("Usage report", "Measured token usage", "Actions", () => openUsage()),
    paletteAction("Switch theme", "Toggle light and dark appearance", "Actions", () => toggleTheme()),
    paletteAction("Help & shortcuts", "Operator guide", "Actions", () => openHelp()),
    paletteAction("Reset workspace data", "Clear employees, runs, approvals, and activity", "Danger", () => resetWorkspace()),
  );
  for (const workspace of workspaces) {
    if (workspace.id === workspaceId) continue;
    items.push(paletteAction(`Switch to ${workspace.name}`, workspace.company, "Workspaces", () => switchWorkspace(workspace.id)));
  }
  for (const agent of state.agents) {
    const stats = agentStats(agent.id);
    items.push(paletteAction(`Edit ${agent.name}`, `${agent.role} · ${agent.branch} · ${plural(stats.runs, "run")}`, "Employees", () => openAgentDialog(agent)));
  }
  for (const task of (state.tasks || []).slice(0, 12)) {
    items.push(
      paletteAction(`Open run: ${task.prompt.slice(0, 64)}`, `${runStatusLabel(task.status)} · ${formatDate(task.createdAt)}`, "Runs", () => {
        expandedRuns.add(task.id);
        runFilter = "all";
        $("#run-filter").value = "all";
        renderRuns();
        scrollTo("#runs");
        const node = $(`[data-toggle-run="${CSS.escape(task.id)}"]`)?.closest(".run-card");
        node?.scrollIntoView({ behavior: "smooth", block: "center" });
      }),
    );
  }
  return items;
}

function openPalette() {
  paletteItems = buildPaletteItems();
  paletteIndex = 0;
  $("#palette-input").value = "";
  renderPalette();
  $("#palette-dialog").showModal();
  $("#palette-input").focus();
}

function filteredPaletteItems() {
  const query = $("#palette-input").value.trim().toLowerCase();
  if (!query) return paletteItems;
  return paletteItems.filter((item) => `${item.group} ${item.label} ${item.hint}`.toLowerCase().includes(query));
}

function renderPalette() {
  const items = filteredPaletteItems();
  if (paletteIndex >= items.length) paletteIndex = Math.max(0, items.length - 1);
  const host = $("#palette-results");
  if (!items.length) {
    host.innerHTML = '<div class="palette-empty">No matching command. Try an employee name, “run”, or “theme”.</div>';
    return;
  }
  let lastGroup = "";
  host.innerHTML = items
    .map((item, index) => {
      const heading = item.group !== lastGroup ? `<div class="palette-group" role="presentation">${escapeHtml(item.group)}</div>` : "";
      lastGroup = item.group;
      return `${heading}<button type="button" role="option" aria-selected="${index === paletteIndex}" class="palette-item ${index === paletteIndex ? "selected" : ""}" data-palette-index="${index}"><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.hint)}</small></button>`;
    })
    .join("");
}

function runPaletteIndex(index) {
  const items = filteredPaletteItems();
  const item = items[index];
  if (!item) return;
  $("#palette-dialog").close();
  window.setTimeout(() => item.run(), 30);
}

/* -------------------------- workspace ops -------------------------- */

function exportRoster() {
  const connectorName = (id) => state.connectors.find((connector) => connector.id === id)?.label || id;
  const rows = [
    ["Name", "Role", "Branch", "Manager", "Capabilities", "Status", "Tool permission labels", "MCP tool grants"],
    ...state.agents.map((agent) => {
      const manager = agent.managerId === "exec" ? executive.name : agentById(agent.managerId)?.name || executive.name;
      const grants = (agent.mcpGrants || []).map((grant) => `${connectorName(grant.connectorId)}: ${grant.tools.join("; ")}`).join(" | ");
      return [agent.name, agent.role, agent.branch, manager, agent.capabilities.join("; "), agent.status, agent.tools.join("; "), grants];
    }),
  ];
  const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `agent-factory-roster-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  toast("Workspace roster exported as CSV");
}

async function downloadBackup() {
  if (backendOutdated) {
    toast("Restart the server to enable workspace backups", true);
    return;
  }
  try {
    const response = await fetch("/api/workspace/backup", { credentials: "same-origin", headers: workspaceId ? { "X-Workspace-Id": workspaceId } : {} });
    if (!response.ok) throw new Error(`Backup failed (${response.status})`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const companySlug = String(workspaceMeta?.company || "workspace").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
    anchor.download = `agent-factory-${companySlug}-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast("Workspace backup downloaded (connector tokens are not included)");
  } catch (error) {
    toast(`Backup was not created. ${error.message}`, true);
  }
}

async function restoreBackup(file) {
  if (!file) return;
  if (backendOutdated) {
    toast("Restart the server to enable workspace restore", true);
    return;
  }
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const candidate = parsed?.state || parsed;
    if (!candidate?.executive || !Array.isArray(candidate.agents)) throw new Error("This file is not an Agent Factory workspace backup.");
    if (!window.confirm("Restore this workspace backup? Current employees, runs, and approvals will be replaced.")) return;
    detachRun();
    await apiRequest("/api/workspace/restore", { method: "POST", body: JSON.stringify({ state: candidate }) });
    await refreshWorkspace({ quiet: true });
    toast("Workspace restored. Connector tokens must be re-entered.");
  } catch (error) {
    toast(`Backup was not restored. ${error.message}`, true);
  } finally {
    $("#restore-file").value = "";
  }
}

async function resetWorkspace() {
  if (backendOutdated) {
    toast("Restart the server to enable workspace reset", true);
    return;
  }
  if (!window.confirm("Clear all employees, runs, approvals, activity, connectors, and tokens from this workspace?\n\nThe company name, executive agent, branches, operator, and tool catalog are kept.")) return;
  try {
    detachRun();
    await apiRequest("/api/workspace/reset", { method: "POST", body: JSON.stringify({ template: "empty" }) });
    await refreshWorkspace({ quiet: true });
    toast("Workspace data cleared");
  } catch (error) {
    toast(`Workspace was not reset. ${error.message}`, true);
  }
}

/* ---------------------------- actions ------------------------------ */

document.addEventListener("click", async (event) => {
  const target = event.target;

  const editAgent = target.closest("[data-edit-agent]");
  if (editAgent) {
    openAgentDialog(agentById(editAgent.dataset.editAgent));
    return;
  }
  if (target.closest("[data-edit-executive]")) {
    openExecutiveDialog();
    return;
  }
  if (target.closest("[data-add-first-employee]")) {
    openAgentDialog();
    return;
  }

  const branchLink = target.closest(".branch-item[data-branch]");
  if (branchLink) {
    event.preventDefault();
    selectedBranch = branchLink.dataset.branch;
    renderBranchList();
    renderOrgChart();
    $("#employees").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const navLink = target.closest(".nav-item");
  if (navLink) {
    $$(".nav-item").forEach((node) => node.classList.remove("active"));
    navLink.classList.add("active");
    $("#current-view-label").textContent = navLink.textContent.trim().replace(/\s+\d+$/, "");
    return;
  }

  const seedDecision = target.closest("[data-approval]");
  if (seedDecision) {
    if (!stateReady) {
      toast("Workspace is not connected to the local server", true);
      return;
    }
    await decideSeedApproval(seedDecision.dataset.approval, seedDecision.dataset.decision);
    return;
  }

  const mcpDecision = target.closest("[data-mcp-approval]");
  if (mcpDecision) {
    await decideMcpApproval(mcpDecision.dataset.mcpApproval, mcpDecision.dataset.decision, mcpDecision);
    return;
  }

  const editConnector = target.closest("[data-edit-connector]");
  if (editConnector) {
    openConnectorDialog((state.connectors || []).find((item) => item.id === editConnector.dataset.editConnector));
    return;
  }
  const toggleConnector = target.closest("[data-toggle-connector]");
  if (toggleConnector) {
    const connector = (state.connectors || []).find((item) => item.id === toggleConnector.dataset.toggleConnector);
    if (connector) {
      await saveConnector(
        { label: connector.label, url: connector.url, description: connector.description, allowedTools: connector.allowedTools, enabled: !connector.enabled },
        false,
        connector.id,
      );
    }
    return;
  }
  const deleteConnector = target.closest("[data-delete-connector]");
  if (deleteConnector) {
    const connector = (state.connectors || []).find((item) => item.id === deleteConnector.dataset.deleteConnector);
    if (connector && window.confirm(`Remove ${connector.label}? Employee grants for it will no longer work.`)) {
      try {
        await apiRequest(`/api/connectors/${encodeURIComponent(connector.id)}`, { method: "DELETE" });
        await refreshWorkspace({ quiet: true });
        toast(`${connector.label} removed`);
      } catch (error) {
        toast(`Connector was not removed. ${error.message}`, true);
      }
    }
    return;
  }

  const editTool = target.closest("[data-edit-tool]");
  if (editTool) {
    openToolDialog(state.tools[Number(editTool.dataset.editTool)]);
    return;
  }
  const deleteToolButton = target.closest("[data-delete-tool]");
  if (deleteToolButton) {
    await deleteTool(Number(deleteToolButton.dataset.deleteTool));
    return;
  }

  const toggleTool = target.closest("[data-toggle-tool]");
  if (toggleTool) {
    const tool = state.tools[Number(toggleTool.dataset.toggleTool)];
    if (tool) {
      const enabled = !tool.connected;
      await commitWorkspace(() => {
        tool.connected = enabled;
        logActivity("tool", "↔", state.operator?.name || "Workspace admin", `${enabled ? "enabled" : "disabled"} a permission label for`, tool.name, "Local workspace · account not connected");
      }, `${tool.name} permission label ${enabled ? "enabled" : "disabled"}`);
    }
    return;
  }

  if (target.closest("#add-agent-button")) {
    if (!stateReady) toast("Workspace is not connected to the local server", true);
    else openAgentDialog();
    return;
  }
  if (target.closest("#add-tool-button")) {
    if (!stateReady) {
      toast("Workspace is not connected to the local server", true);
      return;
    }
    openToolDialog();
    return;
  }
  if (target.closest("#add-mcp-connector")) {
    if (!stateReady) toast("Workspace is not connected to the local server", true);
    else openConnectorDialog();
    return;
  }
  if (target.closest("[data-close-dialog]")) {
    target.closest("dialog")?.close();
    return;
  }
  if (target.closest("#remove-agent-button")) {
    await removeAgent();
    return;
  }
  if (target.closest("#export-button")) {
    if (stateReady) exportRoster();
    else toast("Workspace is not connected to the local server", true);
    return;
  }
  if (target.closest("#all-approvals")) {
    showAllActivity = true;
    activityFilter = "approvals";
    $("#activity-filter").value = "approvals";
    renderActivity();
    $("#activity").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (target.closest("#approvals-more")) {
    openHelp();
    return;
  }
  if (target.closest("#view-all-agents")) {
    selectedBranch = "all";
    renderBranchList();
    renderOrgChart();
    $("#employees").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (target.closest("#load-activity")) {
    showAllActivity = !showAllActivity;
    renderActivity();
    return;
  }
  if (target.closest("#usage-info-button") || target.closest("#backup-from-usage")) {
    if (target.closest("#backup-from-usage")) downloadBackup();
    else openUsage();
    return;
  }
  if (target.closest("#notification-button")) {
    $("#approvals").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (target.closest("#palette-button")) {
    openPalette();
    return;
  }
  if (target.closest("#theme-toggle")) {
    toggleTheme();
    return;
  }
  if (target.closest("#help-button")) {
    openHelp();
    return;
  }

  const attach = target.closest("[data-attach-run]");
  if (attach) {
    attachRun(attach.dataset.attachRun);
    $("#workbench").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const cancel = target.closest("[data-cancel-run]");
  if (cancel) {
    await cancelRun(cancel.dataset.cancelRun);
    return;
  }
  const rerun = target.closest("[data-rerun]");
  if (rerun) {
    const task = taskFor(rerun.dataset.rerun);
    if (task) await startRun(task.prompt);
    return;
  }
  const toggleRun = target.closest("[data-toggle-run]");
  if (toggleRun) {
    const id = toggleRun.dataset.toggleRun;
    if (expandedRuns.has(id)) expandedRuns.delete(id);
    else expandedRuns.add(id);
    renderRuns();
    return;
  }
  const deleteRun = target.closest("[data-delete-run]");
  if (deleteRun) {
    const task = taskFor(deleteRun.dataset.deleteRun);
    if (task && window.confirm(`Delete this saved run?\n\n${task.prompt.slice(0, 160)}`)) {
      try {
        await apiRequest(`/api/runs/${encodeURIComponent(task.id)}`, { method: "DELETE" });
        expandedRuns.delete(task.id);
        await refreshWorkspace({ quiet: true });
        toast("Run deleted");
      } catch (error) {
        toast(`Run was not deleted. ${error.message}`, true);
      }
    }
    return;
  }
  const openRun = target.closest("[data-open-run]");
  if (openRun) {
    const openTask = taskFor(openRun.dataset.openRun);
    if (openTask && isActiveStatus(openTask.status)) attachRun(openTask.id);
    expandedRuns.add(openRun.dataset.openRun);
    runFilter = "all";
    $("#run-filter").value = "all";
    renderRuns();
    $("#runs").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (target.closest("[data-dismiss-live]")) {
    detachRun();
    updateGatewayChrome();
    render();
    return;
  }
  if (target.closest("[data-scroll-approvals]")) {
    $("#approvals").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  if (target.closest("#workspace-switcher")) {
    const menu = $("#workspace-menu");
    const hidden = menu.hidden;
    menu.hidden = !hidden;
    $("#workspace-switcher").setAttribute("aria-expanded", String(hidden));
    $("#profile-menu").hidden = true;
    $("#profile-button").setAttribute("aria-expanded", "false");
    return;
  }
  const workspaceOption = target.closest("[data-workspace-switch]");
  if (workspaceOption) {
    await switchWorkspace(workspaceOption.dataset.workspaceSwitch);
    return;
  }
  if (target.closest("#delete-workspace-button")) {
    await deleteWorkspace();
    return;
  }
  if (target.closest("#profile-button")) {
    const menu = $("#profile-menu");
    const hidden = menu.hidden;
    menu.hidden = !hidden;
    $("#profile-button").setAttribute("aria-expanded", String(hidden));
    $("#workspace-menu").hidden = true;
    $("#workspace-switcher").setAttribute("aria-expanded", "false");
    return;
  }
  const menuAction = target.closest("[data-menu]");
  if (menuAction) {
    $("#profile-menu").hidden = true;
    $("#profile-button").setAttribute("aria-expanded", "false");
    $("#workspace-menu").hidden = true;
    $("#workspace-switcher").setAttribute("aria-expanded", "false");
    const action = menuAction.dataset.menu;
    if (action === "new-workspace") openWorkspaceDialog();
    if (action === "workspace-settings") openSettingsDialog();
    if (action === "usage") openUsage();
    if (action === "backup") downloadBackup();
    if (action === "restore") $("#restore-file").click();
    if (action === "theme") toggleTheme();
    if (action === "help") openHelp();
    if (action === "reset") resetWorkspace();
    return;
  }
  if (!target.closest(".profile-wrap")) {
    const menu = $("#profile-menu");
    if (menu && !menu.hidden) {
      menu.hidden = true;
      $("#profile-button").setAttribute("aria-expanded", "false");
    }
  }
  if (!target.closest(".workspace-wrap")) {
    const menu = $("#workspace-menu");
    if (menu && !menu.hidden) {
      menu.hidden = true;
      $("#workspace-switcher").setAttribute("aria-expanded", "false");
    }
  }
});

/* ---------------------------- forms -------------------------------- */

$("#agent-branch").addEventListener("change", (event) => renderManagerOptions(event.target.value, "exec", $("#agent-id").value));

$("#agent-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!stateReady) {
    toast("Workspace is not connected to the local server", true);
    return;
  }
  const form = new FormData(event.currentTarget);
  const id = $("#agent-id").value;
  const existing = agentById(id);
  const selectedGrantConnectors = [...new Set($$('input[name="mcp-grant"]:checked').map((input) => input.dataset.connectorId))];
  const agent = {
    id: id || newId("employee"),
    name: String(form.get("name") || "").trim(),
    role: String(form.get("role") || "").trim(),
    branch: String(form.get("branch") || "").trim(),
    managerId: String(form.get("manager") || "exec"),
    capabilities: String(form.get("capabilities") || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    status: String(form.get("status")),
    tools: $$('input[name="agent-tool"]:checked').map((input) => input.value),
    mcpGrants: selectedGrantConnectors
      .map((connectorId) => ({
        connectorId,
        tools: $$(`input[name="mcp-grant"][data-connector-id="${CSS.escape(connectorId)}"]:checked`).map((input) => input.value),
      }))
      .filter((grant) => grant.tools.length),
  };
  if (!agent.name || !agent.role || !agent.branch) return;
  if (existing && existing.branch !== agent.branch && state.agents.some((employee) => employee.managerId === existing.id)) {
    toast("Reassign this employee’s reports before moving them to another branch", true);
    return;
  }
  const saved = await commitWorkspace(() => {
    if (existing) Object.assign(existing, agent);
    else state.agents.push(agent);
    logActivity("tool", "✦", agent.name, existing ? "updated their employee profile in" : "was added as an employee in", agent.branch, "Local workspace · roster change");
  }, existing ? `${agent.name} updated` : `${agent.name} added to ${agent.branch}`);
  if (saved) $("#agent-dialog").close();
});

$("#tool-form").addEventListener("submit", saveTool);

$("#mcp-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!stateReady) {
    toast("Workspace is not connected to the local server", true);
    return;
  }
  const id = $("#mcp-connector-id").value;
  const data = {
    label: $("#mcp-label").value.trim(),
    url: $("#mcp-url").value.trim(),
    description: $("#mcp-description").value.trim(),
    allowedTools: $("#mcp-tools")
      .value.split(/[\n,]/)
      .map((name) => name.trim())
      .filter(Boolean),
    enabled: $("#mcp-enabled").checked,
  };
  const token = $("#mcp-token").value;
  if (token) data.bearerToken = token;
  if ($("#mcp-clear-token").checked) data.clearBearerToken = true;
  $("#mcp-token").value = "";
  await saveConnector(data, !id);
});

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!stateReady) {
    setTaskMessage("The local Agent Factory server is unavailable.");
    return;
  }
  if (!gateway.configured) {
    updateGatewayChrome();
    setTaskMessage("Configure the model gateway or start with AGENT_FACTORY_DEMO=1 before running a task.");
    return;
  }
  const prompt = $("#task-prompt").value.trim();
  if (!prompt) return;
  const button = $("#run-task-button");
  startInFlight = true;
  button.disabled = true;
  setTaskMessage("Executive is planning the task. Employee progress will stream below.");
  const started = await startRun(prompt);
  startInFlight = false;
  button.disabled = !stateReady || !gateway.configured;
  if (started) $("#task-prompt").value = "";
});

/* ---------------------------- misc --------------------------------- */

async function removeAgent() {
  if (!stateReady) {
    toast("Workspace is not connected to the local server", true);
    return;
  }
  const id = $("#agent-id").value;
  const agent = agentById(id);
  if (!agent) return;
  const pending = state.approvals.filter((approval) => approval.agent === agent.name);
  if (pending.length) {
    toast("Resolve this employee’s pending approvals before removing them", true);
    return;
  }
  if (state.tasks.some((task) => isActiveStatus(task.status) && (task.assignments || []).some((assignment) => assignment.employeeId === id))) {
    toast("This employee is part of an active run. Cancel or finish it first.", true);
    return;
  }
  if (state.agents.some((employee) => employee.managerId === agent.id)) {
    toast("Reassign this employee’s reports before removing them", true);
    return;
  }
  if (!window.confirm(`Remove ${agent.name} from the workspace?`)) return;
  const removed = await commitWorkspace(() => {
    state.agents = state.agents.filter((item) => item.id !== id);
    logActivity("tool", "−", agent.name, "was removed from the employee roster in", agent.branch, "Local workspace · roster change");
  }, `${agent.name} removed`);
  if (removed) $("#agent-dialog").close();
}

document.addEventListener("keydown", (event) => {
  const tag = event.target?.tagName?.toLowerCase();
  const typing = tag === "input" || tag === "textarea" || tag === "select" || event.target?.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!$("#palette-dialog").open) openPalette();
    return;
  }
  if (event.key === "?" && !typing && !$("#palette-dialog").open) {
    event.preventDefault();
    openHelp();
    return;
  }
  if (event.key === "Escape") {
    const menu = $("#profile-menu");
    if (menu && !menu.hidden) {
      menu.hidden = true;
      $("#profile-button").setAttribute("aria-expanded", "false");
    }
  }
});

$("#palette-input").addEventListener("input", () => {
  paletteIndex = 0;
  renderPalette();
});

$("#palette-input").addEventListener("keydown", (event) => {
  const items = filteredPaletteItems();
  if (event.key === "ArrowDown") {
    event.preventDefault();
    paletteIndex = Math.min(items.length - 1, paletteIndex + 1);
    renderPalette();
    $(".palette-item.selected")?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    paletteIndex = Math.max(0, paletteIndex - 1);
    renderPalette();
    $(".palette-item.selected")?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter") {
    event.preventDefault();
    runPaletteIndex(paletteIndex);
  }
});

$("#palette-results").addEventListener("click", (event) => {
  const item = event.target.closest("[data-palette-index]");
  if (item) runPaletteIndex(Number(item.dataset.paletteIndex));
});

$("#palette-dialog").addEventListener("close", () => {
  paletteItems = [];
  paletteIndex = 0;
});

$("#run-filter").addEventListener("change", (event) => {
  runFilter = event.target.value;
  renderRuns();
});

$("#activity-filter").addEventListener("change", (event) => {
  activityFilter = event.target.value;
  showAllActivity = false;
  renderActivity();
});

$("#restore-file").addEventListener("change", (event) => {
  restoreBackup(event.target.files?.[0]);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && stateReady) refreshWorkspace({ quiet: true });
});

window.addEventListener("beforeunload", () => {
  if (live?.source) live.source.close();
});

$("#workspace-form").addEventListener("submit", createWorkspace);
$("#settings-form").addEventListener("submit", saveSettings);
$("#executive-form").addEventListener("submit", saveExecutive);

/* ---------------------------- startup ------------------------------ */

const today = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date());
$("#today-label").textContent = today.toUpperCase();
updateThemeButton();
render();
updateGatewayChrome();
refreshWorkspace();
