# Model routing

The default route order is stored in config/model-routes.default.json.

1. codex_spark: enabled, gpt-5.3-codex-spark.
2. codex_mini: enabled, gpt-5.4-mini.
3. deepseek_flash: disabled.
4. openai_api: disabled, gpt-4.1.
5. deepseek_reasoner: disabled.

The OpenAI model name was verified through the Models API and a controlled Responses API call. The stable request alias is gpt-4.1; the verified resolved snapshot was gpt-4.1-2025-04-14.

Fallback is operational, not semantic. It occurs only for classified retryable failures or quota exhaustion. Every attempt records route ID, latency, result class, and selected model without recording credentials.

Runtime overrides belong in an ignored private file or protected configuration service. Human operators may change enabled state and priority through a protected admin workflow, but public defaults remain safe.
