# Model routing

## Ownership

The Brain API is the only model-routing owner. n8n and channel adapters call the Brain and never select models themselves.

The public contract is config/model-routes.default.json. An installed runtime may use the ignored .runtime/model-routes.json override. GET /health is the runtime evidence surface.

## Default order

1. codex_gpt_5_6_sol: Codex CLI model gpt-5.6-sol, high reasoning, enabled primary.
2. codex_spark: Codex CLI model gpt-5.3-codex-spark, low reasoning, enabled secondary.
3. openai_api: gpt-4.1, disabled.
4. deepseek_v4_pro: disabled.
5. codex_mini: disabled.
6. deepseek_v4_flash: disabled.

The secondary route is attempted only when the primary route returns a classified availability or quota failure. Business rejection, malformed tool output, safety refusal and ordinary low-quality text are not provider-fallback signals.

## Failure discipline

- Persist the selected route, provider, model, reasoning effort, latency and classified outcome for every model run.
- Retry only transient transport failures within the configured bounded retry policy.
- Never hide a failed external action by switching models.
- Never enable an API route merely because a CLI allowance is exhausted.
- Never duplicate provider keys or route priority in n8n.
- Change the file-backed runtime configuration only through a controlled operator action, then restart the Brain and verify GET /health.

## Capacity boundary

Codex CLI usage consumes a shared ChatGPT plan allowance whose effective request capacity varies with task complexity and context size. It is not a fixed production inference SLA and cannot be converted into a defensible concurrent-customer number from the plan price alone.

Use Codex CLI routes for development, evaluations and intentionally bounded internal traffic. Size production customer traffic from provider API RPM, TPM, latency and load-test evidence. Check current Codex allowance with the CLI status command before a test run.

## Change procedure

1. Update config/model-routes.default.json only when the reusable public contract changes.
2. Update .runtime/model-routes.json for an installed private override.
3. Run npm run source-of-truth:audit.
4. Perform a controlled Brain restart.
5. Confirm route order through GET /health.
6. Run one success case, one quota-fallback case and one non-fallback error case.
7. Preserve traces without credentials or customer content in the public repository.
