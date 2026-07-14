# Repository agent contract

## Purpose

This public repository is a generic, reusable installation template for a multichannel conversational AI system. It contains contracts, local PostgreSQL schema, orchestration scripts, n8n shell workflows, tests, and operational documentation.

## Architecture rules

- Treat n8n as a replaceable channel and operations shell.
- Keep conversation semantics, memory, RAG, tools, escalation, and model routing behind the Brain API.
- Use local PostgreSQL with pgvector by default.
- Use Supabase only when the human operator explicitly requests it in the initial installation prompt.
- Keep channel adapters thin and free of company-specific sales logic.
- Let the language model reason semantically. Do not encode language, intent, sales dialogue, objection handling, or escalation decisions as brittle keyword trees.
- Operational checks for authentication, schema validation, idempotency, rate limits, delivery, and action dispatch are required.

## Public-template safety

- Never commit credentials, tokens, private customer data, company knowledge, production IDs, private domains, or production exports.
- Store real values only in a local ignored .env file or a proper secrets manager.
- Keep tenant-specific prompts, documents, tests, and runtime overrides outside the public repository.
- Before publishing, run npm run template:audit.

## Host safety

Do not modify SSH, TLS certificates, WireGuard, firewalls, security groups, Nginx, DNS, reverse proxies, or unrelated host services.

## Completion standard

An installation is complete only after schema application, Brain API health, isolated memory, escalation reset, model fallback, internal channel-free tests, and selected channel smoke tests pass.
