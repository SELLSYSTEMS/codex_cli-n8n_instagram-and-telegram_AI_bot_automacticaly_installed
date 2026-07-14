import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'workflows');

function stableId(value) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function node(workflow, name, type, position, parameters, typeVersion = 1) {
  return {
    parameters,
    id: stableId(`${workflow}:${name}`),
    name,
    type,
    typeVersion,
    position,
  };
}

function sticky(workflow, name, position, content, width = 520, height = 300) {
  return node(workflow, name, 'n8n-nodes-base.stickyNote', position, {
    content,
    width,
    height,
    color: 5,
  });
}

function webhook(workflow, name, position, httpMethod, path, responseMode = 'onReceived') {
  const parameters = {
    httpMethod,
    path,
    responseMode,
    options: responseMode === 'onReceived' ? { responseCode: 200 } : {},
  };
  return {
    ...node(workflow, name, 'n8n-nodes-base.webhook', position, parameters, 2),
    webhookId: stableId(`${workflow}:${name}:webhook`),
  };
}

function code(workflow, name, position, jsCode) {
  return node(workflow, name, 'n8n-nodes-base.code', position, { jsCode }, 2);
}

function http(workflow, name, position, parameters) {
  return node(workflow, name, 'n8n-nodes-base.httpRequest', position, parameters, 4.2);
}

function respond(workflow, name, position, respondWith = 'json', responseBody = '={{ $json }}') {
  return node(workflow, name, 'n8n-nodes-base.respondToWebhook', position, {
    respondWith,
    responseBody,
    options: {},
  }, 1.4);
}

function edge(nodeName, index = 0) {
  return { node: nodeName, type: 'main', index };
}

function brainRequest(workflow, position) {
  return http(workflow, 'Call Shared Brain API', position, {
    method: 'POST',
    url: "={{ ($env.BRAIN_API_URL || 'http://127.0.0.1:8789').replace(/\\/$/, '') + '/v1/messages' }}",
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Authorization', value: "={{ 'Bearer ' + $env.BRAIN_API_TOKEN }}" }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json) }}',
    options: { timeout: 120000 },
  });
}

function sendGuard(workflow, position) {
  return code(workflow, 'Operational Send Guard', position, [
    "if (!$json.should_send || typeof $json.reply_text !== 'string' || !$json.reply_text.trim()) return [];",
    'return [{ json: $json }];',
  ].join('\n'));
}

function metaVerifyCode(tokenEnv) {
  return [
    'const query = $json.query ?? {};',
    `const expected = $env.${tokenEnv};`,
    "const valid = Boolean(expected) && query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === expected;",
    "return [{ json: { status: valid ? 200 : 403, body: valid ? String(query['hub.challenge'] ?? '') : 'Forbidden' } }];",
  ].join('\n');
}

function verifyResponse(workflow, name, position) {
  const result = respond(workflow, name, position, 'text', '={{ $json.body }}');
  result.parameters.options = { responseCode: '={{ $json.status }}' };
  return result;
}

function adminAuthCode() {
  return [
    'const headers = $json.headers ?? {};',
    "const supplied = headers['x-admin-token'] ?? headers['X-Admin-Token'];",
    "if (!$env.BRAIN_ADMIN_TOKEN || supplied !== $env.BRAIN_ADMIN_TOKEN) throw new Error('Unauthorized');",
    'return [{ json: $json.body ?? {} }];',
  ].join('\n');
}

function brainAdminRequest(workflow, name, position, method, endpoint, body = true) {
  const parameters = {
    method,
    url: `={{ ($env.BRAIN_API_URL || 'http://127.0.0.1:8789').replace(/\\/$/, '') + '${endpoint}' }}`,
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Authorization', value: "={{ 'Bearer ' + $env.BRAIN_ADMIN_TOKEN }}" }],
    },
    options: { timeout: 120000 },
  };
  if (body) {
    parameters.sendBody = true;
    parameters.specifyBody = 'json';
    parameters.jsonBody = '={{ JSON.stringify($json) }}';
  }
  return http(workflow, name, position, parameters);
}

