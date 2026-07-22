import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const outputDirectory = path.resolve('workflows/generated');

function stableId(value) {
  const hash = crypto.createHash('md5').update(value).digest('hex');
  return [hash.slice(0, 8), hash.slice(8, 12), '4' + hash.slice(13, 16), 'a' + hash.slice(17, 20), hash.slice(20, 32)].join('-');
}

function node(workflowName, name, type, typeVersion, position, parameters, extra = {}) {
  return {
    id: stableId(workflowName + ':' + name),
    name,
    type,
    typeVersion,
    position,
    parameters,
    ...extra,
  };
}

function note(workflowName, name, content, position, size = [500, 250], color = 5) {
  return node(workflowName, name, 'n8n-nodes-base.stickyNote', 1, position, {
    content,
    height: size[1],
    width: size[0],
    color,
  });
}

function webhook(workflowName, name, method, webhookPath, position, responseMode = 'onReceived') {
  return node(workflowName, name, 'n8n-nodes-base.webhook', 2.1, position, {
    httpMethod: method,
    path: webhookPath,
    responseMode,
    options: {},
  }, { webhookId: stableId(workflowName + ':' + name + ':webhook') });
}

function code(workflowName, name, jsCode, position) {
  return node(workflowName, name, 'n8n-nodes-base.code', 2, position, { jsCode });
}

function http(workflowName, name, method, url, body, position, tokenMarker, extraHeaders = []) {
  const headers = tokenMarker ? [{ name: 'Authorization', value: 'Bearer ' + tokenMarker }] : [];
  headers.push(...extraHeaders);
  const parameters = {
    method,
    url,
    sendHeaders: headers.length > 0,
    headerParameters: { parameters: headers },
    sendBody: body !== null,
    contentType: 'raw',
    rawContentType: 'application/json',
    body: body === null ? undefined : body,
    options: {},
  };
  if (body === null) {
    delete parameters.contentType;
    delete parameters.rawContentType;
    delete parameters.body;
  }
  return node(workflowName, name, 'n8n-nodes-base.httpRequest', 4.2, position, parameters);
}

function merge(workflowName, name, position) {
  return node(workflowName, name, 'n8n-nodes-base.merge', 3.2, position, {
    mode: 'combine',
    combineBy: 'combineByPosition',
    options: {},
  });
}

function manual(workflowName, position = [0, 300]) {
  return node(workflowName, 'Run manually', 'n8n-nodes-base.manualTrigger', 1, position, {});
}

function responseNode(workflowName, name, body, position) {
  return node(workflowName, name, 'n8n-nodes-base.respondToWebhook', 1.4, position, {
    respondWith: 'text',
    responseBody: body,
    options: {
      responseHeaders: {
        entries: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
      },
    },
  });
}

function connect(connections, from, to, targetInput = 0) {
  if (!connections[from]) connections[from] = { main: [[]] };
  connections[from].main[0].push({ node: to, type: 'main', index: targetInput });
}

function workflow(name, nodes, connections) {
  return { name, active: false, nodes, connections, settings: { executionOrder: 'v1' } };
}

function brainHttp(workflowName, position) {
  return http(
    workflowName,
    'Ask shared AI brain',
    'POST',
    '__BRAIN_API_URL__/v1/messages',
    '={{ JSON.stringify($json) }}',
    position,
    '__BRAIN_API_TOKEN__',
  );
}

function prepareReplyCode() {
  return [
    "const reply = String($json.reply ?? '').trim();",
    'if ($json.should_reply !== true || !reply) return [];',
    'return [{ json: { ...$json, reply } }];',
  ].join('\n');
}

