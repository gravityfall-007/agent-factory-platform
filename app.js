"use strict";

const branches = ["San Francisco", "Berlin", "Singapore", "Remote"];
let executive = { id: "exec", name: "Executive agent", role: "Executive agent · CEO", branch: "Executive", status: "active", tools: [] };
let state = { executive, agents: [], tools: [], approvals: [], activities: [], tasks: [] };
let gateway = { configured: false, model: "", format: "responses" };
let stateReady = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
const agentById = (id) => state.agents.find((agent) => agent.id === id);
let showAllActivity = false;

async function apiRequest(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  } catch {
    throw new Error("The Agent Factory server is unavailable. Start it with `node server.mjs`.");
  }
  let payload = {};
  try { payload = await response.json(); } catch { /* keep a safe, generic error below */ }
  if (!response.ok) throw new Error(payload.error || payload.message || `Request failed (${response.status})`);
  return payload;
}

function setGatewayStatus(message, mode = "offline") {
  const badge = $("#gateway-status");
  badge.classList.remove("ready", "offline", "pending");
  badge.classList.add(mode);
  badge.innerHTML = `<span class="demo-pulse"></span> ${escapeHtml(message)}`;
  $("#run-task-button").disabled = !stateReady || !gateway.configured;
  $("#task-message").textContent = !stateReady
    ? "Waiting for the local server and workspace…"
    : gateway.configured
      ? `Model gateway ready · ${gateway.model}. Tool entries are permission labels only.`
      : "Model gateway is not configured. Set OPENAI_BASE_URL, OPENAI_API_KEY, and AGENT_FACTORY_MODEL on the server, then restart it.";
}

async function refreshWorkspace() {
  try {
    const [status, workspace] = await Promise.all([apiRequest("/api/status"), apiRequest("/api/state")]);
    gateway = status;
    executive = workspace.executive;
    state = workspace;
    stateReady = true;
    render();
    setGatewayStatus(gateway.configured ? `MODEL READY · ${gateway.model}` : "MODEL GATEWAY NOT CONFIGURED", gateway.configured ? "ready" : "offline");
    $("#sync-status").textContent = "Workspace loaded";
    return true;
  } catch (error) {
    stateReady = false;
    gateway = { configured: false, model: "", format: "responses" };
    setGatewayStatus("LOCAL SERVER UNAVAILABLE", "offline");
    $("#sync-status").textContent = "Workspace not loaded";
    $("#task-message").textContent = error.message;
    render();
    return false;
  }
}

