import test from "node:test";
import assert from "node:assert/strict";
import { createGateway, extractModelText, extractUsage, mcpApprovalRequests, publicGatewayStatus, readGatewayConfig } from "../lib/gateway.mjs";
import { HttpError } from "../lib/core.mjs";

test("readGatewayConfig reports an unconfigured gateway without a key", () => {
  const config = readGatewayConfig({});
  assert.equal(config.configured, false);
  assert.equal(config.mode, "unconfigured");
  assert.equal(publicGatewayStatus(config).model, null);
});

test("readGatewayConfig normalizes Responses API URLs", () => {
  const base = { OPENAI_API_KEY: "k", AGENT_FACTORY_MODEL: "m" };
  const cases = [
    ["https://api.example.com", "https://api.example.com/v1/responses"],
    ["https://api.example.com/v1", "https://api.example.com/v1/responses"],
    ["https://api.example.com/v1/", "https://api.example.com/v1/responses"],
    ["https://api.example.com/v1/responses", "https://api.example.com/v1/responses"],
    ["https://api.example.com/openai/v1", "https://api.example.com/openai/v1/responses"],
  ];
  for (const [input, expected] of cases) {
    const config = readGatewayConfig({ ...base, OPENAI_BASE_URL: input });
    assert.equal(config.configured, true, input);
    assert.equal(config.url.toString(), expected, input);
  }
});

test("readGatewayConfig rejects insecure or credential-bearing gateways", () => {
  for (const url of ["http://api.example.com/v1", "https://user:pass@api.example.com/v1", "https://api.example.com/v1?x=1", "not a url"]) {
    const config = readGatewayConfig({ OPENAI_API_KEY: "k", OPENAI_BASE_URL: url });
    assert.equal(config.configured, false, url);
  }
  const local = readGatewayConfig({ OPENAI_API_KEY: "k", OPENAI_BASE_URL: "http://127.0.0.1:4000/v1" });
  assert.equal(local.configured, true);
});

test("demo mode is configured without a key and reports a simulated model", () => {
  const config = readGatewayConfig({ AGENT_FACTORY_DEMO: "1", AGENT_FACTORY_TOKEN_BUDGET: "2500" });
  assert.equal(config.configured, true);
  assert.equal(config.mode, "demo");
  assert.equal(config.budget, 2500);
  const status = publicGatewayStatus(config);
  assert.equal(status.mode, "demo");
  assert.equal(status.configured, true);
  assert.equal("key" in status, false);
});

test("extractModelText supports output_text and output content parts", () => {
  assert.equal(extractModelText({ output_text: "hello" }), "hello");
  assert.equal(extractModelText({ output: [{ content: [{ type: "output_text", text: "a" }, { type: "output_text", text: "b" }] }] }), "a\nb");
  assert.equal(extractModelText({}), "");
});

test("extractUsage normalizes Responses and chat-completions shapes", () => {
  assert.deepEqual(extractUsage({ usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } }), { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 5, completion_tokens: 6 } }), { inputTokens: 5, outputTokens: 6, totalTokens: 11 });
  assert.deepEqual(extractUsage({}), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
});

test("demo gateway produces a deterministic plan from the roster", async () => {
  const config = readGatewayConfig({ AGENT_FACTORY_DEMO: "1" });
  const gateway = createGateway(config);
  const roster = [
    { id: "maya", name: "Maya Chen", role: "Customer Success Lead", branch: "San Francisco", capabilities: ["renewal planning"] },
    { id: "theo", name: "Theo Park", role: "Revenue Analyst", branch: "San Francisco", capabilities: ["pipeline analysis"] },
  ];
  const result = await gateway.call({
    instructions: "You are Avery, the executive agent. Delegate the user's task to the smallest useful set of employees.",
    input: `User task:\nPrepare a renewal plan\n\nAvailable employees (JSON):\n${JSON.stringify(roster)}`,
  });
  const plan = JSON.parse(result.text);
  assert.equal(plan.assignments.length, 2);
  assert.equal(plan.assignments[0].employeeId, "maya");
  assert.ok(result.usage.totalTokens > 0);
  assert.equal(mcpApprovalRequests(result.payload).length, 0);
});

test("demo gateway requests approval only when an MCP tool is granted", async () => {
  const config = readGatewayConfig({ AGENT_FACTORY_DEMO: "1" });
  const gateway = createGateway(config);
  const tools = [{ type: "mcp", server_label: "conn_1", allowed_tools: ["search_projects"] }];
  const result = await gateway.call({
    instructions: "You are Maya Chen, a digital employee working as Customer Success Lead.",
    input: "Executive task: [mcp] inspect the account\n\nYour assignment: inspect the account",
    tools,
  });
  assert.equal(result.text, "");
  assert.equal(result.mcpRequests.length, 1);
  assert.equal(result.mcpRequests[0].server_label, "conn_1");
  assert.equal(result.mcpRequests[0].name, "search_projects");

  const resumed = await gateway.call({
    instructions: "Continue the employee task.",
    input: [{ type: "mcp_approval_response", approve: true, approval_request_id: result.mcpRequests[0].id }],
    tools,
    previousResponseId: result.responseId,
  });
  assert.match(resumed.text, /Simulated external tool call approved/);
  assert.match(resumed.text, /does not contact/);
});

test("live gateway sends the expected request and extracts usage", async () => {
  const config = readGatewayConfig({ OPENAI_API_KEY: "secret", OPENAI_BASE_URL: "https://api.example.com/v1", AGENT_FACTORY_MODEL: "model-x" });
  let captured;
  const gateway = createGateway(config, {
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ id: "resp_9", output_text: "hello", usage: { input_tokens: 1, output_tokens: 2 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const result = await gateway.call({ instructions: "sys", input: "user", maxOutputTokens: 42, tools: [{ type: "mcp", server_label: "x" }] });
  assert.equal(captured.url.toString(), "https://api.example.com/v1/responses");
  assert.equal(captured.init.headers.Authorization, "Bearer secret");
  assert.equal(captured.body.model, "model-x");
  assert.equal(captured.body.instructions, "sys");
  assert.equal(captured.body.max_output_tokens, 42);
  assert.equal(captured.body.tools.length, 1);
  assert.equal(result.text, "hello");
  assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  assert.equal(result.responseId, "resp_9");
});

test("live gateway maps auth failures without leaking the endpoint", async () => {
  const config = readGatewayConfig({ OPENAI_API_KEY: "secret", OPENAI_BASE_URL: "https://api.example.com/v1" });
  const gateway = createGateway(config, {
    fetchImpl: async () => new Response("nope", { status: 401 }),
  });
  await assert.rejects(
    () => gateway.call({ instructions: "s", input: "u" }),
    (error) => error instanceof HttpError && error.status === 502 && /credential/.test(error.message) && !error.message.includes("api.example.com"),
  );
});

test("live gateway propagates aborts and reports timeouts", async () => {
  const config = readGatewayConfig({ OPENAI_API_KEY: "secret", OPENAI_BASE_URL: "https://api.example.com/v1" });
  const abortGateway = createGateway(config, {
    fetchImpl: async (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
  });
  const controller = new AbortController();
  const pending = abortGateway.call({ instructions: "s", input: "u", signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");

  const timeoutGateway = createGateway(config, {
    fetchImpl: async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    },
  });
  await assert.rejects(() => timeoutGateway.call({ instructions: "s", input: "u" }), (error) => error instanceof HttpError && error.status === 504);
});
