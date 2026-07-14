# Escalation lifecycle

Escalation is durable thread state, not a phrase in the reply.

1. The brain decides escalation from full context and policy.
2. It stores reason, summary, actor, and timestamp transactionally.
3. It may send one concise handoff message.
4. Subsequent inbound messages return action silent.
5. A protected operator action resets the marker.
6. The next inbound message resumes with preserved conversation context.
7. Every state transition is auditable.

Do not reset escalation through customer text, language-specific keywords, or a public webhook.
