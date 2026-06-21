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
  const explicitEnglishHandoff = /\b(human|operator|real person|live agent|escalate|transfer me|connect me|talk to (?:a )?(?:human|person|agent|operator|manager))\b/i.test(normalized);
  const sensitiveEnglish = /\b(complaint|refund|chargeback|legal|lawyer|lawsuit|contract dispute|angry|urgent|emergency|data deletion|gdpr|privacy request|security incident|account access|password|billing dispute)\b/i.test(normalized);
  const explicitRussianHandoff = /(?:подключ(?:и|ите)?|позови(?:те)?|дай(?:те)?|нуж(?:ен|на)|хочу|перевед(?:и|ите)|соедин(?:и|ите)|передай(?:те)?|передать).{0,50}(?:оператор|человек|менеджер|специалист|живой|живого)|(?:оператор|человек|менеджер|специалист).{0,30}(?:позвонит|ответит|свяжется|нужен|нужна)/iu.test(normalized);
  const sensitiveRussian = /жалоб|возврат|чарджбек|юрист|суд|договор.*спор|срочно|экстренно|удал.*данн|персональн.*данн|доступ.*аккаунт|парол|спор.*оплат/iu.test(normalized);
  const explicitChineseHandoff = /人工|真人|客服|转接|轉接|转人工|轉人工|联系人工|聯繫人工|找人|经理|經理/u.test(normalized);
  const sensitiveChinese = /投诉|投訴|退款|法律|律师|律師|紧急|緊急|隐私|隱私|删除数据|刪除資料|账号|帳號|密码|密碼/u.test(normalized);
  const explicitVietnameseHandoff = /(?:gặp|chuyển|noi|nói|liên hệ|ket noi|kết nối).{0,40}(?:người thật|nhân viên|tư vấn viên|quản lý|operator|support)|(?:người thật|nhân viên|tư vấn viên|quản lý).{0,30}(?:trả lời|liên hệ|gọi|hỗ trợ)/iu.test(normalized);
  const sensitiveVietnamese = /khiếu nại|hoàn tiền|pháp lý|luật sư|khẩn cấp|xóa dữ liệu|xoá dữ liệu|quyền riêng tư|mật khẩu|tranh chấp thanh toán/iu.test(normalized);

  return explicitEnglishHandoff || sensitiveEnglish
    || explicitRussianHandoff || sensitiveRussian
    || explicitChineseHandoff || sensitiveChinese
    || explicitVietnameseHandoff || sensitiveVietnamese;
}

function hasSalesIntent(message) {
  const normalized = String(message || '').toLowerCase();
  return /\b(price|pricing|cost|package|packages|offer|offers|service|services|sell|buy|quote|proposal|instagram|automation|dm|lead|leads|audit|workflow|crm|bot|chatbot|sales|business|website|site|landing|shop|store|ecommerce|payment|payments|content|marketplace|support|process|system|operations|integration|api|problem|customer|client|booking|order|funnel)\b|цен|прайс|стоим|сколько|пакет|услуг|сервис|предлож|аудит|автоматизац|бот|инстаграм|телеграм|сайт|лендинг|магазин|crm|црм|оплат|лид|продаж|контент|маркетплейс|бизнес|проблем|процесс|система|поддержк|клиент|заявк|заказ|воронк|интеграц|api|апи|что вы можете|чем помог|价格|價錢|多少钱|多少錢|自动化|自動化|机器人|機器人|客户|客戶|销售|銷售|线索|線索|网站|網站|漏斗|giá|bao nhiêu|tự động|tu dong|khách|khach|lead|bán hàng|ban hang|website|trang web|phễu|pheu|crm|bot/i.test(normalized);
}

function isConversationStarter(message) {
  const value = String(message || '').trim();
  return /^(?:hi|hello|hey|yo)(?:[\s!.?,;:]+|$)/i.test(value)
    || /^good\s*(?:morning|afternoon|evening)(?:[\s!.?,;:]+|$)/i.test(value)
    || /^(?:привет|здравствуй|здравствуйте|добрый|доброе)(?:[\s!.?,;:]+|$)/iu.test(value)
    || /^(?:hola|bonjour|hallo|ciao|xin chao|chao|chào)(?:[\s!.?,;:]+|$)/iu.test(value)
    || /^(?:你好|您好)(?:[\s!.?,;:，。！？、]+|$)/u.test(value);
}

