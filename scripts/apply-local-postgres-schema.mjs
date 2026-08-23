#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(rootDir, '.env');
const schemaPath = path.join(rootDir, 'schemas', 'local-postgres-brain.sql');
const migrationsDir = path.join(rootDir, 'schemas', 'migrations');
const lockName = 'n8nlandingtmplfgma:local-postgres-schema';

try {
  process.loadEnvFile(envPath);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const connectionString = process.env.LOCAL_POSTGRES_URL;

if (!connectionString) {
  throw new Error('Set the canonical LOCAL_POSTGRES_URL before applying the schema.');
}

function hasSelfManagedTransaction(sql) {
  const withoutLeadingComments = sql
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, '')
    .trim();
  return /^begin\s*;/iu.test(withoutLeadingComments) && /commit\s*;\s*$/iu.test(withoutLeadingComments);
}

async function runTransactionalSql(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function listMigrations() {
  let names = [];
  try {
    names = await fs.readdir(migrationsDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  return names
    .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
}

const client = new Client({ connectionString });
let lockAcquired = false;
let primaryError = null;

try {
  await client.connect();
  await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName]);
  lockAcquired = true;

  const bootstrapSql = await fs.readFile(schemaPath, 'utf8');
  if (hasSelfManagedTransaction(bootstrapSql)) {
    await client.query(bootstrapSql);
  } else {
    await runTransactionalSql(client, bootstrapSql);
  }

  const migrations = await listMigrations();
  for (const migration of migrations) {
    const sql = await fs.readFile(path.join(migrationsDir, migration), 'utf8');
    await runTransactionalSql(client, sql);
  }

  const database = await client.query('SELECT current_database() AS name');
  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    database: database.rows[0].name,
    bootstrap: path.basename(schemaPath),
    migrations,
  }, null, 2)}\n`);
} catch (error) {
  primaryError = error;
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  let unlockError = null;
  if (lockAcquired) {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
    } catch (error) {
      unlockError = error;
    }
  }
  await client.end().catch(() => {});
  if (!primaryError && unlockError) {
    throw unlockError;
  }
}
