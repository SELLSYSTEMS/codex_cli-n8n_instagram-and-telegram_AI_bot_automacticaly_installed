import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderCircuitBreaker,
  ProviderChainExhaustedError,
  runProviderChain,
} from './provider-circuit-breaker.mjs';
import { runModelProcess } from './model-process-runner.mjs';

const routes = [
  { provider: 'openai', model: 'gpt-4.1', priority: 10, enabled: true },
  { provider: 'deepseek', model: 'deepseek-v4-pro', priority: 20, enabled: true },
];

test('uses OpenAI first and does not call fallback after success', async () => {
  const called = [];
  const result = await runProviderChain({
    routes,
    breaker: new ProviderCircuitBreaker(),
    invoke: async (route) => {
      called.push(route.provider);
      return 'ok';
    },
  });
  assert.deepEqual(called, ['openai']);
  assert.equal(result.route.provider, 'openai');
});

test('falls back to DeepSeek only for retryable provider failure', async () => {
  const called = [];
  const result = await runProviderChain({
    routes,
    breaker: new ProviderCircuitBreaker(),
    invoke: async (route) => {
      called.push(route.provider);
      if (route.provider === 'openai') throw Object.assign(new Error('rate limited'), { status: 429 });
      return 'fallback-ok';
    },
  });
  assert.deepEqual(called, ['openai', 'deepseek']);
  assert.equal(result.value, 'fallback-ok');
  assert.equal(result.attempts[0].outcome, 'retryable_failure');
});

test('does not hide terminal authentication or request errors behind fallback', async () => {
  const called = [];
  await assert.rejects(
    runProviderChain({
      routes,
      breaker: new ProviderCircuitBreaker(),
      invoke: async (route) => {
        called.push(route.provider);
        throw Object.assign(new Error('unauthorized'), { status: 401 });
      },
    }),
    (error) => error.status === 401 && error.providerAttempts[0].outcome === 'terminal_failure',
  );
  assert.deepEqual(called, ['openai']);
});

test('opens, cools down, probes once, and closes circuit after success', async () => {
  let now = 1_000;
  const breaker = new ProviderCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 100,
    now: () => now,
  });
  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(
      runProviderChain({
        routes: [routes[0]],
        breaker,
        now: () => now,
        invoke: async () => { throw Object.assign(new Error('down'), { status: 503 }); },
      }),
      ProviderChainExhaustedError,
    );
  }
  assert.equal(breaker.snapshot()[0].state, 'open');
  await assert.rejects(
    runProviderChain({ routes: [routes[0]], breaker, now: () => now, invoke: async () => 'unexpected' }),
    ProviderChainExhaustedError,
  );
  now += 100;
  const recovered = await runProviderChain({
    routes: [routes[0]],
    breaker,
    now: () => now,
    invoke: async () => 'recovered',
  });
  assert.equal(recovered.value, 'recovered');
  assert.equal(breaker.snapshot()[0].state, 'closed');
});

test('terminates a timed-out model process group and bounds captured output', async () => {
  let failure;
  try {
    await runModelProcess(process.execPath, [
      '-e',
      "process.stdout.write('ready'); setInterval(() => {}, 1000)",
    ], {
      timeoutMs: 80,
      terminationGraceMs: 40,
      maxStdoutBytes: 64,
      maxStderrBytes: 64,
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, 'model_timeout');
  assert.equal(failure.stdout, 'ready');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.throws(() => process.kill(failure.pid, 0), { code: 'ESRCH' });
});

test('terminates a process that exceeds the output boundary', async () => {
  await assert.rejects(
    runModelProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], {
      timeoutMs: 2_000,
      terminationGraceMs: 25,
      maxStdoutBytes: 128,
      maxStderrBytes: 128,
    }),
    (error) => error.code === 'model_output_limit_exceeded' && Buffer.byteLength(error.stdout) === 128,
  );
});
