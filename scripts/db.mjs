import pg from 'pg';
import { embedPassages, embedQuery, vectorLiteral } from './embeddings.mjs';

const { Pool } = pg;
const connectionString = process.env.LOCAL_POSTGRES_URL;

if (!connectionString) throw new Error('LOCAL_POSTGRES_URL is required');

export const pool = new Pool({
  connectionString,
  max: Number(process.env.POSTGRES_POOL_SIZE || 10),
  idleTimeoutMillis: 30000,
  application_name: 'multichannel-agent-brain'
});

function cleanText(value, max = 20000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

function cleanObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function ensureTenantWithClient(client, tenantKey, tenantName) {
  const result = await client.query(
    "insert into agent.tenants (tenant_key, display_name) values ($1, $2) on conflict (tenant_key) do update set display_name = excluded.display_name returning *",
    [tenantKey, tenantName || tenantKey]
  );
  return result.rows[0];
}

export async function ensureTenant(tenantKey, tenantName) {
  return transaction((client) => ensureTenantWithClient(client, tenantKey, tenantName));
}

export async function beginTurn(request) {
  const tenantKey = cleanText(request.tenantKey, 200);
  const tenantName = cleanText(request.tenantName || tenantKey, 300);
  const channel = cleanText(request.channel, 50).toLowerCase();
  const externalUserId = cleanText(request.externalUserId, 500);
  const externalThreadId = cleanText(request.externalThreadId || externalUserId, 500);
  const externalMessageId = cleanText(request.externalMessageId, 500);
  const text = cleanText(request.text);
  const metadata = cleanObject(request.metadata);

  if (!tenantKey || !channel || !externalUserId || !externalThreadId || !externalMessageId || !text) {
    throw new Error('tenantKey, channel, externalUserId, externalThreadId, externalMessageId and text are required');
  }

  return transaction(async (client) => {
    const tenant = await ensureTenantWithClient(client, tenantKey, tenantName);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      tenant.id + ':' + channel + ':' + externalThreadId
    ]);

    let identityResult = await client.query(
      "select i.*, c.display_name, c.profile from agent.identities i join agent.contacts c on c.id = i.contact_id where i.tenant_id = $1 and i.channel = $2 and i.external_user_id = $3",
      [tenant.id, channel, externalUserId]
    );

    let identity;
    if (!identityResult.rowCount) {
      const contactResult = await client.query(
        "insert into agent.contacts (tenant_id, display_name, profile) values ($1, $2, $3::jsonb) returning *",
        [tenant.id, cleanText(metadata.displayName, 500) || null, JSON.stringify({})]
      );
      const contact = contactResult.rows[0];
      identityResult = await client.query(
        "insert into agent.identities (tenant_id, contact_id, channel, external_user_id, metadata) values ($1, $2, $3, $4, $5::jsonb) returning *",
        [tenant.id, contact.id, channel, externalUserId, JSON.stringify(metadata)]
      );
      identity = { ...identityResult.rows[0], display_name: contact.display_name, profile: contact.profile };
    } else {
      identity = identityResult.rows[0];
      await client.query(
        "update agent.identities set metadata = metadata || $2::jsonb where id = $1",
        [identity.id, JSON.stringify(metadata)]
      );
      if (cleanText(metadata.displayName, 500)) {
        await client.query(
          "update agent.contacts set display_name = coalesce(nullif($2, ''), display_name) where id = $1",
          [identity.contact_id, cleanText(metadata.displayName, 500)]
        );
      }
    }

    const conversationResult = await client.query(
      "insert into agent.conversations (tenant_id, contact_id, channel, external_thread_id, metadata) values ($1, $2, $3, $4, $5::jsonb) on conflict (tenant_id, channel, external_thread_id) do update set contact_id = excluded.contact_id, last_message_at = now(), metadata = agent.conversations.metadata || excluded.metadata returning *",
      [tenant.id, identity.contact_id, channel, externalThreadId, JSON.stringify(metadata)]
    );
    const conversation = conversationResult.rows[0];

    const duplicateResult = await client.query(
      "select id from agent.messages where tenant_id = $1 and channel = $2 and external_message_id = $3",
      [tenant.id, channel, externalMessageId]
    );
    if (duplicateResult.rowCount) {
      const priorResult = await client.query(
        "select content, payload, model_route from agent.messages where conversation_id = $1 and direction = 'outbound' and payload ->> 'in_reply_to' = $2 order by created_at desc limit 1",
        [conversation.id, externalMessageId]
      );
      return {
        duplicate: true,
        tenant,
        identity,
        conversation,
        priorReply: priorResult.rows[0] || null,
        request: { tenantKey, tenantName, channel, externalUserId, externalThreadId, externalMessageId, text, metadata }
      };
    }

    const inboundResult = await client.query(
      "insert into agent.messages (tenant_id, conversation_id, contact_id, channel, external_message_id, direction, role, content, payload) values ($1, $2, $3, $4, $5, 'inbound', 'user', $6, $7::jsonb) returning *",
      [tenant.id, conversation.id, identity.contact_id, channel, externalMessageId, text, JSON.stringify(metadata)]
    );

    const historyResult = await client.query(
      "select channel, direction, role, content, created_at from agent.messages where conversation_id = $1 and id <> $2 order by created_at desc limit $3",
      [conversation.id, inboundResult.rows[0].id, Number(process.env.BRAIN_HISTORY_LIMIT || 30)]
    );

    const contactResult = await client.query(
      "select display_name, profile from agent.contacts where id = $1",
      [identity.contact_id]
    );

    return {
      duplicate: false,
      tenant,
      identity: { ...identity, ...contactResult.rows[0] },
      conversation,
      inboundMessage: inboundResult.rows[0],
      history: historyResult.rows.reverse(),
      request: { tenantKey, tenantName, channel, externalUserId, externalThreadId, externalMessageId, text, metadata }
    };
  });
}

