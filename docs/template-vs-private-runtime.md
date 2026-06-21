# Public template vs private runtime

This repository is the public implementation template. It must stay reusable for any company and must not contain a specific company's credentials, customer data, sales memory, prices, thread IDs, page IDs, Supabase project IDs, or n8n hostnames.

## Public template layer

Commit these items to the public repository:

- n8n workflow exports with placeholder values such as `{{COMPANY_NAME}}`, `<your-n8n-domain>`, and `<your-supabase-project-ref>`.
- Supabase schema, RPC definitions, indexes, and generic seed examples.
- setup scripts, smoke tests, and audit scripts.
- generic agent behavior patterns, escalation logic, test scenarios, and runbooks.
- OpenClaw/Codex instructions for installing and adapting the template.

Do not commit these items:

- real `.env` files or secrets.
- private company knowledge-base documents.
- real Page IDs, Instagram IDs, customer thread IDs, n8n domains, Supabase refs, or access tokens.
- company-specific price lists, offer names, scripts, prompts, or sales positioning.
- private operator notes or local Obsidian memory.

## Private runtime layer

Keep these items only in the target company's runtime:

- `.env` and n8n credentials.
- company-specific Supabase `tenant_settings`, `documents`, and sales knowledge.
- live n8n workflow instances connected to the company's Instagram, Telegram, or other channels.
- internal regression data that contains real offers, prices, users, or customer context.

For this project, the current server is used as the private lab while the public repository stays generic. Improvements should first be tested in the private runtime. Only the distilled pattern should be promoted back into the repository.

## Promotion rule

Before committing, convert private implementation details into reusable template concepts:

- Replace company names with `{{COMPANY_NAME}}`.
- Replace domains with `<your-n8n-domain>` or `<your-company-domain>`.
- Replace Supabase project refs with `<your-supabase-project-ref>`.
- Replace real price anchors with configurable examples or environment-driven settings.
- Replace private bot behavior with generic instructions that another company can customize.

Run this before committing:

```bash
node scripts/audit-public-template-safety.mjs
```

The audit fails if tracked files contain known private runtime markers.
