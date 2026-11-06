import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.mjs";

export const baseSeed = (overrides = {}) => ({
  executive: {
    id: "exec",
    name: "Avery Morgan",
    role: "Executive agent · CEO",
    branch: "Executive",
    status: "active",
    tools: ["Slack"],
  },
  agents: [
    {
      id: "maya",
      name: "Maya Chen",
      role: "Customer Success Lead",
      branch: "San Francisco",
      managerId: "exec",
      capabilities: ["renewal planning", "account research"],
      status: "active",
      tools: ["Slack"],
      mcpGrants: [],
    },
    {
      id: "theo",
      name: "Theo Park",
      role: "Revenue Analyst",
      branch: "San Francisco",
      managerId: "exec",
      capabilities: ["pipeline analysis", "forecasting"],
      status: "active",
      tools: ["Slack"],
      mcpGrants: [],
    },
  ],
  tools: [
    { name: "Slack", category: "Communication", connected: true, glyph: "#", style: "chat" },
    { name: "Salesforce", category: "CRM", connected: true, glyph: "S", style: "crm" },
  ],
  connectors: [],
  approvals: [],
  activities: [],
  tasks: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ...overrides,
});

export async function makeTestStore(seed = baseSeed()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-factory-"));
  const seedFile = path.join(root, "seed.json");
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(seedFile, JSON.stringify(seed, null, 2));
  const store = createStore({ dataDir, seedFile });
  await store.init();
  return {
    root,
    seedFile,
    dataDir,
    store,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(fn, { timeout = 4000, interval = 20, label = "condition" } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export const usage = (input = 10, output = 20) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
});

export function planPayload(assignments) {
  return JSON.stringify({ summary: "Test plan", assignments });
}

export function response(text, { usage: usageValue = usage(), mcpRequests = [], responseId = "resp_1" } = {}) {
  return { text, usage: usageValue, mcpRequests, responseId, payload: {} };
}