function instagramWorkflow() {
  const name = 'Channel - Instagram - Shared AI Brain';
  const nodes = [];
  const connections = {};
  nodes.push(note(name, 'Architecture', [
    '## Instagram transport adapter',
    'This workflow contains no sales or language logic.',
    'It verifies Meta, normalizes inbound Instagram messages, calls the shared LangGraph brain, and delivers only approved replies.',
    'All memory, RAG, model routing, escalation, and meaning remain outside n8n.',
  ].join('\n'), [-700, -50], [520, 300], 5));
  nodes.push(webhook(name, 'Instagram verification', 'GET', 'instagram-rag-webhook', [-600, 420], 'responseNode'));
  nodes.push(code(name, 'Validate verification token', [
    "const query = $json.query ?? {};",
    "const valid = query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === '__IG_WEBHOOK_VERIFY_TOKEN__';",
    "if (!valid) throw new Error('Invalid Instagram webhook verification request');",
    "return [{ json: { challenge: String(query['hub.challenge'] ?? '') } }];",
  ].join('\n'), [-330, 420]));
  nodes.push(responseNode(name, 'Return challenge', '={{ $json.challenge }}', [-60, 420]));
  nodes.push(webhook(name, 'Instagram messages', 'POST', 'instagram-rag-webhook', [-600, 760]));
  nodes.push(code(name, 'Normalize Instagram messages', [
    'const envelope = $json.body ?? $json;',
    "if (envelope.object !== 'instagram') return [];",
    'const output = [];',
    'for (const entry of envelope.entry ?? []) {',
    '  for (const event of entry.messaging ?? []) {',
    '    const text = String(event.message?.text ?? "").trim();',
    '    if (!text || (event.message?.is_echo || event.message?.is_self) === true) continue;',
    '    const sender = String(event.sender?.id ?? "");',
    '    if (!sender) continue;',
    '    output.push({ json: {',
    "      tenant_key: '__BRAIN_TENANT_KEY__',",
    "      channel: 'instagram',",
    '      external_user_id: sender,',
    '      external_thread_id: sender,',
    '      external_message_id: String(event.message?.mid ?? (entry.id + ":" + event.timestamp + ":" + sender)),',
    '      text,',
    '      display_name: null,',
    '      recipient_id: sender,',
    '      metadata: { account_id: String(entry.id ?? ""), timestamp: event.timestamp ?? null }',
    '    } });',
    '  }',
    '}',
    'return output;',
  ].join('\n'), [-330, 760]));
  nodes.push(brainHttp(name, [0, 680]));
  nodes.push(merge(name, 'Restore delivery context', [260, 760]));
  nodes.push(code(name, 'Deliver only when brain approves', prepareReplyCode(), [500, 760]));
  nodes.push(http(name, 'Send Instagram reply', 'POST', 'https://graph.instagram.com/__IG_GRAPH_API_VERSION__/__IG_API_USER_ID__/messages',
    '={{ JSON.stringify({ recipient: { id: $json.recipient_id }, message: { text: $json.reply } }) }}', [770, 760], '__IG_ACCESS_TOKEN__'));
  connect(connections, 'Instagram verification', 'Validate verification token');
  connect(connections, 'Validate verification token', 'Return challenge');
  connect(connections, 'Instagram messages', 'Normalize Instagram messages');
  connect(connections, 'Normalize Instagram messages', 'Ask shared AI brain');
  connect(connections, 'Normalize Instagram messages', 'Restore delivery context', 0);
  connect(connections, 'Ask shared AI brain', 'Restore delivery context', 1);
  connect(connections, 'Restore delivery context', 'Deliver only when brain approves');
  connect(connections, 'Deliver only when brain approves', 'Send Instagram reply');
  return workflow(name, nodes, connections);
}

