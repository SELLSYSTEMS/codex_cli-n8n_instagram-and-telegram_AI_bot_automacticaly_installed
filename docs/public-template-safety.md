# Public-template safety

Before every public push:

1. Run npm run template:audit.
2. Inspect staged paths and diff.
3. Confirm .env, .private, production exports, execution payloads, private documents, and runtime route overrides are absent.
4. Confirm examples use synthetic tenants and identifiers.
5. Confirm workflows are inactive and contain no credential values.
6. Confirm local PostgreSQL is documented as default.
7. Confirm Supabase appears only as an explicit optional profile.
8. Confirm no company-specific prompt or test corpus is present.

If a secret was ever committed, removal from the current tree is insufficient. Rotate it and clean repository history deliberately.
