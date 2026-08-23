# Local PostgreSQL migrations

This directory contains ordered, additive migrations for the canonical agent schema.

Rules:

- Use a three-digit sequence followed by a descriptive name, for example 002_add_delivery_attempts.sql.
- Never edit a migration after it has been deployed. Add a new migration instead.
- Do not include BEGIN or COMMIT. The migration runner owns the transaction boundary.
- Make every migration safe to re-run and fail closed when existing data violates a new invariant.
- Preserve tenant isolation in every unique key, lookup path, and relationship involving tenant-owned data.
- Back up production data before any destructive or large data migration.

The bootstrap schema remains the source for fresh installations. Every durable schema change must update both the bootstrap schema and an ordered migration for existing installations.