function whatsappWorkflow() {
  const name = 'Channel - WhatsApp - Shared AI Brain';
  const nodes = [];
  const connections = {};
  nodes.push(note(name, 'Architecture', [
    '## WhatsApp transport adapter',
    'Only transport-specific parsing lives here. The shared brain decides language, intent, sales behavior, tools, RAG, and escalation.',
    'Status callbacks are acknowledged and ignored; user messages are idempotent in PostgreSQL.',
  ].join('\n'), [-700, -50], [520, 280], 5));
  nodes.push(webhook(name, 'WhatsApp verification', 'GET', 'whatsapp-rag-webhook', [-600, 420], 'responseNode'));
  nodes.push(code(name, 'Validate verification token', [
    "const query = $json.query ?? {};",
    "const valid = query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === '__WHATSAPP_WEBHOOK_VERIFY_TOKEN__';",
    "if (!valid) throw new Error('Invalid WhatsApp webhook verification request');",
    "return [{ json: { challenge: String(query['hub.challenge'] ?? '') } }];",
  ].join('\n'), [-330, 420]));
  nodes.push(responseNode(name, 'Return challenge', '={{ $json.challenge }}', [-60, 420]));
  nodes.push(webhook(name, 'WhatsApp messages', 'POST', 'whatsapp-rag-webhook', [-600, 760]));
  nodes.push(code(name, 'Normalize WhatsApp messages', [
    'const envelope = $json.body ?? $json;',
    "if (envelope.object !== 'whatsapp_business_account') return [];",
    'const output = [];',
    'for (const entry of envelope.entry ?? []) {',
    '  for (const change of entry.changes ?? []) {',
    '    const value = change.value ?? {};',
    '    const names = new Map((value.contacts ?? []).map((item) => [String(item.wa_id), item.profile?.name ?? null]));',
    '    for (const message of value.messages ?? []) {',
    '      const text = String(message.text?.body ?? message.button?.text ?? message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? message.image?.caption ?? message.document?.caption ?? "").trim();',
    '      if (!text) continue;',
    '      const sender = String(message.from ?? "");',
    '      if (!sender) continue;',
    '      output.push({ json: {',
    "        tenant_key: '__BRAIN_TENANT_KEY__',",
    "        channel: 'whatsapp',",
    '        external_user_id: sender,',
    '        external_thread_id: sender,',
    '        external_message_id: String(message.id),',
    '        text,',
    '        display_name: names.get(sender) ?? null,',
    '        recipient_id: sender,',
    '        metadata: { phone_number_id: String(value.metadata?.phone_number_id ?? ""), message_type: message.type ?? "text", timestamp: message.timestamp ?? null }',
    '      } });',
    '    }',
    '  }',
    '}',
    'return output;',
  ].join('\n'), [-330, 760]));
  nodes.push(brainHttp(name, [0, 680]));
  nodes.push(merge(name, 'Restore delivery context', [260, 760]));
  nodes.push(code(name, 'Deliver only when brain approves', prepareReplyCode(), [500, 760]));
  nodes.push(http(name, 'Send WhatsApp reply', 'POST', 'https://graph.facebook.com/__WHATSAPP_GRAPH_API_VERSION__/__WHATSAPP_PHONE_NUMBER_ID__/messages',
    '={{ JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: $json.recipient_id, type: "text", text: { preview_url: false, body: $json.reply } }) }}', [770, 760], '__WHATSAPP_ACCESS_TOKEN__'));
  connect(connections, 'WhatsApp verification', 'Validate verification token');
  connect(connections, 'Validate verification token', 'Return challenge');
  connect(connections, 'WhatsApp messages', 'Normalize WhatsApp messages');
  connect(connections, 'Normalize WhatsApp messages', 'Ask shared AI brain');
  connect(connections, 'Normalize WhatsApp messages', 'Restore delivery context', 0);
  connect(connections, 'Ask shared AI brain', 'Restore delivery context', 1);
  connect(connections, 'Restore delivery context', 'Deliver only when brain approves');
  connect(connections, 'Deliver only when brain approves', 'Send WhatsApp reply');
  return workflow(name, nodes, connections);
}