function workflow(name, nodes, connections) {
  return {
    name,
    nodes,
    pinData: {},
    connections,
    active: false,
    settings: {
      executionOrder: 'v1',
      saveManualExecutions: true,
      callerPolicy: 'workflowsFromSameOwner',
    },
    versionId: stableId(`${name}:version`),
    meta: {
      templateCredsSetupCompleted: false,
    },
    tags: [],
  };
}

function instagramWorkflow() {
  const name = 'Channel Adapter: Instagram -> Shared Brain';
  const normalize = [
    'const body = $json.body ?? $json;',
    'const events = (body.entry ?? []).flatMap((entry) => entry.messaging ?? []);',
    'const event = events.find((item) => item?.message?.text && !item.message.is_echo);',
    'if (!event) return [];',
    'return [{ json: {',
    "  tenant_key: $env.BRAIN_TENANT_KEY || 'default',",
    "  channel: 'instagram',",
    '  external_user_id: String(event.sender?.id ?? \'\'),',
    '  channel_conversation_id: String(event.sender?.id ?? \'\'),',
    '  external_message_id: String(event.message?.mid ?? event.timestamp ?? \'\'),',
    '  text: String(event.message.text),',
    '  metadata: { recipient_id: event.recipient?.id ?? null, received_at: event.timestamp ?? null },',
    '} }];',
  ].join('\n');

  const nodes = [
    sticky(name, 'READ ME - Replaceable Transport Shell', [-900, -420], [
      '# Instagram transport only',
      '',
      'This workflow does not contain company knowledge, sales policy, memory, RAG, or semantic routing. It only verifies Meta, normalizes an inbound event, calls the Shared Brain API, and delivers a permitted response.',
      '',
      'Required runtime values: `IG_WEBHOOK_VERIFY_TOKEN`, `IG_ACCESS_TOKEN`, `IG_MESSAGES_ENDPOINT`, `BRAIN_API_URL`, `BRAIN_API_TOKEN`, `BRAIN_TENANT_KEY`.',
      '',
      'Set the Meta callback to the production webhook URL only after credentials are configured. Keep this workflow inactive in the public template.',
    ].join('\n'), 620, 330),
    webhook(name, 'Instagram Webhook Verification', [-860, 20], 'GET', 'instagram-rag-webhook', 'responseNode'),
    code(name, 'Verify Instagram Subscription', [-620, 20], metaVerifyCode('IG_WEBHOOK_VERIFY_TOKEN')),
    verifyResponse(name, 'Return Meta Challenge', [-360, 20]),
    webhook(name, 'Instagram Message Receiver', [-860, 260], 'POST', 'instagram-rag-webhook'),
    code(name, 'Normalize Instagram Message', [-620, 260], normalize),
    brainRequest(name, [-330, 260]),
    sendGuard(name, [-40, 260]),
    http(name, 'Send Instagram Reply', [250, 260], {
      method: 'POST',
      url: '={{ $env.IG_MESSAGES_ENDPOINT }}',
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'Authorization', value: "={{ 'Bearer ' + $env.IG_ACCESS_TOKEN }}" },
        { name: 'Content-Type', value: 'application/json' },
      ] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ recipient: { id: $node["Normalize Instagram Message"].json.external_user_id }, message: { text: $json.reply_text } }) }}',
      options: { timeout: 30000 },
    }),
  ];

  return workflow(name, nodes, {
    'Instagram Webhook Verification': { main: [[edge('Verify Instagram Subscription')]] },
    'Verify Instagram Subscription': { main: [[edge('Return Meta Challenge')]] },
    'Instagram Message Receiver': { main: [[edge('Normalize Instagram Message')]] },
    'Normalize Instagram Message': { main: [[edge('Call Shared Brain API')]] },
    'Call Shared Brain API': { main: [[edge('Operational Send Guard')]] },
    'Operational Send Guard': { main: [[edge('Send Instagram Reply')]] },
  });
}

