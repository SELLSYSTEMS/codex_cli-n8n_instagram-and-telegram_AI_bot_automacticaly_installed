#!/usr/bin/env node
import fs from 'node:fs';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile('.env');
loadEnvFile('/etc/n8n/n8n.env');

const baseUrl = (process.env.N8N_BASE_URL || '').replace(/\/+$/, '');
const token = process.env.INTERNAL_TEST_TOKEN || '';

if (!baseUrl) {
  console.error('N8N_BASE_URL is missing in .env or /etc/n8n/n8n.env');
  process.exit(2);
}

if (!token) {
  console.error('INTERNAL_TEST_TOKEN is missing in .env or /etc/n8n/n8n.env');
  process.exit(2);
}

const endpoint = `${baseUrl}/webhook/internal-rag-test`;
const baseThread =
  process.argv.find((arg) => arg.startsWith('--thread='))?.slice('--thread='.length) ||
  `live-n8n-regression-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;

const cases = [
  {
    name: 'ru_greeting',
    message: 'Привет',
    checks: [
      ['status answered', (r) => r.status === 'answered'],
      ['simple greeting', (r) => r.simple_greeting === true],
      ['sales opener', (r) => /Sell\.Systems|AI-автоматизац|Instagram|Telegram|CRM/i.test(r.response || '')],
      ['usd default', (r) => r.preferred_currency === 'USD'],
    ],
  },
  {
    name: 'ru_offer',
    message: 'Что вы можете сделать для моего бизнеса?',
    checks: [
      ['status answered', (r) => r.status === 'answered'],
      ['not escalated', (r) => r.status !== 'escalated'],
      ['sales language', (r) => /автоматизац|лид|CRM|воронк|бот/i.test(r.response || '')],
      ['usd prices', (r) => /\$/.test(r.response || '') && !/HKD|гонконг/i.test(r.response || '')],
      ['discovery question', (r) => /\?/.test(r.response || '')],
    ],
  },
  {
    name: 'ru_manager_delay_not_handoff',
    message: 'У меня менеджеры не успевают отвечать в директе, можно автоматизировать?',
    checks: [
      ['status answered', (r) => r.status === 'answered'],
      ['not escalated', (r) => r.status !== 'escalated'],
      ['automation sales answer', (r) => /директ|лид|менеджер|автоматизац|ответ/i.test(r.response || '')],
    ],
  },
  {
    name: 'ru_price_instagram',
    message: 'Сколько стоит Instagram бот для ответов клиентам?',
    checks: [
      ['status answered', (r) => r.status === 'answered'],
      ['usd default', (r) => r.preferred_currency === 'USD'],
      ['usd price anchors', (r) => /\$(165|230|360|1,?515|3,?180|5,?615)/.test(r.response || '')],
      ['no hkd by language', (r) => !/HKD|гонконгск|港幣|港币/i.test(r.response || '')],
    ],
  },
  {
    name: 'zh_price_instagram',
    message: 'Instagram 自动回复机器人多少钱？',
    checks: [
      ['status answered', (r) => r.status === 'answered'],
      ['usd default', (r) => r.preferred_currency === 'USD'],
      ['usd prices', (r) => /\$|USD|美元/i.test(r.response || '')],
      ['no hkd by language', (r) => !/HKD|港幣|港币/i.test(r.response || '')],
    ],
  },
  {
    name: 'vi_price_vnd',
    message: 'Bot Instagram trả lời khách hàng giá bao nhiêu bằng VND?',
    checks: [
      ['status answered', (r) => r.status === 'answered'],
      ['explicit vnd honored', (r) => r.preferred_currency === 'VND'],
      ['vnd and usd shown', (r) => /VND/i.test(r.response || '') && /USD|\$/.test(r.response || '')],
    ],
  },
  {
    name: 'ru_off_topic_weather',
    message: 'Какая погода завтра?',
    checks: [
      ['status answered', (r) => r.status === 'answered'],
      ['not escalated', (r) => r.status !== 'escalated'],
      ['redirect to business scope', (r) => /автоматизац|CRM|бот|лид|бизнес/i.test(r.response || '')],
      ['no forecast answer', (r) => !/температур|дожд|солнеч|облач|ветер/i.test(r.response || '')],
    ],
  },
  {
    name: 'zh_handoff',
    message: '请转人工客服',
    checks: [
      ['status escalated', (r) => r.status === 'escalated'],
      ['handoff text', (r) => /人工|客服|оператор|human/i.test(r.response || '')],
    ],
  },
];

async function postCase(testCase, index) {
  const threadId = `${baseThread}-${String(index + 1).padStart(2, '0')}-${testCase.name}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-test-token': token,
    },
    body: JSON.stringify({
      tenant_id: 'demo',
      channel: 'internal_test',
      thread_id: threadId,
      message: testCase.message,
    }),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      name: testCase.name,
      ok: false,
      failures: [`invalid JSON response: HTTP ${response.status}`],
      response_preview: text.slice(0, 240),
    };
  }

  const failures = [];
  if (!response.ok) failures.push(`HTTP ${response.status}`);

  for (const [label, check] of testCase.checks) {
    let passed = false;
    try {
      passed = Boolean(check(json));
    } catch {
      passed = false;
    }
    if (!passed) failures.push(label);
  }

  return {
    name: testCase.name,
    thread: threadId,
    status: json.status,
    ok: failures.length === 0,
    failures,
    response_preview: String(json.response || '').replace(/\s+/g, ' ').slice(0, 260),
  };
}

const results = [];
for (let index = 0; index < cases.length; index += 1) {
  results.push(await postCase(cases[index], index));
}

const passed = results.filter((result) => result.ok).length;
const failed = results.length - passed;

console.log(
  JSON.stringify(
    {
      ok: failed === 0,
      passed,
      failed,
      endpoint,
      base_thread: baseThread,
      results,
    },
    null,
    2,
  ),
);

if (failed > 0) process.exit(1);
