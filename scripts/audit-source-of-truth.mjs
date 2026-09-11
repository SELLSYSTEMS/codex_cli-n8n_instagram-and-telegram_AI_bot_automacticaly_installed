#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const errors = [];
const warnings = [];
const checks = [];

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function exists(relativePath) {
  return fs.existsSync(absolute(relativePath));
}

function readText(relativePath) {
  return fs.readFileSync(absolute(relativePath), "utf8");
}

function readJson(relativePath) {
  try {
    return JSON.parse(readText(relativePath));
  } catch (error) {
    errors.push(relativePath + ": invalid or unreadable JSON: " + error.message);
    return null;
  }
}

function record(name, ok, failureDetail, successDetail = "verified") {
  const detail = ok ? successDetail : failureDetail;
  checks.push({ name, ok, detail });
  if (!ok) errors.push(name + ": " + failureDetail);
}

function walk(value, visitor, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visitor, trail.concat(index)));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.entries(value).forEach(([key, entry]) => {
    visitor(key, entry, trail.concat(key));
    walk(entry, visitor, trail.concat(key));
  });
}

function actionsById(config, id) {
  const actions = Array.isArray(config?.actions) ? config.actions : [];
  return actions.filter((action) => action?.id === id);
}

function routeSignature(route) {
  return {
    id: route.id,
    provider: route.provider,
    model: route.model,
    enabled: Boolean(route.enabled),
    priority: Number(route.priority),
    reasoning:
      route.reasoningEffort ??
      route.reasoning_effort ??
      route.effort ??
      null
  };
}

const registryPath = "config/source-of-truth.default.json";
const registry = readJson(registryPath);
record("ownership registry", Boolean(registry?.domains), "domains registry is required");

const expectedOwners = {
  database: "brain-api",
  modelRouting: "brain-api",
  commercialActions: "brain-api",
  tenantKnowledge: "brain-api",
  conversationSemantics: "brain-api",
  channelDelivery: "n8n-shell",
  operations: "operator"
};

for (const [domain, owner] of Object.entries(expectedOwners)) {
  record(
    "owner " + domain,
    registry?.domains?.[domain]?.owner === owner,
    "expected " + owner
  );
}

if (registry?.domains) {
  for (const domain of Object.values(registry.domains)) {
    for (const key of ["publicContract", "publicPrompt"]) {
      if (domain[key]) {
        record("path " + domain[key], exists(domain[key]), "referenced public path is missing");
      }
    }
  }
}

const defaultRoutesPath = "config/model-routes.default.json";
const defaultRoutes = readJson(defaultRoutesPath);
const routes = Array.isArray(defaultRoutes?.routes) ? defaultRoutes.routes : [];
record("model routes present", routes.length > 0, "at least one model route is required");

const routeIds = routes.map((route) => route.id);
record(
  "model route IDs unique",
  new Set(routeIds).size === routeIds.length,
  "duplicate route IDs found"
);

const priorities = routes.map((route) => Number(route.priority));
record(
  "model priorities unique",
  priorities.every(Number.isFinite) && new Set(priorities).size === priorities.length,
  "priorities must be finite and unique"
);

const enabledRoutes = routes
  .filter((route) => route.enabled)
  .sort((left, right) => Number(left.priority) - Number(right.priority));
record("enabled model route", enabledRoutes.length > 0, "no enabled route exists");

if (enabledRoutes[0]) {
  record(
    "primary route description",
    /primary/i.test(String(enabledRoutes[0].purpose || "")),
    "highest-priority enabled route must identify itself as primary"
  );
}
if (enabledRoutes[1]) {
  record(
    "secondary route description",
    /secondary/i.test(String(enabledRoutes[1].purpose || "")),
    "second enabled route must identify itself as secondary"
  );
}

const runtimeRoutesPath = registry?.domains?.modelRouting?.runtimeOverride;
if (runtimeRoutesPath && exists(runtimeRoutesPath)) {
  const runtimeRoutes = readJson(runtimeRoutesPath);
  const runtimeList = Array.isArray(runtimeRoutes?.routes) ? runtimeRoutes.routes : [];
  const publicContracts = new Map(
    routes.map((route) => [route.id, { provider: route.provider, model: route.model }]),
  );
  const runtimeIds = runtimeList.map((route) => route.id);
  const priorities = runtimeList.map((route) => route.priority);
  const contractCompatible =
    runtimeIds.length === publicContracts.size &&
    new Set(runtimeIds).size === runtimeIds.length &&
    runtimeList.every((route) => {
      const contract = publicContracts.get(route.id);
      return contract?.provider === route.provider && contract?.model === route.model;
    });
  const priorityCompatible =
    priorities.every((priority) => Number.isFinite(priority)) &&
    new Set(priorities).size === priorities.length;
  const hasEnabledRoute = runtimeList.some((route) => route.enabled === true);
  const inlineSecretPaths = [];
  const inspectInlineSecrets = (value, pathParts = []) => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      const nextPath = [...pathParts, key];
      if (
        /(secret|token|password|api[_-]?key|authorization)/i.test(key) &&
        typeof nested === "string" &&
        nested.trim()
      ) {
        inlineSecretPaths.push(nextPath.join("."));
      }
      inspectInlineSecrets(nested, nextPath);
    }
  };
  inspectInlineSecrets(runtimeRoutes);
  record(
    "runtime model route contract compatibility",
    contractCompatible,
    "runtime routes must preserve the complete public id/provider/model contract",
  );
  record(
    "runtime model route priorities",
    priorityCompatible,
    "runtime route priorities must be finite and unique",
  );
  record(
    "runtime model route availability",
    hasEnabledRoute,
    "runtime override must leave at least one model route enabled",
  );
  record(
    "runtime model route secret hygiene",
    inlineSecretPaths.length === 0,
    inlineSecretPaths.length
      ? `inline secret-like values found at ${inlineSecretPaths.join(", ")}`
      : "runtime route configuration contains no inline secrets",
  );
} else {
  warnings.push("runtime model route file is absent; acceptable only before installation");
}

