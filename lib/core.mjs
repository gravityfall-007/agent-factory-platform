/**
 * Shared constants, errors, and workspace-state validation.
 *
 * The validator is deliberately strict about shape and size because every
 * request body, restored backup, and on-disk state file passes through it
 * before it can influence a model call or the UI.
 */

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_PROMPT_CHARS = 6000;
export const MAX_HISTORY = 100;
export const MAX_ACTIVITIES = 500;
export const MAX_APPROVALS = 500;
export const MAX_TASK_LOG = 200;
export const TASK_STATUSES = ["queued", "running", "waiting_approval", "done", "failed", "canceled"];
export const ASSIGNMENT_STATUSES = ["pending", "working", "awaiting_approval", "done", "failed", "skipped"];
export const MAX_CONCURRENT_RUNS = 2;
export const MAX_QUEUED_RUNS = 3;

export class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    if (code) this.code = code;
  }
}

export function boundedString(value, field, max, required = false) {
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(400, `${field} is required.`);
  if (trimmed.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
  return trimmed;
}

export function optionalString(value, field, max, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return boundedString(value, field, max);
}

export function stringArray(value, field, maxItems = 50, maxLength = 120) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new HttpError(400, `${field} must be a list with at most ${maxItems} entries.`);
  }
  return value.map((item, index) => boundedString(item, `${field}[${index}]`, maxLength));
}

export function recordArray(value, field, maxItems, transform) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new HttpError(400, `${field} must be a list with at most ${maxItems} entries.`);
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, `${field}[${index}] must be an object.`);
    }
    return transform(item, index);
  });
}

export function nonNegativeInteger(value, field, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 1e12) {
    throw new HttpError(400, `${field} must be a non-negative integer.`);
  }
  return number;
}

export function booleanValue(value, field, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new HttpError(400, `${field} must be true or false.`);
  return value;
}

export function isoDateString(value, field, fallback = null) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== null) return fallback;
    throw new HttpError(400, `${field} is required.`);
  }
  const text = boundedString(value, field, 40, true);
  if (Number.isNaN(Date.parse(text))) throw new HttpError(400, `${field} must be an ISO date.`);
  return text;
}

const status = (value, field) => {
  if (value !== "active" && value !== "idle") throw new HttpError(400, `${field} must be active or idle.`);
  return value;
};

function normalizeUsage(value, field) {
  if (value === undefined || value === null) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${field} must be an object.`);
  const inputTokens = nonNegativeInteger(value.inputTokens, `${field}.inputTokens`);
  const outputTokens = nonNegativeInteger(value.outputTokens, `${field}.outputTokens`);
  const totalTokens = nonNegativeInteger(value.totalTokens, `${field}.totalTokens`) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function normalizeLog(value, field) {
  if (value === undefined || value === null) return [];
  return recordArray(value, field, MAX_TASK_LOG, (entry, index) => ({
    at: isoDateString(entry.at, `${field}[${index}].at`, new Date(0).toISOString()),
    type: boundedString(entry.type || "note", `${field}[${index}].type`, 40, true),
    message: boundedString(entry.message || "", `${field}[${index}].message`, 600),
  }));
}

function normalizeMcpBlock(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an object.`);
  }
  if (value.arguments !== undefined && (!value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments))) {
    throw new HttpError(400, `${field}.arguments must be a JSON object.`);
  }
  const args = value.arguments || {};
  let serialized;
  try {
    serialized = JSON.stringify(args);
  } catch {
    throw new HttpError(400, `${field}.arguments must be valid JSON data.`);
  }
  if (serialized.length > 20_000) throw new HttpError(400, `${field}.arguments is too large.`);
  return {
    connectorId: boundedString(value.connectorId, `${field}.connectorId`, 100, true),
    connectorLabel: boundedString(value.connectorLabel, `${field}.connectorLabel`, 80, true),
    toolName: boundedString(value.toolName, `${field}.toolName`, 120, true),
    arguments: args,
    ...(value.runId ? { runId: boundedString(value.runId, `${field}.runId`, 100) } : {}),
  };
}