export async function retrieveKnowledge(tenantId, queryText, limit = 8) {
  const query = cleanText(queryText, 12000);
  if (!query) return [];
  const embedding = vectorLiteral(await embedQuery(query));
  const result = await pool.query(
    "with query_data as (select plainto_tsquery('simple', $3) as lexical), scored as (select kc.id, kc.content, kc.metadata, kd.source_key, kd.title, greatest(0, 1 - (kc.embedding <=> $2::vector)) as semantic_score, ts_rank_cd(kc.search_vector, query_data.lexical) as lexical_score from agent.knowledge_chunks kc join agent.knowledge_documents kd on kd.id = kc.document_id cross join query_data where kc.tenant_id = $1) select id, content, metadata, source_key, title, semantic_score, lexical_score, (semantic_score * 0.82 + least(lexical_score, 1) * 0.18) as score from scored order by score desc limit $4",
    [tenantId, embedding, query, Number(limit)]
  );
  return result.rows;
}

export async function finishTurn(turn, decision, modelRun) {
  const reply = cleanText(decision.reply);
  const shouldReply = decision.should_reply !== false && Boolean(reply);
  const action = decision.should_escalate ? 'escalate' : shouldReply ? 'reply' : 'silent';
  const summary = cleanText(decision.conversationSummary || decision.conversation_summary, 8000);
  const solutionScope = cleanObject(decision.solutionScope || decision.solution_scope);
  const confirmedCommitments = Array.isArray(decision.confirmedCommitments || decision.confirmed_commitments)
    ? (decision.confirmedCommitments || decision.confirmed_commitments)
        .map((item) => cleanText(item, 1000))
        .filter(Boolean)
        .slice(0, 50)
    : [];
  const semanticState = {
    ...cleanObject(decision.semanticState || decision.semantic_state),
    intent: cleanText(decision.intent, 500),
    conversation_phase: cleanText(decision.conversationPhase || decision.conversation_phase, 500),
    customer_readiness: cleanText(decision.customerReadiness || decision.customer_readiness, 500),
    material_blocker: cleanText(decision.materialBlocker || decision.material_blocker, 1500) || null,
    next_best_action: cleanText(decision.nextBestAction || decision.next_best_action, 1500),
    commercial_progress: cleanText(decision.commercialProgress || decision.commercial_progress, 1500),
    decision_status: cleanText(decision.decisionStatus || decision.decision_status, 200),
    confirmed_commitments: confirmedCommitments,
    pending_customer_commitment:
      cleanText(decision.pendingCustomerCommitment || decision.pending_customer_commitment, 1500) || null,
    solution_scope: solutionScope,
    commercial_action: cleanObject(decision.commercialAction || decision.commercial_action),
    last_confidence: decision.confidence ?? null,
    last_action: action,
  };
  const profilePatch = cleanObject(
    decision.contactProfilePatch || decision.contact_profile_patch || decision.contact_profile
  );
  const escalationReason = cleanText(decision.escalationReason || decision.escalation_reason, 2000);

  if (decision.should_reply !== false && !reply) throw new Error('The model returned an empty reply');

  return transaction(async (client) => {
    let outboundMessage = null;
    if (shouldReply) {
      const outboundResult = await client.query(
        "insert into agent.messages (tenant_id, conversation_id, contact_id, channel, direction, role, content, payload, model_route) values ($1, $2, $3, $4, 'outbound', 'assistant', $5, $6::jsonb, $7) returning *",
        [
          turn.tenant.id,
          turn.conversation.id,
          turn.identity.contact_id,
          turn.request.channel,
          reply,
          JSON.stringify({ in_reply_to: turn.request.externalMessageId, action, confidence: decision.confidence ?? null }),
          modelRun.routeId
        ]
      );
      outboundMessage = outboundResult.rows[0];
    }

    await client.query(
      "update agent.contacts set profile = profile || $2::jsonb where id = $1",
      [turn.identity.contact_id, JSON.stringify(profilePatch)]
    );

    const conversationResult = await client.query(
      "update agent.conversations set summary = coalesce(nullif($2, ''), summary), semantic_state = semantic_state || $3::jsonb, status = case when $4 = 'escalate' then 'escalated' else status end, escalated_at = case when $4 = 'escalate' then coalesce(escalated_at, now()) else escalated_at end, escalation_reason = case when $4 = 'escalate' then nullif($5, '') else escalation_reason end, last_message_at = now() where id = $1 returning *",
      [turn.conversation.id, summary, JSON.stringify(semanticState), action, escalationReason]
    );

    await client.query(
      "insert into agent.model_runs (tenant_id, conversation_id, inbound_message_id, route_id, model, status, latency_ms, details) values ($1, $2, $3, $4, $5, 'success', $6, $7::jsonb)",
      [
        turn.tenant.id,
        turn.conversation.id,
        turn.inboundMessage.id,
        modelRun.routeId,
        modelRun.model,
        modelRun.latencyMs,
        JSON.stringify({ attempts: modelRun.attempts || [], provider: modelRun.provider })
      ]
    );

    return {
      reply,
      should_reply: shouldReply,
      should_escalate: action === 'escalate',
      escalation_reason: escalationReason,
      confidence: decision.confidence ?? null,
      action,
      conversation: conversationResult.rows[0],
      outbound_message: outboundMessage,
      model_route: modelRun.routeId,
    };
  });
}

