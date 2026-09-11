import { createHash } from 'node:crypto';
import { pool } from './db.mjs';
import { projectToHubSpot } from './crm-hubspot.mjs';
import { isSyntheticCrmContext } from './crm-test-classifier.mjs';

try {
  process.loadEnvFile?.('.env');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const provider = () => String(process.env.CRM_PROVIDER || 'none').trim().toLowerCase();
const enabled = () => String(process.env.CRM_SYNC_ENABLED || 'false').toLowerCase() === 'true' && provider() !== 'none';
const clean = (value, fallback = '') => String(value ?? fallback).trim();

function eventKey(parts) {
  return createHash('sha256').update(parts.map((part) => clean(part)).join('|')).digest('hex');
}

function publicError(error) {
  return clean(error?.message || error || 'Unknown CRM sync error').slice(0, 1500);
}

async function locateTurn(input, result) {
  const tenantKey = clean(input.tenantKey || input.tenant_key || input.tenant, 'default');
  const channel = clean(input.channel, 'internal');
  const externalUserId = clean(
    input.externalUserId || input.external_user_id || input.sender_id || input.user_id,
    'unknown',
  );
  const externalThreadId = clean(
    input.externalThreadId || input.external_thread_id || input.thread_id || input.chat_id,
    externalUserId,
  );
  const query = await pool.query(
    `select t.id as tenant_id,
            i.contact_id,
            cv.id as conversation_id,
            t.tenant_key
       from agent.tenants t
       join agent.identities i
         on i.tenant_id = t.id
        and i.channel = $2
        and i.external_user_id = $3
       left join lateral (
         select c.id
           from agent.conversations c
          where c.tenant_id = t.id
            and c.contact_id = i.contact_id
            and (c.external_thread_id = $4 or $4 = '')
          order by c.updated_at desc
          limit 1
       ) cv on true
      where t.tenant_key = $1
      limit 1`,
    [tenantKey, channel, externalUserId, externalThreadId],
  );
  const row = query.rows[0];
  if (!row) return null;
  return {
    ...row,
    conversation_id: result?.conversation?.id || result?.conversation_id || row.conversation_id,
    externalMessageId: clean(input.externalMessageId || input.external_message_id || input.message_id),
    channel,
    externalUserId,
    externalThreadId,
  };
}

async function isInternalTestConversation(conversationId) {
  const result = await pool.query(
    `select c.channel, c.metadata, t.tenant_key
       from agent.conversations c
       join agent.tenants t on t.id = c.tenant_id
      where c.id = $1
      limit 1`,
    [conversationId],
  );
  return isSyntheticCrmContext(result.rows[0]);
}

export async function enqueueCrmProjection(input, result) {
  if (!enabled()) return { queued: false, reason: 'disabled' };
  const turn = await locateTurn(input, result);
  if (!turn?.conversation_id) return { queued: false, reason: 'turn-not-found' };
  if (await isInternalTestConversation(turn.conversation_id)) {
    return { queued: false, reason: 'internal-test-conversation' };
  }
  const dedupeKey = eventKey([
    turn.tenant_id,
    turn.contact_id,
    turn.conversation_id,
    turn.externalMessageId || result?.outbound_message_id || result?.action || Date.now(),
  ]);
  const inserted = await pool.query(
    `insert into agent.crm_sync_outbox
       (tenant_id, contact_id, conversation_id, provider, event_type, dedupe_key, payload)
     values ($1, $2, $3, $4, 'conversation_turn', $5, $6::jsonb)
      on conflict (tenant_id, provider, dedupe_key) do nothing
     returning id`,
    [
      turn.tenant_id,
      turn.contact_id,
      turn.conversation_id,
      provider(),
      dedupeKey,
      JSON.stringify({
        channel: turn.channel,
        externalMessageId: turn.externalMessageId || null,
        action: result?.action || null,
      }),
    ],
  );
  if (inserted.rowCount) void drainCrmOutbox({ limit: 5 }).catch((error) => console.error('[crm] drain failed:', publicError(error)));
  return { queued: Boolean(inserted.rowCount), dedupeKey };
}

async function claimJobs(limit, options = {}) {
  const includeBackfill = Boolean(options.includeBackfill);
  const response = await pool.query(
    `with picked as (
       select id
         from agent.crm_sync_outbox
        where (
          (
            status in ('pending', 'retry') and available_at <= now()
          ) or (
            status = 'processing' and locked_at < now() - interval '10 minutes'
          )
        )
          and ($2::boolean or event_type <> 'backfill')
        order by
          case when event_type = 'conversation_turn' then 0 else 1 end,
          created_at
        for update skip locked
        limit $1
     )
     update agent.crm_sync_outbox o
        set status = 'processing',
            attempts = o.attempts + 1,
            locked_at = now(),
            updated_at = now()
       from picked
      where o.id = picked.id
     returning o.*`,
    [Math.max(1, Math.min(250, Number(limit || 25))), includeBackfill],
  );
  return response.rows;
}

async function loadSnapshot(job) {
  const [contactResult, identitiesResult, conversationResult, messagesResult, countResult, linkResult] = await Promise.all([
    pool.query(
      `select c.id, c.display_name, c.profile, c.updated_at, t.tenant_key
         from agent.contacts c
         join agent.tenants t on t.id = c.tenant_id
        where c.id = $1 and c.tenant_id = $2`,
      [job.contact_id, job.tenant_id],
    ),
    pool.query(
      `select channel, external_user_id, metadata
         from agent.identities
        where tenant_id = $1 and contact_id = $2
        order by created_at`,
      [job.tenant_id, job.contact_id],
    ),
    pool.query(
      `select id, channel, status, summary, semantic_state, escalated_at, updated_at, metadata
         from agent.conversations
        where id = $1 and tenant_id = $2`,
      [job.conversation_id, job.tenant_id],
    ),
    pool.query(
      `select role, direction, content, created_at
         from agent.messages
        where conversation_id = $1
        order by created_at desc
        limit 12`,
      [job.conversation_id],
    ),
    pool.query('select count(*)::int as count from agent.messages where conversation_id = $1', [job.conversation_id]),
    pool.query(
      `select external_contact_id, external_record_url, sync_state
         from agent.crm_contact_links
        where tenant_id = $1 and contact_id = $2 and provider = $3`,
      [job.tenant_id, job.contact_id, job.provider],
    ),
  ]);

  const contact = contactResult.rows[0];
  if (!contact) throw new Error(`CRM contact source ${job.contact_id} no longer exists`);
  const messages = messagesResult.rows;
  return {
    tenant: { id: job.tenant_id, key: contact.tenant_key },
    contact,
    identities: identitiesResult.rows,
    conversation: conversationResult.rows[0] || null,
    messages,
    messageCount: Number(countResult.rows[0]?.count || 0),
    latestInbound: messages.find((message) => message.direction === 'inbound') || null,
    latestOutbound: messages.find((message) => message.direction === 'outbound') || null,
    link: linkResult.rows[0] || null,
    customerKey: `${contact.tenant_key}:${contact.id}`,
  };
}

async function completeJob(job, projection) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into agent.crm_contact_links
         (tenant_id, contact_id, provider, external_contact_id, external_record_url, sync_state, last_synced_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, now())
       on conflict (tenant_id, contact_id, provider) do update
         set external_contact_id = excluded.external_contact_id,
             external_record_url = excluded.external_record_url,
             sync_state = excluded.sync_state,
             last_synced_at = now(),
             updated_at = now()`,
      [
        job.tenant_id,
        job.contact_id,
        job.provider,
        projection.externalContactId,
        projection.externalRecordUrl,
        JSON.stringify(projection.syncState || {}),
      ],
    );
    await client.query(
      `update agent.crm_sync_outbox
          set status = 'completed', completed_at = now(), locked_at = null,
              external_object_id = $2, last_error = null, updated_at = now()
        where id = $1`,
      [job.id, projection.externalContactId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function failJob(job, error) {
  const maxAttempts = Math.max(1, Number(process.env.CRM_MAX_ATTEMPTS || 8));
  const status = Number(error?.status || 0);
  const permanentClientError = status >= 400
    && status < 500
    && ![408, 409, 425, 429].includes(status);
  const dead = permanentClientError || Number(job.attempts) >= maxAttempts;
  const delaySeconds = Math.min(3600, 5 * (2 ** Math.min(10, Number(job.attempts))));
  await pool.query(
    `update agent.crm_sync_outbox
        set status = $2,
            available_at = now() + ($3 * interval '1 second'),
            locked_at = null,
            last_error = $4,
            updated_at = now()
      where id = $1`,
    [job.id, dead ? 'dead' : 'retry', delaySeconds, publicError(error)],
  );
}

async function projectJob(job) {
  if (job.provider !== 'hubspot') throw new Error(`Unsupported CRM provider: ${job.provider}`);
  const snapshot = await loadSnapshot(job);
  const projection = await projectToHubSpot(snapshot, job);
  await completeJob(job, projection);
  return projection;
}

let activeDrain = null;

export async function drainCrmOutbox(options = {}) {
  if (!enabled()) return { processed: 0, completed: 0, failed: 0, reason: 'disabled' };
  if (activeDrain) return activeDrain;
  activeDrain = (async () => {
  const jobs = await claimJobs(options.limit || 25, {
    includeBackfill: options.includeBackfill,
  });
    let completed = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        await projectJob(job);
        completed += 1;
      } catch (error) {
        failed += 1;
        await failJob(job, error);
        console.error(`[crm] job ${job.id} failed:`, publicError(error));
      }
    }
    return { processed: jobs.length, completed, failed };
  })();
  try {
    return await activeDrain;
  } finally {
    activeDrain = null;
  }
}

let workerTimer;

export function startCrmWorker() {
  if (!enabled() || workerTimer) return false;
  const interval = Math.max(1000, Number(process.env.CRM_WORKER_INTERVAL_MS || 15000));
  workerTimer = setInterval(
    () => void drainCrmOutbox().catch((error) => console.error('[crm] worker failed:', publicError(error))),
    interval,
  );
  workerTimer.unref();
  return true;
}

export async function enqueueCrmBackfill(limit = 250) {
  if (!enabled()) return { queued: 0, reason: 'disabled' };
  const source = await pool.query(
    `select c.tenant_id, c.id as contact_id, cv.id as conversation_id,
            greatest(c.updated_at, coalesce(cv.updated_at, c.updated_at)) as source_updated_at
       from agent.contacts c
     left join lateral (
       select id, updated_at
         from agent.conversations
   where tenant_id = c.tenant_id and contact_id = c.id
     and coalesce(channel, '') not in (
       'scenario_test', 'scenario-test', 'internal_test', 'internal-test',
       'internal_e2e', 'internal-e2e', 'diagnostic_test', 'diagnostic-test'
     )
     and lower(coalesce(metadata ->> 'test', 'false')) not in ('true', '1', 'yes')
     and lower(coalesce(metadata ->> 'synthetic', 'false')) not in ('true', '1', 'yes')
     and lower(coalesce(metadata ->> 'runtime', '')) not in ('test', 'scenario')
     and lower(coalesce(metadata ->> 'environment', '')) not in (
       'test', 'testing', 'scenario', 'diagnostic', 'synthetic',
       'internal-test', 'internal_test', 'internal-e2e', 'internal_e2e'
     )
     and not exists (
       select 1
         from agent.tenants test_tenant
        where test_tenant.id = c.tenant_id
          and (
            lower(test_tenant.tenant_key) in (
              'internal-test', 'internal_test', 'internal-e2e', 'internal_e2e',
              'scenario-test', 'scenario_test', 'diagnostic-test', 'diagnostic_test'
            )
            or lower(test_tenant.tenant_key) like 'internal-test-%'
            or lower(test_tenant.tenant_key) like 'internal_test_%'
            or lower(test_tenant.tenant_key) like 'internal-e2e-%'
            or lower(test_tenant.tenant_key) like 'internal_e2e_%'
            or lower(test_tenant.tenant_key) like 'scenario-test-%'
            or lower(test_tenant.tenant_key) like 'scenario_test_%'
            or lower(test_tenant.tenant_key) like 'diagnostic-test-%'
            or lower(test_tenant.tenant_key) like 'diagnostic_test_%'
          )
     )
   order by updated_at desc
        limit 1
     ) cv on true
    where cv.id is not null
      and to_jsonb(c)::text not ilike '%.example.test%'
    order by source_updated_at desc
    limit $1`,
    [Math.max(1, Math.min(5000, Number(limit || 250)))],
  );
  let queued = 0;
  for (const row of source.rows) {
    const dedupeKey = eventKey(['backfill', row.tenant_id, row.contact_id, row.conversation_id, row.source_updated_at]);
    const inserted = await pool.query(
      `insert into agent.crm_sync_outbox
         (tenant_id, contact_id, conversation_id, provider, event_type, dedupe_key, payload)
       values ($1, $2, $3, $4, 'backfill', $5, '{"source":"backfill"}'::jsonb)
      on conflict (tenant_id, provider, dedupe_key) do nothing
       returning id`,
      [row.tenant_id, row.contact_id, row.conversation_id, provider(), dedupeKey],
    );
    queued += inserted.rowCount;
  }
  return { queued, considered: source.rowCount };
}

export async function crmStatus() {
  const [outbox, links] = await Promise.all([
    pool.query(
      `select status, count(*)::int as count
         from agent.crm_sync_outbox
        where provider = $1
        group by status
        order by status`,
      [provider()],
    ),
    pool.query(
      `select l.external_contact_id, l.external_record_url, l.last_synced_at,
              c.display_name, t.tenant_key
         from agent.crm_contact_links l
         join agent.contacts c on c.id = l.contact_id
         join agent.tenants t on t.id = l.tenant_id
        where l.provider = $1
        order by l.last_synced_at desc
        limit 20`,
      [provider()],
    ),
  ]);
  return {
    enabled: enabled(),
    provider: provider(),
    outbox: Object.fromEntries(outbox.rows.map((row) => [row.status, row.count])),
    recentContacts: links.rows,
  };
}
