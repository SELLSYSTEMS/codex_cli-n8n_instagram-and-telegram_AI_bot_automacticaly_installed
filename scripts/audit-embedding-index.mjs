import { pool } from './db.mjs';
import { EMBEDDING_DIMENSION, EMBEDDING_FINGERPRINT } from './embeddings.mjs';

async function run() {
  const { rows: [result] } = await pool.query(`
    select
      count(*)::integer as total,
      count(*) filter (where embedding is null)::integer as missing_embedding,
      count(*) filter (
        where embedding is not null and vector_dims(embedding) <> $1
      )::integer as wrong_dimension,
      count(*) filter (
        where coalesce(metadata->>'embedding_fingerprint', '') <> $2
      )::integer as fingerprint_mismatch
    from agent.knowledge_chunks
  `, [EMBEDDING_DIMENSION, EMBEDDING_FINGERPRINT]);

  const report = {
    ...result,
    expected_dimension: EMBEDDING_DIMENSION,
    expected_fingerprint: EMBEDDING_FINGERPRINT,
  };

  console.log(JSON.stringify(report, null, 2));

  if (result.missing_embedding > 0 || result.wrong_dimension > 0 || result.fingerprint_mismatch > 0) {
    process.exitCode = 1;
  }
}

try {
  await run();
} finally {
  await pool.end();
}
