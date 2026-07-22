import assert from "node:assert/strict";
import process from "node:process";
import { trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

process.loadEnvFile?.(".env");

const baseUrl = (process.env.LANGFUSE_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
assert(publicKey && secretKey, "Langfuse project keys are missing");

const health = await fetch(`${baseUrl}/api/public/health`);
assert.equal(health.ok, true, `Langfuse health failed: HTTP ${health.status}`);

const processor = new LangfuseSpanProcessor({
  baseUrl,
  publicKey,
  secretKey,
  exportMode: "immediate",
  shouldExportSpan: () => true,
});
const sdk = new NodeSDK({ spanProcessors: [processor] });
sdk.start();
const tracer = trace.getTracer("brain-runtime-smoke");
const span = tracer.startSpan("deployment.langfuse.smoke", {
  attributes: {
    "langfuse.trace.name": "deployment.langfuse.smoke",
    "deployment.environment": "local",
    "test.synthetic": true,
  },
});
const traceId = span.spanContext().traceId;
span.end();
await sdk.shutdown();

const authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
let observed = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  const response = await fetch(`${baseUrl}/api/public/traces/${traceId}`, {
    headers: { authorization },
  });
  if (response.ok) {
    observed = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.equal(observed, true, `Langfuse did not expose trace ${traceId}`);
console.log(JSON.stringify({ ok: true, health: "up", traceObserved: true, traceId }, null, 2));
