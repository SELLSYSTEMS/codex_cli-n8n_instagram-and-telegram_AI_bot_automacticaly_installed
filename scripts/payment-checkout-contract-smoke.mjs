import assert from 'node:assert/strict';
import { appendCommercialActionExecution, appendCommercialActionValidation } from './commercial-action-tool.mjs';

const resolution = {
  action_id: 'present_checkout',
  commercial_action: {
    objective: 'present_checkout',
    customer_commitment: 'customer explicitly selected the deposit option',
    payment_amount_usd: 439.6,
    credits: 440,
    checkout: {
      url: 'https://checkout.example.test',
      sign_in_method: 'Google',
      funding_control: '+ Add Credits',
      settlement_currency: 'USD',
      credit_value_usd: 1,
      payment_methods: ['card', 'PayPal', 'cryptocurrency'],
      post_payment_process: 'A human manager contacts the customer and starts work.',
    },
  },
};

const validationPrompt = appendCommercialActionValidation('BASE', resolution);
assert.match(validationPrompt, /Exact transaction authorization must be present in the newest inbound customer turn/);
assert.match(validationPrompt, /do not ask for the same authorization again/i);

const executionPrompt = appendCommercialActionExecution('BASE', resolution);
for (const expected of ['https://checkout.example.test', '+ Add Credits', 'Google', '439.6', '440', 'card', 'PayPal', 'cryptocurrency']) {
  assert.ok(executionPrompt.includes(expected), `checkout execution prompt is missing ${expected}`);
}
assert.match(executionPrompt, /give the authenticated action in one compact sequence/i);
assert.match(executionPrompt, /Never invent or alter a URL, amount, currency, credit quantity, payment method/i);

console.log('payment checkout contract smoke: ok');