function telegramWorkflow() {
  const name = 'Channel Adapter: Telegram -> Shared Brain';
  const normalize = [
    'const message = $json.message ?? $json.edited_message;',
    'if (!message?.text || message.from?.is_bot) return [];',
    'return [{ json: {',
    "  tenant_key: $env.BRAIN_TENANT_KEY || 'default',",
    "  channel: 'telegram',",
    '  external_user_id: String(message.from.id),',
    '  channel_conversation_id: String(message.chat.id),',
    '  external_message_id: String(message.message_id),',
    '  text: String(message.text),',
    '  metadata: { username: message.from.username ?? null, first_name: message.from.first_name ?? null },',
    '} }];',
  ].join('\n');

  const trigger = node(name, 'Telegram Trigger', [-800, 220], 'n8n-nodes-base.telegramTrigger', {
    updates: ['message', 'edited_message'],
    additionalFields: {},
  }, 1.2);

  const send = node(name, 'Send Telegram Reply', [280, 220], 'n8n-nodes-base.telegram', {
    resource: 'message',
    operation: 'sendMessage',
    chatId: '={{ $node["Normalize Telegram Message"].json.channel_conversation_id }}',
    text: '={{ $json.reply_text }}',
    additionalFields: { appendAttribution: false },
  }, 1.2);

  return workflow(name, [
    sticky(name, 'READ ME - Native Telegram Adapter', [-840, -300], [
      '# Telegram transport only',
      '',
      'Attach one Telegram credential to both Telegram nodes. The shared Brain API owns all language, memory, RAG, sales/support behavior, and escalation decisions.',
      '',
      'Required runtime values: `BRAIN_API_URL`, `BRAIN_API_TOKEN`, `BRAIN_TENANT_KEY`.',
      '',
      'No company content belongs in this workflow. Keep it inactive in the public template.',
    ].join('\n'), 600, 290),
    trigger,
    code(name, 'Normalize Telegram Message', [-530, 220], normalize),
    brainRequest(name, [-240, 220]),
    sendGuard(name, [40, 220]),
    send,
  ], {
    'Telegram Trigger': { main: [[edge('Normalize Telegram Message')]] },
    'Normalize Telegram Message': { main: [[edge('Call Shared Brain API')]] },
    'Call Shared Brain API': { main: [[edge('Operational Send Guard')]] },
    'Operational Send Guard': { main: [[edge('Send Telegram Reply')]] },
  });
}

