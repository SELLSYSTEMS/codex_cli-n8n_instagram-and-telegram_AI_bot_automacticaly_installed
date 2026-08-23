# Operations and data ownership

This document defines the repository-wide order contract. It prevents a second
database schema, a second runtime directory, or an unowned production artifact
from quietly becoming another source of truth.

## Canonical ownership

| Surface | Source of truth | Mutable | Classification | Retirement rule |
| --- | --- | --- | --- | --- |
| Generic application code | Public repository | Through reviewed changes | Public | Replace through versioned change |
| Generic workflow templates | workflows/generated | Through generation only | Public | Regenerate, audit, then replace |
| Tenant knowledge and policy | .private/active | Yes | Private local | Archive before replacement |
| Operational inventories and decisions | .private/operations | Append or supersede | Private local | Preserve with decision record |
| Historical snapshots | .private/archives | No | Private local | Operator-approved retention |
| Latest snapshot pointers | .private/pointers | Yes | Private local | Update atomically |
| Process state and test artifacts | .runtime | Yes, generated | Local ephemeral | Stop owner, then remove |
| Conversation data | PostgreSQL schema agent | Yes | Private production | Backup and migration plan |
| Legacy conversation data | PostgreSQL public.bot_* | No writes | Private quarantine | Backup, reconcile, approve, retire |
| Conversation semantics | Brain API | Yes | Private runtime | Versioned prompt/tool contract |
| Channel delivery | Thin adapters and n8n | Yes | Private runtime | Disable adapter after smoke test |
| Payments | External operator-selected application | Yes | Private external | Contract-specific migration |

## Directory contract

The public template contains generic code and documentation. Real tenant
knowledge, production identifiers, credentials, live exports, and customer
records never belong there.

The .private directory has four durable classes:

- active: current tenant knowledge, policies, actions, and private test cases.
- operations: inventories, ownership maps, migration decisions, and runbooks.
- archives: immutable snapshots and superseded material.
- pointers: small files naming the latest approved snapshot.

The .runtime directory is the only generated-state root. Logs, PIDs, model
downloads, route health, caches, traces, and test results must not create new
top-level roots.

## Database contract

The agent schema is the only writable application schema. New application
tables require an explicit owner, retention rule, indexes, tenant isolation,
and migration. Objects matching public.bot_* are legacy quarantine objects.
Runtime code must not read or write them.

Legacy retirement is intentionally separate from ordinary cleanup:

1. Create a timestamped backup.
2. Record schemas, functions, row counts, and date ranges.
3. Reconcile identities, conversations, messages, knowledge, and escalation
   state against agent.
4. Review unmatched records.
5. Obtain explicit operator approval.
6. Retire legacy objects in one reversible migration window.

## Workflow and external-service contract

n8n remains a replaceable shell. Channel workflows normalize events and deliver
responses; they do not contain tenant-specific sales reasoning. The Brain API
owns conversation semantics, memory, retrieval, tools, escalation, and model
routing.

Payment processing is an external application selected by the operator. This
repository can define a payment-action contract, but it must not claim ownership
of an unresolved domain, origin, wallet, merchant account, or checkout system.

## Required checks

Run these before publishing or after a structural migration:

1. npm run organization:audit
2. npm run project:audit
3. npm run database:inventory
4. npm run template:audit

No legacy database deletion is implied by a successful audit.
