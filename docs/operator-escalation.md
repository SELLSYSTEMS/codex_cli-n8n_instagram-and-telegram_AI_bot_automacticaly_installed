# Operator escalation and reset playbook

The bot has two separate escalation concepts:

- `conversation_events.escalated`: immutable audit flag for a specific message/event.
- `thread_states.status`: current routing state for a thread.

When the bot sends a handoff/escalation reply, n8n calls `mark_thread_escalated`. Future inbound messages in the same Instagram thread are logged but receive no bot reply until a human resets the marker.

## Why this exists

Without a state marker, an escalated customer can keep messaging and the bot can repeat the same escalation text. That is bad UX and creates operator confusion. The correct behavior is one handoff message, then silence until reset.

## Reset in Supabase SQL

Use this after a human operator has reviewed the thread and wants the bot to answer again:

```sql
select public.reset_thread_escalation(
  'demo',
  'instagram',
  'THREAD_ID_FROM_CONVERSATION_EVENTS',
  'operator_name',
  'ready for bot again'
);
```

## Reset through Supabase REST RPC

```bash
curl -sS -X POST "$SUPABASE_REST_URL/rpc/reset_thread_escalation" \
  -H "apikey: $SUPABASE_SECRET_KEY" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "p_tenant_id":"demo",
    "p_channel":"instagram",
    "p_thread_id":"THREAD_ID_FROM_CONVERSATION_EVENTS",
    "p_reset_by":"operator_name",
    "p_note":"ready for bot again"
  }'
```

## Operator workflow

1. Open Supabase `conversation_events`.
2. Filter by `tenant_id`, `channel`, and `instagram_thread_id`.
3. Review the latest customer messages and the bot's last escalation reason.
4. Reply manually if needed.
5. Run `reset_thread_escalation` only when the bot should resume.
6. Send or wait for the next customer message.

## Expected n8n behavior

- Active thread: normal RAG/reply flow continues.
- Newly escalated thread: bot sends one escalation/handoff reply and marks thread state.
- Already escalated thread: n8n logs the inbound message and ends at `Silent: Already Escalated`.
