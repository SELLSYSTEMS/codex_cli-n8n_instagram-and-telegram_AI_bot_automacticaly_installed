# Public template strategy

The public repository should teach an AI coding agent how to recreate the system without exposing this company's private memory or credentials.

## Public repo should contain

- Architecture overview.
- n8n workflow exports with environment variable references.
- Supabase schema and RPCs.
- Setup runbook.
- Instagram first-path guide.
- Operator escalation/reset guide.
- Skill instructions for Codex/OpenClaw-style reuse.

## Public repo should not contain

- Real n8n API keys.
- OpenAI API keys.
- Instagram access tokens.
- Supabase service keys.
- Private company memory packs.
- Raw conversations or lead data.
- Company-specific operator-only prompts unless intentionally sanitized.

## Private customer memory model

Each future user should bring their own curated company pack. The template should define the shape:

- `company_identity`
- `services_and_offers`
- `pricing_or_quote_logic`
- `qualification_questions`
- `support_rules`
- `proof_and_case_families`
- `guardrails`
- `handoff_rules`

The template should not ship Sell.Systems private content as default retrieval data.
