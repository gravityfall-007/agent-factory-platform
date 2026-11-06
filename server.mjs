import { createServer } from "node:http";
import { readFile, mkdir, rename, writeFile, chmod } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "workspace.json");
const SECRET_FILE = path.join(DATA_DIR, "connector-secrets.json");
const PENDING_FILE = path.join(DATA_DIR, "pending-approvals.json");
const SEED_FILE = path.join(ROOT, "seed-data.json");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 6000;
const MAX_HISTORY = 100;
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const copy = (value) => structuredClone(value);
let cachedState;
let stateLoaded = false;
let writeQueue = Promise.resolve();
let secretCache;
let pendingCache;

async function loadPrivate(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
async function writePrivate(file, value) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await chmod(DATA_DIR, 0o700).catch(() => {});
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600).catch(() => {});
  await rename(temp, file);
}
async function getSecrets() { if (!secretCache) secretCache = await loadPrivate(SECRET_FILE); return secretCache; }
async function saveSecrets(value) { await writePrivate(SECRET_FILE, value); secretCache = value; }
async function getPending() { if (!pendingCache) pendingCache = await loadPrivate(PENDING_FILE); return pendingCache; }
async function savePending(value) { await writePrivate(PENDING_FILE, value); pendingCache = value; }

function boundedString(value, field, max, required = false) {
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(400, `${field} is required.`);
  if (trimmed.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
  return trimmed;
}

function stringArray(value, field, maxItems = 50, maxLength = 120) {
  if (!Array.isArray(value) || value.length > maxItems) throw new HttpError(400, `${field} must be a list with at most ${maxItems} entries.`);
  return value.map((item, index) => boundedString(item, `${field}[${index}]`, maxLength));
}

function recordArray(value, field, maxItems, transform) {
  if (!Array.isArray(value) || value.length > maxItems) throw new HttpError(400, `${field} must be a list with at most ${maxItems} entries.`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HttpError(400, `${field}[${index}] must be an object.`);
    return transform(item, index);
  });
}

