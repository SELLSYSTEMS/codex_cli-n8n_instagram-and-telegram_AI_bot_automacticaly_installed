#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const { Client } = pg;
const brainBaseUrl = (process.env.BRAIN_BASE_URL || 'http://127.0.0.1:8789').replace(/\/$/, '');
const brainToken = process.env.BRAIN_API_TOKEN;
const databaseUrl = process.env.LOCAL_POSTGRES_URL || process.env.DATABASE_URL;
const tenantKey = process.env.CONTACT_TEST_TENANT_KEY || process.env.BRAIN_TEST_TENANT_KEY || 'test-tenant';
const expectedProvider = process.env.CONTACT_TEST_EXPECTED_PROVIDER || '';
const expectedModel = process.env.CONTACT_TEST_EXPECTED_MODEL || '';
const requireNoFallback = process.env.CONTACT_TEST_REQUIRE_NO_FALLBACK !== 'false';

if (!brainToken) throw new Error('BRAIN_API_TOKEN is required');
if (!databaseUrl) throw new Error('LOCAL_POSTGRES_URL or DATABASE_URL is required');

const runId = randomUUID();
const externalUserId = `contact-memory-qa-${runId}`;
const externalThreadId = `contact-memory-thread-${runId}`;
const email = `avery.morgan+${runId.slice(0, 8)}@example.com`;
let messageSequence = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flattenStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => flattenStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => flattenStrings(item, output));
  return output;
}

function searchable(value) {
  return flattenStrings(value).join(' ').toLowerCase();
}

function assertContainsAll(value, fragments, label) {
  const text = searchable(value);
  for (const fragment of fragments) {
    assert(text.includes(fragment.toLowerCase()), `${label} is missing ${fragment}`);
  }
}

function assertContainsAny(value, alternatives, label) {
  const text = searchable(value);
  assert(alternatives.some((fragment) => text.includes(fragment.toLowerCase())), `${label} is missing one of: ${alternatives.join(', ')}`);
}

function routeSummary(result) {
  return {
    provider: result.provider || result.model_route?.provider || '',
    model: result.model || result.model_route?.model || '',
    fallbackCount: Number(result.fallback_count ?? result.model_route?.fallback_count ?? 0)
  };
}