async function commitWorkspace(mutator, successMessage) {
  if (!stateReady) { toast("Workspace is not connected to the local server", true); return false; }
  const before = structuredClone(state);
  mutator();
  render();
  try {
    await apiRequest("/api/state", { method: "PUT", body: JSON.stringify(state) });
    $("#sync-status").textContent = "Saved just now";
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

function render() {
  renderOrgChart();
  renderApprovals();
  renderActivity();
  renderTasks();
  renderTools();
  renderConnectors();
  updateMetrics();
}

function renderOrgChart() {
  const selected = document.querySelector(".branch-item.selected")?.dataset.branch || "all";
  const visibleBranches = selected === "all" ? branches : branches.filter((branch) => branch === selected);
  const executiveTools = executive.tools.filter((name) => state.tools.some((tool) => tool.name === name && tool.connected)).length;
  const branchCards = visibleBranches.map((branch) => {
    const agents = state.agents.filter((agent) => agent.branch === branch);
    const branchClass = branch === "San Francisco" ? "sf" : branch.toLowerCase().split(" ")[0];
    const renderAgentNode = (agent, nested = false) => {
      const manager = agent.managerId === "exec" ? executive.name : agentById(agent.managerId)?.name || executive.name;
      const children = agents.filter((child) => child.managerId === agent.id);
      const row = `<div class="branch-agent">
        <span class="agent-avatar" aria-hidden="true">${escapeHtml(initials(agent.name))}</span>
        <span class="agent-info"><span class="agent-name">${escapeHtml(agent.name)}</span><span class="agent-role">${escapeHtml(agent.role)} · reports to ${escapeHtml(manager)}</span><span class="agent-capabilities">${escapeHtml(agent.capabilities.join(", ") || "No capabilities listed")}</span></span>
        <span class="agent-status" aria-label="${agent.status === "active" ? "Active" : "Idle"}">${agent.status === "active" ? "Active" : "Idle"}</span>
        <button class="agent-edit" data-edit-agent="${escapeHtml(agent.id)}" aria-label="Edit ${escapeHtml(agent.name)}" title="Edit employee">✎</button>
      </div>`;
      return `${nested ? `<div class="agent-children">${row}</div>` : row}${children.map((child) => renderAgentNode(child, true)).join("")}`;
    };
    const roots = agents.filter((agent) => agent.managerId === "exec" || !agents.some((candidate) => candidate.id === agent.managerId));
    return `<section class="branch-card" aria-label="${escapeHtml(branch)} branch">
      <div class="branch-card-head"><span class="branch-dot ${escapeHtml(branchClass)}"></span>${escapeHtml(branch)}<small>${agents.length} ${agents.length === 1 ? "EMPLOYEE" : "EMPLOYEES"}</small></div>
      ${agents.length ? roots.map((agent) => renderAgentNode(agent)).join("") : `<div class="empty-branch">No employees in this branch yet.</div>`}
    </section>`;
  }).join("");
  $("#org-chart").innerHTML = `<article class="ceo-card">
    <span class="agent-avatar ceo" aria-hidden="true">${escapeHtml(initials(executive.name))}</span>
    <span class="agent-info"><span class="agent-name-row"><span class="agent-name">${escapeHtml(executive.name)}</span><span class="ceo-label">EXECUTIVE</span></span><span class="agent-role">${escapeHtml(executive.role)} · coordinates all branches</span></span>
    <span class="agent-status">${executiveTools} labels</span>
  </article><div class="org-branches">${branchCards}</div>`;
  $$(".branch-count").forEach((node) => {
    const branch = node.closest(".branch-item")?.dataset.branch;
    node.textContent = branch === "all" ? state.agents.length : state.agents.filter((agent) => agent.branch === branch).length;
  });
  $(".branch-item[data-branch='all']")?.classList.toggle("selected", selected === "all");
}

function renderApprovals() {
  const list = $("#approval-list");
  if (!stateReady) {
    list.innerHTML = '<div class="approval-empty">Connect to the local server to load approval history.</div>';
  } else if (!state.approvals.some((item) => !item.mcp) && !state.approvals.length) {
    list.innerHTML = '<div class="approval-empty">You’re all caught up. New requests will appear here.</div>';
  } else {
    list.innerHTML = state.approvals.filter((item) => !item.mcp && !item.connectorId).map((approval) => `<article class="approval-card">
      <div class="approval-meta"><span class="approval-avatar">${escapeHtml(approval.initials)}</span><strong>${escapeHtml(approval.agent)}</strong><span>requested review</span><span class="approval-time">${escapeHtml(approval.time)}</span></div>
      <p class="approval-title">${escapeHtml(approval.action)}</p><p class="approval-desc">${escapeHtml(approval.detail)}</p>
      <div class="approval-actions"><button class="small-action approve" data-approval="${escapeHtml(approval.id)}" data-decision="approved">Approve</button><button class="small-action" data-approval="${escapeHtml(approval.id)}" data-decision="rejected">Reject</button></div>
    </article>`).join("");
  }
  const mcpHost = $("#mcp-pending-list");
  const pending = (state.approvals || []).filter((item) => item.mcp || item.connectorId);
  mcpHost.innerHTML = pending.map((approval) => {
    const call = approval.mcp || approval;
    const employee = approval.employeeName || approval.agent || "Employee agent";
    return `<article class="mcp-approval-card">
    <div class="mcp-approval-meta"><span class="mcp-mark">MCP</span><div><strong>${escapeHtml(call.connectorLabel || "Remote MCP server")}</strong><small>${escapeHtml(employee)} · ${escapeHtml(call.toolName)}</small></div></div>
    <p class="mcp-approval-warning">Approving sends these exact arguments to the remote server and may trigger an external action.</p>
    <pre class="mcp-arguments">${escapeHtml(JSON.stringify(call.arguments ?? {}, null, 2))}</pre>
    <div class="approval-actions"><button class="small-action approve" data-mcp-approval="${escapeHtml(approval.id)}" data-decision="approved">Approve this call</button><button class="small-action" data-mcp-approval="${escapeHtml(approval.id)}" data-decision="rejected">Reject</button></div>
  </article>`;
  }).join("");
  const count = state.approvals.length;
  $("#approval-count-badge").textContent = count;
  $("#approval-nav-count").textContent = count;
  $("#approval-nav-count").classList.toggle("attention", count > 0);
  $("#pending-approvals-metric").textContent = String(count).padStart(2, "0");
  const approvalEmployees = new Set(state.approvals.map((approval) => approval.agent)).size;
  $("#approval-employee-count").textContent = `across ${approvalEmployees} ${approvalEmployees === 1 ? "employee" : "employees"}`;
}

function renderActivity() {
  const events = showAllActivity ? state.activities : state.activities.slice(0, 6);
  $("#activity-feed").innerHTML = !stateReady ? '<div class="approval-empty">Workspace history is unavailable while the local server is offline.</div>' : events.map((event) => `<article class="activity-item">
    <span class="activity-icon ${escapeHtml(event.kind)}" aria-hidden="true">${escapeHtml(event.icon)}</span>
    <span class="activity-copy"><strong>${escapeHtml(event.agent)}</strong> ${escapeHtml(event.action)} <strong>${escapeHtml(event.target)}</strong><small>${escapeHtml(event.detail)}</small></span>
    <time class="activity-time">${escapeHtml(event.time)}</time>
  </article>`).join("");
  $("#load-activity").hidden = state.activities.length <= 6;
  $("#load-activity").textContent = showAllActivity ? "Show recent activity ↑" : `View all ${state.activities.length} events →`;
}

function renderTasks() {
  const host = $("#task-results");
  const tasks = state.tasks || [];
  if (!stateReady) {
    host.innerHTML = '<div class="task-empty">Start the local server to load saved task runs.</div>';
    return;
  }
  if (!tasks.length) {
    host.innerHTML = '<div class="task-empty">Completed and failed task runs will be saved here.</div>';
    return;
  }
  host.innerHTML = tasks.slice(0, 3).map((task) => `<article class="task-result ${task.status === "failed" ? "failed" : task.status === "waiting_approval" ? "waiting" : "completed"}">
    <div class="task-result-head"><div><span class="task-result-label">${task.status === "failed" ? "RUN FAILED" : task.status === "waiting_approval" ? "WAITING FOR APPROVAL" : "EXECUTIVE SUMMARY"}</span><h3>${escapeHtml(task.prompt)}</h3></div><time>${escapeHtml(formatTaskDate(task.createdAt))}</time></div>
    ${task.summary ? `<p class="task-summary">${escapeHtml(task.summary)}</p>` : `<p class="task-summary">${task.status === "failed" ? escapeHtml(task.error || "The run failed. Check the gateway configuration and try again.") : task.status === "waiting_approval" ? "Paused until the requested MCP call is approved or rejected." : "No executive summary was returned."}</p>`}
    ${task.assignments?.length ? `<div class="assignment-list">${task.assignments.map((assignment) => `<div class="assignment-result"><div><strong>${escapeHtml(assignment.employeeName)}</strong><small>${escapeHtml(assignment.task)}</small></div><p>${escapeHtml(assignment.result || "No result returned.")}</p></div>`).join("")}</div>` : ""}
  </article>`).join("");
}

function formatTaskDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function renderTools() {
  const enabled = state.tools.filter((tool) => tool.connected).length;
  $("#tool-count").textContent = `${enabled} labels`;
  $("#tool-list").innerHTML = state.tools.map((tool, index) => `<div class="tool-row">
    <span class="tool-logo ${escapeHtml(tool.style)}" aria-hidden="true">${escapeHtml(tool.glyph)}</span>
    <span class="tool-copy"><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.category)} · not connected</small></span>
    <span class="tool-state ${tool.connected ? "" : "off"}">${tool.connected ? "Listed" : "Disabled"}</span>
    <button class="toggle" type="button" role="switch" aria-checked="${tool.connected}" aria-label="${tool.connected ? "Disable" : "Enable"} ${escapeHtml(tool.name)} permission label; not connected" data-toggle-tool="${index}"></button>
  </div>`).join("");
}

function renderConnectors() {
  const host = $("#mcp-connector-list");
  const connectors = state.connectors || [];
  if (!stateReady) { host.innerHTML = '<div class="approval-empty">Connector settings require the local server.</div>'; return; }
  if (!connectors.length) { host.innerHTML = '<div class="approval-empty">No MCP servers configured. Add one to make explicitly granted tools available.</div>'; return; }
  host.innerHTML = connectors.map((connector) => `<article class="mcp-connector-card ${connector.enabled ? "" : "disabled"}">
    <div class="mcp-connector-heading"><span class="mcp-mark">MCP</span><div><strong>${escapeHtml(connector.label)}</strong><small>${escapeHtml(connector.url)}</small></div><span class="connector-badge">${connector.enabled ? "ENABLED" : "DISABLED"}</span></div>
    <p>${escapeHtml(connector.description || "No description")}</p><div class="connector-tools">${(connector.allowedTools || []).map((tool) => `<span>${escapeHtml(tool)}</span>`).join("")}</div>
    <small class="token-state">${connector.hasBearerToken ? "Server-held bearer token saved" : "No bearer token saved"}</small>
    <div class="connector-actions"><button type="button" data-edit-connector="${escapeHtml(connector.id)}">Edit</button><button type="button" data-toggle-connector="${escapeHtml(connector.id)}">${connector.enabled ? "Disable" : "Enable"}</button><button type="button" class="danger-link" data-delete-connector="${escapeHtml(connector.id)}">Remove</button></div>
  </article>`).join("");
}

function updateMetrics() {
  if (!stateReady) {
    $("#active-agents-metric").textContent = "—";
    $("#agent-nav-count").textContent = "—";
    return;
  }
  const active = state.agents.filter((agent) => agent.status === "active").length + (executive.status === "active" ? 1 : 0);
  $("#active-agents-metric").innerHTML = `${active}<span class="metric-total"> / ${state.agents.length + 1}</span>`;
  $("#agent-nav-count").textContent = state.agents.length;
}

function logActivity(kind, icon, agent, action, target, detail) {
  state.activities.unshift({ id: `evt-${Date.now()}`, kind, icon, agent, action, target, detail, time: "just now" });
}

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  node.textContent = message;
  $("#toast-region").append(node);
  window.setTimeout(() => node.remove(), 3200);
}

function openAgentDialog(agent = null) {
  const form = $("#agent-form");
  form.reset();
  $("#agent-id").value = agent?.id || "";
  $("#agent-name").value = agent?.name || "";
  $("#agent-role").value = agent?.role || "";
  $("#agent-branch").value = agent?.branch || branches[0];
  $("#agent-capabilities").value = agent?.capabilities.join(", ") || "";
  $("#agent-status").value = agent?.status || "active";
  renderManagerOptions(agent?.branch || branches[0], agent?.managerId || "exec", agent?.id || "");
  $("#agent-dialog-title").textContent = agent ? "Edit employee" : "Create employee";
  $("#save-agent-button").textContent = agent ? "Save changes" : "Create employee";
  $("#form-tool-options").innerHTML = state.tools.map((tool, index) => `<label class="tool-option"><input type="checkbox" name="agent-tool" value="${escapeHtml(tool.name)}" ${agent?.tools.includes(tool.name) ? "checked" : ""} ${tool.connected ? "" : "disabled"}><span>${escapeHtml(tool.name)}${tool.connected ? "" : " · disabled"}</span></label>`).join("");
  const grants = agent?.mcpGrants || [];
  const grantOptions = (state.connectors || []).filter((connector) => connector.enabled).map((connector) => {
    const selected = grants.find((grant) => grant.connectorId === connector.id)?.tools || [];
    return `<fieldset class="mcp-grant-group"><legend>${escapeHtml(connector.label)}</legend>${connector.allowedTools.map((tool) => `<label class="tool-option"><input type="checkbox" name="mcp-grant" data-connector-id="${escapeHtml(connector.id)}" value="${escapeHtml(tool)}" ${selected.includes(tool) ? "checked" : ""}><span>${escapeHtml(tool)}</span></label>`).join("")}</fieldset>`;
  }).join("");
  $("#form-mcp-options").innerHTML = grantOptions || '<small class="field-hint">No enabled MCP servers. Add a server in Integrations first.</small>';
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
  const form = $("#mcp-form");
  form.reset();
  $("#mcp-connector-id").value = connector?.id || "";
  $("#mcp-label").value = connector?.label || "";
  $("#mcp-url").value = connector?.url || "";
  $("#mcp-description").value = connector?.description || "";
  $("#mcp-tools").value = (connector?.allowedTools || []).join("\n");
  $("#mcp-enabled").checked = connector?.enabled ?? true;
  $("#mcp-token").value = "";
  $("#mcp-token").placeholder = connector?.hasBearerToken ? "Saved token · blank keeps it" : "Optional bearer token";
  $("#mcp-dialog-title").textContent = connector ? "Edit MCP server" : "Add MCP server";
  $("#save-mcp-button").textContent = connector ? "Save changes" : "Save connector";
  $("#mcp-dialog").showModal();
  $("#mcp-label").focus();
}

async function saveConnector(data, isNew = false, idOverride = "") {
  try {
    const id = idOverride || $("#mcp-connector-id").value;
    const endpoint = id ? `/api/connectors/${encodeURIComponent(id)}` : "/api/connectors";
    const method = id ? "PUT" : "POST";
    await apiRequest(endpoint, { method, body: JSON.stringify(data) });
    await refreshWorkspace();
    $("#mcp-dialog").close();
    toast(isNew ? "MCP server saved. Grant tools to employees before use." : "MCP server updated");
    return true;
  } catch (error) { toast(`Connector was not saved. ${error.message}`, true); return false; }
}

$("#agent-branch").addEventListener("change", (event) => renderManagerOptions(event.target.value, "exec", $("#agent-id").value));

document.addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-agent]");
  if (edit) openAgentDialog(agentById(edit.dataset.editAgent));

  const branchLink = event.target.closest(".branch-item");
  if (branchLink) {
    event.preventDefault();
    $$(".branch-item").forEach((node) => node.classList.remove("selected"));
    branchLink.classList.add("selected");
    renderOrgChart();
    $("#employees").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const navLink = event.target.closest(".nav-item");
  if (navLink) {
    $$(".nav-item").forEach((node) => node.classList.remove("active"));
    navLink.classList.add("active");
    $("#current-view-label").textContent = navLink.textContent.trim().replace(/\s+\d+$/, "");
  }

  const decision = event.target.closest("[data-approval]");
  if (decision) {
    if (!stateReady) { toast("Workspace is not connected to the local server", true); return; }
    const index = state.approvals.findIndex((approval) => approval.id === decision.dataset.approval);
    if (index >= 0) {
      const approval = state.approvals[index];
      const approved = decision.dataset.decision === "approved";
      await commitWorkspace(() => {
        state.approvals.splice(index, 1);
        logActivity(approved ? "complete" : "reject", approved ? "✓" : "×", approval.agent, approved ? "received approval to" : "had a request rejected for", approval.action, "Local workspace · seeded review example");
      }, `${approved ? "Approved" : "Rejected"}: ${approval.action}`);
    }
  }

  const mcpDecision = event.target.closest("[data-mcp-approval]");
  if (mcpDecision) {
    mcpDecision.disabled = true;
    try {
      const response = await apiRequest(`/api/mcp/approvals/${encodeURIComponent(mcpDecision.dataset.mcpApproval)}`, { method: "POST", body: JSON.stringify({ decision: mcpDecision.dataset.decision }) });
      await refreshWorkspace();
      if (response.pendingApproval) toast(`Another MCP call needs review: ${response.pendingApproval.toolName}`);
      else if (response.task?.status === "done") toast("Approval handled; workflow completed.");
      else if (response.task?.status === "failed") toast(response.task.summary || "Workflow failed after approval.", true);
      else toast(mcpDecision.dataset.decision === "approved" ? "Call approved; workflow resumed." : "Call rejected; workflow resumed.");
    } catch (error) { mcpDecision.disabled = false; toast(`Approval decision was not completed. ${error.message}`, true); }
  }

  const connectorEdit = event.target.closest("[data-edit-connector]");
  if (connectorEdit) openConnectorDialog((state.connectors || []).find((item) => item.id === connectorEdit.dataset.editConnector));
  const connectorToggle = event.target.closest("[data-toggle-connector]");
  if (connectorToggle) {
    const connector = (state.connectors || []).find((item) => item.id === connectorToggle.dataset.toggleConnector);
    if (connector) await saveConnector({ label: connector.label, url: connector.url, description: connector.description, allowedTools: connector.allowedTools, enabled: !connector.enabled }, false, connector.id);
  }
  const connectorDelete = event.target.closest("[data-delete-connector]");
  if (connectorDelete) {
    const connector = (state.connectors || []).find((item) => item.id === connectorDelete.dataset.deleteConnector);
    if (connector && window.confirm(`Remove ${connector.label}? Employee grants for it will no longer work.`)) {
      try { await apiRequest(`/api/connectors/${encodeURIComponent(connector.id)}`, { method: "DELETE" }); await refreshWorkspace(); toast(`${connector.label} removed`); }
      catch (error) { toast(`Connector was not removed. ${error.message}`, true); }
    }
  }

  const toggle = event.target.closest("[data-toggle-tool]");
  if (toggle) {
    const tool = state.tools[Number(toggle.dataset.toggleTool)];
    if (tool) {
      const enabled = !tool.connected;
      await commitWorkspace(() => {
        tool.connected = enabled;
        logActivity("tool", "↔", "Workspace admin", `${enabled ? "enabled" : "disabled"} a permission label for`, tool.name, "Local workspace · account not connected");
      }, `${tool.name} permission label ${enabled ? "enabled" : "disabled"}`);
    }
  }

  if (event.target.closest("#add-agent-button")) {
    if (!stateReady) toast("Workspace is not connected to the local server", true);
    else openAgentDialog();
  }
  if (event.target.closest("#add-tool-button")) {
    if (!stateReady) { toast("Workspace is not connected to the local server", true); return; }
    $("#tool-form").reset(); $("#tool-dialog").showModal(); $("#tool-name").focus();
  }
  if (event.target.closest("#add-mcp-connector")) { if (!stateReady) toast("Workspace is not connected to the local server", true); else openConnectorDialog(); }
  if (event.target.closest("[data-close-dialog]")) event.target.closest("dialog")?.close();
  if (event.target.closest("#remove-agent-button")) {
    if (!stateReady) { toast("Workspace is not connected to the local server", true); return; }
    const id = $("#agent-id").value;
    const agent = agentById(id);
    const waiting = state.approvals.filter((approval) => approval.agent === agent?.name);
    if (waiting.length) { toast("Resolve this employee’s pending approvals before removing them", true); return; }
    if (state.agents.some((employee) => employee.managerId === agent?.id)) { toast("Reassign this employee’s reports before removing them", true); return; }
    if (agent && window.confirm(`Remove ${agent.name} from the demo workspace?`)) {
      const removed = await commitWorkspace(() => {
        state.agents = state.agents.filter((item) => item.id !== id);
        logActivity("tool", "−", agent.name, "was removed from the employee roster in", agent.branch, "Local workspace · roster change");
      }, `${agent.name} removed`);
      if (removed) $("#agent-dialog").close();
    }
  }
  if (event.target.closest("#export-button")) { if (stateReady) exportReport(); else toast("Workspace is not connected to the local server", true); }
  if (event.target.closest("#all-approvals")) { showAllActivity = true; renderActivity(); $("#activity").scrollIntoView({ behavior: "smooth", block: "start" }); toast("Approval decisions are included in the activity history"); }
  if (event.target.closest("#view-all-agents")) { $(".branch-item[data-branch='all']")?.click(); }
  if (event.target.closest("#load-activity")) { showAllActivity = !showAllActivity; renderActivity(); }
  if (event.target.closest("#usage-info-button")) toast("Usage figures are seeded demo values, not measured consumption");
  if (event.target.closest(".notification-button")) $("#approvals").scrollIntoView({ behavior: "smooth", block: "start" });
  if (event.target.closest(".icon-button[aria-label='Search']")) {
    const query = window.prompt("Search employees, branches, tools, or activity");
    if (query?.trim()) {
      const found = state.agents.find((agent) => `${agent.name} ${agent.role} ${agent.branch}`.toLowerCase().includes(query.toLowerCase())) || state.tools.find((tool) => tool.name.toLowerCase().includes(query.toLowerCase()));
      toast(found ? `Found ${found.name} in the demo workspace` : "No matching employee or tool found", !found);
    }
  }
});

