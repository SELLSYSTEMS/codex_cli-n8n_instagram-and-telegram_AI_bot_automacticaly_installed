#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const strict = process.argv.includes('--strict');

const expectedAgentTables = [
  'contacts',
  'commercial_requests',
  'conversations',
  'crm_contact_links',
  'crm_sync_outbox',
  'delivery_events',
  'identities',
  'inbound_events',
  'knowledge_chunks',
  'knowledge_documents',
  'messages',
  'model_runs',
  'schema_migrations',
  'tenants',
].sort();

async function loadLocalEnv() {
  let source;
  try {
    source = await readFile('.env', 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function databaseUrl() {
  const candidates = [
    'BRAIN_DATABASE_URL',
    'DATABASE_URL',
    'LOCAL_POSTGRES_URL',
    'POSTGRES_URL',
    'POSTGRES_CONNECTION_STRING',
  ];
  for (const key of candidates) {
    if (process.env[key]) return { key, value: process.env[key] };
  }
  throw new Error(`missing database URL; set one of: ${candidates.join(', ')}`);
}

function safeIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`unsafe SQL identifier: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

async function tableCounts(client, tables) {
  const counts = {};
  for (const { schema_name: schema, table_name: table } of tables) {
    const result = await client.query(`select count(*)::bigint as count from ${safeIdentifier(schema)}.${safeIdentifier(table)}`);
    counts[`${schema}.${table}`] = Number(result.rows[0].count);
  }
  return counts;
}

function sorted(values) {
  return [...values].sort();
}

function sameStrings(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function isSafeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.split(/[\\/]+/).includes('..');
}

function parseSha256Sums(source) {
  const checksums = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/i);
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
    checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

async function validateFrozenLegacyPolicy({ legacyObjects, rowCounts }) {
  const policyPath = '.private/operations/legacy-database-policy.json';
  if (legacyObjects.length === 0) {
    return {
      approved: true,
      policyPath,
      status: 'absent',
      archiveDirectory: null,
      errors: [],
    };
  }

  const errors = [];
  let policy;
  try {
    policy = JSON.parse(await readFile(policyPath, 'utf8'));
  } catch (error) {
    errors.push(`cannot load ${policyPath}: ${error.message}`);
    return {
      approved: false,
      policyPath,
      status: null,
      archiveDirectory: null,
      errors,
    };
  }

  const legacyPolicy = policy?.legacy ?? {};
  const archiveDirectory = legacyPolicy.archiveDirectory ?? null;
  const allowedObjects = Array.isArray(legacyPolicy.allowedObjects) ? legacyPolicy.allowedObjects : [];
  const functionObjects = Array.isArray(legacyPolicy.functionObjects) ? legacyPolicy.functionObjects : [];
  const requiredArtifacts = Array.isArray(legacyPolicy.requiredArtifacts) ? legacyPolicy.requiredArtifacts : [];

  if (policy.version !== 1) errors.push('legacy policy version must be 1');
  if (policy.canonicalSchema !== 'agent') errors.push('legacy policy canonicalSchema must be agent');
  if (legacyPolicy.status !== 'frozen-archive-only') errors.push('legacy policy status must be frozen-archive-only');
  if (legacyPolicy.schema !== 'public') errors.push('legacy policy schema must be public');
  if (!sameStrings(legacyObjects, allowedObjects)) errors.push('live legacy objects do not exactly match the approved object list');
  if (!isSafeRelativePath(archiveDirectory)) errors.push('legacy archiveDirectory must be a safe repository-relative path');
  if (requiredArtifacts.length === 0) errors.push('legacy policy must list required archive artifacts');

  const artifactContents = new Map();
  if (isSafeRelativePath(archiveDirectory)) {
    for (const artifact of requiredArtifacts) {
      if (typeof artifact !== 'string' || path.basename(artifact) !== artifact) {
        errors.push(`unsafe archive artifact name: ${String(artifact)}`);
        continue;
      }
      try {
        artifactContents.set(artifact, await readFile(path.join(archiveDirectory, artifact)));
      } catch (error) {
        errors.push(`cannot read archive artifact ${artifact}: ${error.message}`);
      }
    }
  }

  let manifest;
  const manifestBuffer = artifactContents.get('MANIFEST.json');
  if (manifestBuffer) {
    try {
      manifest = JSON.parse(manifestBuffer.toString('utf8'));
    } catch (error) {
      errors.push(`invalid archive MANIFEST.json: ${error.message}`);
    }
  } else {
    errors.push('archive MANIFEST.json is required');
  }

  if (manifest) {
    if (manifest.disposition !== 'historical-isolated-read-only-archive') {
      errors.push('archive manifest disposition is not historical-isolated-read-only-archive');
    }
    if (manifest.canonicalRuntimeSchema !== 'agent') {
      errors.push('archive manifest canonicalRuntimeSchema must be agent');
    }
    const manifestTables = Object.keys(manifest.tables ?? {});
    if (!sameStrings([...manifestTables, ...functionObjects], legacyObjects)) {
      errors.push('archive manifest tables and approved functions do not match live legacy objects');
    }
    for (const [objectName, expectedCount] of Object.entries(manifest.tables ?? {})) {
      if (rowCounts[objectName] !== expectedCount) {
        errors.push(`legacy row count drift for ${objectName}: expected ${expectedCount}, found ${rowCounts[objectName] ?? 'missing'}`);
      }
    }
  }

  const checksumBuffer = artifactContents.get('SHA256SUMS');
  if (checksumBuffer) {
    try {
      const checksums = parseSha256Sums(checksumBuffer.toString('utf8'));
      for (const artifact of requiredArtifacts.filter((name) => name !== 'SHA256SUMS')) {
        const content = artifactContents.get(artifact);
        if (!content) continue;
        const expectedChecksum = checksums.get(artifact);
        if (!expectedChecksum) {
          errors.push(`SHA256SUMS is missing ${artifact}`);
          continue;
        }
        const actualChecksum = createHash('sha256').update(content).digest('hex');
        if (actualChecksum !== expectedChecksum) errors.push(`checksum mismatch for ${artifact}`);
      }
    } catch (error) {
      errors.push(`invalid archive SHA256SUMS: ${error.message}`);
    }
  } else {
    errors.push('archive SHA256SUMS is required');
  }

  return {
    approved: errors.length === 0,
    policyPath,
    status: legacyPolicy.status ?? null,
    archiveDirectory,
    errors,
  };
}

await loadLocalEnv();
const selectedUrl = databaseUrl();
const client = new Client({
  connectionString: selectedUrl.value,
  application_name: 'brain_database_inventory',
});

try {
  await client.connect();

  const tableResult = await client.query(`
    select schemaname as schema_name, tablename as table_name
    from pg_catalog.pg_tables
    where schemaname = 'agent'
       or (schemaname = 'public' and tablename like 'bot\\_%' escape '\\')
    order by schemaname, tablename
  `);

  const functionResult = await client.query(`
    select n.nspname as schema_name, p.proname as function_name
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('agent', 'public')
      and p.proname like '%bot%'
    order by n.nspname, p.proname
  `);

  const agentTables = tableResult.rows
    .filter((row) => row.schema_name === 'agent')
    .map((row) => row.table_name)
    .sort();
  const legacyTables = tableResult.rows
    .filter((row) => row.schema_name === 'public')
    .map((row) => row.table_name)
    .sort();
  const missingAgentTables = expectedAgentTables.filter((table) => !agentTables.includes(table));
  const unexpectedAgentTables = agentTables.filter((table) => !expectedAgentTables.includes(table));
  const legacyObjects = [
    ...legacyTables.map((name) => `public.${name}`),
    ...functionResult.rows
      .filter((row) => row.schema_name === 'public')
      .map((row) => `public.${row.function_name}()`),
  ];
  const rowCounts = await tableCounts(client, tableResult.rows);
  const legacyPolicy = await validateFrozenLegacyPolicy({ legacyObjects, rowCounts });
  const canonicalSchemaExact = missingAgentTables.length === 0 && unexpectedAgentTables.length === 0;
  const legacyStateControlled = legacyObjects.length === 0 || legacyPolicy.approved;

  const report = {
    ok: canonicalSchemaExact && (!strict || legacyStateControlled),
    mode: strict ? 'strict' : 'inventory',
    strictPolicy: 'canonical-exact-and-legacy-verified',
    connectionVariable: selectedUrl.key,
    canonical: {
      schema: 'agent',
      expectedTables: expectedAgentTables,
      actualTables: agentTables,
      missingTables: missingAgentTables,
      unexpectedTables: unexpectedAgentTables,
    },
    legacy: {
      present: legacyObjects.length > 0,
      tables: legacyTables,
      functions: functionResult.rows.filter((row) => row.schema_name === 'public'),
      objects: legacyObjects,
      policy: legacyPolicy,
    },
    rowCounts,
    readOnly: true,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
