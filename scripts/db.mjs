import pg from "pg";

const { Pool } = pg;
let pool;

function databaseUrl() {
  return process.env.LOCAL_POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
}

export function databaseConfigured() {
  return Boolean(databaseUrl());
}

export function getPool() {
  if (!pool) {
    const connectionString = databaseUrl();
    if (!connectionString) throw new Error("LOCAL_POSTGRES_URL is required");
    pool = new Pool({
      connectionString,
      max: Number(process.env.BOT_DB_POOL_SIZE || 10),
      idleTimeoutMillis: 30000,
      application_name: "portable-conversational-agent"
    });
  }
  return pool;
}

async function tenantFor(client, input) {
  if (input.tenant_id) {
    const result = await client.query("select * from agent.tenants where id = $1", [input.tenant_id]);
    if (!result.rowCount) throw new Error("Unknown tenant_id");
    return result.rows[0];
  }

  const slug = String(input.tenant_slug || process.env.BOT_TENANT_SLUG || "default");
  const name = String(input.tenant_name || slug);
  const settings = input.tenant_settings && typeof input.tenant_settings === "object"
    ? input.tenant_settings
    : {};

  const result = await client.query(
    `insert into agent.tenants (slug, name, settings)
     values ($1, $2, $3::jsonb)
     on conflict (slug) do update
       set name = coalesce(nullif(excluded.name, ''), agent.tenants.name),
           updated_at = now()
     returning *`,
    [slug, name, JSON.stringify(settings)]
  );
  return result.rows[0];
}