export async function recordModelFailure(turn, failure) {
  if (!turn || !turn.tenant || !turn.conversation) return;
  await pool.query(
    "insert into agent.model_runs (tenant_id, conversation_id, inbound_message_id, route_id, model, status, latency_ms, error_class, details) values ($1, $2, $3, $4, $5, 'error', $6, $7, $8::jsonb)",
    [
      turn.tenant.id,
      turn.conversation.id,
      turn.inboundMessage ? turn.inboundMessage.id : null,
      failure.routeId || 'none',
      failure.model || 'none',
      failure.latencyMs || null,
      failure.errorClass || 'unknown',
      JSON.stringify({
        message: cleanText(failure.message, 2000),
        retryable: Boolean(failure.retryable),
      })
    ]
  );
}

export async function resetEscalation(input) {
  const tenantKey = cleanText(input.tenantKey, 200);
  return transaction(async (client) => {
    const tenantResult = await client.query("select id from agent.tenants where tenant_key = $1", [tenantKey]);
    if (!tenantResult.rowCount) throw new Error('Tenant not found');
    const tenantId = tenantResult.rows[0].id;
    let result;
    if (input.conversationId) {
      result = await client.query(
        "update agent.conversations set status = 'active', escalated_at = null, escalation_reason = null where tenant_id = $1 and id = $2 returning *",
        [tenantId, cleanText(input.conversationId, 100)]
      );
    } else {
      result = await client.query(
        "update agent.conversations set status = 'active', escalated_at = null, escalation_reason = null where tenant_id = $1 and channel = $2 and external_thread_id = $3 returning *",
        [tenantId, cleanText(input.channel, 50).toLowerCase(), cleanText(input.externalThreadId, 500)]
      );
    }
    if (!result.rowCount) throw new Error('Conversation not found');
    const conversation = result.rows[0];
    await client.query(
      "insert into agent.messages (tenant_id, conversation_id, contact_id, channel, direction, role, content, payload) values ($1, $2, $3, $4, 'internal', 'operator', $5, $6::jsonb)",
      [tenantId, conversation.id, conversation.contact_id, conversation.channel, cleanText(input.note || 'Escalation reset by operator', 2000), JSON.stringify({ event: 'escalation_reset' })]
    );
    return conversation;
  });
}

