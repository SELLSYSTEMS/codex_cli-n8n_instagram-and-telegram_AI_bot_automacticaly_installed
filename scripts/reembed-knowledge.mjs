import crypto from 'node:crypto';

import { pool } from './db.mjs';
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_FINGERPRINT,
  EMBEDDING_MODEL,
  embedTexts,
} from './embeddings.mjs';

const vectorLiteral = (embedding) => `[${embedding.join(',')}]`;
const contentHash = (content) => crypto.createHash('sha256').update(content).digest('hex');

const run = async () => {
  const { rows } = await pool.query(`
    select id::text as id, content
    from agent.knowledge_chunks
    order by id::text
  `);

  if (rows.length === 0) {
    return {
      reembedded: 0,
      model: EMBEDDING_MODEL,
      dimension: EMBEDDING_DIMENSION,
      fingerprint: EMBEDDING_FINGERPRINT,
    };
  }

  const snapshots = rows.map((row) => ({
    id: row.id,
    content: row.content,
    hash: contentHash(row.content),
  }));
  const embeddings = await embedTexts(snapshots.map((row) => row.content));
  const client = await pool.connect();

  try {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(hashtext('agent.knowledge_chunks.reembed'))");

    const locked = await client.query(`
      select id::text as id, content
      from agent.knowledge_chunks
      where id::text = any($1::text[])
      order by id::text
      for update
    `, [snapshots.map((row) => row.id)]);

    if (locked.rows.length !== snapshots.length) {
      throw new Error('Knowledge index changed during re-embedding');
    }

    const lockedById = new Map(locked.rows.map((row) => [row.id, row]));
    for (const snapshot of snapshots) {
      const current = lockedById.get(snapshot.id);
      if (!current || contentHash(current.content) !== snapshot.hash) {
        throw new Error('Knowledge content changed during re-embedding');
      }
    }

    for (let index = 0; index < snapshots.length; index += 1) {
      await client.query(`
        update agent.knowledge_chunks
        set embedding = $1::vector,
            metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb
        where id::text = $3
      `, [
        vectorLiteral(embeddings[index]),
        JSON.stringify({
          embedding_fingerprint: EMBEDDING_FINGERPRINT,
          embedding_model: EMBEDDING_MODEL,
          embedding_dimension: EMBEDDING_DIMENSION,
          embedded_at: new Date().toISOString(),
        }),
        snapshots[index].id,
      ]);
    }

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  return {
    reembedded: snapshots.length,
    model: EMBEDDING_MODEL,
    dimension: EMBEDDING_DIMENSION,
    fingerprint: EMBEDDING_FINGERPRINT,
  };
};

try {
  console.log(JSON.stringify(await run(), null, 2));
} finally {
  await pool.end();
}
