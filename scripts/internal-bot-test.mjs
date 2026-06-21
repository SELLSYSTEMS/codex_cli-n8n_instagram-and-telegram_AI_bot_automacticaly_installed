#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

function loadDotEnv(path = '.env') {
  if (!fs.existsSync(path)) return;
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const args = { channel: 'internal_test', log: true, reset: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--message') args.message = argv[++i];
    else if (arg === '--thread') args.thread = argv[++i];
    else if (arg === '--tenant') args.tenant = argv[++i];
    else if (arg === '--channel') args.channel = argv[++i];
    else if (arg === '--reset') args.reset = true;
    else if (arg === '--no-log') args.log = false;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/internal-bot-test.mjs --message "What do you offer?" --thread local-test-001
  node scripts/internal-bot-test.mjs --reset --thread local-test-001

Options:
  --message TEXT   Message to send into the bot brain without IG/TG
  --thread ID      Stable internal test thread id
  --tenant ID      Tenant id; defaults to DEFAULT_TENANT_ID or demo
  --channel NAME   Defaults to internal_test; do not use instagram for local tests
  --reset          Reset escalation marker for the internal test thread
  --no-log         Run without writing conversation_events
`;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${url} failed: HTTP ${res.status} ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

function maxSimilarity(matches) {
  return matches.reduce((max, row) => Math.max(max, Number(row.similarity || 0)), 0);
}

function hasHardEscalationSignal(message) {
  const normalized = String(message || '').toLowerCase();
  return /\b(human|operator|manager|escalate|complaint|refund|legal|lawyer|angry|urgent|call me|real person|human agent|live agent|support person)\b/.test(normalized);
}

function hasSalesIntent(message) {
  const normalized = String(message || '').toLowerCase();
  return /\b(price|pricing|cost|package|packages|offer|offers|service|services|sell|buy|quote|proposal|instagram|automation|dm|lead|leads|audit|workflow|crm|bot|chatbot|sales|business|website|payment|payments|content|marketplace|support|process|system)\b|цена|цены|прайс|стоим|сколько|пакет|пакеты|услуг|сервис|предлож|аудит|автоматизац|бот|инстаграм|телеграм|сайт|crm|црм|оплат|лид|лиды|продаж|контент|маркетплейс|бизнес|проблем|процесс|система|поддержк|что вы можете|чем помог/i.test(normalized);
}

function hasSalesCriticalContext(matches) {
  return (Array.isArray(matches) ? matches : []).some((match) => {
    const haystack = [match.source_key, match.source_type, match.chunk_text].join(' ').toLowerCase();
    return /private_bot_memory|company_identity|services?|offers?|fixed_price|price|pricing|quote|package|sales|playbook|qualification|scoping|dialogue|objection/.test(haystack);
  });
}

function shouldEscalate(message, confidence, threshold, matches = []) {
  const hardHandoff = hasHardEscalationSignal(message);
  const salesIntent = hasSalesIntent(message);
  const salesContext = hasSalesCriticalContext(matches);
  const answerableNearThreshold = matches.length > 0 && confidence >= Math.max(0.28, threshold - 0.12);
  const salesContextOverride = salesIntent && salesContext && confidence >= 0.28;

  if (hardHandoff) {
    return { escalate: true, reason: 'explicit_handoff_request', sales_intent: salesIntent, sales_context: salesContext };
  }

  if (matches.length === 0) {
    return { escalate: true, reason: 'no_retrieved_context', sales_intent: salesIntent, sales_context: salesContext };
  }

  if (salesContextOverride) {
    return { escalate: false, reason: 'sales_context_override', sales_intent: salesIntent, sales_context: salesContext };
  }

  if (answerableNearThreshold) {
    return { escalate: false, reason: 'near_threshold_with_context', sales_intent: salesIntent, sales_context: salesContext };
  }

  return {
    escalate: confidence < threshold,
    reason: confidence < threshold ? 'low_rag_confidence' : 'answerable_confidence',
    sales_intent: salesIntent,
    sales_context: salesContext,
  };
}

function sourceLabel(row) {
  return row.source_key || row.source_type || row.id || 'unknown_source';
}

function buildContext(matches) {
  return matches.map((row, index) => {
    const text = String(row.chunk_text || '').trim();
    return `Source ${index + 1}: ${sourceLabel(row)}\n${text}`;
  }).join('\n\n---\n\n');
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const tenant = args.tenant || process.env.DEFAULT_TENANT_ID || 'demo';
  const thread = args.thread || `internal-${Date.now()}`;
  const channel = args.channel || 'internal_test';
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const openaiKey = requireEnv('OPENAI_API_KEY');
  if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');
  if (!supabaseKey) throw new Error('Missing SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY, or SUPABASE_ANON_KEY');

  const restBase = `${supabaseUrl}/rest/v1`;
  const supabaseHeaders = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  if (args.reset) {
    const state = await requestJson(`${restBase}/rpc/reset_thread_escalation`, {
      method: 'POST',
      headers: supabaseHeaders,
      body: JSON.stringify({
        p_tenant_id: tenant,
        p_channel: channel,
        p_thread_id: thread,
        p_reset_by: 'internal-bot-test-cli',
        p_note: 'Reset from local internal bot test harness',
      }),
    });
    console.log(JSON.stringify({ ok: true, action: 'reset', tenant_id: tenant, channel, thread_id: thread, state }, null, 2));
    return;
  }

  if (!args.message) throw new Error('--message is required unless --reset is used');

  const threadState = await requestJson(`${restBase}/rpc/get_thread_state`, {
    method: 'POST',
    headers: supabaseHeaders,
    body: JSON.stringify({ p_tenant_id: tenant, p_channel: channel, p_thread_id: thread }),
  });

  if (threadState?.status === 'escalated' && threadState?.silence_after_escalation !== false) {
    if (args.log) {
      await requestJson(`${restBase}/conversation_events`, {
        method: 'POST',
        headers: { ...supabaseHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          tenant_id: tenant,
          channel,
          instagram_thread_id: thread,
          role: 'user',
          content: args.message,
          intent: 'muted_after_escalation',
          confidence: null,
          escalated: true,
          raw_event: { source: 'internal_bot_test', muted_by_thread_state: threadState },
        }),
      });
    }
    console.log(JSON.stringify({
      ok: true,
      status: 'silent_already_escalated',
      tenant_id: tenant,
      channel,
      thread_id: thread,
      response: null,
      reset_hint: `select public.reset_thread_escalation('${tenant}', '${channel}', '${thread}', 'operator', 'handoff complete');`,
    }, null, 2));
    return;
  }

  const tenantSettings = await requestJson(`${restBase}/rpc/get_tenant_settings`, {
    method: 'POST',
    headers: supabaseHeaders,
    body: JSON.stringify({ p_tenant_id: tenant }),
  });

  const threadContext = await requestJson(`${restBase}/rpc/get_thread_context`, {
    method: 'POST',
    headers: supabaseHeaders,
    body: JSON.stringify({ p_tenant_id: tenant, p_thread_id: thread, p_limit: 8 }),
  });

  const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  const embeddingBody = await requestJson('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: embeddingModel, input: args.message }),
  });
  const embedding = embeddingBody.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error('OpenAI embedding response did not contain data[0].embedding');

  const matchCount = Number(process.env.SUPABASE_MATCH_COUNT || 5);
  const minSimilarity = Number(process.env.SUPABASE_MIN_SIMILARITY || 0.1);
  const matches = await requestJson(`${restBase}/rpc/match_documents`, {
    method: 'POST',
    headers: supabaseHeaders,
    body: JSON.stringify({ p_tenant_id: tenant, query_embedding: embedding, match_count: matchCount, min_similarity: minSimilarity }),
  });

  const confidence = maxSimilarity(Array.isArray(matches) ? matches : []);
  const threshold = Number(process.env.RAG_CONFIDENCE_THRESHOLD || tenantSettings?.confidence_threshold || 0.30);
  const decision = shouldEscalate(args.message, confidence, threshold, Array.isArray(matches) ? matches : []);
  const escalate = decision.escalate;

  if (args.log) {
    await requestJson(`${restBase}/conversation_events`, {
      method: 'POST',
      headers: { ...supabaseHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        tenant_id: tenant,
        channel,
        instagram_thread_id: thread,
        role: 'user',
        content: args.message,
        intent: escalate ? 'internal_test_escalation_candidate' : 'internal_test_message',
        confidence,
        matched_document_ids: (Array.isArray(matches) ? matches : []).map((row) => row.id).filter(Boolean),
        escalated: false,
        raw_event: { source: 'internal_bot_test' },
      }),
    });
  }

  let response;
  if (escalate) {
    response = 'I will ask a human operator to review this and follow up. I will stay silent here until the operator resets the handoff marker.';
    await requestJson(`${restBase}/rpc/mark_thread_escalated`, {
      method: 'POST',
      headers: supabaseHeaders,
      body: JSON.stringify({
        p_tenant_id: tenant,
        p_channel: channel,
        p_thread_id: thread,
        p_reason: decision.reason || (confidence < threshold ? 'low_rag_confidence' : 'explicit_handoff_request'),
        p_metadata: { source: 'internal_bot_test', confidence, threshold, decision },
      }),
    });
  } else {
    const chatModel = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const context = buildContext(Array.isArray(matches) ? matches.slice(0, matchCount) : []);
    const latestMessage = args.message || '';
const hasCyrillic = /[А-Яа-яЁё]/.test(latestMessage);
const hasCjk = /[\u3400-\u9FFF\uF900-\uFAFF]/u.test(latestMessage);
const customerLanguage = hasCyrillic ? 'Russian' : hasCjk ? 'Cantonese/Traditional Chinese' : 'English';
const preferredCurrency = /(hong\s*kong|\bhk\b|hk\$|香港|港|廣東話|广东话|粵語|粤语|cantonese)/i.test(latestMessage) || hasCjk ? 'HKD' : 'USD';
    const priorMessages = Array.isArray(threadContext)
      ? threadContext.map((event) => `${event.role}: ${event.content}`).join('\n')
      : '';
    const chatBody = await requestJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: [
              `You are the official ${tenantSettings?.brand_name || 'Sell.Systems'} inbound sales assistant test harness for Instagram DM.`,
              `Required output language: ${customerLanguage}\nRequired pricing currency: ${preferredCurrency}. This overrides retrieved context language.`,
    `Required pricing currency: ${preferredCurrency}. Default to USD for international users. Use HKD only when the customer is clearly in Hong Kong, mentions HK/Hong Kong, or writes in Cantonese/Chinese. This overrides retrieved context currency.`,
              'Use retrieved company context to sell and qualify inbound leads.',
              'If services, packages, audits, quote logic, or pricing guidance appear in context, answer with those details and recommend the next step.',
    'Treat every inbound interest as sales discovery: if the customer asks about automation, AI, bots, Instagram, Telegram, CRM, websites, payments, leads, content, marketplaces, operations, support, pricing, or business problems, connect it to relevant Sell.Systems offers from context, explain the practical outcome, recommend the smallest useful next step, and ask one specific qualifying question.',
    'If the user asks about prices, packages, services, costs, quotes, budgets, or what Sell.Systems offers, and the retrieved context contains fixed prices, anchor prices, currency amounts, packages, product names, or offer tables, name the relevant amounts directly in the context currency before saying details may vary.',
    'For broad pricing questions, give a compact menu of the most relevant retrieved offers instead of a vague depends answer.',
    'If exact pricing is missing from retrieved context, say pricing depends on scope and ask one or two qualification questions.',
              'Escalate only for explicit human handoff, legal/refund/complaint issues, sensitive account-specific cases, or no useful context.',
              'Reply in the same language as the latest customer message. Do not switch language because retrieved context is written in another language. Keep it concise, practical, and sales-oriented.',
              'Do not mention this is an internal test unless the user asks.',
            ].join(' '),
          },
          {
            role: 'user',
            content: `Required output language: ${customerLanguage}\n\nRecent thread context:\n${priorMessages || '(none)'}\n\nRetrieved company context:\n${context || '(none)'}\n\nIncoming message:\n${args.message}`,
          },
        ],
      }),
    });
    response = chatBody.choices?.[0]?.message?.content?.trim();
    if (!response) throw new Error('OpenAI chat response did not contain choices[0].message.content');
  }

  if (args.log) {
    await requestJson(`${restBase}/conversation_events`, {
      method: 'POST',
      headers: { ...supabaseHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        tenant_id: tenant,
        channel,
        instagram_thread_id: thread,
        role: 'assistant',
        content: response,
        intent: escalate ? 'internal_test_escalated' : 'internal_test_answer',
        confidence,
        matched_document_ids: (Array.isArray(matches) ? matches : []).map((row) => row.id).filter(Boolean),
        model_name: escalate ? 'handoff_rule' : (process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini'),
        escalated: escalate,
        raw_event: { source: 'internal_bot_test', thread_state: escalate ? 'escalated' : 'bot_active', decision },
      }),
    });
  }

  console.log(JSON.stringify({
    ok: true,
    status: escalate ? 'escalated' : 'answered',
    tenant_id: tenant,
    channel,
    thread_id: thread,
    confidence,
    threshold,
    decision_reason: decision.reason,
    sales_intent: decision.sales_intent,
    sales_context: decision.sales_context,
    response,
    matched_sources: (Array.isArray(matches) ? matches : []).slice(0, matchCount).map((row) => ({
      source_key: row.source_key,
      source_type: row.source_type || row.metadata?.source_type,
      similarity: row.similarity,
    })),
    reset_hint: escalate ? `node scripts/internal-bot-test.mjs --reset --thread ${thread}` : null,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