function validateState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Workspace state must be an object.");
  const executive = input.executive;
  if (!executive || typeof executive !== "object" || Array.isArray(executive)) throw new HttpError(400, "Workspace executive is required.");
  const status = (value, field) => {
    if (value !== "active" && value !== "idle") throw new HttpError(400, `${field} must be active or idle.`);
    return value;
  };
  const connectors = recordArray(input.connectors || [], "connectors", 100, (connector, index) => ({
    id: boundedString(connector.id, `connectors[${index}].id`, 100, true),
    label: boundedString(connector.label, `connectors[${index}].label`, 80, true),
    url: boundedString(connector.url, `connectors[${index}].url`, 2000, true),
    description: boundedString(connector.description || "", `connectors[${index}].description`, 500),
    allowedTools: stringArray(connector.allowedTools || [], `connectors[${index}].allowedTools`, 50, 120),
    enabled: connector.enabled !== false,
  }));
  if (new Set(connectors.map((item) => item.id)).size !== connectors.length) throw new HttpError(400, "Connector IDs must be unique.");
  const agents = recordArray(input.agents, "agents", 100, (agent, index) => ({
    id: boundedString(agent.id, `agents[${index}].id`, 100, true),
    name: boundedString(agent.name, `agents[${index}].name`, 80, true),
    role: boundedString(agent.role, `agents[${index}].role`, 120, true),
    branch: boundedString(agent.branch, `agents[${index}].branch`, 80, true),
    managerId: boundedString(agent.managerId || "exec", `agents[${index}].managerId`, 100, true),
    capabilities: stringArray(agent.capabilities || [], `agents[${index}].capabilities`, 30),
    status: status(agent.status, `agents[${index}].status`),
    tools: stringArray(agent.tools || [], `agents[${index}].tools`, 100),
    mcpGrants: recordArray(agent.mcpGrants || [], `agents[${index}].mcpGrants`, 100, (grant, grantIndex) => ({
      connectorId: boundedString(grant.connectorId, `agents[${index}].mcpGrants[${grantIndex}].connectorId`, 100, true),
      tools: stringArray(grant.tools || [], `agents[${index}].mcpGrants[${grantIndex}].tools`, 50, 120),
    })),
  }));
  const uniqueAgentIds = new Set(agents.map((agent) => agent.id));
  if (uniqueAgentIds.size !== agents.length) throw new HttpError(400, "Employee IDs must be unique.");
  for (const agent of agents) {
    if (new Set(agent.mcpGrants.map((grant) => grant.connectorId)).size !== agent.mcpGrants.length) throw new HttpError(400, `Employee ${agent.name} has duplicate connector grants.`);
    for (const grant of agent.mcpGrants) {
      const connector = connectors.find((item) => item.id === grant.connectorId);
      if (!connector || grant.tools.some((tool) => !connector.allowedTools.includes(tool))) throw new HttpError(400, `Employee ${agent.name} has a tool grant outside the connector's allowed tools.`);
    }
  }
  const tools = recordArray(input.tools, "tools", 100, (tool, index) => ({
    name: boundedString(tool.name, `tools[${index}].name`, 80, true),
    category: boundedString(tool.category || "General", `tools[${index}].category`, 80, true),
    connected: Boolean(tool.connected),
    glyph: boundedString(tool.glyph || "•", `tools[${index}].glyph`, 8),
    style: boundedString(tool.style || "", `tools[${index}].style`, 32),
  }));
  const approvals = recordArray(input.approvals, "approvals", 500, (item, index) => ({
    id: boundedString(item.id, `approvals[${index}].id`, 100, true),
    agent: boundedString(item.agent, `approvals[${index}].agent`, 80, true),
    initials: boundedString(item.initials || "", `approvals[${index}].initials`, 8),
    action: boundedString(item.action, `approvals[${index}].action`, 300, true),
    detail: boundedString(item.detail || "", `approvals[${index}].detail`, 500),
    time: boundedString(item.time || "", `approvals[${index}].time`, 50),
    ...(item.mcp ? { mcp: {
      connectorId: boundedString(item.mcp.connectorId, `approvals[${index}].mcp.connectorId`, 100, true),
      connectorLabel: boundedString(item.mcp.connectorLabel, `approvals[${index}].mcp.connectorLabel`, 80, true),
      toolName: boundedString(item.mcp.toolName, `approvals[${index}].mcp.toolName`, 120, true),
      arguments: item.mcp.arguments && typeof item.mcp.arguments === "object" ? item.mcp.arguments : {},
    } } : {}),
  }));
  const activities = recordArray(input.activities, "activities", 500, (item, index) => ({
    id: boundedString(item.id || randomUUID(), `activities[${index}].id`, 100, true),
    kind: boundedString(item.kind || "tool", `activities[${index}].kind`, 32),
    icon: boundedString(item.icon || "•", `activities[${index}].icon`, 8),
    agent: boundedString(item.agent || "Workspace", `activities[${index}].agent`, 100, true),
    action: boundedString(item.action || "updated", `activities[${index}].action`, 300, true),
    target: boundedString(item.target || "workspace", `activities[${index}].target`, 300, true),
    detail: boundedString(item.detail || "", `activities[${index}].detail`, 500),
    time: boundedString(item.time || "just now", `activities[${index}].time`, 50),
  }));
  const tasks = recordArray(input.tasks || [], "tasks", MAX_HISTORY, (task, index) => ({
    id: boundedString(task.id, `tasks[${index}].id`, 100, true),
    prompt: boundedString(task.prompt, `tasks[${index}].prompt`, MAX_PROMPT_CHARS, true),
    summary: boundedString(task.summary || "", `tasks[${index}].summary`, 12_000),
    status: ["done", "failed", "waiting_approval"].includes(task.status) ? task.status : (() => { throw new HttpError(400, `tasks[${index}].status is invalid.`); })(),
    createdAt: boundedString(task.createdAt, `tasks[${index}].createdAt`, 50, true),
    assignments: recordArray(task.assignments || [], `tasks[${index}].assignments`, 3, (assignment, assignmentIndex) => ({
      employeeId: boundedString(assignment.employeeId, `tasks[${index}].assignments[${assignmentIndex}].employeeId`, 100, true),
      employeeName: boundedString(assignment.employeeName, `tasks[${index}].assignments[${assignmentIndex}].employeeName`, 80, true),
      task: boundedString(assignment.task, `tasks[${index}].assignments[${assignmentIndex}].task`, 2000, true),
      result: boundedString(assignment.result || "", `tasks[${index}].assignments[${assignmentIndex}].result`, 12_000),
    })),
  }));
  return {
    executive: {
      id: boundedString(executive.id, "executive.id", 100, true),
      name: boundedString(executive.name, "executive.name", 80, true),
      role: boundedString(executive.role, "executive.role", 120, true),
      branch: boundedString(executive.branch || "Executive", "executive.branch", 80, true),
      status: status(executive.status, "executive.status"),
      tools: stringArray(executive.tools || [], "executive.tools", 100),
      mcpGrants: [],
    },
    agents,
    tools,
    approvals,
    activities,
    tasks,
    connectors,
  };
}