function telegramWorkflow() {
  const name = 'Channel - Telegram - Shared AI Brain';
  const nodes = [];
  const connections = {};
  nodes.push(note(name, 'Architecture', [
    '## Telegram transport adapter',
    'Telegram webhook authentication and normalization only. No language, intent, or sales branches.',
    'The same PostgreSQL memory and shared AI brain are used by all channels.',
  ].join('\n'), [-700, -50], [520, 260], 5));
  nodes.push(webhook(name, 'Telegram messages', 'POST', 'telegram-rag-webhook', [-600, 540]));
  nodes.push(code(name, 'Authenticate and normalize Telegram', [
    "const actualSecret = String($json.headers?.['x-telegram-bot-api-secret-token'] ?? '');",
    "if (actualSecret !== '__TELEGRAM_WEBHOOK_SECRET__') throw new Error('Invalid Telegram webhook secret');",
    'const update = $json.body ?? $json;',
    'const message = update.message ?? update.edited_message;',
    'if (!message) return [];',
    'const text = String(message.text ?? message.caption ?? "").trim();',
    'if (!text) return [];',
    'const sender = String(message.from?.id ?? message.chat?.id ?? "");',
    'const chat = String(message.chat?.id ?? sender);',
    'if (!sender || !chat) return [];',
    'const displayName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || message.from?.username || null;',
    'return [{ json: {',
    "  tenant_key: '__BRAIN_TENANT_KEY__',",
    "  channel: 'telegram',",
    '  external_user_id: sender,',
    '  external_thread_id: chat,',
    '  external_message_id: String(update.update_id ?? (chat + ":" + message.message_id)),',
    '  text,',
    '  display_name: displayName,',
    '  recipient_id: chat,',
    '  metadata: { username: message.from?.username ?? null, message_id: message.message_id ?? null }',
    '} }];',
  ].join('\n'), [-330, 540]));
  nodes.push(brainHttp(name, [0, 460]));
  nodes.push(merge(name, 'Restore delivery context', [260, 540]));
  nodes.push(code(name, 'Deliver only when brain approves', prepareReplyCode(), [500, 540]));
  nodes.push(http(name, 'Send Telegram reply', 'POST', 'https://api.telegram.org/bot__TELEGRAM_BOT_TOKEN__/sendMessage',
    '={{ JSON.stringify({ chat_id: $json.recipient_id, text: $json.reply }) }}', [770, 540], null));
  connect(connections, 'Telegram messages', 'Authenticate and normalize Telegram');
  connect(connections, 'Authenticate and normalize Telegram', 'Ask shared AI brain');
  connect(connections, 'Authenticate and normalize Telegram', 'Restore delivery context', 0);
  connect(connections, 'Ask shared AI brain', 'Restore delivery context', 1);
  connect(connections, 'Restore delivery context', 'Deliver only when brain approves');
  connect(connections, 'Deliver only when brain approves', 'Send Telegram reply');
  return workflow(name, nodes, connections);
}

function operatorWorkflow(name, noteText, configCode, endpoint, method = 'POST') {
  const nodes = [
    note(name, 'Instructions', noteText, [-500, -50], [620, 300], 4),
    manual(name),
    code(name, 'Editable operator input', configCode, [260, 300]),
    http(name, 'Apply safely', method, '__BRAIN_API_URL__' + endpoint, '={{ JSON.stringify($json) }}', [560, 300], '__BRAIN_ADMIN_TOKEN__'),
  ];
  const connections = {};
  connect(connections, 'Run manually', 'Editable operator input');
  connect(connections, 'Editable operator input', 'Apply safely');
  return workflow(name, nodes, connections);
}

