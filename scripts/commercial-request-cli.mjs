#!/usr/bin/env node

import { loadEnvFile } from 'node:process';
import path from 'node:path';
import pg from 'pg';

try {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const { Pool } = pg;
const ACTIVE_STATUSES = ['requested', 'preparing', 'ready'];
const ALL_STATUSES = [...ACTIVE_STATUSES, 'delivered', 'cancelled'];

function usage() {
  return `Usage:
  npm run commercial:requests -- list --tenant-key TENANT [--conversation-id UUID] [--status STATUS | --all] [--limit N]
  npm run commercial:requests -- transition --tenant-key TENANT --request-id UUID --status STATUS [--note TEXT]

Statuses: ${ALL_STATUSES.join(', ')}

The command reads only LOCAL_POSTGRES_URL. List output intentionally excludes customer payloads and private context.`;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function requireOption(args, name) {
  const value = option(args, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function publicRequest(row) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    conversation_id: row.conversation_id,
    action_id: row.action_id,
    status: row.status,
    test_only: row.test_only,
    requested_at: row.requested_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
    operator_note: row.operator_note,
  };
}

async function resolveTenantId(client, tenantKey) {
  const result = await client.query(
    'select id from agent.tenants where tenant_key = $1 limit 1',
    [tenantKey],
  );
  if (result.rowCount !== 1) throw new Error(`Unknown tenant key: ${tenantKey}`);
  return result.rows[0].id;
}

async function listRequests(client, args, tenantId) {
  const conversationId = option(args, '--conversation-id');
  const requestedStatus = option(args, '--status');
  const includeAll = args.includes('--all');
  const parsedLimit = Number.parseInt(option(args, '--limit') || '50', 10);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
    throw new Error('--limit must be an integer from 1 through 200.');
  }
  if (requestedStatus && includeAll) throw new Error('Use either --status or --all, not both.');
  if (requestedStatus && !ALL_STATUSES.includes(requestedStatus)) {
    throw new Error(`Unsupported status: ${requestedStatus}`);
  }

  const values = [tenantId];
  const where = ['tenant_id = $1'];
  if (conversationId) {
    values.push(conversationId);
    where.push(`conversation_id = $${values.length}`);
  }
  if (requestedStatus) {
    values.push(requestedStatus);
    where.push(`status = $${values.length}`);
  } else if (!includeAll) {
    values.push(ACTIVE_STATUSES);
    where.push(`status = any($${values.length}::text[])`);
  }
  values.push(parsedLimit);

  const result = await client.query(
    `select id, tenant_id, conversation_id, action_id, status, test_only,
            requested_at, updated_at, resolved_at, operator_note
       from agent.commercial_requests
      where ${where.join(' and ')}
      order by updated_at desc
      limit $${values.length}`,
    values,
  );
  return result.rows.map(publicRequest);
}

async function transitionRequest(client, args, tenantId) {
  const requestId = requireOption(args, '--request-id');
  const status = requireOption(args, '--status').toLowerCase();
  const note = option(args, '--note');
  if (!ALL_STATUSES.includes(status)) throw new Error(`Unsupported status: ${status}`);

  const result = await client.query(
    'select (agent.transition_commercial_request($1, $2, $3, $4)).*',
    [tenantId, requestId, status, note],
  );
  return publicRequest(result.rows[0]);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!['list', 'transition'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (!process.env.LOCAL_POSTGRES_URL) {
    throw new Error('LOCAL_POSTGRES_URL is required; legacy database URL aliases are not accepted.');
  }

  const tenantKey = requireOption(args, '--tenant-key');
  const pool = new Pool({ connectionString: process.env.LOCAL_POSTGRES_URL, max: 1 });
  try {
    const client = await pool.connect();
    try {
      const tenantId = await resolveTenantId(client, tenantKey);
      const data = command === 'list'
        ? await listRequests(client, args, tenantId)
        : await transitionRequest(client, args, tenantId);
      process.stdout.write(`${JSON.stringify({ ok: true, command, data }, null, 2)}\n`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
