import { startApplication } from "./lib/app.mjs";
import { publicGatewayStatus } from "./lib/gateway.mjs";

const port = Number.parseInt(process.env.PORT || "8000", 10);
const host = process.env.HOST || "127.0.0.1";

try {
  const app = await startApplication({ port, host });
  const status = publicGatewayStatus(app.config);
  console.log(`Agent Factory listening on http://${host}:${app.port}`);
  if (status.configured) {
    console.log(
      status.mode === "demo"
        ? `Demo model mode is on (${status.model}); runs are simulated and no external model is called.`
        : `Model gateway configured (Responses API, ${status.model}); local budget ${status.budget.toLocaleString("en-US")} tokens.`,
    );
  } else {
    console.log("Model gateway not configured. Set OPENAI_BASE_URL, OPENAI_API_KEY, and AGENT_FACTORY_MODEL, or use AGENT_FACTORY_DEMO=1.");
  }
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.warn("Warning: the server is not bound to loopback. It has no authentication; do not expose it to a network.");
  }

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`Received ${signal}; shutting down.`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} catch (error) {
  console.error(`Agent Factory failed to start (${error?.code || error?.name || "error"}).`);
  process.exitCode = 1;
}