$("#agent-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!stateReady) { toast("Workspace is not connected to the local server", true); return; }
  const form = new FormData(event.currentTarget);
  const id = $("#agent-id").value;
  const existing = agentById(id);
  const agent = {
    id: id || `employee-${Date.now()}`,
    name: String(form.get("name")).trim(),
    role: String(form.get("role")).trim(),
    branch: String(form.get("branch")),
    managerId: String(form.get("manager") || "exec"),
    capabilities: String(form.get("capabilities") || "").split(",").map((item) => item.trim()).filter(Boolean),
    status: String(form.get("status")),
    tools: $$('input[name="agent-tool"]:checked').map((input) => input.value),
    mcpGrants: [...new Set($$('input[name="mcp-grant"]:checked').map((input) => input.dataset.connectorId))].map((connectorId) => ({ connectorId, tools: $$(`input[name="mcp-grant"][data-connector-id="${CSS.escape(connectorId)}"]:checked`).map((input) => input.value) })),
  };
  if (!agent.name || !agent.role) return;
  if (existing && existing.branch !== agent.branch && state.agents.some((employee) => employee.managerId === existing.id)) {
    toast("Reassign this employee’s reports before moving them to another branch", true);
    return;
  }
  const saved = await commitWorkspace(() => {
    if (existing) Object.assign(existing, agent); else state.agents.push(agent);
    logActivity("tool", "✦", agent.name, existing ? "updated their employee profile in" : "was added as an employee in", agent.branch, "Local workspace · roster change");
  }, existing ? `${agent.name} updated` : `${agent.name} added to ${agent.branch}`);
  if (saved) $("#agent-dialog").close();
});

