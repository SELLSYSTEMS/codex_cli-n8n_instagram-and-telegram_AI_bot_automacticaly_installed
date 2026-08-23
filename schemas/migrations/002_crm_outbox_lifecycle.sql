-- Canonicalize CRM projection lifecycle and quarantine non-production artifacts.
alter table agent.crm_sync_outbox
  drop constraint if exists crm_sync_outbox_status_check;

alter table agent.crm_sync_outbox
  add constraint crm_sync_outbox_status_check
  check (status in ('pending', 'processing', 'completed', 'retry', 'dead', 'cancelled'));

update agent.crm_sync_outbox as o
set status = 'cancelled',
    locked_at = null,
    updated_at = now()
 where o.status in ('pending', 'processing', 'retry', 'dead')
   and (
     coalesce(o.last_error, '') in ('cancelled_backfill', 'invalid_test_identity')
     or o.conversation_id in (
       select c.id
         from agent.conversations as c
        where c.channel in ('scenario_test', 'internal_test')
           or lower(coalesce(c.metadata ->> 'test', 'false')) in ('true', '1', 'yes')
           or lower(coalesce(c.metadata ->> 'runtime', '')) in ('test', 'scenario')
     )
     or o.contact_id in (
       select c.id
         from agent.contacts as c
        where to_jsonb(c)::text ilike '%.example.test%'
     )
   );

update agent.crm_sync_outbox as o
set status = 'retry',
    attempts = 0,
    available_at = now(),
    locked_at = null,
    completed_at = null,
    last_error = null,
    updated_at = now()
 where o.status = 'dead'
   and coalesce(o.last_error, '') like '%crm_contact_links_provider_external_contact_id_key%';