function whatsappWorkflow() {
  const name = 'Channel Adapter: WhatsApp -> Shared Brain';
  const normalize = [
    'const body = $json.body ?? $json;',
    'const values = (body.entry ?? []).flatMap((entry) => (entry.changes ?? []).map((change) => change.value ?? {}));',
    'const value = values.find((item) => Array.isArray(item.messages) && item.messages.length);',
    'const message = value?.messages?.[0];',
    'const text = message?.text?.body ?? message?.button?.text ?? message?.interactive?.button_reply?.title ?? message?.interactive?.list_reply?.title;',
    'if (!message || !text) return [];',
    'const contact = value.contacts?.find((item) => item.wa_id === message.from) ?? value.contacts?.[0];',
    'return [{ json: {',
    "  tenant_key: $env.BRAIN_TENANT_KEY || 'default',",
    "  channel: 'whatsapp',",
    '  external_user_id: String(message.from),',
    '  channel_conversation_id: String(message.from),',
    '  external_message_id: String(message.id),',
    '  text: String(text),',
    '  metadata: { profile_name: contact?.profile?.name ?? null, message_type: message.type ?? null },',
    '} }];',
  ].join('\n');

  return workflow(name, [
    sticky(name, 'READ ME - WhatsApp Cloud Adapter', [-900, -420], [
      '# WhatsApp Cloud transport only',
      '',
      'This workflow handles webhook verification, inbound normalization, Brain API invocation, and Cloud API delivery. Status events are acknowledged but not sent to the model.',
      '',
      'Required runtime values: `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_API_VERSION`, `BRAIN_API_URL`, `BRAIN_API_TOKEN`, `BRAIN_TENANT_KEY`.',
      '',
      'Keep it inactive in the public template.',
    ].join('\n'), 640, 330),
    webhook(name, 'WhatsApp Webhook Verification', [-860, 20], 'GET', 'whatsapp-rag-webhook', 'responseNode'),
    code(name, 'Verify WhatsApp Subscription', [-620, 20], metaVerifyCode('WHATSAPP_WEBHOOK_VERIFY_TOKEN')),
    verifyResponse(name, 'Return Meta Challenge', [-360, 20]),
    webhook(name, 'WhatsApp Message Receiver', [-860, 260], 'POST', 'whatsapp-rag-webhook'),
    code(name, 'Normalize WhatsApp Message', [-620, 260], normalize),
    brainRequest(name, [-330, 260]),
    sendGuard(name, [-40, 260]),
    http(name, 'Send WhatsApp Reply', [250, 260], {
      method: 'POST',
      url: "={{ 'https://graph.facebook.com/' + ($env.WHATSAPP_GRAPH_API_VERSION || 'v25.0') + '/' + $env.WHATSAPP_PHONE_NUMBER_ID + '/messages' }}",
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'Authorization', value: "={{ 'Bearer ' + $env.WHATSAPP_ACCESS_TOKEN }}" },
        { name: 'Content-Type', value: 'application/json' },
      ] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: $node["Normalize WhatsApp Message"].json.external_user_id, type: "text", text: { preview_url: false, body: $json.reply_text } }) }}',
      options: { timeout: 30000 },
    }),
  ], {
    'WhatsApp Webhook Verification': { main: [[edge('Verify WhatsApp Subscription')]] },
    'Verify WhatsApp Subscription': { main: [[edge('Return Meta Challenge')]] },
    'WhatsApp Message Receiver': { main: [[edge('Normalize WhatsApp Message')]] },
    'Normalize WhatsApp Message': { main: [[edge('Call Shared Brain API')]] },
    'Call Shared Brain API': { main: [[edge('Operational Send Guard')]] },
    'Operational Send Guard': { main: [[edge('Send WhatsApp Reply')]] },
  });
}

function testHarnessWorkflow() {
  const name = 'Operator: Shared Brain Test Harness';
  const normalize = [
    "const body = $json;",
    "if (!body.text || typeof body.text !== 'string') throw new Error('text is required');",
    'return [{ json: {',
    "  tenant_key: body.tenant_key || $env.BRAIN_TENANT_KEY || 'default',",
    "  channel: body.channel || 'internal_test',",
    "  external_user_id: String(body.external_user_id || 'scenario-user'),",
    "  channel_conversation_id: String(body.channel_conversation_id || body.external_user_id || 'scenario-thread'),",
    "  external_message_id: String(body.external_message_id || ('manual-' + Date.now())),",
    '  text: body.text,',
    '  metadata: { test_run: true, ...(body.metadata ?? {}) },',
    '} }];',
  ].join('\n');

  return workflow(name, [
    sticky(name, 'READ ME - Channel-Free Testing', [-850, -300], [
      '# Test the brain without Instagram, Telegram, or WhatsApp',
      '',
      'POST JSON to the production webhook with header `x-admin-token`. Reuse the same `external_user_id` and `channel_conversation_id` to test memory across turns.',
      '',
      'This harness calls the exact same Brain API contract as every channel. It is an operator surface, not a second chatbot implementation.',
    ].join('\n'), 620, 270),
    webhook(name, 'Brain Test Webhook', [-800, 180], 'POST', 'brain-test', 'responseNode'),
    code(name, 'Authenticate Test Request', [-560, 180], adminAuthCode()),
    code(name, 'Normalize Test Turn', [-300, 180], normalize),
    brainRequest(name, [0, 180]),
    respond(name, 'Return Brain Result', [300, 180]),
  ], {
    'Brain Test Webhook': { main: [[edge('Authenticate Test Request')]] },
    'Authenticate Test Request': { main: [[edge('Normalize Test Turn')]] },
    'Normalize Test Turn': { main: [[edge('Call Shared Brain API')]] },
    'Call Shared Brain API': { main: [[edge('Return Brain Result')]] },
  });
}

