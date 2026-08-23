import assert from "node:assert/strict";

import {
  isExecutableCommercialAction,
  isOperationalCheckout,
  isOperationalPaymentOption,
} from "./commercial-action-tool.mjs";

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
const presentCheckout = {
  id: "present_checkout",
  enabled: true,
  requires_payment_option: true,
};

const unavailableCatalog = {
  checkout: {
    provider_name: "checkout",
    url: "https://example.invalid/pay",
    provider_configured: false,
    deposit_enabled: false,
    deposit_fraction: null,
    full_payment_enabled: false,
  },
  payment_options: [deposit, fullPayment],
};

assert.equal(isOperationalCheckout(unavailableCatalog), false);
assert.equal(isOperationalPaymentOption(deposit, unavailableCatalog), false);
assert.equal(isExecutableCommercialAction(presentCheckout, unavailableCatalog), false);
assert.equal(isExecutableCommercialAction(presentCheckout), false);

const configuredCatalog = {
  checkout: {
    provider_name: "checkout",
    url: "https://checkout.example.test/pay",
    provider_configured: true,
    deposit_enabled: true,
    deposit_fraction: 0.35,
    full_payment_enabled: false,
  },
  payment_options: [deposit, fullPayment],
};

assert.equal(isOperationalCheckout(configuredCatalog), true);
assert.equal(isOperationalPaymentOption(deposit, configuredCatalog), true);
assert.equal(isOperationalPaymentOption(fullPayment, configuredCatalog), false);
assert.equal(isExecutableCommercialAction(presentCheckout, configuredCatalog), true);

const mismatchedCatalog = {
  ...configuredCatalog,
  checkout: {
    ...configuredCatalog.checkout,
    deposit_fraction: 0.5,
  },
};

assert.equal(isOperationalPaymentOption(deposit, mismatchedCatalog), false);
assert.equal(isExecutableCommercialAction(presentCheckout, mismatchedCatalog), false);

console.log(JSON.stringify({
  status: "passed",
  checks: [
    "disabled-provider-fails-closed",
    "disabled-payment-option-fails-closed",
    "configured-deposit-is-executable",
    "fraction-mismatch-fails-closed",
  ],
}));
