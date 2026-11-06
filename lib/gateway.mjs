/**
 * Model gateway client and the deterministic demo gateway.
 *
 * Live mode talks to an OpenAI Responses-compatible endpoint. Demo mode makes
 * no network calls at all, produces deterministic plans/results, and reports
 * simulated token usage so the product can be evaluated end to end.
 */
import { HttpError } from "./core.mjs";

const DEFAULT_BUDGET = 100_000;
const DEFAULT_TIMEOUT_MS = 90_000;

function positiveInteger(value, fallback, min = 1, max = 1_000_000_000) {
  const number = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function readGatewayConfig(env = process.env) {
  const budget = positiveInteger(env.AGENT_FACTORY_TOKEN_BUDGET, DEFAULT_BUDGET, 1000);
  const timeoutMs = positiveInteger(env.AGENT_FACTORY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 5000, 300_000);
  const demo = /^(1|true|yes|on)$/i.test((env.AGENT_FACTORY_DEMO || "").trim());
  const model = (env.AGENT_FACTORY_MODEL || "").trim();
  if (demo) {
    return {
      configured: true,
      mode: "demo",
      model: model || "demo-planner",
      format: "responses",
      budget,
      timeoutMs,
    };
  }
  const key = (env.OPENAI_API_KEY || "").trim();
  const base = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim();
  const resolvedModel = model || "gpt-4.1-mini";
  if (!key || !base) {
    return { configured: false, mode: "unconfigured", model: resolvedModel, format: "responses", budget, timeoutMs };
  }
  let url;
  try {
    url = new URL(base);
  } catch {
    return { configured: false, mode: "unconfigured", model: resolvedModel, format: "responses", budget, timeoutMs };
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) || url.username || url.password || url.search || url.hash) {
    return { configured: false, mode: "unconfigured", model: resolvedModel, format: "responses", budget, timeoutMs };
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/responses")) {
    url.pathname = pathname.endsWith("/v1") ? `${pathname}/responses` : `${pathname}/v1/responses`;
  }
  url.search = "";
  url.hash = "";
  return { configured: true, mode: "live", url, key, model: resolvedModel, format: "responses", budget, timeoutMs };
}

export function publicGatewayStatus(config) {
  return {
    configured: Boolean(config.configured),
    mode: config.mode,
    model: config.configured ? config.model : null,
    format: "responses",
    budget: config.budget,
  };
}

export function extractModelText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  const chunks = (payload?.output || [])
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text);
  return chunks.join("\n").trim();
}

