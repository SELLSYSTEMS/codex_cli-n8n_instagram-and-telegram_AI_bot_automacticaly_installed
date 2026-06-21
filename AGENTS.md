## Scope

This repository only covers:
- GitHub docs and runbooks for the Instagram DM RAG bot playbook
- n8n workflow artifacts
- Supabase schema and operational notes

Do not use this repo as an execution target for host/network platform changes.

## Hard Constraints

- **Never modify** SSH configuration/files.
- **Never modify** SSL/TLS certificate files or certificate issuance workflows.
- **Never modify** WireGuard configuration.
- **Never modify** firewall rules or security-groups.
- Do not change unrelated services on the host, including Nginx, reverse-proxy, DNS, or system services.

## Secrets and Credentials

- Do not commit secrets.
- Keep all real secrets in `.env` and list them in `.gitignore`.
- Use placeholders in workflow exports and docs; reference environment variables where possible.

## Operational Notes

- Main n8n domain: `https://<your-n8n-domain>`
- Keep all user-facing workflow names and labels consistent for future AI agent onboarding.
