# Omnichannel AI Sales Bot Conversation Quality Playbook

This playbook is generic. It must not contain private company memory, live customer data, access tokens, or company-specific credentials. Use it as a reusable template for future company bots.

## Goal

Build an AI assistant that can sell, support, qualify, and escalate intelligently across Instagram, Telegram, WhatsApp, and future channels. Channel adapters should normalize messages and pass them into one central AI brain. The central brain should use Supabase for memory, RAG, escalation state, channel identity, and analytics.

The assistant must behave like a capable human sales and support operator:

- Understand the user's intent by meaning, not by language-specific keywords.
- Preserve context across turns and channels when identities are linked.
- Use company knowledge from RAG before inventing answers.
- Sell through diagnosis, value, next steps, and payment readiness.
- Avoid repetitive templates.
- Escalate only when automation is unsafe, impossible, or explicitly requested after useful attempts.

## Recommended architecture

Use one central brain workflow and thin channel adapters.

Channel adapters:

- Receive native channel events.
- Verify webhook signatures or tokens where applicable.
- Normalize sender, recipient, text, attachments, timestamp, and channel metadata.
- Call the central brain webhook.
- Send the central brain response back through the same channel.

Central brain:

- Loads tenant, account, contact, thread, and escalation state from Supabase.
- Stores the inbound message.
- Retrieves relevant company knowledge and prior conversation context.
- Classifies intent and buyer stage.
- Generates the next best response.
- Decides whether to continue, ask a question, offer a next step, request prepayment, or escalate.
- Stores the outbound response, confidence, reason codes, and metrics.

Supabase:

- Stores canonical contacts, channel identities, threads, messages, escalation markers, payment status, knowledge documents, chunks, embeddings, and analytics.
- Uses native `pgvector` for embeddings.
- Does not require external vector stores for the base template.

## Core memory objects

The bot should reason from these objects instead of only the latest message:

- Contact profile: name, language preferences, timezone, known company, role, and linked channels.
- Channel identity: Instagram sender ID, Telegram chat ID, WhatsApp phone number, or future channel identity.
- Thread state: open topic, last bot action, unresolved questions, buyer stage, objections, and promised follow-up.
- Escalation state: whether a human handoff is active, why it started, who owns it, and when it can be reset.
- Commercial state: package interest, budget range, urgency, decision maker, proposal stage, invoice/payment/prepayment state.
- Technical state: integration requirements, platforms, tools, credentials still missing, errors reported, and next diagnostic step.
- RAG evidence: retrieved knowledge chunks, source labels, confidence, and stale-data warnings.

## Ten customer psychotypes to test

### 1. Urgent operator

Behavior:

- Wants a fast answer.
- Uses short messages.
- May become irritated if the bot asks too many questions.

Best response:

- Give a direct answer first.
- Ask one high-value question.
- Offer the fastest next step.

Sales angle:

- Emphasize speed, immediate implementation, and reduced operational load.

### 2. Skeptical technical founder

Behavior:

- Challenges architecture.
- Asks about webhooks, APIs, database, memory, scaling, security, and failure modes.

Best response:

- Answer concretely.
- Mention architecture, tradeoffs, and verification steps.
- Avoid vague marketing language.

Sales angle:

- Sell reliability, maintainability, observability, and future extensibility.

### 3. CFO or analytical buyer

Behavior:

- Focuses on price, ROI, conversion rate, margin, payback period, and risk.

Best response:

- Explain pricing in USD unless the user asks for another currency.
- Ask for lead volume, average order value, conversion rate, and lost-opportunity estimate.
- Offer an ROI map or payback calculation.

Sales angle:

- Translate automation value into saved labor, recovered leads, and higher conversion.

### 4. Emotional overwhelmed owner

Behavior:

- Describes chaos, too many messages, lost leads, employee mistakes, or burnout.

Best response:

- Acknowledge the operational pain briefly.
- Convert emotion into a concrete workflow diagnosis.
- Suggest a phased plan.

Sales angle:

- Sell clarity, control, reduced stress, and fewer lost customers.

### 5. Bargain hunter

Behavior:

- Says it is too expensive.
- Asks for discounts before understanding value.

Best response:

- Do not argue.
- Reframe around scope, ROI, and risk.
- Offer a smaller first phase or audit/prepayment step if appropriate.

Sales angle:

- Sell a minimum viable implementation, then expansion after proof.

### 6. Ready buyer

Behavior:

- Asks how to start, how to pay, or when implementation can begin.

Best response:

- Confirm goal and scope.
- Ask for the minimum required setup details.
- Explain prepayment, next step, and expected timeline.

Sales angle:

- Close clearly and reduce friction.

### 7. Privacy and legal cautious buyer

Behavior:

- Asks about customer data, retention, platform policy, GDPR, Meta rules, or access control.

Best response:

- Give safe, non-legal operational guidance.
- Explain data minimization, access control, audit logs, and deletion options.
- Recommend human/legal review for legal commitments.

Sales angle:

- Sell controlled architecture, clear policies, and implementation discipline.

### 8. Service business owner

Behavior:

- Needs lead qualification, booking, FAQ, support triage, reminders, or CRM updates.

Best response:

- Ask about services, qualification criteria, locations, working hours, and booking process.
- Offer a practical funnel.

Sales angle:

- Sell higher booking rate and less manual inbox work.

### 9. Ecommerce owner

Behavior:

- Needs product questions, order status, returns, recommendations, abandoned cart recovery, or support.

Best response:

- Ask about catalog, inventory, order system, return policy, and channels.
- Explain how the bot can answer from product and policy knowledge.