async function sendMessage(text) {
  messageSequence += 1;
  const response = await fetch(`${brainBaseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${brainToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      tenant_key: tenantKey,
      tenant_name: 'Contact Memory QA',
      channel: 'internal-test',
      channel_account_id: 'contact-memory-qa',
      external_user_id: externalUserId,
      external_thread_id: externalThreadId,
      external_message_id: `${runId}-${messageSequence}`,
      text,
      metadata: { source: 'contact-memory-crm-smoke', synthetic: true }
    })
  });
  const raw = await response.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(`Brain returned non-JSON HTTP ${response.status}`);
  }
  assert(response.ok, `Brain returned HTTP ${response.status}: ${result.error || result.message || 'unknown error'}`);
  assert(result.should_reply !== false, 'Brain unexpectedly suppressed a normal QA message');
  assert(typeof result.reply === 'string' && result.reply.trim().length > 0, 'Brain returned an empty reply');
  const route = routeSummary(result);
  if (expectedProvider) assert(route.provider === expectedProvider, `Expected provider ${expectedProvider}, received ${route.provider || 'unknown'}`);
  if (expectedModel) assert(route.model === expectedModel, `Expected model ${expectedModel}, received ${route.model || 'unknown'}`);
  if (requireNoFallback) assert(route.fallbackCount === 0, `Unexpected model fallback count: ${route.fallbackCount}`);
  return { result, route };
}

async function matchingRows(client, tableName, needle) {
  const allowed = new Set(['agent.contacts']);
  assert(allowed.has(tableName), 'Unsafe table name');
  const query = `select to_jsonb(row_value) as row_data from ${tableName} row_value where lower(to_jsonb(row_value)::text) like lower($1)`;
  const { rows } = await client.query(query, [`%${needle}%`]);
  return rows.map((row) => row.row_data);
}

async function matchingIdentityProfiles(client, externalUserId) {
  const { rows } = await client.query(
    `select jsonb_build_object(
       'identity_id', identity_value.id,
       'tenant_id', identity_value.tenant_id,
       'channel', identity_value.channel,
       'external_user_id', identity_value.external_user_id,
       'identity_metadata', identity_value.metadata,
       'contact_id', contact_value.id,
       'display_name', contact_value.display_name,
       'profile', contact_value.profile,
       'created_at', least(identity_value.created_at, contact_value.created_at),
       'updated_at', greatest(identity_value.updated_at, contact_value.updated_at)
     ) as row_data
     from agent.identities identity_value
     join agent.contacts contact_value
       on contact_value.id = identity_value.contact_id
      and contact_value.tenant_id = identity_value.tenant_id
     where identity_value.channel = 'internal-test'
       and identity_value.external_user_id = $1`,
    [externalUserId],
  );
  return rows.map((row) => row.row_data);
}

async function crmLinks(client, contactIds) {
  if (contactIds.length === 0) return [];
  const { rows } = await client.query(
    `select to_jsonb(link_value) as row_data
       from agent.crm_contact_links link_value
      where link_value.contact_id = any($1::uuid[])
        and link_value.provider = 'hubspot'`,
    [contactIds]
  );
  return rows.map((row) => row.row_data);
}

function drainCrm() {
  const child = spawnSync(process.execPath, ['scripts/crm-cli.mjs', 'drain'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 120000
  });
  if (child.status !== 0) {
    const detail = String(child.stderr || child.stdout || '').trim().slice(-500);
    throw new Error(`CRM drain failed with exit ${child.status}${detail ? `: ${detail}` : ''}`);
  }
}

async function waitForHubSpotLink(client, contactIds) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const links = await crmLinks(client, contactIds);
    const linked = links.find((link) => typeof link.external_contact_id === 'string' && link.external_contact_id.length > 0);
    if (linked) return linked;
    if (attempt === 0 || attempt === 5) drainCrm();
    await sleep(1000);
  }
  throw new Error('HubSpot contact link was not created after CRM drain');
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const turns = [];
  turns.push(await sendMessage("Hi, I'm Avery Morgan from Northstar QA Labs. We need a conversational assistant for customer enquiries."));
  turns.push(await sendMessage(`Email is the best way to reach me: ${email}. Weekday afternoons in UTC+1 are ideal.`));

    let identities = await matchingIdentityProfiles(client, externalUserId);
  assert(identities.length === 1, `Expected one customer identity after discovery, received ${identities.length}`);
  assertContainsAll(identities[0], ['avery', 'morgan', 'northstar', email, 'email', 'afternoon'], 'Cumulative customer profile');
  assertContainsAny(identities[0], ['utc+1', 'utc +1', 'utc+01', '+01:00'], 'Cumulative customer timezone');

  turns.push(await sendMessage('We are still defining the scope. What information do you need before recommending the right next step?'));
  turns.push(await sendMessage('One more detail: the first rollout should cover WhatsApp and Instagram.'));

    identities = await matchingIdentityProfiles(client, externalUserId);
  assert(identities.length === 1, `Expected one customer identity after sparse updates, received ${identities.length}`);
  assertContainsAll(identities[0], ['avery', 'morgan', 'northstar', email, 'email', 'afternoon'], 'Profile after sparse updates');

    let contacts = await matchingRows(client, 'agent.contacts', email);
    assert(contacts.length === 0, `Synthetic traffic entered CRM projection; received ${contacts.length} contacts`);

    turns.push(await sendMessage('Actually, mornings after 10:00 in UTC+1 are better for follow-up. Please retain the rest of my details.'));

      identities = await matchingIdentityProfiles(client, externalUserId);
  assert(identities.length === 1, `Expected one customer identity after preference update, received ${identities.length}`);
  assertContainsAll(identities[0], ['avery', 'morgan', 'northstar', email, 'email'], 'Profile after preference update');
  assertContainsAny(identities[0], ['morning', '10:00', 'after 10'], 'Updated contact time');
  assertContainsAny(identities[0], ['utc+1', 'utc +1', 'utc+01', '+01:00'], 'Updated customer timezone');

    contacts = await matchingRows(client, 'agent.contacts', email);
    assert(contacts.length === 0, `Synthetic traffic entered CRM projection after update; received ${contacts.length} contacts`);

    const route = turns.at(-1).route;
  process.stdout.write(`${JSON.stringify({
    ok: true,
      turns: turns.length,
      identityCount: identities.length,
      localContactCount: contacts.length,
      hubspotLinked: false,
      externalCrmSuppressed: true,
      cumulativeMemory: true,
    preferenceUpdated: true,
    provider: route.provider,
    model: route.model,
    fallbackCount: route.fallbackCount
  }, null, 2)}\n`);
} finally {
  await client.end();
}
