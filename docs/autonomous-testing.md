# Autonomous Bot Regression Testing

Use this before live Instagram or Telegram QA. It tests the bot brain directly through Supabase and OpenAI, without sending external channel replies.

## Command

```bash
node scripts/internal-bot-regression-suite.mjs --thread local-regression
```

Optional flags:

```bash
node scripts/internal-bot-regression-suite.mjs --tenant demo --channel internal_test --thread local-regression --no-log
```

## What the suite checks

- Russian sales/pricing questions return concrete USD price anchors.
- Website, CRM, Instagram, Telegram, lead handling, and sales automation requests are treated as sales opportunities, not rejected early.
- The assistant asks a useful qualification question when the lead describes a business problem.
- English and Chinese pricing questions are answered in the customer language and still use USD anchors.
- Off-topic questions are redirected to {{COMPANY_NAME}} automation scope instead of answering unrelated content.
- Explicit operator requests mark the thread as escalated.
- After escalation, the bot stays silent for that thread.
- After an operator reset, the bot answers again.

## Required pass condition

The command must finish with:

```json
{
  "ok": true
}
```

If any scenario fails, fix the bot prompt, deterministic routing, retrieval context, or Supabase state logic before running live Instagram tests.

## Live channel rule

Instagram and Telegram should be used only after the internal suite passes. Live channel tests validate webhook transport, token permissions, and delivery. They should not be the primary way to iterate on AI behavior.