export function extractUsage(payload) {
  const raw = payload?.usage;
  if (!raw || typeof raw !== "object") return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const inputTokens = Number(raw.input_tokens ?? raw.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(raw.output_tokens ?? raw.completion_tokens ?? 0) || 0;
  const totalTokens = Number(raw.total_tokens ?? inputTokens + outputTokens) || inputTokens + outputTokens;
  return {
    inputTokens: Math.max(0, Math.trunc(inputTokens)),
    outputTokens: Math.max(0, Math.trunc(outputTokens)),
    totalTokens: Math.max(0, Math.trunc(totalTokens)),
  };
}

export function mcpApprovalRequests(payload) {
  return (payload?.output || []).filter((item) => item?.type === "mcp_approval_request");
}

export function responseIdOf(payload) {
  if (typeof payload?.id !== "string" || !payload.id) {
    throw new HttpError(502, "The model gateway response could not be resumed safely.");
  }
  return payload.id;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function demoUsage(inputText, outputText) {
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

function overlapScore(employee, prompt) {
  const words = new Set(
    prompt
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3),
  );
  const haystack = `${employee.role} ${employee.branch} ${(employee.capabilities || []).join(" ")} ${(employee.availableTools || []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const word of words) if (haystack.includes(word)) score += 1;
  return score;
}

function demoAssignmentVerb(employee) {
  const role = `${employee.role || ""}`.toLowerCase();
  if (/research|analys|analy|data/.test(role)) return "Analyze";
  if (/market|content|brand|growth/.test(role)) return "Draft";
  if (/customer|support|success/.test(role)) return "Prepare a customer-ready recommendation for";
  if (/people|hr|talent/.test(role)) return "Prepare people-ops guidance for";
  if (/engineer|product/.test(role)) return "Outline an implementation approach for";
  return "Work on";
}

function parseRoster(input) {
  const text = String(input);
  const marker = text.indexOf("Available employees (JSON):");
  if (marker < 0) return [];
  const jsonText = text.slice(marker + "Available employees (JSON):".length).trim();
  try {
    const roster = JSON.parse(jsonText);
    return Array.isArray(roster) ? roster : [];
  } catch {
    return [];
  }
}

function demoPlan(input) {
  const roster = parseRoster(input);
  const promptMatch = String(input).match(/User task:\s*([\s\S]*?)\n\nAvailable employees/);
  const prompt = promptMatch ? promptMatch[1].trim() : String(input).slice(0, 400);
  if (!roster.length) return JSON.stringify({ summary: "No employees available.", assignments: [] });
  const ranked = [...roster].sort((a, b) => overlapScore(b, prompt) - overlapScore(a, prompt));
  const chosen = ranked.slice(0, Math.min(2, ranked.length));
  const assignments = chosen.map((employee) => ({
    employeeId: employee.id,
    task: `${demoAssignmentVerb(employee)} the following task: "${prompt.slice(0, 500)}". Return a concise, concrete result and list your assumptions.`,
  }));
  return JSON.stringify({
    summary: `Demo plan: delegate to ${assignments.length} ${assignments.length === 1 ? "employee" : "employees"} and synthesize the results.`,
    assignments,
  });
}

function demoEmployeeResult(input, employeeHint = "") {
  const text = String(input);
  const assignmentMatch = text.match(/Your assignment:\s*([\s\S]*)$/);
  const assignment = (assignmentMatch ? assignmentMatch[1] : text).trim().slice(0, 900);
  const lines = [
    `**Demo work result${employeeHint ? ` — ${employeeHint}` : ""}**`,
    `Assignment: ${assignment}`,
    "",
    "Assessment: A short, review-ready deliverable is the best next step. Confirm the audience and success measure, then turn the strongest open question into a decision the executive can make.",
    "1. Gather the relevant internal context and confirm the goal and audience.",
    "2. Produce a first-pass deliverable with explicit assumptions and open questions.",
    "3. Flag anything that would require an external system or a human decision.",
    "",
    "Assumptions: this is a simulated demo result; no live data was read and no external system was contacted.",
  ];
  return lines.join("\n");
}

function demoSynthesis(input) {
  const text = String(input);
  const marker = text.indexOf("Employee results (JSON):");
  let results = [];
  if (marker >= 0) {
    try {
      const parsed = JSON.parse(text.slice(marker + "Employee results (JSON):".length).trim());
      if (Array.isArray(parsed)) results = parsed;
    } catch {
      results = [];
    }
  }
  const lines = ["**Executive summary (demo mode)**", ""];
  if (!results.length) {
    lines.push("No employee results were returned, so no synthesis could be produced.");
    return lines.join("\n");
  }
  lines.push(`Work was delegated to ${results.length} ${results.length === 1 ? "employee" : "employees"}.`);
  for (const item of results) {
    const resultLines = String(item.result || "")
      .split("\n")
      .map((line) => line.trim());
    const firstLine =
      resultLines.find((line) => line.startsWith("Assessment:")) ||
      resultLines.find((line) => line && !line.startsWith("**") && !line.startsWith("Assignment:") && !line.startsWith("What I would do") && !line.startsWith("Assumptions"));
    const finding = firstLine ? firstLine.replace(/^Assessment:\s*/, "") : "";
    lines.push(`- **${item.employeeName}** — ${finding ? finding.slice(0, 200) : "returned no usable text."}`);
  }
  lines.push("", "Next step: review the assumptions above, then run a live task or approve any requested external tool call. This summary was generated in demo mode.");
  return lines.join("\n");
}

function createDemoGateway(config) {
  let sequence = 0;
  const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${++sequence}`;

  return async function callDemo({ instructions = "", input, tools }) {
    const inputText = typeof input === "string" ? input : JSON.stringify(input);
    const approvalDecision = Array.isArray(input) ? input.find((item) => item?.type === "mcp_approval_response") : null;

    let text;
    let extraOutput = [];
    if (approvalDecision) {
      text = approvalDecision?.approve
        ? "Simulated external tool call approved. Demo mode does not contact the remote MCP server; the returned result is illustrative only."
        : "The external tool call was rejected. The workflow resumes without contacting the remote MCP server.";
    } else if (/Delegate the user's task/.test(instructions)) {
      text = demoPlan(input);
    } else if (/Synthesize employee results/.test(instructions)) {
      text = demoSynthesis(input);
    } else if (/Digital employee|digital employee/i.test(instructions)) {
      const nameMatch = instructions.match(/You are ([^,]+),/);
      const employeeName = nameMatch ? nameMatch[1].trim() : "";
      const wantsTool = tools?.length && /\[mcp\]|use (the )?(mcp|external) tool|external tool/i.test(inputText);
      if (wantsTool) {
        const tool = tools[0];
        extraOutput = [{
          type: "mcp_approval_request",
          id: nextId("demo_approval"),
          name: tool.allowed_tools?.[0] || "demo_lookup",
          server_label: tool.server_label,
          arguments: { query: inputText.slice(0, 240), note: "Generated by the demo gateway. Arguments are illustrative." },
        }];
        text = "";
      } else {
        text = demoEmployeeResult(input, employeeName);
      }
    } else {
      text = "Demo gateway response: no structured task was recognized.";
    }

    const payload = {
      id: nextId("demo_response"),
      output_text: text,
      output: extraOutput.length
        ? extraOutput
        : [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: demoUsage(`${instructions}\n${inputText}`, text),
      demo: true,
    };
    return payload;
  };
}

export function createGateway(config, { fetchImpl = globalThis.fetch } = {}) {
  const demoCall = config.mode === "demo" ? createDemoGateway(config) : null;

  async function callLive({ instructions, input, maxOutputTokens = 1200, tools, previousResponseId, signal }) {
    const body = {
      model: config.model,
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
    };
    if (tools?.length) body.tools = tools;
    if (previousResponseId) body.previous_response_id = previousResponseId;
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs || DEFAULT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await fetchImpl(config.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: combined,
        redirect: "error",
      });
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError") throw error;
      if (error.name === "TimeoutError") throw new HttpError(504, "The model gateway timed out. Try a shorter task or increase AGENT_FACTORY_TIMEOUT_MS.");
      // Never log error.message: some fetch errors embed the configured endpoint.
      throw new HttpError(502, "The model gateway could not be reached. Check its URL and server network access.");
    }
    if (!response.ok) {
      if (response.status === 429) throw new HttpError(429, "The model gateway is rate limiting requests. Wait a moment and try again.");
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(502, `The model gateway rejected the credential (HTTP ${response.status}). Check OPENAI_API_KEY.`);
      }
      throw new HttpError(502, `The model gateway returned HTTP ${response.status}. Check the server key, model, and gateway logs.`);
    }
    try {
      return await response.json();
    } catch {
      throw new HttpError(502, "The model gateway returned an invalid response.");
    }
  }

  return {
    config,
    async call(request) {
      const payload = demoCall ? await demoCall(request) : await callLive(request);
      return {
        payload,
        text: extractModelText(payload),
        usage: extractUsage(payload),
        mcpRequests: mcpApprovalRequests(payload),
        responseId: typeof payload?.id === "string" ? payload.id : null,
      };
    },
  };
}
