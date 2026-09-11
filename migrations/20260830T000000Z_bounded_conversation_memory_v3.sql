begin;

alter table agent.conversations
  alter column durable_memory_version set default 3,
  alter column durable_memory set default
    '{"memory_schema_version":3,"current_objective":"","active_workstreams":[],"settled_customer_facts":[],"confirmed_commitments":[],"unresolved_material_question":"","last_completed_outcome":"","active_commercial_lifecycle":{},"commercial_readiness":"not_ready","scope_sufficiency":"insufficient","sparse_contact_profile":{},"established_response_language":"","authoritative_evidence_references":[]}'::jsonb;

with source as (
  select
    id,
    coalesce(durable_memory, '{}'::jsonb) as memory
  from agent.conversations
)
update agent.conversations as conversation
set
  durable_memory_version = 3,
  durable_memory = jsonb_build_object(
    'memory_schema_version', 3,
    'current_objective',
      case
        when jsonb_typeof(source.memory -> 'current_objective') = 'string'
          then source.memory ->> 'current_objective'
        else ''
      end,
    'active_workstreams',
      case
        when jsonb_typeof(source.memory -> 'active_workstreams') = 'array'
          then source.memory -> 'active_workstreams'
        else '[]'::jsonb
      end,
    'settled_customer_facts',
      case
        when jsonb_typeof(source.memory -> 'settled_customer_facts') = 'array'
          then source.memory -> 'settled_customer_facts'
        when jsonb_typeof(source.memory -> 'settled_customer_facts') = 'object'
          then (
            select coalesce(
              jsonb_agg(
                jsonb_build_object('key', fact.key, 'value', fact.value)
                order by fact.key
              ),
              '[]'::jsonb
            )
            from jsonb_each(source.memory -> 'settled_customer_facts') as fact
          )
        else '[]'::jsonb
      end,
    'confirmed_commitments',
      case
        when jsonb_typeof(source.memory -> 'confirmed_commitments') = 'array'
          then source.memory -> 'confirmed_commitments'
        else '[]'::jsonb
      end,
    'unresolved_material_question',
      case
        when jsonb_typeof(source.memory -> 'unresolved_material_question') = 'string'
          then source.memory ->> 'unresolved_material_question'
        else ''
      end,
    'last_completed_outcome',
      case
        when jsonb_typeof(source.memory -> 'last_completed_outcome') = 'string'
          then source.memory ->> 'last_completed_outcome'
        else ''
      end,
    'active_commercial_lifecycle',
      case
        when jsonb_typeof(source.memory -> 'active_commercial_lifecycle') = 'object'
          then source.memory -> 'active_commercial_lifecycle'
        else '{}'::jsonb
      end,
    'commercial_readiness',
      case
        when source.memory ->> 'commercial_readiness' in (
          'not_ready',
          'considering',
          'explicitly_ready'
        ) then source.memory ->> 'commercial_readiness'
        else 'not_ready'
      end,
    'scope_sufficiency',
      case
        when source.memory ->> 'scope_sufficiency' in (
          'insufficient',
          'proposal_ready',
          'transaction_ready'
        ) then source.memory ->> 'scope_sufficiency'
        else 'insufficient'
      end,
    'sparse_contact_profile',
      case
        when jsonb_typeof(source.memory -> 'sparse_contact_profile') = 'object'
          then source.memory -> 'sparse_contact_profile'
        else '{}'::jsonb
      end,
    'established_response_language',
      case
        when jsonb_typeof(source.memory -> 'established_response_language') = 'string'
          then source.memory ->> 'established_response_language'
        else ''
      end,
    'authoritative_evidence_references',
      case
        when jsonb_typeof(source.memory -> 'authoritative_evidence_references') = 'array'
          then source.memory -> 'authoritative_evidence_references'
        else '[]'::jsonb
      end
  )
from source
where conversation.id = source.id;

commit;
