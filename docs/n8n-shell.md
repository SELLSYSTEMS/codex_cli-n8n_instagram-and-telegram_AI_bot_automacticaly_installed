# n8n as a replaceable shell

The workflows directory contains inactive import artifacts. Import only the channels required by an installation.

The shell is intentionally thin:

- channel workflows normalize and deliver;
- the test harness calls the same Brain API used by channels;
- the escalation reset workflow calls a protected admin endpoint;
- the model route admin workflow changes only validated runtime configuration;
- knowledge ingestion is private and authenticated.

Deleting or replacing n8n must not delete conversation memory, RAG data, evaluations, or business rules because those belong to PostgreSQL and the Brain API.
