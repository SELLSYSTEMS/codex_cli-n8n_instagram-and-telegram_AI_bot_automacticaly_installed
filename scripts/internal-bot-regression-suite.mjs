#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const botScript = resolve(__dirname, 'internal-bot-test.mjs');

function parseArgs(argv) {
  const args = {
    tenant: 'demo',
    channel: 'internal_test',
    thread: `regression-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    noLog: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant') args.tenant = argv[++i] || args.tenant;
    else if (arg === '--channel') args.channel = argv[++i] || args.channel;
    else if (arg === '--thread') args.thread = argv[++i] || args.thread;
    else if (arg === '--no-log') args.noLog = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }

  return args;
}

function usage() {
  console.log(`Usage:
  node scripts/internal-bot-regression-suite.mjs [--thread local-regression] [--tenant demo] [--channel internal_test] [--no-log]

Runs autonomous bot-brain regression checks without Instagram/Telegram transport.
The suite validates sales discovery, USD pricing, multilingual behavior, off-topic redirect, escalation silence, and reset.`);
}

const CASES = [
  {
    name: 'ru_what_can_you_do',
    message: 'Что вы можете сделать для моего бизнеса?',
    expect: ['answered', 'sales', 'question', 'not_escalated'],
  },
  {
    name: 'ru_price_instagram',
    message: 'Сколько стоит Instagram бот для лидов?',
    expect: ['answered', 'price', 'sales', 'not_escalated'],
  },
  {
    name: 'ru_site_crm_budget',
    message: 'Хочу сайт и CRM, бюджет небольшой. Что можете предложить?',
    expect: ['answered', 'price', 'sales', 'not_escalated'],
  },
  {
    name: 'ru_needs_discovery',
    message: 'У меня мало заявок и менеджеры долго отвечают клиентам. Что можно автоматизировать?',
    expect: ['answered', 'sales', 'question', 'not_escalated'],
  },
  {
    name: 'ru_manager_delay_not_handoff',
    message: 'У меня менеджеры не успевают отвечать в директе, можно автоматизировать?',
    expect: ['answered', 'sales', 'question', 'not_escalated'],
  },
  {
    name: 'en_discovery_unclear',
    message: 'I have a small shop and lose leads in DMs, what should I do?',
    expect: ['answered', 'sales', 'question', 'not_escalated'],
  },
  {
    name: 'en_multichannel_price',
    message: 'How much for an Instagram and Telegram lead handling bot?',
    expect: ['answered', 'price', 'sales', 'not_escalated'],
  },
  {
    name: 'zh_price_instagram',
    message: '你好，Instagram 自动回复和销售机器人多少钱？',
    expect: ['answered', 'price', 'cjk', 'not_escalated'],
  },
  {
    name: 'zh_handoff',
    message: '请转人工客服',
    expect: ['escalated', 'cjk'],
  },
  {
    name: 'vi_price_vnd',
    message: 'Bot Instagram trả lời khách hàng giá bao nhiêu bằng VND?',
    expect: ['answered', 'price', 'sales', 'question', 'currency_vnd', 'not_escalated'],
  },
  {
    name: 'ru_off_topic_weather',
    message: 'Какая погода сегодня в Москве?',
    expect: ['answered', 'redirect', 'not_weather_answer', 'not_escalated'],
  },
  {
    name: 'ru_greeting',
    message: 'Привет',
    expect: ['answered', 'sales', 'question', 'simple_greeting', 'not_escalated'],
  },
];

function runBot(args, extra) {
  const childArgs = [
    botScript,
    '--tenant', args.tenant,
    '--channel', args.channel,
    ...extra,
  ];

  if (args.noLog) childArgs.push('--no-log');

  const result = spawnSync(process.execPath, childArgs, {
    cwd: resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
  });

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();

  if (result.status !== 0) {
    return {
      ok: false,
      statusCode: result.status,
      parseError: null,
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 2000),
    };
  }

  try {
    return JSON.parse(stdout);
  } catch (error) {
    return {
      ok: false,
      parseError: error.message,
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 2000),
    };
  }
}

function textOf(result) {
  return String(result?.response || result?.reply_text || result?.text || result?.answer || '');
}

function hasPrice(text) {
  const value = String(text || '');

  if (/HK\$|HKD|港币|港幣/i.test(value)) {
    return false;
  }

  return /(?:\$\s?(?:165|230|360|745|1,?515|3,?180|5,?615)|(?:165|230|360|745|1,?515|1515|3,?180|3180|5,?615|5615)\s*(?:USD|usd|доллар|dollars?|美元)|USD|доллар|dollar|美元)/i.test(value);
}

function hasSalesLanguage(text) {
  return /(instagram|telegram|crm|лид|лиды|заявк|продаж|автоматизац|бот|воронк|сайт|аудит|Sell\.Systems|workflow|automation|销售|銷售|客户|客戶|自动化|自動化|机器人|機器人|线索|線索|网站|網站|bán hàng|khách|tự động|tu dong|trang web|phễu|pheu)/i.test(text);
}

function asksQuestion(text) {
  return /[?？]/.test(text) || /(какая|какой|сколько|what|which|how many|как|где|когда)/i.test(text);
}

function isCjk(text) {
  return /[\u3400-\u9FFF]/.test(text);
}

function isSimpleGreetingResult(result, text) {
  return result?.simple_greeting === true || /(что сейчас важнее|what should we improve first|bạn muốn cải thiện|你现在最想先改善)/i.test(text);
}

function redirectsToScope(text) {
  return /(автоматизац|бот|crm|instagram|telegram|лид|продаж|воронк|business automation|sales|workflow|Sell\.Systems)/i.test(text);
}

function doesNotAnswerWeather(text) {
  return !/(температур|градус|осадк|ветер|forecast|weather is|сегодня.*погод)/i.test(text);
}

function evaluate(caseDef, result) {
  const failures = [];
  const text = textOf(result);

  for (const expectation of caseDef.expect) {
    if (expectation === 'answered' && result.status !== 'answered') failures.push(`expected status=answered got=${result.status}`);
    if (expectation === 'escalated' && result.status !== 'escalated') failures.push(`expected status=escalated got=${result.status}`);
    if (expectation === 'not_escalated' && (result.status === 'escalated' || result.status === 'silent_already_escalated')) failures.push(`expected not escalated got=${result.status}`);
    if (expectation === 'price' && !hasPrice(text)) failures.push('expected concrete USD pricing');
    if (expectation === 'sales' && !hasSalesLanguage(text)) failures.push('expected sales/automation framing');
    if (expectation === 'question' && !asksQuestion(text)) failures.push('expected a qualification question');
    if (expectation === 'cjk' && !isCjk(text)) failures.push('expected Chinese/CJK response');
    if (expectation === 'currency_vnd' && result.preferred_currency !== 'VND') failures.push(`expected preferred_currency=VND got=${result.preferred_currency}`);
    if (expectation === 'simple_greeting' && !isSimpleGreetingResult(result, text)) failures.push('expected deterministic/simple greeting sales opener');
    if (expectation === 'redirect' && !redirectsToScope(text)) failures.push('expected redirect to {{COMPANY_NAME}} automation scope');
    if (expectation === 'not_weather_answer' && !doesNotAnswerWeather(text)) failures.push('expected not to answer the weather request directly');
  }

  if (!result.ok) failures.push('bot result ok=false');
  if (!text && result.status === 'answered') failures.push('answered status without response text');

  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const results = [];

  for (let i = 0; i < CASES.length; i += 1) {
    const caseDef = CASES[i];
    const thread = `${args.thread}-${String(i + 1).padStart(2, '0')}-${caseDef.name}`;

    runBot(args, ['--reset', '--thread', thread]);
    const result = runBot(args, ['--thread', thread, '--message', caseDef.message]);
    const failures = evaluate(caseDef, result);

    results.push({
      name: caseDef.name,
      thread,
      status: result.status || null,
      ok: failures.length === 0,
      failures,
      response_preview: textOf(result).replace(/\s+/g, ' ').slice(0, 260),
    });
  }

  const handoffThread = `${args.thread}-handoff-marker`;
  runBot(args, ['--reset', '--thread', handoffThread]);
  const handoff = runBot(args, ['--thread', handoffThread, '--message', 'Подключи живого оператора']);
  const afterHandoff = runBot(args, ['--thread', handoffThread, '--message', 'А сколько стоит Instagram бот?']);
  const reset = runBot(args, ['--reset', '--thread', handoffThread]);
  const afterReset = runBot(args, ['--thread', handoffThread, '--message', 'А сколько стоит Instagram бот?']);

  const handoffFailures = [];
  if (handoff.status !== 'escalated') handoffFailures.push(`expected first handoff status=escalated got=${handoff.status}`);
  if (!/оператор|человек|human|specialist/i.test(textOf(handoff))) handoffFailures.push('expected handoff text');
  if (afterHandoff.status !== 'silent_already_escalated') handoffFailures.push(`expected silence after escalation got=${afterHandoff.status}`);
  if (textOf(afterHandoff)) handoffFailures.push('expected no response while escalation marker is active');
  const resetStatus = reset.status || reset.state?.status;
  if (resetStatus !== 'bot_active') handoffFailures.push(`expected reset status=bot_active got=${resetStatus}`);
  if (afterReset.status !== 'answered') handoffFailures.push(`expected answered after reset got=${afterReset.status}`);
  if (!hasPrice(textOf(afterReset))) handoffFailures.push('expected price after reset');

  results.push({
    name: 'escalation_marker_silence_and_reset',
    thread: handoffThread,
    status: `${handoff.status || 'null'} -> ${afterHandoff.status || 'null'} -> ${resetStatus || 'null'} -> ${afterReset.status || 'null'}`,
    ok: handoffFailures.length === 0,
    failures: handoffFailures,
    response_preview: textOf(afterReset).replace(/\s+/g, ' ').slice(0, 260),
  });

  const failed = results.filter((item) => !item.ok);
  const summary = {
    ok: failed.length === 0,
    passed: results.length - failed.length,
    failed: failed.length,
    tenant: args.tenant,
    channel: args.channel,
    base_thread: args.thread,
    results,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
