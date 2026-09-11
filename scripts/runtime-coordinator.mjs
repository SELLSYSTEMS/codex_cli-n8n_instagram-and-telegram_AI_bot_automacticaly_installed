export class RuntimeOverloadError extends Error {
  constructor(message = 'The assistant is at capacity. Retry the same message shortly.') {
    super(message);
    this.name = 'RuntimeOverloadError';
    this.code = 'BRAIN_OVERLOADED';
    this.retrySafe = true;
  }
}

export class RuntimeDeadlineError extends Error {
  constructor(message = 'The assistant did not start this turn before its deadline.') {
    super(message);
    this.name = 'RuntimeDeadlineError';
    this.code = 'BRAIN_DEADLINE_EXCEEDED';
    this.retrySafe = true;
  }
}

export {
  RuntimeOverloadError as QueueOverloadError,
  RuntimeDeadlineError as TurnDeadlineError,
};

export class RuntimeCoordinator {
  constructor({ concurrency = 1, maxQueue = 64, defaultDeadlineMs = 120_000 } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.maxQueue = Math.max(1, Number(maxQueue) || 64);
    this.defaultDeadlineMs = Math.max(1_000, Number(defaultDeadlineMs) || 120_000);
    this.active = 0;
    this.queue = [];
    this.activeConversations = new Set();
    this.inflightDedupe = new Map();
    this.counters = {
      accepted: 0,
      completed: 0,
      failed: 0,
      deduplicated: 0,
      overloaded: 0,
      expired: 0,
      maxObservedQueue: 0,
    };
  }

  run({ conversationKey, dedupeKey, deadlineMs }, task) {
    const dedupe = String(dedupeKey || '').trim();
    if (dedupe && this.inflightDedupe.has(dedupe)) {
      this.counters.deduplicated += 1;
      return this.inflightDedupe.get(dedupe);
    }
    if (this.queue.length >= this.maxQueue) {
      this.counters.overloaded += 1;
      return Promise.reject(new RuntimeOverloadError());
    }

    const key = String(conversationKey || 'unknown');
    const timeout = Math.max(1_000, Number(deadlineMs) || this.defaultDeadlineMs);
    const promise = new Promise((resolve, reject) => {
      const item = {
        key,
        dedupe,
        task,
        resolve,
        reject,
        expiresAt: Date.now() + timeout,
        timer: null,
      };
      item.timer = setTimeout(() => {
        const index = this.queue.indexOf(item);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.counters.expired += 1;
        if (item.dedupe) this.inflightDedupe.delete(item.dedupe);
        reject(new RuntimeDeadlineError());
        this.#drain();
      }, timeout);
      item.timer.unref?.();
      this.queue.push(item);
      this.counters.accepted += 1;
      this.counters.maxObservedQueue = Math.max(this.counters.maxObservedQueue, this.queue.length);
      this.#drain();
    });

    if (dedupe) {
      this.inflightDedupe.set(dedupe, promise);
      promise.catch(() => {}).finally(() => {
        if (this.inflightDedupe.get(dedupe) === promise) this.inflightDedupe.delete(dedupe);
      });
    }
    return promise;
  }

  snapshot() {
    return {
      concurrency_limit: this.concurrency,
      active: this.active,
      queued: this.queue.length,
      active_conversations: this.activeConversations.size,
      inflight_dedupe: this.inflightDedupe.size,
      ...this.counters,
    };
  }

  #drain() {
    while (this.active < this.concurrency) {
      const now = Date.now();
      let selected = -1;
      for (let index = 0; index < this.queue.length; index += 1) {
        const item = this.queue[index];
        if (item.expiresAt <= now) continue;
        if (!this.activeConversations.has(item.key)) {
          selected = index;
          break;
        }
      }
      if (selected < 0) return;

      const [item] = this.queue.splice(selected, 1);
      clearTimeout(item.timer);
      this.active += 1;
      this.activeConversations.add(item.key);

      Promise.resolve()
        .then(() => item.task({ deadlineAt: item.expiresAt }))
        .then((result) => {
          this.counters.completed += 1;
          item.resolve(result);
        })
        .catch((error) => {
          this.counters.failed += 1;
          item.reject(error);
        })
        .finally(() => {
          this.active -= 1;
          this.activeConversations.delete(item.key);
          this.#drain();
        });
    }
  }
}

export const runtimeCoordinator = new RuntimeCoordinator();