function inferPreferredCurrency(message) {
  const normalized = String(message || '');
  const rules = [
    ['USD', /\b(usd|us\s*dollars?|dollars?|\$)\b/i],
    ['HKD', /\b(hkd|hk\$|hong\s*kong\s*dollars?)\b|港币|港幣/i],
    ['EUR', /\b(eur|euro|euros?)\b|€/i],
    ['GBP', /\b(gbp|pounds?|sterling)\b|£/i],
    ['AUD', /\b(aud|australian\s*dollars?)\b/i],
    ['CAD', /\b(cad|canadian\s*dollars?)\b/i],
    ['SGD', /\b(sgd|singapore\s*dollars?)\b/i],
    ['CNY', /\b(cny|rmb|yuan)\b|人民币|人民幣/i],
    ['JPY', /\b(jpy|yen)\b|¥/i],
    ['VND', /\b(vnd|dong|vietnamese\s*dong)\b|₫/i],
    ['THB', /\b(thb|baht)\b/i],
    ['AED', /\b(aed|dirham|dirhams)\b/i],
    ['INR', /\b(inr|rupees?)\b/i],
    ['RUB', /\b(rub|rouble|ruble|rubles?)\b|руб|₽/i],
  ];
  const match = rules.find(([, regex]) => regex.test(normalized));
  return match ? match[0] : 'USD';
}

