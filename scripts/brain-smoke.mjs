const base = process.env.BRAIN_API_URL || "http://127.0.0.1:8789";
const health = await fetch(`${base}/health`);
const healthBody = await health.json();
if (!health.ok || !healthBody.ok) throw new Error(`Brain health failed: ${JSON.stringify(healthBody)}`);
process.stdout.write(`health ok; enabled routes: ${healthBody.enabled_routes.map((route) => route.id).join(", ")}\n`);

if (process.argv.includes("--live")) {
  const eventId = `smoke-${Date.now()}`;
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
      channel: "internal",
      external_user_id: "smoke-user",
      external_thread_id: "smoke-thread",
      external_event_id: eventId,
      text: "Hello. Briefly explain how you can help."
    })
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`Live brain smoke failed: ${JSON.stringify(body)}`);
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}