function resetWorkflow() {
  const name = 'Operator: Reset Conversation Escalation';
  return workflow(name, [
    sticky(name, 'READ ME - Human Handover Reset', [-800, -300], [
      '# Resume automation after human handover',
      '',
      'POST the conversation identity and `x-admin-token`. The Brain API clears the durable pause marker. Until this reset, the model is not called and the bot remains silent.',
      '',
      'Required body: `tenant_key` plus either `conversation_id` or `channel` + `channel_conversation_id`.',
    ].join('\n'), 600, 270),
    webhook(name, 'Escalation Reset Webhook', [-760, 180], 'POST', 'brain-admin/escalations/reset', 'responseNode'),
    code(name, 'Authenticate Reset Request', [-500, 180], adminAuthCode()),
    brainAdminRequest(name, 'Reset Escalation in Brain', [-220, 180], 'POST', '/v1/escalations/reset'),
    respond(name, 'Return Reset Result', [80, 180]),
  ], {
    'Escalation Reset Webhook': { main: [[edge('Authenticate Reset Request')]] },
    'Authenticate Reset Request': { main: [[edge('Reset Escalation in Brain')]] },
    'Reset Escalation in Brain': { main: [[edge('Return Reset Result')]] },
  });
}

function knowledgeWorkflow() {
  const name = 'Operator: Knowledge Ingest -> Shared Brain';
  return workflow(name, [
    sticky(name, 'READ ME - Generic Knowledge Ingest', [-820, -320], [
      '# Add tenant knowledge',
      '',
      'POST `tenant_key`, `title`, `content`, optional `source_uri`, and optional `metadata` with header `x-admin-token`.',
      '',
      'Chunking, embeddings, storage, and tenant isolation belong to the Brain service. Do not put company documents or credentials into this public workflow export.',
    ].join('\n'), 620, 280),
    webhook(name, 'Knowledge Ingest Webhook', [-780, 180], 'POST', 'brain-admin/knowledge', 'responseNode'),
    code(name, 'Authenticate Knowledge Request', [-520, 180], adminAuthCode()),
    brainAdminRequest(name, 'Ingest Through Brain API', [-240, 180], 'POST', '/v1/knowledge'),
    respond(name, 'Return Ingest Result', [60, 180]),
  ], {
    'Knowledge Ingest Webhook': { main: [[edge('Authenticate Knowledge Request')]] },
    'Authenticate Knowledge Request': { main: [[edge('Ingest Through Brain API')]] },
    'Ingest Through Brain API': { main: [[edge('Return Ingest Result')]] },
  });
}