const publicCommercialPath = "config/commercial-actions.default.json";
const publicCommercial = readJson(publicCommercialPath);
if (publicCommercial) {
  const publicText = JSON.stringify(publicCommercial);
  record(
    "public commercial URLs",
    !/https?:\/\//i.test(publicText),
    "public defaults must not contain tenant checkout URLs"
  );

  const publicSecrets = [];
  walk(publicCommercial, (key, value, trail) => {
    if (/(secret|token|api.?key|password|credential)/i.test(key) && value) {
      publicSecrets.push(trail.join("."));
    }
  });
  record(
    "public commercial secrets",
    publicSecrets.length === 0,
    "non-empty secret-like fields: " + publicSecrets.join(", ")
  );

  const publicCheckout = actionsById(publicCommercial, "present_checkout");
  record(
    "public checkout disabled",
    publicCheckout.length === 1 &&
      publicCheckout.every((action) => action.enabled !== true),
    "present_checkout must be disabled in the public template"
  );
}

const hasPrivate = exists(".private");
const privateCommercialPath = registry?.domains?.commercialActions?.privateOverride;
if (hasPrivate && privateCommercialPath) {
  record(
    "private commercial override",
    exists(privateCommercialPath),
    "installed tenant requires a private commercial override"
  );
  if (exists(privateCommercialPath)) {
    const privateCommercial = readJson(privateCommercialPath);
    if (privateCommercial) {
      const privateText = JSON.stringify(privateCommercial);
      record(
        "private checkout URL",
        /https:\/\//i.test(privateText),
        "installed commercial configuration requires an HTTPS checkout surface"
      );
      const privateCheckout = actionsById(privateCommercial, "present_checkout");
      record(
        "private checkout action enabled",
        privateCheckout.length === 1 &&
          privateCheckout.some((action) => action.enabled === true),
        "present_checkout is not enabled"
      );

      const privateSecrets = [];
      walk(privateCommercial, (key, value, trail) => {
        if (
          /(secret|token|api.?key|password|credential)/i.test(key) &&
          typeof value === "string" &&
          value.trim()
        ) {
          privateSecrets.push(trail.join("."));
        }
      });
      record(
        "private commercial inline secrets",
        privateSecrets.length === 0,
        "secret-like values must come from environment variables: " + privateSecrets.join(", ")
      );
    }
  }
}

const privateKnowledge = [
  ".private/active/knowledge/knowledge-manifest.json",
  ".private/active/knowledge/runtime-consultative-sales-policy.md"
];
if (hasPrivate) {
  for (const relativePath of privateKnowledge) {
    record("private knowledge " + relativePath, exists(relativePath), "required installed file is missing");
  }
}

const modelDocs = readText("docs/model-routing.md");
for (const [label, marker] of [
  ["OpenAI primary model", "gpt-4.1"],
  ["DeepSeek fallback model", "deepseek-v4-pro"]
]) {
  record(
    "model docs " + label,
    modelDocs.includes(marker),
    `documentation marker is missing: ${marker}`
  );
}
record(
  "model docs classified fallback contract",
  /classified/i.test(modelDocs) && /fallback/i.test(modelDocs),
  "documentation must describe classified fallback behavior"
);

const brainDocs = readText("docs/brain-api.md");
record(
  "escalation reset route",
  brainDocs.includes("/v1/admin/escalations/reset") &&
    !brainDocs.includes("POST /v1/escalations/reset"),
  "documentation must use the canonical admin reset route"
);

if (hasPrivate) {
  const compatibilityAliases = readJson(".private/operations/compatibility-aliases.json");
  record(
    "compatibility aliases retired",
    compatibilityAliases?.status === "retired" &&
      Array.isArray(compatibilityAliases.aliases) &&
      compatibilityAliases.aliases.length === 0 &&
      Array.isArray(compatibilityAliases.forbidden_paths) &&
      compatibilityAliases.forbidden_paths.length > 0 &&
      compatibilityAliases.forbidden_paths.every((relativePath) => !exists(relativePath)),
    "compatibility aliases must be retired and their historical paths must not exist"
  );
} else {
  warnings.push("private compatibility alias ledger not present; expected only after tenant installation");
}

const result = {
  ok: errors.length === 0,
  registry: registryPath,
  checks,
  warnings,
  errors
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exitCode = result.ok ? 0 : 1;
