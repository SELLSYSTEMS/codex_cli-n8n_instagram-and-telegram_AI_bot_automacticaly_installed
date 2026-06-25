# Conversational AI sales scenario suite

This catalog defines reusable tests for the public n8n + Supabase RAG bot template. It is intentionally company-neutral: use placeholders and environment variables for prices, products, channels, tokens, and knowledge-base content.

## Purpose

Use these scenarios to validate that every channel adapter (Instagram, Telegram, WhatsApp, or future channels) sends the same normalized message contract into one shared AI brain. The channel layer should only receive, normalize, send replies, and log delivery state. Sales logic, memory, RAG, escalation, and reset behavior should live in the shared core flow.

## Acceptance rules

- The bot answers like a real expert, not with generic support templates.
- It keeps thread context across turns using Supabase memory.
- It retrieves company knowledge through Supabase `pgvector`; no local vector store and no external vector wrapper.
- It qualifies the buyer before recommending an offer.
- It uses USD by default unless the user asks for another currency or locale-specific pricing.
- It handles objections with diagnosis, business value, risk reduction, and a concrete next step.
- It asks for prepayment or booking only when there is enough buying intent.
- It escalates to a human only for explicit human requests, legal/payment execution, safety/regulatory concerns, unsupported work, or genuinely low confidence.
- After escalation, it stays silent until an operator reset marker clears the escalation state.
- It supports multilingual conversations by meaning, not by brittle keyword rules.

## Environment contract

The runnable test harness should use environment variables only:

```bash
INTERNAL_RAG_TEST_URL=https://YOUR_N8N_DOMAIN/webhook/internal-rag-test
INTERNAL_TEST_TOKEN=replace_me
EXPECTED_AUDIT_PRICE_USD=replace_me
EXPECTED_MVP_FROM_USD=replace_me
EXPECTED_SUPPORT_FROM_USD=replace_me
```

Never commit real tokens, page IDs, phone IDs, OpenAI keys, Supabase service keys, Meta tokens, Telegram tokens, or WhatsApp tokens.

## Scenario matrix

| ID | Scenario | Validates |
| --- | --- | --- |
| 01 | Founder with vague demand | Discovery before pitching; business diagnosis; no template response. |
| 02 | Price shopper | Gives pricing framework, qualifies scope, explains value. |
| 03 | Cheaper competitor objection | Handles price objection without discounting too early. |
| 04 | Escalation marker and reset | Bot stays silent after escalation until reset. |
| 05 | Technical context loss | Maintains previous technical context across turns. |
| 06 | English SaaS founder | English sales flow, SaaS-specific qualification. |
| 07 | Spanish service business | Multilingual semantic handling. |
| 08 | Irrelevant topic | Off-topic detection and safe redirect. |
| 09 | Human-only emergency | Escalates only when human intervention is required. |
| 10 | Reset after operator | Operator reset re-enables bot response. |
| 11 | Audit scope | Explains audit deliverables and business output. |
| 12 | Implementation roadmap | Produces staged implementation plan. |
| 13 | Price objection: thinking | Keeps conversation alive without pressure. |
| 14 | Company docs RAG | Uses retrieved knowledge instead of hallucinated offers. |
| 15 | Bot quality complaint | Responds to quality complaints with corrective plan. |
| 16 | ROI metrics | Explains measurable ROI and tracking. |
| 17 | USD pricing | Defaults to USD for public/global template. |
| 18 | Local currency request | Switches currency only when requested. |
| 19 | Send price only | Gives concise pricing but still anchors value and next step. |
| 20 | Technical integrations | Explains integrations and asks for system details. |
| 21 | CRM/payment integration | Handles CRM, calendar, payment, and handoff architecture. |
| 22 | Privacy/security | Gives privacy/security answer only for real privacy/security intent. |
| 23 | Delayed context | Recovers context after delayed follow-up. |
| 24 | Aggressive relevant sales | Handles hostile but relevant buyers without escalating too early. |
| 25 | Channel prioritization | Helps choose first launch channel. |
| 26 | CFO budget control | Addresses budget risk, ROI, and phased rollout. |
| 27 | Emotional owner | Calms, diagnoses, and converts frustration into next step. |
| 28 | Skeptical technical founder | Gives technical confidence without overclaiming. |
| 29 | Bargain hunter hard discount | Protects margin; offers smaller scope instead of blind discount. |
| 30 | Legal/privacy cautious | Separates legal review from implementation discussion. |
| 31 | Ready buyer prepayment | Moves to booking/prepayment when intent is high. |
| 32 | Service business discovery | Qualifies service, branch/location, urgency, booking path, and deposit. |
| 33 | Ecommerce owner | Handles catalog/order/support automation path. |
| 34 | High-ticket consulting | Adapts to high-trust consultative sales. |
| 35 | Language switching | Keeps meaning and context when the user switches languages. |

## Recommended test loop

1. Upload or seed company knowledge into Supabase.
2. Run one internal webhook scenario suite against the shared AI brain.
3. Fix prompt, memory, retrieval, or routing failures in the core workflow only.
4. Re-run the internal suite until every scenario passes.
5. Test each channel adapter with one short smoke test.
6. Export sanitized workflow JSON and update public docs only after private company data is removed.

## Internal webhook request shape

```json
{
  "tenant_id": "demo_tenant",
  "channel": "internal_test",
  "thread_id": "scenario-01",
  "user_id": "lead-01",
  "text": "I want an AI bot for my business but I do not know where to start"
}
```

The response should include at minimum:

```json
{
  "answer": "...",
  "requires_handoff": false,
  "detected_intent": "...",
  "confidence": 0.8
}
```

## Public-template rule

The public repository should contain the reusable architecture, scenario matrix, workflow templates, and schema templates. It should not contain one company's private knowledge base, proprietary sales scripts, live tokens, real page/account IDs, or exact private pricing unless those are intentionally public examples.
