const DEFAULT_RETRYABLE_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'model_timeout',
  'provider_timeout',
  'provider_unavailable',
]);

function finitePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedReason(error) {
  const candidate = error?.code || error?.name || 'provider_failure';
  return String(candidate).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80);
}

function statusOf(error) {
  const candidate = error?.status ?? error?.statusCode ?? error?.response?.status;
  const status = Number(candidate);
  return Number.isInteger(status) ? status : null;
}

export function isRetryableProviderFailure(error) {
  const status = statusOf(error);
  if (status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599)) {
    return true;
  }
  return DEFAULT_RETRYABLE_CODES.has(String(error?.code || ''));
}

export class ProviderCircuitOpenError extends Error {
  constructor(provider, retryAfterMs) {
    super(`Provider circuit is open: ${provider}`);
    this.name = 'ProviderCircuitOpenError';
    this.code = 'provider_circuit_open';
    this.provider = provider;
    this.retryAfterMs = Math.max(0, retryAfterMs);
  }
}

export class ProviderChainExhaustedError extends Error {
  constructor(attempts) {
    super('No configured model provider completed the request');
    this.name = 'ProviderChainExhaustedError';
    this.code = 'provider_chain_exhausted';
    this.attempts = attempts;
  }
}

export class ProviderCircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = finitePositiveInteger(options.failureThreshold, 3);
    this.cooldownMs = finitePositiveInteger(options.cooldownMs, 30_000);
    this.halfOpenMaxAttempts = finitePositiveInteger(options.halfOpenMaxAttempts, 1);
    this.now = options.now || Date.now;
    this.states = new Map();
    this.ticketSequence = 0;
  }

  stateFor(provider) {
    if (!this.states.has(provider)) {
      this.states.set(provider, {
        state: 'closed',
        consecutiveFailures: 0,
        openedAt: null,
        halfOpenInFlight: 0,
        lastFailureReason: null,
        lastFailureAt: null,
        lastSuccessAt: null,
      });
    }
    return this.states.get(provider);
  }

  acquire(provider) {
    const current = this.stateFor(provider);
    const now = this.now();

    if (current.state === 'open') {
      const elapsed = now - current.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new ProviderCircuitOpenError(provider, this.cooldownMs - elapsed);
      }
      current.state = 'half_open';
      current.halfOpenInFlight = 0;
    }

    if (current.state === 'half_open' && current.halfOpenInFlight >= this.halfOpenMaxAttempts) {
      throw new ProviderCircuitOpenError(provider, this.cooldownMs);
    }

    if (current.state === 'half_open') current.halfOpenInFlight += 1;
    this.ticketSequence += 1;
    return Object.freeze({
      id: this.ticketSequence,
      provider,
      probe: current.state === 'half_open',
    });
  }

  recordSuccess(ticket) {
    const current = this.stateFor(ticket.provider);
    current.state = 'closed';
    current.consecutiveFailures = 0;
    current.openedAt = null;
    current.halfOpenInFlight = 0;
    current.lastFailureReason = null;
    current.lastSuccessAt = this.now();
  }

  recordFailure(ticket, error) {
    const current = this.stateFor(ticket.provider);
    if (ticket.probe) current.halfOpenInFlight = Math.max(0, current.halfOpenInFlight - 1);
    current.consecutiveFailures += 1;
    current.lastFailureReason = boundedReason(error);
    current.lastFailureAt = this.now();

    if (ticket.probe || current.consecutiveFailures >= this.failureThreshold) {
      current.state = 'open';
      current.openedAt = this.now();
      current.halfOpenInFlight = 0;
    }
  }

  recordNeutral(ticket) {
    const current = this.stateFor(ticket.provider);
    if (ticket.probe) {
      current.state = 'open';
      current.openedAt = this.now();
      current.halfOpenInFlight = Math.max(0, current.halfOpenInFlight - 1);
    }
  }

  snapshot() {
    const now = this.now();
    return [...this.states.entries()].map(([provider, value]) => ({
      provider,
      state: value.state,
      consecutiveFailures: value.consecutiveFailures,
      retryAfterMs: value.state === 'open'
        ? Math.max(0, this.cooldownMs - (now - value.openedAt))
        : 0,
      halfOpenInFlight: value.halfOpenInFlight,
      lastFailureReason: value.lastFailureReason,
      lastFailureAt: value.lastFailureAt,
      lastSuccessAt: value.lastSuccessAt,
    }));
  }
}

export async function runProviderChain({
  routes,
  invoke,
  breaker,
  retryable = isRetryableProviderFailure,
  now = Date.now,
}) {
  const ordered = routes
    .filter((route) => route?.enabled !== false)
    .toSorted((left, right) => Number(left.priority ?? 100) - Number(right.priority ?? 100));
  const attempts = [];

  for (const route of ordered) {
    const startedAt = now();
    let ticket;
    try {
      ticket = breaker.acquire(route.provider);
    } catch (error) {
      attempts.push({
        provider: route.provider,
        model: route.model,
        outcome: 'circuit_open',
        durationMs: 0,
        errorCode: error.code,
      });
      continue;
    }

    try {
      const value = await invoke(route);
      breaker.recordSuccess(ticket);
      attempts.push({
        provider: route.provider,
        model: route.model,
        outcome: 'success',
        durationMs: Math.max(0, now() - startedAt),
        errorCode: null,
      });
      return { value, route, attempts };
    } catch (error) {
      const canFallback = retryable(error);
      if (canFallback) breaker.recordFailure(ticket, error);
      else breaker.recordNeutral(ticket);
      attempts.push({
        provider: route.provider,
        model: route.model,
        outcome: canFallback ? 'retryable_failure' : 'terminal_failure',
        durationMs: Math.max(0, now() - startedAt),
        errorCode: boundedReason(error),
      });
      if (!canFallback) {
        error.providerAttempts = attempts;
        throw error;
      }
    }
  }

  throw new ProviderChainExhaustedError(attempts);
}