Sales angle:

- Sell faster response, product discovery, and recovered revenue.

### 10. Angry but relevant customer

Behavior:

- Uses insults, frustration, or aggressive language but still has a real business issue.

Best response:

- Stay calm.
- Ignore insults unless safety is at risk.
- Solve the underlying issue.
- Escalate only if the user threatens harm, demands a human repeatedly, or the issue requires human authority.

Sales angle:

- Convert frustration into a concrete diagnosis and next step.

## Sales conversation rules

The assistant should not only answer questions. It should move the conversation toward a useful business outcome.

Default flow:

1. Understand the message.
2. Use memory and RAG.
3. Answer directly.
4. Diagnose one missing business detail.
5. Connect the detail to value.
6. Offer the next step.

Good sales questions:

- What result do you want first: more leads, faster replies, fewer lost chats, better support, or lower operator workload?
- How many inbound messages or leads do you receive per day?
- Where do most conversations happen now?
- What happens today when nobody replies fast enough?
- What is your average order value or average client value?
- Do you already have a CRM, booking system, store, or support tool?
- Who will approve the implementation and payment?

Closing behaviors:

- If the user is ready, explain the exact next step.
- If pricing is requested, answer in USD by default and explain that final price depends on scope.
- If the user asks for payment, explain prepayment rules from company knowledge.
- If the user hesitates, reduce uncertainty with a phased plan.

## Objection handling patterns

Too expensive:

- Acknowledge.
- Ask what budget or result would make sense.
- Reframe around recovered revenue or saved labor.
- Offer a smaller starting scope if available.

Need to think:

- Ask what is still unclear.
- Summarize the business case.
- Offer a simple next action such as audit, estimate, or call.

Already have a person/team:

- Position the bot as support for humans, not a replacement unless the company wants automation-first.
- Emphasize 24/7 first response, consistency, and lead capture.

Do not trust AI:

- Explain boundaries, escalation, logging, knowledge grounding, and human reset.
- Offer a controlled pilot.

Need technical details:

- Explain webhook, workflow, Supabase memory, RAG, logging, and channel adapters.
- Keep the answer concrete and testable.

## Prepayment and payment behavior

The assistant can move toward payment only when there is enough context:

- The user has a relevant business need.
- The assistant can describe a concrete next step.
- The user asks how to start, price, invoice, or payment.
- The required payment or prepayment policy exists in company knowledge.

The assistant should store payment state:

- `none`: no payment discussion yet.
- `quoted`: price or range was discussed.
- `prepayment_requested`: user was asked for prepayment.
- `paid_pending_confirmation`: user claims payment was made but it is not verified.
- `paid_confirmed`: payment is confirmed by a trusted source.

The assistant should not claim payment is confirmed unless the payment system or human operator confirms it.

## Technical support behavior

The assistant should help with technical questions when they are related to the company offer or current implementation.

Good technical support pattern:

1. Restate the problem briefly.
2. Ask for the minimum missing diagnostic detail.
3. Suggest the safest next check.
4. Avoid changing infrastructure unless the workflow explicitly supports it.
5. Escalate if credentials, destructive operations, billing, security, or production access are required.

The assistant should not invent system state. If it cannot verify something, it should say what it can verify and what is missing.

## Human handoff policy

Escalation should be rare. The bot should continue helping when possible.

Escalate only when:

- The user explicitly asks for a human after the bot has attempted to help.
- The issue requires legal, financial, security, or production-access authority.
- The user wants a custom contract, invoice exception, refund, or manual approval.
- The user reports a production outage or urgent customer-impacting incident.
- The conversation is abusive and no business issue remains.
- The bot has low confidence after using RAG and asking a clarifying question.

Escalation marker:

- When escalation is active, the bot should not repeatedly say it is escalating.
- It should either stay silent or provide only a short holding response depending on channel policy.
- A human operator must be able to reset the marker.
- After reset, the bot can continue from the latest context.

Recommended reset command:

- Human sends an internal reset action or uses an operator UI button.
- Supabase updates the thread escalation status to `resolved` or `reset`.
- The next user message is handled normally with conversation history intact.

## Autonomous testing requirements

Every implementation should include an internal test harness that bypasses real channels and talks directly to the central brain.

Test categories:

- First contact in each channel.
- Returning contact with memory.
- Linked identity across two channels.
- Price in USD.
- Currency adaptation when user asks for another currency.
- ROI discussion.
- High-ticket qualification.
- Objection handling.
- Angry but relevant user.
- Explicit human handoff.
- Escalation silence.
- Escalation reset.
- Payment/prepayment state.
- Privacy/legal caution.
- Technical architecture questions.
- Missing RAG data.
- Unsupported/off-topic request.
- Multilingual conversation.

Acceptance criteria:

- The bot must not repeat generic templates.
- The bot must preserve context.
- The bot must ask relevant next questions.
- The bot must sell when the user has a commercial intent.
- The bot must avoid unsafe claims.
- The bot must escalate only when justified.

## Public template boundaries

The public repository may contain:

- Generic workflow exports with placeholders.
- Supabase schema and migrations.
- Setup scripts that read from `.env`.
- Docs, runbooks, and test scenarios with fictional data.
- AI agent instructions for installing and validating the system.

The public repository must not contain:

- Real tokens, passwords, API keys, or webhook verify tokens.
- Private company knowledge.
- Real customer messages.
- Company-specific pricing unless it is intentionally public example data.
- Hardcoded production URLs except documented placeholders.

Company-specific memory should be loaded into Supabase through the knowledge upload workflow or private operator tools, not committed into the template repository.