$("#tool-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!stateReady) { toast("Workspace is not connected to the local server", true); return; }
  const form = new FormData(event.currentTarget);
  const name = String(form.get("name")).trim();
  if (!name) return;
  if (state.tools.some((tool) => tool.name.toLowerCase() === name.toLowerCase())) { toast("That tool label already exists", true); return; }
  const saved = await commitWorkspace(() => {
    state.tools.push({ name, category: String(form.get("category")), connected: true, glyph: initials(name).slice(0, 1), style: "" });
    logActivity("tool", "＋", "Workspace admin", "added a tool permission label for", name, "Local workspace · account not connected");
  }, `${name} permission label added`);
  if (saved) $("#tool-dialog").close();
});

$("#mcp-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!stateReady) { toast("Workspace is not connected to the local server", true); return; }
  const id = $("#mcp-connector-id").value;
  const data = {
    label: $("#mcp-label").value.trim(),
    url: $("#mcp-url").value.trim(),
    description: $("#mcp-description").value.trim(),
    allowedTools: $("#mcp-tools").value.split(/[\n,]/).map((name) => name.trim()).filter(Boolean),
    enabled: $("#mcp-enabled").checked,
  };
  const token = $("#mcp-token").value;
  if (token) data.bearerToken = token;
  $("#mcp-token").value = "";
  await saveConnector(data, !id);
});

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!stateReady) { $("#task-message").textContent = "The local Agent Factory server is unavailable."; return; }
  if (!gateway.configured) {
    setGatewayStatus("MODEL GATEWAY NOT CONFIGURED", "offline");
    return;
  }
  const prompt = $("#task-prompt").value.trim();
  if (!prompt) return;
  const button = $("#run-task-button");
  button.disabled = true;
  $("#task-message").textContent = "Executive is planning the task. Employee results will appear after the executive reviews them.";
  try {
    const response = await apiRequest("/api/workflows", { method: "POST", body: JSON.stringify({ prompt }) });
    if (!response.task) throw new Error("The server returned no task result.");
    await refreshWorkspace();
    $("#task-prompt").value = "";
    $("#task-message").textContent = response.pendingApproval
      ? `Workflow paused: ${response.pendingApproval.employeeName} requested ${response.pendingApproval.toolName}. Review the exact arguments in Approvals.`
      : response.task.status === "failed" ? `Task failed: ${response.task.summary || "check server and gateway status"}`
      : response.task.status === "waiting_approval" ? "Workflow paused for MCP approval. Review the exact arguments in Approvals."
      : "Task completed and saved to workspace history.";
  } catch (error) {
    await refreshWorkspace();
    $("#task-message").textContent = `Task did not complete: ${error.message}`;
    toast(error.message, true);
  } finally {
    button.disabled = !stateReady || !gateway.configured;
  }
});

function exportReport() {
  const rows = [["Name", "Role", "Branch", "Manager", "Capabilities", "Status", "Tool permission labels"], ...state.agents.map((agent) => [agent.name, agent.role, agent.branch, agent.managerId === "exec" ? executive.name : agentById(agent.managerId)?.name || executive.name, agent.capabilities.join("; "), agent.status, agent.tools.join("; ")])];
  const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = "agent-factory-demo-roster.csv"; anchor.click(); URL.revokeObjectURL(url);
  toast("Workspace roster exported as CSV");
}

const date = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date());
$(".eyebrow").innerHTML = `<span class="eyebrow-line"></span>${escapeHtml(date.toUpperCase())}`;
refreshWorkspace();
