alter table agent.commercial_requests
  drop constraint if exists commercial_requests_tenant_id_conversation_id_action_id_key;

create unique index if not exists commercial_requests_active_unique_idx
  on agent.commercial_requests (tenant_id, conversation_id, action_id)
  where status in ('requested', 'preparing', 'ready');

create index if not exists commercial_requests_active_lookup_idx
  on agent.commercial_requests (tenant_id, conversation_id, updated_at desc)
  where status in ('requested', 'preparing', 'ready');
