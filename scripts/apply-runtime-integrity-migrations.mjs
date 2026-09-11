#!/usr/bin/env node

import process from 'node:process';

try {
  process.loadEnvFile?.('.env');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const migrations = [
  'migrations/20260828T064500Z_runtime_integrity.sql',
  'migrations/20260828T065000Z_bounded_conversation_memory.sql',
  'migrations/20260828T070000Z_inbound_dedupe.sql',
  'migrations/20260830T000000Z_bounded_conversation_memory_v3.sql',
  'migrations/20260830T001000Z_bounded_conversation_memory_v3_enforcement.sql',
];

function migrationBody(sql) {
  const normalized = sql.trim();
  const match = normalized.match(/^begin\s*;\s*([\s\S]*?)\s*commit\s*;\s*$/i);
  return match ? match[1] : normalized;
}

const connectionString = process.env.LOCAL_POSTGRES_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('LOCAL_POSTGRES_URL or DATABASE_URL is required');
}

const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  application_name: 'multichannel-brain-migrator',
});

const client = await pool.connect();
try {
  await client.query('select pg_advisory_lock(hashtext($1))', ['multichannel-brain-runtime-migrations']);
  await client.query('create schema if not exists agent');
  await client.query(`
    create table if not exists agent.schema_migrations (
      migration_name text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )
  `);

  for (const migrationName of migrations) {
    const sql = await readFile(path.resolve(process.cwd(), migrationName), 'utf8');
    const sha256 = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query(
      'select sha256 from agent.schema_migrations where migration_name = $1',
      [migrationName],
    );

    if (existing.rowCount === 1) {
      if (existing.rows[0].sha256 !== sha256) {
        throw new Error(`Applied migration checksum mismatch: ${migrationName}`);
      }
      console.log(`Already applied: ${migrationName}`);
      continue;
    }

    await client.query('begin');
    try {
      await client.query(migrationBody(sql));
      await client.query(
        'insert into agent.schema_migrations (migration_name, sha256) values ($1, $2)',
        [migrationName, sha256],
      );
      await client.query('commit');
      console.log(`Applied: ${migrationName}`);
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
} finally {
  try {
    await client.query('select pg_advisory_unlock(hashtext($1))', ['multichannel-brain-runtime-migrations']);
  } catch {
    // Connection teardown releases the session lock if unlock cannot run.
  }
  client.release();
  await pool.end();
}