function modelAdminWorkflow() {
  const name = 'Operator: Model Route Control';
  const manual = node(name, 'Manual Trigger', [-780, 360], 'n8n-nodes-base.manualTrigger', {}, 1);
  const editor = code(name, 'EDIT ENABLED AND PRIORITY HERE', [-520, 360], [
    '// Lower priority number runs first. Disabled routes are skipped.',
    '// Never paste API keys here; keys remain in the private runtime environment.',
    'return [{ json: { routes: [',
    "  { id: 'codex_spark', provider: 'codex_cli', model: 'gpt-5.3-codex-spark', enabled: true, priority: 10, reasoning_effort: 'low' },",
    "  { id: 'codex_mini', provider: 'codex_cli', model: 'gpt-5.4-mini', enabled: true, priority: 20, reasoning_effort: 'low' },",
    "  { id: 'deepseek_flash', provider: 'deepseek', model: 'deepseek-chat', enabled: false, priority: 30 },",
    "  { id: 'openai_api', provider: 'openai', model: 'gpt-4.1', enabled: false, priority: 40 },",
    "  { id: 'deepseek_reasoner', provider: 'deepseek', model: 'deepseek-reasoner', enabled: false, priority: 50 },",
    '] } }];',
  ].join('\n'));

  return workflow(name, [
    sticky(name, 'READ ME - Human-Friendly Model Routing', [-860, -360], [
      '# Model failover control',
      '',
      'Manual path: open `EDIT ENABLED AND PRIORITY HERE`, change only `enabled` and `priority`, then execute the workflow.',
      '',
      'API paths: GET or PUT the `brain-admin/model-routes` webhook using header `x-admin-token`.',
      '',
      'Default order: Codex Spark, Codex mini. DeepSeek and OpenAI API are present but disabled. The verified OpenAI stable alias is `gpt-4.1`.',
      '',
      'Provider failure and quota errors may fall through; malformed model output and business decisions are never replaced by hard-coded sales templates.',
    ].join('\n'), 700, 340),
    webhook(name, 'Get Model Routes Webhook', [-820, 20], 'GET', 'brain-admin/model-routes', 'responseNode'),
    code(name, 'Authenticate Get Request', [-570, 20], adminAuthCode()),
    brainAdminRequest(name, 'Read Routes from Brain', [-300, 20], 'GET', '/v1/admin/model-routes', false),
    respond(name, 'Return Current Routes', [-20, 20]),
    webhook(name, 'Put Model Routes Webhook', [-820, 180], 'PUT', 'brain-admin/model-routes', 'responseNode'),
    code(name, 'Authenticate Put Request', [-570, 180], adminAuthCode()),
    brainAdminRequest(name, 'Update Routes in Brain', [-300, 180], 'PUT', '/v1/admin/model-routes'),
    respond(name, 'Return Updated Routes', [-20, 180]),
    manual,
    editor,
    brainAdminRequest(name, 'Apply Edited Routes', [-230, 360], 'PUT', '/v1/admin/model-routes'),
  ], {
    'Get Model Routes Webhook': { main: [[edge('Authenticate Get Request')]] },
    'Authenticate Get Request': { main: [[edge('Read Routes from Brain')]] },
    'Read Routes from Brain': { main: [[edge('Return Current Routes')]] },
    'Put Model Routes Webhook': { main: [[edge('Authenticate Put Request')]] },
    'Authenticate Put Request': { main: [[edge('Update Routes in Brain')]] },
    'Update Routes in Brain': { main: [[edge('Return Updated Routes')]] },
    'Manual Trigger': { main: [[edge('EDIT ENABLED AND PRIORITY HERE')]] },
    'EDIT ENABLED AND PRIORITY HERE': { main: [[edge('Apply Edited Routes')]] },
  });
}

const artifacts = new Map([
  ['channel-instagram.json', instagramWorkflow()],
  ['channel-telegram.json', telegramWorkflow()],
  ['channel-whatsapp.json', whatsappWorkflow()],
  ['brain-test-harness.json', testHarnessWorkflow()],
  ['operator-escalation-reset.json', resetWorkflow()],
  ['knowledge-ingest.json', knowledgeWorkflow()],
  ['model-route-admin.json', modelAdminWorkflow()],
]);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
for (const [file, data] of artifacts) {
  await writeFile(join(outDir, file), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
}

console.log(`Generated ${artifacts.size} inactive n8n workflow templates.`);