export async function linkIdentities(input) {
  const tenantKey = cleanText(input.tenantKey, 200);
  const sourceChannel = cleanText(input.sourceChannel, 50).toLowerCase();
  const sourceUserId = cleanText(input.sourceUserId, 500);
  const targetChannel = cleanText(input.targetChannel, 50).toLowerCase();
  const targetUserId = cleanText(input.targetUserId, 500);
  if (!tenantKey || !sourceChannel || !sourceUserId || !targetChannel || !targetUserId) {
    throw new Error('tenantKey and both channel/user identity pairs are required');
  }

  return transaction(async (client) => {
    const tenant = await ensureTenantWithClient(client, tenantKey, input.tenantName || tenantKey);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      tenant.id + ':identity-link:' + sourceChannel + ':' + sourceUserId + ':' + targetChannel + ':' + targetUserId
    ]);

    const findIdentity = async (channel, userId) => {
      const result = await client.query(
        "select * from agent.identities where tenant_id = $1 and channel = $2 and external_user_id = $3",
        [tenant.id, channel, userId]
      );
      return result.rows[0] || null;
    };

    let source = await findIdentity(sourceChannel, sourceUserId);
    let target = await findIdentity(targetChannel, targetUserId);
    let canonicalContactId = source ? source.contact_id : target ? target.contact_id : null;

    if (!canonicalContactId) {
      const contact = await client.query(
        "insert into agent.contacts (tenant_id, display_name) values ($1, $2) returning id",
        [tenant.id, cleanText(input.displayName, 500) || null]
      );
      canonicalContactId = contact.rows[0].id;
    }

    const createIdentity = async (channel, userId) => {
      const result = await client.query(
        "insert into agent.identities (tenant_id, contact_id, channel, external_user_id) values ($1, $2, $3, $4) on conflict (tenant_id, channel, external_user_id) do update set contact_id = excluded.contact_id returning *",
        [tenant.id, canonicalContactId, channel, userId]
      );
      return result.rows[0];
    };

    if (!source) source = await createIdentity(sourceChannel, sourceUserId);
    if (!target) target = await createIdentity(targetChannel, targetUserId);

    const duplicateContactIds = [...new Set([source.contact_id, target.contact_id])].filter((id) => id !== canonicalContactId);
    for (const duplicateId of duplicateContactIds) {
      const duplicateProfile = await client.query("select profile from agent.contacts where id = $1", [duplicateId]);
      if (duplicateProfile.rowCount) {
        await client.query(
          "update agent.contacts set profile = profile || $2::jsonb where id = $1",
          [canonicalContactId, JSON.stringify(duplicateProfile.rows[0].profile || {})]
        );
      }
      await client.query("update agent.identities set contact_id = $1 where contact_id = $2", [canonicalContactId, duplicateId]);
      await client.query("update agent.conversations set contact_id = $1 where contact_id = $2", [canonicalContactId, duplicateId]);
      await client.query("update agent.messages set contact_id = $1 where contact_id = $2", [canonicalContactId, duplicateId]);
      await client.query("delete from agent.contacts where id = $1", [duplicateId]);
    }

    await client.query(
      "update agent.identities set contact_id = $1 where id in ($2, $3)",
      [canonicalContactId, source.id, target.id]
    );

    return { tenantId: tenant.id, contactId: canonicalContactId, source: { channel: sourceChannel, userId: sourceUserId }, target: { channel: targetChannel, userId: targetUserId } };
  });
}