async function loadStateDirect() {
  if (stateLoaded) return;
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    cachedState = validateState(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    cachedState = validateState(JSON.parse(await readFile(SEED_FILE, "utf8")));
    await writeStateDirect(cachedState);
  }
  stateLoaded = true;
}

async function writeStateDirect(next) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const temp = `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, STATE_FILE);
}

function enqueueStateWrite(operation) {
  const pending = writeQueue.then(operation);
  writeQueue = pending.catch(() => {});
  return pending;
}

async function getWorkspaceState() {
  await writeQueue;
  await loadStateDirect();
  return copy(cachedState);
}

function replaceWorkspaceState(input) {
  const safe = validateState(input);
  return enqueueStateWrite(async () => {
    await loadStateDirect();
    await writeStateDirect(safe);
    cachedState = safe;
    return copy(cachedState);
  });
}

function updateWorkspaceState(mutator) {
  return enqueueStateWrite(async () => {
    await loadStateDirect();
    const next = copy(cachedState);
    await mutator(next);
    const safe = validateState(next);
    await writeStateDirect(safe);
    cachedState = safe;
    return copy(cachedState);
  });
}

function gatewayConfig() {
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim();
  const key = (process.env.OPENAI_API_KEY || "").trim();
  const model = (process.env.AGENT_FACTORY_MODEL || "gpt-6-luna").trim();
  if (!key || !model || !base) return null;
  let url;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) || url.username || url.password || url.search || url.hash) return null;
  const suffix = "/responses";
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith(suffix)) {
    url.pathname = pathname.endsWith("/v1") ? `${pathname}${suffix}` : `${pathname}/v1${suffix}`;
  }
  url.search = "";
  url.hash = "";
  return { url, key, model };
}

function publicGatewayStatus() {
  const config = gatewayConfig();
  return {
    configured: Boolean(config),
    model: (process.env.AGENT_FACTORY_MODEL || "gpt-6-luna").trim() || null,
    format: "responses",
  };
}

function extractModelText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  const chunks = (payload?.output || []).flatMap((item) => item?.content || []).filter((part) => part?.type === "output_text" && typeof part.text === "string").map((part) => part.text);
  return chunks.join("\n").trim();
}

async function callResponses(instructions, input, maxOutputTokens = 1200, tools = undefined, previousResponseId = undefined) {
  const config = gatewayConfig();
  if (!config) throw new HttpError(503, "Model gateway is not configured. Set OPENAI_BASE_URL, OPENAI_API_KEY, and AGENT_FACTORY_MODEL on the server, then restart it.");
  const body = { model: config.model, instructions, input, max_output_tokens: maxOutputTokens };
  if (tools?.length) body.tools = tools;
  if (previousResponseId) body.previous_response_id = previousResponseId;
  let response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
      redirect: "error",
    });
  } catch (error) {
    // Do not log error.message: some fetch errors include the configured endpoint.
    console.error(`Model gateway request failed (${error.name || "network error"}).`);
    throw new HttpError(502, "The model gateway could not be reached. Check its URL and server network access.");
  }
  if (!response.ok) {
    console.error(`Model gateway returned HTTP ${response.status}.`);
    throw new HttpError(502, `The model gateway returned HTTP ${response.status}. Check the server key, model, and gateway logs.`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(502, "The model gateway returned an invalid response.");
  }
  return payload;
}

async function callModel(instructions, input, maxOutputTokens = 1200) {
  const payload = await callResponses(instructions, input, maxOutputTokens);
  const text = extractModelText(payload);
  if (!text) throw new HttpError(502, "The model gateway response contained no text.");
  return text;
}

function mcpRequests(payload) { return (payload?.output || []).filter((item) => item?.type === "mcp_approval_request"); }
function responseId(payload) {
  if (typeof payload?.id !== "string") throw new HttpError(502, "The model gateway response could not be resumed safely.");
  return payload.id;
}
function publicConnector(connector, secrets) {
  return { ...connector, hasBearerToken: Boolean(secrets[connector.id]) };
}
async function mcpToolsFor(agent, state, secrets) {
  const entries = await Promise.all(agent.mcpGrants.map(async (grant) => {
    const connector = state.connectors.find((item) => item.id === grant.connectorId && item.enabled);
    const allowed = connector && grant.tools.filter((name) => connector.allowedTools.includes(name));
    if (!connector || !allowed.length) return null;
    await validateConnectorUrl(connector.url);
    return { type: "mcp", server_label: connector.id, server_description: connector.description || connector.label, server_url: connector.url, require_approval: "always", allowed_tools: allowed, ...(secrets[connector.id] ? { authorization: secrets[connector.id] } : {}) };
  }));
  return entries.filter(Boolean);
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const p = address.split(".").map(Number), a = p[0], b = p[1];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 2, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return value.startsWith("2") || value.startsWith("3") || value.startsWith("2001:") && !value.startsWith("2001:db8:");
  }
  return false;
}
async function validateConnectorUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new HttpError(400, "Connector URL must be a valid HTTPS URL."); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new HttpError(400, "Connector URL must use HTTPS and omit credentials, query strings, and fragments.");
  const literal = isIP(host);
  const addresses = literal ? [{ address: host }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new HttpError(400, "Connector URL must resolve only to public IP addresses.");
  return url.toString();
}

function toolConnector(requestItem, agent, state) {
  const connector = state.connectors.find((item) => item.id === requestItem.server_label && item.enabled);
  const grant = agent.mcpGrants.find((item) => item.connectorId === connector?.id);
  const toolName = typeof requestItem.name === "string" ? requestItem.name : "unknown tool";
  if (!connector || !grant || !grant.tools.includes(toolName) || !connector.allowedTools.includes(toolName)) throw new HttpError(502, "The model requested an MCP tool outside this employee's permissions.");
  return { connector, toolName };
}

function parsePlan(text, eligibleAgents) {
  const normalized = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let plan;
  try {
    plan = JSON.parse(normalized);
  } catch {
    throw new HttpError(502, "The executive agent returned an invalid delegation plan. Try a more specific task.");
  }
  if (!Array.isArray(plan?.assignments)) throw new HttpError(502, "The executive agent returned an invalid delegation plan. Try again.");
  const eligible = new Map(eligibleAgents.map((agent) => [agent.id, agent]));
  const assignments = [];
  const seen = new Set();
  for (const candidate of plan.assignments) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.employeeId !== "string" || typeof candidate.task !== "string") continue;
    const employee = eligible.get(candidate.employeeId);
    const task = candidate.task.trim();
    if (!employee || seen.has(employee.id) || !task) continue;
    seen.add(employee.id);
    assignments.push({ employeeId: employee.id, employeeName: employee.name, task: task.slice(0, 2000), result: "" });
    if (assignments.length === 3) break;
  }
  if (!assignments.length) throw new HttpError(502, "The executive agent did not assign work to an available employee. Try a more specific task.");
  return { summary: typeof plan.summary === "string" ? plan.summary.trim().slice(0, 1000) : "", assignments };
}

function activity(agent, action, target, detail, kind = "complete", icon = "✦") {
  return { id: randomUUID(), kind, icon, agent, action, target, detail, time: "just now" };
}

async function executeWorkflow(prompt) {
  if (!gatewayConfig()) throw new HttpError(503, "Model gateway is not configured. Set OPENAI_BASE_URL, OPENAI_API_KEY, and AGENT_FACTORY_MODEL on the server, then restart it.");
  const initialState = await getWorkspaceState();
  const activeAgents = initialState.agents.filter((agent) => agent.status === "active");
  if (!activeAgents.length) throw new HttpError(422, "Add or activate at least one employee agent before assigning work.");

  const task = { id: randomUUID(), prompt, summary: "", status: "failed", createdAt: new Date().toISOString(), assignments: [] };
  try {
    const roster = activeAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      branch: agent.branch,
      managerId: agent.managerId,
      capabilities: agent.capabilities,
      availableTools: agent.tools.filter((name) => initialState.tools.some((tool) => tool.name === name && tool.connected)),
    }));
    const planText = await callModel(
      `You are ${initialState.executive.name}, the executive agent. Delegate the user's task to the smallest useful set of employees, at most three. Return only a JSON object with this shape: {"summary":"brief plan","assignments":[{"employeeId":"exact roster id","task":"bounded instruction"}]}. Use only employee IDs in the roster. Never invent that a tool or external system was accessed; this product's connectors are metadata only.`,
      `User task:\n${prompt}\n\nAvailable employees (JSON):\n${JSON.stringify(roster)}`,
      900,
    );
    const plan = parsePlan(planText, activeAgents);
    task.assignments = plan.assignments;
    const secrets = await getSecrets();
    for (let index = 0; index < plan.assignments.length; index += 1) {
      const assignment = plan.assignments[index];
      const employee = activeAgents.find((candidate) => candidate.id === assignment.employeeId);
      const toolNames = employee.tools.filter((name) => initialState.tools.some((tool) => tool.name === name && tool.connected));
      const payload = await callResponses(
        `You are ${employee.name}, a digital employee working as ${employee.role} in ${employee.branch}. Capabilities: ${employee.capabilities.join(", ") || "not specified"}. Available internal tools: ${toolNames.join(", ") || "none"}. Use only the external MCP tools explicitly provided and follow their results accurately. Provide a concrete work result and state assumptions.`,
        `Executive task: ${prompt}\n\nYour assignment: ${assignment.task}`,
        1200,
        await mcpToolsFor(employee, initialState, secrets),
      );
      const requests = mcpRequests(payload);
      if (requests.length) {
        const { connector, toolName } = toolConnector(requests[0], employee, initialState);
        const approvalId = randomUUID();
        const pending = await getPending();
        pending[approvalId] = { taskId: task.id, prompt, assignmentIndex: index, employeeId: employee.id, connectorId: connector.id, responseId: responseId(payload), approvalRequestId: requests[0].id, remaining: plan.assignments.slice(index + 1) };
        await savePending(pending);
        task.status = "waiting_approval";
        task.assignments[index] = assignment;
        task.summary = "Waiting for human approval to use an external tool.";
        await updateWorkspaceState((state) => {
          state.tasks.unshift(task); state.tasks = state.tasks.slice(0, MAX_HISTORY);
          state.approvals.unshift({ id: approvalId, agent: employee.name, initials: employee.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2), action: `${toolName} on ${connector.label}`, detail: "Review the arguments before approving this external tool call.", time: "just now", mcp: { connectorId: connector.id, connectorLabel: connector.label, toolName, arguments: requests[0].arguments || {} } });
        });
        return { task, pendingApproval: { id: approvalId, taskId: task.id, employeeName: employee.name, connectorId: connector.id, connectorLabel: connector.label, toolName, arguments: requests[0].arguments || {} } };
      }
      task.assignments[index] = { ...assignment, result: extractModelText(payload) || "" };
    }
    task.summary = await synthesizeTask(task, initialState);
    task.status = "done";
    await updateWorkspaceState((state) => {
      state.tasks.unshift(task);
      state.tasks = state.tasks.slice(0, MAX_HISTORY);
      state.activities.unshift(activity(initialState.executive.name, "completed an employee task workflow for", prompt.slice(0, 180), `${task.assignments.length} employee agents · model-backed`, "complete", "✦"));
      state.activities = state.activities.slice(0, 500);
    });
    return task;
  } catch (error) {
    const safeMessage = error instanceof HttpError ? error.message : "A model agent could not complete the workflow. Check the gateway settings and try again.";
    task.summary = safeMessage;
    task.status = "failed";
    await updateWorkspaceState((state) => {
      state.tasks.unshift(task);
      state.tasks = state.tasks.slice(0, MAX_HISTORY);
      state.activities.unshift(activity(initialState.executive.name, "could not complete the workflow for", prompt.slice(0, 180), safeMessage, "reject", "!"));
      state.activities = state.activities.slice(0, 500);
    });
    throw error;
  }
}

async function synthesizeTask(task, state) {
  return callModel(`You are ${state.executive.name}, the executive agent. Synthesize employee results into a concise response. Distinguish completed work from external actions and surface assumptions.`, `Original task:\n${task.prompt}\n\nEmployee results (JSON):\n${JSON.stringify(task.assignments.map(({ employeeName, task: assignedTask, result }) => ({ employeeName, task: assignedTask, result })))}`, 1400);
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function serveStatic(pathname, response) {
  const item = STATIC_FILES.get(pathname);
  if (!item) throw new HttpError(404, "Not found.");
  const [filename, contentType] = item;
  const content = await readFile(path.join(ROOT, filename));
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": content.byteLength,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  response.end(content);
}

async function route(request, response) {
  const url = new URL(request.url, "http://localhost");
  const { pathname } = url;
  if (pathname === "/api/status" && request.method === "GET") return json(response, 200, publicGatewayStatus());
  if (pathname === "/api/state" && request.method === "GET") {
    const state = await getWorkspaceState(), secrets = await getSecrets();
    state.connectors = state.connectors.map((item) => publicConnector(item, secrets));
    return json(response, 200, state);
  }
  if (pathname === "/api/state" && request.method === "PUT") {
    const input = await readJsonBody(request);
    const current = await getWorkspaceState();
    const submittedConnectors = (input.connectors || []).map(({ hasBearerToken, ...item }) => item);
    if (JSON.stringify(submittedConnectors) !== JSON.stringify(current.connectors)) throw new HttpError(400, "Manage connector metadata through the connector routes.");
    const protectedApprovals = (items) => (items || []).filter((item) => item.mcp).map((item) => ({ id: item.id, mcp: item.mcp }));
    if (JSON.stringify(protectedApprovals(input.approvals)) !== JSON.stringify(protectedApprovals(current.approvals))) throw new HttpError(400, "Pending MCP approvals can only be resolved through the approval route.");
    const saved = await replaceWorkspaceState(input);
    return json(response, 200, saved);
  }
  if (pathname === "/api/connectors" && request.method === "POST") {
    const body = await readJsonBody(request);
    const label = boundedString(body?.label, "label", 80, true), endpoint = await validateConnectorUrl(boundedString(body?.url, "url", 2000, true));
    const description = boundedString(body?.description || "", "description", 500);
    const allowedTools = [...new Set(stringArray(body?.allowedTools || [], "allowedTools", 50, 120))];
    const bearerToken = boundedString(body?.bearerToken || "", "bearerToken", 4096);
    const connector = { id: `conn_${randomUUID().replaceAll("-", "")}`, label, url: endpoint, description, allowedTools, enabled: true };
    await updateWorkspaceState((state) => state.connectors.push(connector));
    if (bearerToken) { const secrets = await getSecrets(); secrets[connector.id] = bearerToken; await saveSecrets(secrets); }
    return json(response, 201, { connector: publicConnector(connector, await getSecrets()) });
  }
  const connectorMatch = pathname.match(/^\/api\/connectors\/([^/]+)$/);
  if (connectorMatch && request.method === "PUT") {
    const id = decodeURIComponent(connectorMatch[1]), body = await readJsonBody(request), current = await getWorkspaceState();
    const found = current.connectors.find((item) => item.id === id); if (!found) throw new HttpError(404, "Connector not found.");
    const connector = { id, label: boundedString(body?.label, "label", 80, true), url: await validateConnectorUrl(boundedString(body?.url, "url", 2000, true)), description: boundedString(body?.description || "", "description", 500), allowedTools: [...new Set(stringArray(body?.allowedTools || [], "allowedTools", 50, 120))], enabled: body?.enabled !== false };
    const pending = await getPending(); if (Object.values(pending).some((item) => item.connectorId === id)) throw new HttpError(409, "Resolve pending approvals before changing this connector.");
    await updateWorkspaceState((state) => { state.connectors = state.connectors.map((item) => item.id === id ? connector : item); for (const agent of state.agents) agent.mcpGrants = agent.mcpGrants.map((grant) => grant.connectorId === id ? { ...grant, tools: grant.tools.filter((tool) => connector.allowedTools.includes(tool)) } : grant); });
    const secrets = await getSecrets();
    if (body.clearBearerToken === true) delete secrets[id];
    else if (typeof body.bearerToken === "string" && body.bearerToken.trim()) secrets[id] = boundedString(body.bearerToken, "bearerToken", 4096, true);
    await saveSecrets(secrets);
    return json(response, 200, { connector: publicConnector(connector, secrets) });
  }
  if (connectorMatch && request.method === "DELETE") {
    const id = decodeURIComponent(connectorMatch[1]), pending = await getPending();
    if (Object.values(pending).some((item) => item.connectorId === id)) throw new HttpError(409, "Resolve pending approvals before removing this connector.");
    await updateWorkspaceState((state) => { state.connectors = state.connectors.filter((item) => item.id !== id); for (const agent of state.agents) agent.mcpGrants = agent.mcpGrants.filter((grant) => grant.connectorId !== id); });
    const secrets = await getSecrets(); delete secrets[id]; await saveSecrets(secrets);
    return json(response, 200, { ok: true });
  }
  const approvalMatch = pathname.match(/^\/api\/mcp\/approvals\/([^/]+)$/);
  if (approvalMatch && request.method === "POST") {
    const id = decodeURIComponent(approvalMatch[1]), body = await readJsonBody(request);
    if (!body || !["approved", "rejected"].includes(body.decision)) throw new HttpError(400, "decision must be approved or rejected.");
    const pending = await getPending(), record = pending[id]; if (!record) throw new HttpError(404, "Pending approval not found.");
    const state = await getWorkspaceState(), task = state.tasks.find((item) => item.id === record.taskId), employee = state.agents.find((item) => item.id === record.employeeId);
    if (!task || !employee) throw new HttpError(409, "The workflow or employee is no longer available.");
    const secrets = await getSecrets(), toolDefinitions = await mcpToolsFor(employee, state, secrets);
    if (!toolDefinitions.length) throw new HttpError(409, "The employee no longer has an enabled MCP tool grant.");
    const connectorId = state.approvals.find((item) => item.id === id)?.mcp?.connectorId;
    const connector = state.connectors.find((item) => item.id === connectorId && item.enabled);
    if (!connector || record.connectorId !== connector.id || !employee.mcpGrants.some((grant) => grant.connectorId === connector.id)) throw new HttpError(409, "The connector grant changed while approval was pending.");
    const payload = await callResponses(`Continue the employee task for ${employee.name}. Use only the granted MCP tools and report results accurately.`, [{ type: "mcp_approval_response", approve: body.decision === "approved", approval_request_id: record.approvalRequestId }], 1200, toolDefinitions, record.responseId);
    delete pending[id]; await savePending(pending);
    await updateWorkspaceState((workspace) => { workspace.approvals = workspace.approvals.filter((item) => item.id !== id); });
    const requestItem = mcpRequests(payload)[0];
    if (requestItem) {
      const picked = toolConnector(requestItem, employee, state), nextId = randomUUID();
      pending[nextId] = { ...record, responseId: responseId(payload), approvalRequestId: requestItem.id, connectorId: picked.connector.id }; await savePending(pending);
      const publicApproval = { id: nextId, taskId: task.id, employeeName: employee.name, connectorId: picked.connector.id, connectorLabel: picked.connector.label, toolName: picked.toolName, arguments: requestItem.arguments || {} };
      task.status = "waiting_approval";
      await updateWorkspaceState((workspace) => { workspace.approvals.unshift({ id: nextId, agent: employee.name, initials: employee.name.slice(0, 2), action: `${picked.toolName} on ${picked.connector.label}`, detail: "Review the arguments before approving this external tool call.", time: "just now", mcp: { connectorId: picked.connector.id, connectorLabel: picked.connector.label, toolName: picked.toolName, arguments: requestItem.arguments || {} } }); workspace.tasks = workspace.tasks.map((item) => item.id === task.id ? task : item); });
      return json(response, 200, { task, pendingApproval: publicApproval });
    }
    task.assignments[record.assignmentIndex].result = extractModelText(payload) || "The external action was declined.";
    for (const assignment of record.remaining || []) {
      const nextEmployee = state.agents.find((item) => item.id === assignment.employeeId);
      if (!nextEmployee) continue;
      const nextPayload = await callResponses(`You are ${nextEmployee.name}, a digital employee. Complete the assigned work; use only explicitly provided MCP tools and report accurately.`, `Executive task: ${task.prompt}\n\nYour assignment: ${assignment.task}`, 1200, await mcpToolsFor(nextEmployee, state, secrets));
      const nextRequest = mcpRequests(nextPayload)[0];
      if (nextRequest) {
        const picked = toolConnector(nextRequest, nextEmployee, state), nextId = randomUUID();
        pending[nextId] = { taskId: task.id, prompt: task.prompt, assignmentIndex: task.assignments.findIndex((item) => item.employeeId === assignment.employeeId), employeeId: nextEmployee.id, connectorId: picked.connector.id, responseId: responseId(nextPayload), approvalRequestId: nextRequest.id, remaining: (record.remaining || []).slice((record.remaining || []).indexOf(assignment) + 1) };
        await savePending(pending);
        const publicApproval = { id: nextId, taskId: task.id, employeeName: nextEmployee.name, connectorId: picked.connector.id, connectorLabel: picked.connector.label, toolName: picked.toolName, arguments: nextRequest.arguments || {} };
        task.status = "waiting_approval";
        await updateWorkspaceState((workspace) => { workspace.approvals.unshift({ id: nextId, agent: nextEmployee.name, initials: nextEmployee.name.slice(0, 2), action: `${picked.toolName} on ${picked.connector.label}`, detail: "Review the arguments before approving this external tool call.", time: "just now", mcp: { connectorId: picked.connector.id, connectorLabel: picked.connector.label, toolName: picked.toolName, arguments: nextRequest.arguments || {} } }); workspace.tasks = workspace.tasks.map((item) => item.id === task.id ? task : item); });
        return json(response, 200, { task, pendingApproval: publicApproval });
      }
      const assignmentIndex = task.assignments.findIndex((item) => item.employeeId === assignment.employeeId);
      if (assignmentIndex >= 0) task.assignments[assignmentIndex].result = extractModelText(nextPayload) || "";
    }
    task.status = "done";
    task.summary = await synthesizeTask(task, state);
    await updateWorkspaceState((workspace) => { workspace.tasks = workspace.tasks.map((item) => item.id === task.id ? task : item); workspace.activities.unshift(activity(employee.name, "resolved an MCP approval workflow for", task.prompt.slice(0, 180), body.decision === "approved" ? "Tool call approved and workflow resumed" : "Tool call rejected and workflow resumed", body.decision === "approved" ? "complete" : "approval", body.decision === "approved" ? "✦" : "◷")); });
    return json(response, 200, { task });
  }
  if (pathname === "/api/workflows" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Request body must be an object.");
    const prompt = boundedString(body.prompt, "prompt", MAX_PROMPT_CHARS, true);
    if (!gatewayConfig()) throw new HttpError(503, "Model gateway is not configured. Set OPENAI_BASE_URL, OPENAI_API_KEY, and AGENT_FACTORY_MODEL on the server, then restart it.");
    const result = await executeWorkflow(prompt);
    return json(response, 200, result);
  }
  if (pathname.startsWith("/api/")) throw new HttpError(404, "API route not found.");
  if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
  return serveStatic(pathname, response);
}

const port = Number.parseInt(process.env.PORT || "8000", 10);
const host = process.env.HOST || "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (!(error instanceof HttpError)) console.error(`Request failed (${error.name || "server error"}).`);
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "The server could not complete that request.";
    json(response, status, { error: message });
  });
});

server.listen(port, host, () => {
  console.log(`Agent Factory listening on http://${host}:${port}`);
  const gateway = publicGatewayStatus();
  console.log(gateway.configured ? `Model gateway configured (Responses API, ${gateway.model}).` : "Model gateway not configured; task execution is unavailable.");
});

server.on("error", (error) => {
  console.error(`Server failed to start (${error.code || error.name}).`);
  process.exitCode = 1;
});
