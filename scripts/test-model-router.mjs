#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function findRoutes(value) {
  if (Array.isArray(value)) {
    if (
      value.length > 0 &&
      value.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof item.provider === 'string' &&
          typeof item.model === 'string',
      )
    ) {
      return value;
    }

    for (const item of value) {
      const routes = findRoutes(item);
      if (routes) return routes;
    }

    return null;
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const routes = findRoutes(item);
      if (routes) return routes;
    }
  }

  return null;
}

function routeLabel(route) {
  return `${route.provider}/${route.model}`;
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

const requestedConfig =
  argumentValue('--config') ??
  process.env.MODEL_ROUTER_TEST_CONFIG ??
  'config/model-routes.default.json';
const configPath = path.resolve(rootDir, requestedConfig);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const routes = findRoutes(config);

assert.ok(routes, 'Model route configuration must contain a non-empty route array');
assert.ok(routes.length > 0, 'At least one model route is required');

for (const route of routes) {
  assert.equal(typeof route.id, 'string', 'Every route must have a string id');
  assert.ok(route.id.trim(), 'Route id must not be empty');
  assert.equal(typeof route.provider, 'string', `${route.id}: provider must be a string`);
  assert.ok(route.provider.trim(), `${route.id}: provider must not be empty`);
  assert.equal(typeof route.model, 'string', `${route.id}: model must be a string`);
  assert.ok(route.model.trim(), `${route.id}: model must not be empty`);
  assert.equal(typeof route.enabled, 'boolean', `${route.id}: enabled must be boolean`);
  assert.ok(
    Number.isInteger(route.priority) && route.priority > 0,
    `${route.id}: priority must be a positive integer`,
  );
}

assertUnique(
  routes.map((route) => route.id),
  'Route ids',
);
assertUnique(
  routes.map((route) => route.priority),
  'Route priorities',
);
assertUnique(
  routes.map((route) => routeLabel(route)),
  'Provider/model pairs',
);

const enabledRoutes = routes
  .filter((route) => route.enabled)
  .sort((left, right) => left.priority - right.priority);

assert.ok(enabledRoutes.length > 0, 'At least one model route must be enabled');

const isPublicDefault =
  path.relative(rootDir, configPath) === path.join('config', 'model-routes.default.json');

if (isPublicDefault) {
  assert.deepEqual(
    enabledRoutes.map(routeLabel),
    ['codex_cli/gpt-5.3-codex-spark', 'codex_cli/gpt-5.4-mini'],
    'The public default fallback chain must be Codex Spark, then Codex Mini',
  );

  const disabledRoutes = new Set(routes.filter((route) => !route.enabled).map(routeLabel));
  for (const expected of [
    'deepseek/deepseek-chat',
    'openai/gpt-4.1',
    'deepseek/deepseek-reasoner',
  ]) {
    assert.ok(disabledRoutes.has(expected), `${expected} must be available but disabled by default`);
  }
}

console.log(
  JSON.stringify(
    {
      status: 'passed',
      mode: 'offline-contract',
      config: path.relative(rootDir, configPath),
      primary: routeLabel(enabledRoutes[0]),
      fallbackChain: enabledRoutes.slice(1).map(routeLabel),
      routeCount: routes.length,
    },
    null,
    2,
  ),
);
