import { readFile } from "node:fs/promises";

const suite = JSON.parse(await readFile(new URL("../tests/scenarios/generic-conversation-cases.json", import.meta.url), "utf8"));
if (!Array.isArray(suite.scenarios) || suite.scenarios.length < 10) throw new Error("Scenario suite is incomplete");

if (!process.argv.includes("--live")) {
  process.stdout.write(`scenario definitions ok: ${suite.scenarios.length}\n`);
  process.exit(0);
}

const base = process.env.BRAIN_API_URL || "http://127.0.0.1:8789";
const runId = Date.now();
const reports = [];

for (const scenario of suite.scenarios) {
  const outputs = [];
  for (let index = 0; index < scenario.turns.length; index += 1) {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.BRAIN_API_TOKEN
          ? { Authorization: `Bearer ${process.env.BRAIN_API_TOKEN}` }
          : {})
      },
      body: JSON.stringify({
        tenant_slug: "default",
        channel: "internal-test",
        external_user_id: `${scenario.id}-${runId}`,
        external_thread_id: `${scenario.id}-${runId}`,
        external_event_id: `${scenario.id}-${runId}-${index}`,
        text: scenario.turns[index],
        metadata: { scenario_id: scenario.id }
      })
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(`${scenario.id}: ${body.error || response.status}`);
    outputs.push({
      action: body.action,
      should_reply: body.should_reply,
      message: body.message,
      model: body.model
    });
  }
  reports.push({ id: scenario.id, expectation: scenario.expect, outputs });
}

process.stdout.write(`${JSON.stringify({ run_id: runId, reports }, null, 2)}\n`);