export async function getContactState(input) {
  const result = await pool.query(
    "select t.tenant_key, c.id as contact_id, c.display_name, c.profile, i.channel, i.external_user_id, cv.id as conversation_id, cv.external_thread_id, cv.status, cv.summary, cv.semantic_state, cv.escalated_at, cv.escalation_reason, cv.last_message_at from agent.tenants t join agent.identities i on i.tenant_id = t.id join agent.contacts c on c.id = i.contact_id left join agent.conversations cv on cv.contact_id = c.id where t.tenant_key = $1 and i.channel = $2 and i.external_user_id = $3 order by cv.last_message_at desc nulls last",
    [cleanText(input.tenantKey, 200), cleanText(input.channel, 50).toLowerCase(), cleanText(input.externalUserId, 500)]
  );
  return result.rows;
}

export async function replaceKnowledge(input) {
  const tenantKey = cleanText(input.tenantKey, 200);
  const sourceKey = cleanText(input.sourceKey, 1000);
  const title = cleanText(input.title || sourceKey, 1000);
  const contentHash = cleanText(input.contentHash, 128);
  const metadata = cleanObject(input.metadata);
  const chunks = Array.isArray(input.chunks) ? input.chunks.map((chunk) => cleanText(chunk)).filter(Boolean) : [];
  if (!tenantKey || !sourceKey || !contentHash || !chunks.length) throw new Error('Knowledge document is incomplete');

  const tenant = await ensureTenant(tenantKey, input.tenantName || tenantKey);
  const existing = await transaction(async (client) => {
    const result = await client.query(
      "select d.id, d.content_hash, count(c.id)::integer as chunk_count from agent.knowledge_documents d left join agent.knowledge_chunks c on c.document_id = d.id where d.tenant_id = $1 and d.source_key = $2 group by d.id, d.content_hash",
      [tenant.id, sourceKey]
    );
    return result.rows[0] || null;
  });
  if (existing?.content_hash === contentHash && existing.chunk_count > 0) {
    return {
      documentId: existing.id,
      chunks: existing.chunk_count,
      sourceKey,
      unchanged: true,
    };
  }

  const embeddingRows = [];
  const batchSize = Number(process.env.LOCAL_EMBEDDING_BATCH_SIZE || 24);
  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize);
    embeddingRows.push(...await embedPassages(batch));
  }

  return transaction(async (client) => {
    const documentResult = await client.query(
      "insert into agent.knowledge_documents (tenant_id, source_key, title, content_hash, metadata) values ($1, $2, $3, $4, $5::jsonb) on conflict (tenant_id, source_key) do update set title = excluded.title, content_hash = excluded.content_hash, metadata = excluded.metadata returning *",
      [tenant.id, sourceKey, title, contentHash, JSON.stringify(metadata)]
    );
    const document = documentResult.rows[0];
    await client.query("delete from agent.knowledge_chunks where document_id = $1", [document.id]);

    for (let index = 0; index < chunks.length; index += 1) {
      await client.query(
        "insert into agent.knowledge_chunks (tenant_id, document_id, chunk_index, content, embedding, metadata) values ($1, $2, $3, $4, $5::vector, $6::jsonb)",
        [tenant.id, document.id, index, chunks[index], vectorLiteral(embeddingRows[index]), JSON.stringify({ ...metadata, chunkIndex: index })]
      );
    }
    return { documentId: document.id, chunks: chunks.length, sourceKey, unchanged: false };
  });
}

export async function dbHealth() {
  const result = await pool.query(
    "select current_database() as database, current_user as user, (select count(*)::int from agent.tenants) as tenants, (select count(*)::int from agent.messages) as messages, (select count(*)::int from agent.knowledge_chunks) as knowledge_chunks"
  );
  return result.rows[0];
}

export async function closeDatabase() {
  await pool.end();
}


export async function pruneKnowledge(input) {
  const tenantKey = cleanText(input?.tenantKey, 200);
  const sourceKeys = Array.isArray(input?.sourceKeys)
    ? [...new Set(input.sourceKeys.map((value) => cleanText(value, 1000)).filter(Boolean))]
    : [];
  if (!tenantKey || !sourceKeys.length) throw new Error('Knowledge prune requires tenantKey and at least one retained sourceKey');
  const tenant = await ensureTenant(tenantKey, input?.tenantName || tenantKey);
  return transaction(async (client) => {
    const result = await client.query(
      'delete from agent.knowledge_documents where tenant_id = $1 and not (source_key = any($2::text[])) returning source_key',
      [tenant.id, sourceKeys]
    );
    return { removed: result.rowCount, sourceKeys: result.rows.map((row) => row.source_key) };
  });
}