export async function beginTurn(input) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const tenant = await tenantFor(client, input);
    const channel = String(input.channel || "internal");
    const externalUserId = String(input.external_user_id || input.external_thread_id || "anonymous");
    const externalThreadId = String(input.external_thread_id || externalUserId);
    const lockKey = `${tenant.id}:${channel}:${externalUserId}:${externalThreadId}`;
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);

    let identity = await client.query(
      `select ci.*, c.display_name, c.profile
         from agent.contact_identities ci
         join agent.contacts c on c.id = ci.contact_id
        where ci.tenant_id = $1 and ci.channel = $2 and ci.external_user_id = $3`,
      [tenant.id, channel, externalUserId]
    );

    if (!identity.rowCount) {
      const contact = await client.query(
        `insert into agent.contacts (tenant_id, display_name, profile)
         values ($1, $2, $3::jsonb) returning *`,
        [
          tenant.id,
          input.display_name || null,
          JSON.stringify(input.contact_profile || {})
        ]
      );
      identity = await client.query(
        `insert into agent.contact_identities
           (tenant_id, contact_id, channel, external_user_id, metadata)
         values ($1, $2, $3, $4, $5::jsonb)
         returning *, $6::text as display_name, $7::jsonb as profile`,
        [
          tenant.id,
          contact.rows[0].id,
          channel,
          externalUserId,
          JSON.stringify(input.identity_metadata || {}),
          input.display_name || null,
          JSON.stringify(input.contact_profile || {})
        ]
      );
    }

    const contactId = identity.rows[0].contact_id;
    let conversation = await client.query(
      `select * from agent.conversations
        where tenant_id = $1 and channel = $2 and external_thread_id = $3
        for update`,
      [tenant.id, channel, externalThreadId]
    );

    if (!conversation.rowCount) {
      conversation = await client.query(
        `insert into agent.conversations
           (tenant_id, contact_id, channel, external_thread_id)
         values ($1, $2, $3, $4) returning *`,
        [tenant.id, contactId, channel, externalThreadId]
      );
    }

    const conversationRow = conversation.rows[0];
    const message = await client.query(
      `insert into agent.messages
         (tenant_id, conversation_id, channel, external_event_id, role, content, metadata)
       values ($1, $2, $3, $4, 'user', $5, $6::jsonb)
       on conflict (tenant_id, channel, external_event_id)
         where external_event_id is not null
       do nothing
       returning id`,
      [
        tenant.id,
        conversationRow.id,
        channel,
        input.external_event_id || null,
        String(input.text || ""),
        JSON.stringify(input.metadata || {})
      ]
    );

    const duplicate = Boolean(input.external_event_id && !message.rowCount);
    await client.query(
      `update agent.conversations
          set last_message_at = now(), updated_at = now()
        where id = $1`,
      [conversationRow.id]
    );

    const history = await client.query(
      `select m.role, m.content, m.channel, m.created_at
         from agent.messages m
         join agent.conversations c on c.id = m.conversation_id
        where c.tenant_id = $1 and c.contact_id = $2
          and ($3::uuid is null or m.id <> $3)
        order by m.created_at desc
        limit $4`,
      [
        tenant.id,
        contactId,
        message.rows[0]?.id || null,
        Number(process.env.BOT_HISTORY_LIMIT || 30)
      ]
    );

    await client.query("commit");
    return {
      tenant,
      contact_id: contactId,
      conversation: conversationRow,
      channel,
      external_user_id: externalUserId,
      external_thread_id: externalThreadId,
      duplicate,
      paused: conversationRow.bot_paused,
      history: history.rows.reverse()
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function retrieveKnowledge({ tenantId, text, embedding, limit = 8 }) {
  const client = await getPool().connect();
  try {
    if (Array.isArray(embedding) && embedding.length) {
      const result = await client.query(
        `select kc.content, kd.title, kd.source_uri, kc.metadata,
                (
                  0.72 * (1 - (kc.embedding <=> $3::vector)) +
                  0.28 * ts_rank_cd(kc.search_vector, websearch_to_tsquery('simple', $2))
                ) as score
           from agent.knowledge_chunks kc
           join agent.knowledge_documents kd on kd.id = kc.document_id
          where kc.tenant_id = $1 and kc.embedding is not null
          order by score desc
          limit $4`,
        [tenantId, text, `[${embedding.join(",")}]`, limit]
      );
      return result.rows;
    }

    const result = await client.query(
      `select kc.content, kd.title, kd.source_uri, kc.metadata,
              ts_rank_cd(kc.search_vector, websearch_to_tsquery('simple', $2)) as score
         from agent.knowledge_chunks kc
         join agent.knowledge_documents kd on kd.id = kc.document_id
        where kc.tenant_id = $1
          and kc.search_vector @@ websearch_to_tsquery('simple', $2)
        order by score desc
        limit $3`,
      [tenantId, text, limit]
    );
    return result.rows;
  } finally {
    client.release();
  }
}

export async function finishTurn({ turn, decision, model }) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    let effectiveDecision = decision;

    if (decision.action === "escalate") {
      const updated = await client.query(
        `update agent.conversations
            set bot_paused = true,
                status = 'escalated',
                escalation_reason = $2,
                escalated_at = now(),
                escalation_acknowledged_at = now(),
                context_summary = coalesce(nullif($3, ''), context_summary),
                updated_at = now()
          where id = $1 and bot_paused = false
          returning id`,
        [turn.conversation.id, decision.escalation_reason, decision.memory_summary]
      );
      if (!updated.rowCount) {
        effectiveDecision = { ...decision, action: "silent", message: "" };
      }
    } else {
      await client.query(
        `update agent.conversations
            set context_summary = coalesce(nullif($2, ''), context_summary),
                updated_at = now()
          where id = $1`,
        [turn.conversation.id, decision.memory_summary]
      );
    }

    if (
      (effectiveDecision.action === "reply" || effectiveDecision.action === "escalate") &&
      effectiveDecision.message
    ) {
      await client.query(
        `insert into agent.messages
           (tenant_id, conversation_id, channel, role, content, metadata)
         values ($1, $2, $3, 'assistant', $4, $5::jsonb)`,
        [
          turn.tenant.id,
          turn.conversation.id,
          turn.channel,
          effectiveDecision.message,
          JSON.stringify({
            provider: model.provider,
            model: model.model,
            action: effectiveDecision.action
          })
        ]
      );
    }

    await client.query(
      `insert into agent.model_runs
         (tenant_id, conversation_id, provider, model, action, confidence,
          latency_ms, route_attempts, usage, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
      [
        turn.tenant.id,
        turn.conversation.id,
        model.provider,
        model.model,
        effectiveDecision.action,
        effectiveDecision.confidence,
        model.latency_ms,
        JSON.stringify(model.attempts || []),
        JSON.stringify(model.usage || {}),
        JSON.stringify({
          intent: effectiveDecision.intent,
          lead_stage: effectiveDecision.lead_stage
        })
      ]
    );

    await client.query("commit");
    return effectiveDecision;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function resetEscalation(input) {
  const client = await getPool().connect();
  try {
    const tenant = await tenantFor(client, input);
    const values = [tenant.id];
    const clauses = ["tenant_id = $1", "bot_paused = true"];

    if (input.conversation_id) {
      values.push(input.conversation_id);
      clauses.push(`id = $${values.length}`);
    } else {
      if (!input.channel || !input.external_thread_id) {
        throw new Error("Provide conversation_id, or channel and external_thread_id");
      }
      values.push(input.channel);
      clauses.push(`channel = $${values.length}`);
      values.push(input.external_thread_id);
      clauses.push(`external_thread_id = $${values.length}`);
    }

    const result = await client.query(
      `update agent.conversations
          set bot_paused = false,
              status = 'active',
              escalation_reason = null,
              escalated_at = null,
              escalation_acknowledged_at = null,
              updated_at = now()
        where ${clauses.join(" and ")}
        returning id, channel, external_thread_id, status, bot_paused`,
      values
    );
    return result.rows;
  } finally {
    client.release();
  }
}

export async function replaceKnowledgeDocument(input, chunks) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const tenant = await tenantFor(client, input);
    const document = await client.query(
      `insert into agent.knowledge_documents
         (tenant_id, source_key, title, source_uri, checksum, metadata)
       values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (tenant_id, source_key) do update
         set title = excluded.title,
             source_uri = excluded.source_uri,
             checksum = excluded.checksum,
             metadata = excluded.metadata,
             updated_at = now()
       returning *`,
      [
        tenant.id,
        input.source_key,
        input.title,
        input.source_uri || null,
        input.checksum || null,
        JSON.stringify(input.metadata || {})
      ]
    );

    await client.query("delete from agent.knowledge_chunks where document_id = $1", [document.rows[0].id]);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await client.query(
        `insert into agent.knowledge_chunks
           (tenant_id, document_id, chunk_index, content, embedding, metadata)
         values ($1, $2, $3, $4, $5::vector, $6::jsonb)`,
        [
          tenant.id,
          document.rows[0].id,
          index,
          chunk.content,
          chunk.embedding ? `[${chunk.embedding.join(",")}]` : null,
          JSON.stringify(chunk.metadata || {})
        ]
      );
    }
    await client.query("commit");
    return { tenant_id: tenant.id, document_id: document.rows[0].id, chunks: chunks.length };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
