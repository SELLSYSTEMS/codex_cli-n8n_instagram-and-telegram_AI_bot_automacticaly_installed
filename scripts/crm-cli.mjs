process.loadEnvFile?.('.env');

const { pool } = await import('./db.mjs');
const { ensureHubSpotSchema, getHubSpotAccount } = await import('./crm-hubspot.mjs');
const { crmStatus, drainCrmOutbox, enqueueCrmBackfill } = await import('./crm-projection.mjs');

const command = process.argv[2] || 'status';
const limit = Number(process.argv[3] || 250);

async function drainBudget(options = {}) {
  const budget = Math.max(1, Math.min(5000, limit));
  let remaining = budget;
  const totals = { processed: 0, completed: 0, failed: 0, budget };
  while (remaining > 0) {
    const batch = await drainCrmOutbox({
      limit: Math.min(25, remaining),
      includeBackfill: Boolean(options.includeBackfill),
    });
    totals.processed += batch.processed || 0;
    totals.completed += batch.completed || 0;
    totals.failed += batch.failed || 0;
    remaining -= batch.processed || 0;
    if (!batch.processed || batch.failed) break;
  }
  return totals;
}

async function main() {
  if (command === 'setup') {
    const account = await getHubSpotAccount();
    const schema = await ensureHubSpotSchema();
    console.log(JSON.stringify({ ok: true, account, schema }, null, 2));
    return;
  }

  if (command === 'verify') {
    const account = await getHubSpotAccount();
    const db = await pool.query(
      `select to_regclass('agent.crm_contact_links') as links,
              to_regclass('agent.crm_sync_outbox') as outbox`,
    );
    console.log(JSON.stringify({
      ok: Boolean(db.rows[0]?.links && db.rows[0]?.outbox),
      account,
      database: db.rows[0],
      status: await crmStatus(),
    }, null, 2));
    return;
  }

  if (command === 'backfill') {
    const queued = await enqueueCrmBackfill(limit);
    const drained = await drainBudget({ includeBackfill: true });
    console.log(JSON.stringify({ ok: true, queued, drained, status: await crmStatus() }, null, 2));
    return;
  }

  if (command === 'drain') {
    console.log(JSON.stringify({ ok: true, drained: await drainBudget(), status: await crmStatus() }, null, 2));
    return;
  }

  if (command === 'status') {
    console.log(JSON.stringify(await crmStatus(), null, 2));
    return;
  }

  throw new Error(`Unknown CRM command: ${command}`);
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
