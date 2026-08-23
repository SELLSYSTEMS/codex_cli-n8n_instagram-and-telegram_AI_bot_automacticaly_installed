# Native evaluation and contact memory

## Contact memory contract

The Brain owns a cumulative contact profile in PostgreSQL. Every model decision may
return a sparse `contact_profile` patch containing only newly learned or explicitly
corrected facts. Empty, null, guessed, unchanged, and placeholder values are ignored.
Nested objects merge recursively and arrays keep unique meaningful values.

The model may naturally ask for one missing contact fact when that fact enables an
agreed follow-up. It must not run a CRM checklist or interrupt useful discovery.
Channel identifiers are routing metadata and are never treated as customer-provided
phone numbers.

HubSpot projection searches by the stable Brain customer key, then email, then phone.
It updates an existing record when found and skips anonymous profiles until the
customer has supplied an identifying business or contact fact.

## Native Langfuse evaluators

Run:

```bash
npm run langfuse:native-evaluators
```

This creates a local DeepSeek-compatible Langfuse model connection and six live
observation evaluators:

- conversation quality
- progressive discovery
- commercial judgment
- memory continuity
- grounding and safety
- language consistency

Rules sample all new Brain observations. Their numeric scores and reasoning appear in
the Langfuse project evaluation views after new traced interactions are processed.
No model secret is printed by the bootstrap command.

The deterministic scenario runner remains the release gate. Native judges add
semantic quality evidence; they do not replace schema, delivery, idempotency, memory,
or escalation assertions.
