# Private variable inventory

Create a local ignored .env file. Values below are names only.

Core:

- LOCAL_POSTGRES_URL
- BRAIN_API_HOST
- BRAIN_API_PORT
- BRAIN_API_TOKEN
- BRAIN_ADMIN_TOKEN
- BOT_TENANT_KEY

Codex CLI:

- CODEX_BIN
- CODEX_HOME
- CODEX_REASONING_EFFORT
- MODEL_ROUTES_FILE
- MODEL_ROUTES_RUNTIME_FILE

Optional APIs, disabled by default:

- OPENAI_API_KEY
- DEEPSEEK_API_KEY

n8n administration:

- N8N_BASE_URL
- N8N_API_KEY

Channel-specific variables:

- Instagram app, verify, access-token, account, and Graph base variables.
- Telegram bot token and account mapping variables.
- WhatsApp app, verify, access-token, phone-number, and Graph base variables.

Use n8n credentials or a secrets manager where supported. Never expose a secret through an Edit Fields node, sticky note, export, execution payload, or Git history.
