import assert from "node:assert/strict";

import {
  isOperationalCheckout,
  isOperationalPaymentOption,
} from "./commercial-action-tool.mjs";
import {
  normalizeCommercialAction,
  releaseTextOnlyAfterConformanceFailure,
} from "./model-router.mjs";
import { deriveSemanticState } from "./semantic-state.mjs";

const canonicalCatalog = {
  checkout: {
    provider_name: "configured-provider",
    url: "https://checkout.example.test/",
  },
};
const deposit = {
  id: "deposit",
  enabled: true,
  fraction_of_grounded_total: 0.35,
};
const fullPayment = {
  id: "full_payment",
  enabled: true,
  fraction_of_grounded_total: 1,
};

assert.equal(isOperationalCheckout(canonicalCatalog), true);
assert.equal(isOperationalPaymentOption(deposit, canonicalCatalog), true);
assert.equal(isOperationalPaymentOption(fullPayment, canonicalCatalog), true);
assert.equal(
  isOperationalCheckout({
    checkout: {
      ...canonicalCatalog.checkout,
      provider_configured: false,
    },
  }),
  false,
);

const resolvedState = deriveSemanticState(
  {
    semantic_state: {
      known_facts: ["The buyer needs a simple landing page."],
      open_questions: [],
    },
  },
  {
    known_facts: ["The buyer is ready to begin."],
    open_questions: ["What is the launch date?"],
  },
);

assert.deepEqual(resolvedState.open_questions, []);
assert.deepEqual(resolvedState.known_facts, [
  "The buyer is ready to begin.",
  "The buyer needs a simple landing page.",
]);

const semanticError = new Error(
  "Semantic conformance review did not approve the candidate response.",
);
semanticError.code = "SEMANTIC_CONFORMANCE_FAILED";
semanticError.violations = [
  {
    rule_id: "grounded_commercial_terms",
    evidence: "The response invented an unsupported deposit percentage.",
    required_change: "Use only configured and grounded commercial terms.",
  },
];

const blocked = releaseTextOnlyAfterConformanceFailure(
  {
    shouldReply: true,
    decision: {
      reply: "Pay an unsupported 35% deposit now.",
      commercial_action: {
        action_id: "present_checkout",
      },
    },
    commercialAction: {
      actionId: "present_checkout",
    },
    failures: [],
  },
  semanticError,
);

assert.equal(blocked.shouldReply, true);
assert.equal(blocked.decision.commercial_action, null);
assert.equal(blocked.commercialAction, null);
assert.equal(blocked.semanticConformance.releaseMode, "safe_reply_fail_closed");
assert.equal(blocked.semanticConformance.actionsBlocked, true);
assert.deepEqual(blocked.semanticConformance.violations, semanticError.violations);
assert.doesNotMatch(blocked.decision.reply, /35%/);

const normalizedAuthorizedDeposit = normalizeCommercialAction({
  action_id: "present_checkout",
  option_id: "deposit",
  total_grounded_amount: 1256,
  payment_amount: 439.6,
  currency: "USD",
  grounding_reference: "Proof-Driven Landing Build: about US$1,256",
  authorization_is_explicit: true,
  authorization_is_unambiguous: true,
  authorization_evidence: "I authorize the 35% deposit now.",
  authorization_scope: "35% deposit on Proof-Driven Landing Build at US$1,256 total",
});

assert.equal(normalizedAuthorizedDeposit.action_id, "present_checkout");
assert.equal(normalizedAuthorizedDeposit.arguments.option_id, "deposit");
assert.equal(normalizedAuthorizedDeposit.arguments.grounded_total_usd, 1256);
assert.equal(
  normalizedAuthorizedDeposit.arguments.grounding_reference,
  "Proof-Driven Landing Build: about US$1,256",
);
assert.equal(normalizedAuthorizedDeposit.arguments.authorization_is_explicit, true);
assert.equal(normalizedAuthorizedDeposit.arguments.authorization_is_unambiguous, true);
assert.equal(
  normalizedAuthorizedDeposit.arguments.authorization_evidence,
  "I authorize the 35% deposit now.",
);
assert.equal(
  normalizedAuthorizedDeposit.arguments.authorization_scope,
  "35% deposit on Proof-Driven Landing Build at US$1,256 total",
);

console.log("landing buyer regression smoke: ok");