export function validateState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "Workspace state must be an object.");
  }
  const executive = input.executive;
  if (!executive || typeof executive !== "object" || Array.isArray(executive)) {
    throw new HttpError(400, "Workspace executive is required.");
  }

  const connectors = recordArray(input.connectors || [], "connectors", 100, (connector, index) => ({
    id: boundedString(connector.id, `connectors[${index}].id`, 100, true),
    label: boundedString(connector.label, `connectors[${index}].label`, 80, true),
    url: boundedString(connector.url, `connectors[${index}].url`, 2000, true),
    description: optionalString(connector.description, `connectors[${index}].description`, 500),
    allowedTools: [...new Set(stringArray(connector.allowedTools || [], `connectors[${index}].allowedTools`, 50, 120))],
    enabled: connector.enabled !== false,
  }));
  if (new Set(connectors.map((item) => item.id)).size !== connectors.length) {
    throw new HttpError(400, "Connector IDs must be unique.");
  }

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
      tools: [...new Set(stringArray(grant.tools || [], `agents[${index}].mcpGrants[${grantIndex}].tools`, 50, 120))],
    })),
  }));
  const uniqueAgentIds = new Set(agents.map((agent) => agent.id));
  if (uniqueAgentIds.size !== agents.length) throw new HttpError(400, "Employee IDs must be unique.");
  for (const agent of agents) {
    if (new Set(agent.mcpGrants.map((grant) => grant.connectorId)).size !== agent.mcpGrants.length) {
      throw new HttpError(400, `Employee ${agent.name} has duplicate connector grants.`);
    }
    for (const grant of agent.mcpGrants) {
      const connector = connectors.find((item) => item.id === grant.connectorId);
      if (!connector || grant.tools.some((tool) => !connector.allowedTools.includes(tool))) {
        throw new HttpError(400, `Employee ${agent.name} has a tool grant outside the connector's allowed tools.`);
      }
    }
  }

  const tools = recordArray(input.tools, "tools", 100, (tool, index) => ({
    name: boundedString(tool.name, `tools[${index}].name`, 80, true),
    category: boundedString(tool.category || "General", `tools[${index}].category`, 80, true),
    connected: Boolean(tool.connected),
    glyph: boundedString(tool.glyph || "•", `tools[${index}].glyph`, 8),
    style: boundedString(tool.style || "", `tools[${index}].style`, 32),
  }));

  const approvals = recordArray(input.approvals || [], "approvals", MAX_APPROVALS, (item, index) => {
    const entry = {
      id: boundedString(item.id, `approvals[${index}].id`, 100, true),
      agent: boundedString(item.agent, `approvals[${index}].agent`, 100, true),
      initials: optionalString(item.initials, `approvals[${index}].initials`, 8),
      action: boundedString(item.action, `approvals[${index}].action`, 300, true),
      detail: optionalString(item.detail, `approvals[${index}].detail`, 500),
      time: optionalString(item.time, `approvals[${index}].time`, 50),
      createdAt: isoDateString(item.createdAt, `approvals[${index}].createdAt`, new Date(0).toISOString()),
    };
    if (item.mcp) entry.mcp = normalizeMcpBlock(item.mcp, `approvals[${index}].mcp`);
    return entry;
  });
  if (new Set(approvals.map((item) => item.id)).size !== approvals.length) {
    throw new HttpError(400, "Approval IDs must be unique.");
  }

  const activities = recordArray(input.activities || [], "activities", MAX_ACTIVITIES, (item, index) => ({
    id: boundedString(item.id || `activity-${index}`, `activities[${index}].id`, 100, true),
    kind: boundedString(item.kind || "tool", `activities[${index}].kind`, 32),
    icon: boundedString(item.icon || "•", `activities[${index}].icon`, 8),
    agent: boundedString(item.agent || "Workspace", `activities[${index}].agent`, 100, true),
    action: boundedString(item.action || "updated", `activities[${index}].action`, 300, true),
    target: boundedString(item.target || "workspace", `activities[${index}].target`, 300, true),
    detail: optionalString(item.detail, `activities[${index}].detail`, 500),
    time: boundedString(item.time || "just now", `activities[${index}].time`, 50),
  }));

  const tasks = recordArray(input.tasks || [], "tasks", MAX_HISTORY, (task, index) => {
    const taskStatus = TASK_STATUSES.includes(task.status)
      ? task.status
      : (() => { throw new HttpError(400, `tasks[${index}].status is invalid.`); })();
    return {
      id: boundedString(task.id, `tasks[${index}].id`, 100, true),
      prompt: boundedString(task.prompt, `tasks[${index}].prompt`, MAX_PROMPT_CHARS, true),
      summary: optionalString(task.summary, `tasks[${index}].summary`, 20_000),
      status: taskStatus,
      createdAt: isoDateString(task.createdAt, `tasks[${index}].createdAt`),
      updatedAt: isoDateString(task.updatedAt, `tasks[${index}].updatedAt`, task.createdAt),
      completedAt: task.completedAt ? isoDateString(task.completedAt, `tasks[${index}].completedAt`) : null,
      error: optionalString(task.error, `tasks[${index}].error`, 1000),
      model: optionalString(task.model, `tasks[${index}].model`, 120),
      usage: normalizeUsage(task.usage, `tasks[${index}].usage`),
      log: normalizeLog(task.log, `tasks[${index}].log`),
      assignments: recordArray(task.assignments || [], `tasks[${index}].assignments`, 3, (assignment, assignmentIndex) => {
        const field = `tasks[${index}].assignments[${assignmentIndex}]`;
        const assignmentStatus = ASSIGNMENT_STATUSES.includes(assignment.status)
          ? assignment.status
          : assignment.result ? "done" : "pending";
        return {
          employeeId: boundedString(assignment.employeeId, `${field}.employeeId`, 100, true),
          employeeName: boundedString(assignment.employeeName, `${field}.employeeName`, 80, true),
          task: boundedString(assignment.task, `${field}.task`, 2000, true),
          status: assignmentStatus,
          result: optionalString(assignment.result, `${field}.result`, 20_000),
          error: optionalString(assignment.error, `${field}.error`, 1000),
          startedAt: assignment.startedAt ? isoDateString(assignment.startedAt, `${field}.startedAt`) : null,
          completedAt: assignment.completedAt ? isoDateString(assignment.completedAt, `${field}.completedAt`) : null,
          usage: normalizeUsage(assignment.usage, `${field}.usage`),
        };
      }),
    };
  });
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new HttpError(400, "Task IDs must be unique.");

  const usage = input.usage ? normalizeUsage(input.usage, "usage") : derivedUsage({ tasks });

  return {
    schemaVersion: 3,
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
    usage,
  };
}

/** Sum task usage so a workspace restored without totals still reports something useful. */
export function derivedUsage(state) {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const task of state.tasks || []) {
    usage.inputTokens += task.usage?.inputTokens || 0;
    usage.outputTokens += task.usage?.outputTokens || 0;
    usage.totalTokens += task.usage?.totalTokens || 0;
  }
  return usage;
}