function operatorWorkflows() {
  const modelName = 'Operator - Model Route Control';
  const model = operatorWorkflow(modelName, [
    '## Model priority control',
    'Edit only the values in Editable operator input, then run this workflow.',
    'Lower priority numbers run first. Disabled providers are never called.',
    'Default: Codex Spark, then Codex Mini. DeepSeek and OpenAI are present but disabled.',
  ].join('\n'), [
    'return [{ json: { routes: [',
    "  { id: 'codex_spark', provider: 'codex_cli', model: 'gpt-5.3-codex-spark', enabled: true, priority: 10, reasoning_effort: 'low' },",
    "  { id: 'codex_mini', provider: 'codex_cli', model: 'gpt-5.4-mini', enabled: true, priority: 20, reasoning_effort: 'low' },",
    "  { id: 'deepseek_flash', provider: 'deepseek', model: 'deepseek-chat', enabled: false, priority: 30 },",
    "  { id: 'openai_api', provider: 'openai', model: 'gpt-4.1', enabled: false, priority: 40 },",
    "  { id: 'deepseek_reasoner', provider: 'deepseek', model: 'deepseek-reasoner', enabled: false, priority: 50 }",
    '] } }];',
  ].join('\n'), '/v1/admin/model-routes', 'PUT');

  const escalationName = 'Operator - Escalation Reset';
  const escalation = operatorWorkflow(escalationName, [
    '## Resume an escalated conversation',
    'Enter the channel and external user ID from the operator view. Running this clears only the escalation marker; history remains intact.',
  ].join('\n'), [
    'return [{ json: {',
    "  tenant_key: '__BRAIN_TENANT_KEY__',",
    "  channel: 'telegram',",
    "  external_user_id: 'REPLACE_WITH_USER_ID'",
    '} }];',
  ].join('\n'), '/v1/admin/escalations/reset');

  const identityName = 'Operator - Cross-channel Identity Link';
  const identity = operatorWorkflow(identityName, [
    '## Link two channel identities',
    'Use this only after a human has confirmed both identities belong to the same person. The shared contact then keeps one memory across channels.',
  ].join('\n'), [
    'return [{ json: {',
    "  tenant_key: '__BRAIN_TENANT_KEY__',",
    "  primary: { channel: 'telegram', external_user_id: 'REPLACE_PRIMARY_ID' },",
    "  secondary: { channel: 'whatsapp', external_user_id: 'REPLACE_SECONDARY_ID' }",
    '} }];',
  ].join('\n'), '/v1/admin/identities/link');

  const knowledgeName = 'Operator - Knowledge Ingest';
  const knowledge = operatorWorkflow(knowledgeName, [
    '## Add or replace trusted knowledge',
    'Paste approved company knowledge into Editable operator input. It is chunked and embedded locally into PostgreSQL/pgvector.',
    'For many files, use npm run knowledge:ingest instead.',
  ].join('\n'), [
    'return [{ json: {',
    "  tenant_key: '__BRAIN_TENANT_KEY__',",
    "  source_path: 'operator/manual-note',",
    "  title: 'Replace with a descriptive title',",
    "  content: 'Replace with approved company knowledge'",
    '} }];',
  ].join('\n'), '/v1/admin/knowledge');

  return [model, escalation, identity, knowledge];
}

function internalWorkflow() {
  const name = 'Internal - Brain Test Harness';
  const nodes = [
    note(name, 'Instructions', [
      '## Channel-free brain test',
      'Run this workflow to test the exact production brain without Instagram, WhatsApp, or Telegram.',
      'Edit the message and stable user ID to test multi-turn memory. This workflow never sends an external message.',
    ].join('\n'), [-500, -50], [620, 290], 3),
    manual(name),
    code(name, 'Editable test message', [
      'return [{ json: {',
      "  tenant_key: '__BRAIN_TENANT_KEY__',",
      "  channel: 'internal_test',",
      "  external_user_id: 'n8n-operator-test',",
      "  external_thread_id: 'n8n-operator-test',",
      "  external_message_id: 'manual-' + Date.now(),",
      "  text: 'Hello. Briefly explain how you can help my business.',",
      "  display_name: 'Operator test',",
      '  metadata: { source: "n8n-manual-test" }',
      '} }];',
    ].join('\n'), [260, 300]),
    brainHttp(name, [560, 300]),
  ];
  const connections = {};
  connect(connections, 'Run manually', 'Editable test message');
  connect(connections, 'Editable test message', 'Ask shared AI brain');
  return workflow(name, nodes, connections);
}

const workflows = [instagramWorkflow(), whatsappWorkflow(), telegramWorkflow(), ...operatorWorkflows(), internalWorkflow()];
await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(outputDirectory, { recursive: true });
for (const item of workflows) {
  const filename = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.json';
  await fs.writeFile(path.join(outputDirectory, filename), JSON.stringify(item, null, 2) + '\n');
}
console.log(JSON.stringify({ generated: workflows.length, directory: outputDirectory, names: workflows.map((item) => item.name) }, null, 2));
