# Model routing

## Ownership

The Brain API is the only model-routing owner. n8n and channel adapters call the Brain and never select models themselves.

The public contract is config/model-routes.default.json. An installed runtime may use the ignored .runtime/model-routes.json override. GET /health is the runtime evidence surface.

## Default order

1. openai_api: OpenAI API model gpt-4.1, enabled primary.
2. deepseek_v4_pro: DeepSeek API model deepseek-v4-pro, enabled secondary.
3. codex_gpt_5_6_sol: disabled optional development route.
4. codex_spark: disabled optional development route.
5. codex_mini: disabled optional development route.
6. deepseek_v4_flash: disabled.

The secondary route is attempted only when the primary route returns a classified provider-availability, quota, transient-transport, or open-circuit failure. Business rejection, malformed tool output, safety refusal, and ordinary low-quality prose are not provider-fallback signals.

## Failure discipline

- Persist the selected route, provider, model, reasoning effort, latency and classified outcome for every model run.
- Retry only transient transport failures within the configured bounded retry policy.
- Never hide a failed external action by switching models.
- Codex CLI routes are explicit opt-in development and evaluation routes; never auto-enable them in production.
- Never duplicate provider keys or route priority in n8n.
- Change the file-backed runtime configuration only through a controlled operator action, then restart the Brain and verify GET /health.

## Capacity boundary

Provider API routes are the production default and must be sized from measured RPM, TPM, latency, error, and load-test evidence.

Codex CLI routes are optional for development, evaluations, and intentionally bounded internal traffic. They are never automatic production fallbacks. Check current Codex allowance with the CLI status command before an explicitly enabled test run.

## Change procedure

1. Update config/model-routes.default.json only when the reusable public contract changes.
2. Update .runtime/model-routes.json for an installed private override.
3. Run npm run source-of-truth:audit.
4. Perform a controlled Brain restart.
5. Confirm route order through GET /health.
6. Run one success case, one quota-fallback case and one non-fallback error case.
7. Preserve traces without credentials or customer content in the public repository.