function inferResponseLanguage(message) {
  const text = String(message || '').trim();
  if (!text) return 'the same language as the customer message';

  const cjkChars = text.match(/[\u3400-\u9FFF]/g) || [];
  const cyrillicChars = text.match(/[А-Яа-яЁё]/g) || [];
  const vietnameseChars = text.match(/[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/g) || [];
  const latinWords = text.match(/[A-Za-z][A-Za-z'’-]*/g) || [];

  if (cjkChars.length >= 2) return 'Chinese/Cantonese matching the customer message';
  if (cyrillicChars.length >= 2) return 'Russian';
  if (vietnameseChars.length >= 1) return 'Vietnamese';
  if (latinWords.length >= 2) return 'English';

  return 'the same language as the customer message';
}

function buildEscalationReply(responseLanguage) {
  if (responseLanguage === 'Russian') {
    return 'Передаю диалог человеку-оператору. Дальше я буду молчать в этом чате, пока оператор не сбросит маркер передачи.';
  }
  if (responseLanguage === 'Vietnamese') {
    return 'Tôi sẽ chuyển cuộc trò chuyện này cho nhân viên phụ trách. Tôi sẽ giữ im lặng tại đây cho đến khi nhân viên đặt lại trạng thái chuyển tiếp.';
  }
  if (String(responseLanguage || '').startsWith('Chinese')) {
    return '我会请人工客服查看并跟进。在操作员重置转接标记之前，我会在这里保持静默。';
  }
  return 'I will ask a human operator to review this and follow up. I will stay silent here until the operator resets the handoff marker.';
}

function buildGreetingReply(responseLanguage) {
  if (responseLanguage === 'Russian') {
    return 'Привет! Я помощник {{COMPANY_NAME}} по AI-автоматизации, продажам, CRM, Instagram/Telegram-ботам, сайтам и воронкам. Что сейчас важнее улучшить: больше лидов, скорость ответа клиентам, CRM-процесс или сайт/воронку?';
  }
  if (responseLanguage === 'Vietnamese') {
    return 'Xin chào! Tôi là trợ lý {{COMPANY_NAME}} về tự động hóa AI, bán hàng, CRM, bot Instagram/Telegram, website và phễu bán hàng. Bạn muốn cải thiện phần nào trước: thêm lead, tốc độ phản hồi, quy trình CRM hay website/phễu?';
  }
  if (String(responseLanguage || '').startsWith('Chinese')) {
    return '你好！我是 {{COMPANY_NAME}} 的 AI 自动化和销售系统助手，可以帮助规划 Instagram/Telegram 机器人、CRM、网站/漏斗和线索处理。你现在最想先改善哪一块：更多线索、回复速度、CRM 流程，还是网站/销售漏斗？';
  }
  return 'Hi! I am the {{COMPANY_NAME}} assistant for AI automation, sales/CRM workflows, Instagram/Telegram bots, websites, funnels, and lead handling. What should we improve first: more leads, faster replies, CRM process, or website/funnel?';
}

function isSimpleGreeting(message) {
  const value = String(message || '').trim();
  if (!isConversationStarter(value)) return false;
  if (hasSalesIntent(value)) return false;
  return value.split(/\s+/).filter(Boolean).length <= 3 && value.length <= 32;
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
  const conversationStarter = isConversationStarter(message);
  const salesContext = hasSalesCriticalContext(matches);

  if (hardHandoff) {
    return { escalate: true, reason: 'explicit_or_sensitive_handoff_request', sales_intent: salesIntent, sales_context: salesContext, semantic_fallback: false };
  }

  if (matches.length === 0 && (salesIntent || conversationStarter)) {
    return { escalate: false, reason: 'semantic_sales_discovery_fallback_no_rag_match', sales_intent: salesIntent, sales_context: salesContext, semantic_fallback: true };
  }

  if (matches.length === 0) {
    return { escalate: false, reason: 'topic_guardrail_fallback_no_rag_match', sales_intent: salesIntent, sales_context: salesContext, semantic_fallback: true };
  }

  if (salesContext) {
    return { escalate: false, reason: 'business_context_answer', sales_intent: salesIntent, sales_context: salesContext, semantic_fallback: false };
  }

  if (confidence < threshold) {
    return { escalate: false, reason: 'weak_context_answer_with_guardrail', sales_intent: salesIntent, sales_context: salesContext, semantic_fallback: true };
  }

  return {
    escalate: false,
    reason: 'answerable_confidence',
    sales_intent: salesIntent,
    sales_context: salesContext,
    semantic_fallback: false,
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

function buildSalesFallbackContext(message, currency = 'USD') {
  return [
    'Meaning-first fallback for inbound commercial conversations when Supabase RAG is weak, missing, or not directly matched.',
    'Primary goal: behave like a capable sales/discovery assistant, not a rigid FAQ bot. Understand customer intent across any language and keep the conversation moving toward a qualified next step.',
    'Greeting rule: for simple greetings or conversation starters, do not answer generically. Briefly position {{COMPANY_NAME}} around AI automation, sales/CRM workflows, Instagram/Telegram bots, websites/funnels, and lead handling, then ask which area the customer wants to improve first.',
    'Allowed offer families: AI automation, Instagram/Telegram DM assistants, lead-response systems, CRM/workflow automation, websites, landing pages, sales funnels, ecommerce/shop builds, payment flows, content/marketplace operations, and customer-support automations.',
    'Discovery rule: if a customer asks for something broad or unclear, infer the likely business problem, explain the practical outcome in one or two sentences, then ask one concrete qualification question. Do not give up because exact RAG text is missing.',
    'Website rule: a website request can connect to lead capture, CRM, analytics, payment, booking, and DM automation when relevant. Ask whether they need a landing page, company website, ecommerce/shop, or full funnel.',
    `Currency rule: default public pricing currency is USD for every language. Current requested/default currency: ${currency}. Use another currency only if the customer explicitly asks for that currency. Do not infer currency from language alone, including Chinese/Cantonese. Do not use HKD/HK$/港币/港幣 unless requested explicitly. If retrieved context contains non-USD prices but requested/default currency is USD, ignore those non-USD prices and quote the public USD anchors. If exact conversion is not in retrieved context, quote the USD base and say final local-currency invoice can be calculated after scope confirmation.`,
    'Pricing rule: use exact prices only when they are present in retrieved context. If exact pricing is missing, say pricing depends on scope and ask for the smallest missing scoping detail.',
    'Topic guardrail: if the message is not clearly related to {{COMPANY_NAME}} services, briefly steer back to automation, websites, bots, or sales systems and ask what business result they want. Do not escalate immediately for normal ambiguity or off-topic small talk.',
    'Escalate only when the user explicitly asks for a human/operator/manager, raises legal/refund/complaint/urgent/sensitive account-specific issues, or after repeated failed attempts where the bot cannot safely help.',
    `Latest customer message: ${String(message || '').trim() || '(empty)'}`,
  ].join('\n');
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
  const responseLanguage = inferResponseLanguage(args.message);
  const preferredCurrency = inferPreferredCurrency(args.message);
  const simpleGreeting = isSimpleGreeting(args.message);

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
    response = buildEscalationReply(responseLanguage);
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
  } else if (simpleGreeting) {
    response = buildGreetingReply(responseLanguage);
  } else {
    const chatModel = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const latestMessage = args.message || '';
    const retrievedContext = buildContext(Array.isArray(matches) ? matches.slice(0, matchCount) : []);
    const context = retrievedContext || buildSalesFallbackContext(latestMessage, preferredCurrency);
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
              `You are the official ${tenantSettings?.brand_name || '{{COMPANY_NAME}}'} inbound sales assistant test harness for Instagram DM.`,
              'Operate by meaning and customer intent, not by hard-coded language rules. Customers may write in any language and may request any currency.',
              'Reply in the same language as the latest customer message unless the customer asks for another language.',
              `Required response language: ${responseLanguage}. This controls customer-facing language only; do not use it for intent, price selection, currency, or escalation.`,
              'Every customer-facing sentence must be in the required response language. If it is English, answer only in English; if Russian, answer only in Russian; if Chinese/Cantonese, answer in Chinese/Cantonese.',
              `Default/requested pricing currency: ${preferredCurrency}. Default public pricing is USD for every language. Use another currency only if the customer explicitly asks for it. Do not infer HKD/CNY/local currency from Chinese/Cantonese text alone. Do not use HKD/HK$/港币/港幣 unless requested explicitly. If retrieved context contains non-USD prices but preferred currency is USD, ignore those non-USD prices and quote the public USD anchors. If conversion is not available in context, keep the base price in USD and say local-currency conversion can be confirmed after scope.`,
              'Use retrieved Supabase company context for factual claims. When fallback context is provided, use it for sales discovery, qualification, and safe offer-family framing only.',
              'Do not invent exact prices, delivery timelines, discounts, guarantees, or case studies that are not in the context.',
              'Treat ordinary interest as sales discovery: if the customer asks about automation, AI, bots, Instagram, Telegram, CRM, websites, payments, leads, content, marketplaces, operations, support, pricing, or business problems, connect it to relevant {{COMPANY_NAME}} offers, explain the practical outcome, recommend the smallest useful next step, and ask one specific qualifying question.',
      'For greetings/conversation starters, briefly introduce {{COMPANY_NAME}} as helping with AI automation, sales/CRM workflows, Instagram/Telegram bots, websites/funnels, and lead handling; ask one specific area to improve. Do not answer only “how can I help?”.',
              'If the user asks about prices, packages, services, costs, quotes, budgets, or what {{COMPANY_NAME}} offers, and the retrieved context contains fixed prices, anchor prices, currency amounts, packages, product names, or offer tables, name the relevant amounts directly before saying details may vary.',
              'For broad pricing questions, give a compact menu of the most relevant retrieved offers instead of a vague depends answer. If exact pricing is missing from retrieved context, say pricing depends on scope and ask one specific qualification question.',
              'If the user is vague, diagnose needs like a human consultant: identify the likely business objective, offer the closest relevant path, and ask one useful question.',
              'If the user is off-topic, do one short redirect back to {{COMPANY_NAME}} services. Only escalate after explicit human request, legal/refund/complaint/urgent/sensitive account-specific issue, or repeated inability to help safely.',
              'Do not escalate normal sales/service/website/pricing questions only because retrieval is weak.',
              'Keep it concise, practical, and sales-oriented.',
              'Do not mention this is an internal test unless the user asks.',
            ].join(' '),
          },
          {
            role: 'user',
            content: `Required response language:\n${responseLanguage}\n\nDefault/requested pricing currency:\n${preferredCurrency}\n\nRecent thread context:\n${priorMessages || '(none)'}\n\nRetrieved/fallback company context:\n${context || '(none)'}\n\nIncoming message:\n${args.message}`,
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
        model_name: escalate ? 'handoff_rule' : simpleGreeting ? 'greeting_rule' : (process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini'),
        escalated: escalate,
        raw_event: { source: 'internal_bot_test', thread_state: escalate ? 'escalated' : 'bot_active', decision, simple_greeting: simpleGreeting },
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
    semantic_fallback: decision.semantic_fallback,
    preferred_currency: preferredCurrency,
    simple_greeting: simpleGreeting,
    response_language: responseLanguage,
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
