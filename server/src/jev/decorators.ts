// Decorator chain around a JevEngine, outermost first:
//   retry → rate limit → model version guard → spend limit → http
// Same shape as the Java chain in sitz-platz-chaos, shrunk to what a demo needs.

import { JevHttpError, type JevEngine } from "./client.js";
import type { JevRequest, JevResponse } from "./questions.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

export class Retrying implements JevEngine {
  constructor(
    private inner: JevEngine,
    private opts = { maxAttempts: 2, initialMs: 150, maxMs: 500, jitter: 0.25, maxRetryAfterMs: 1000 },
  ) {}
  async decide(req: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    let attempt = 0;
    let delay = this.opts.initialMs;
    for (;;) {
      attempt++;
      try {
        return await this.inner.decide(req, signal);
      } catch (e) {
        const retryable = e instanceof JevHttpError ? e.retryable : e instanceof TypeError; // TypeError = fetch network error
        if (!retryable || attempt >= this.opts.maxAttempts || signal?.aborted) throw e;
        let wait = delay * (1 + (Math.random() * 2 - 1) * this.opts.jitter);
        if (e instanceof JevHttpError && e.retryAfterMs != null) wait = Math.min(e.retryAfterMs, this.opts.maxRetryAfterMs);
        await sleep(wait);
        delay = Math.min(this.opts.maxMs, delay * 2);
      }
    }
  }
}

// ---------------------------------------------------------------------------

export class RateLimitError extends Error {
  constructor() {
    super("local rate limit");
  }
}

/** Token bucket per attempt. Jev allows 1200/min; we stay far below. */
export class RateLimiting implements JevEngine {
  private tokens: number;
  private last = Date.now();
  constructor(
    private inner: JevEngine,
    private perSecond = 10,
    private burst = 8,
  ) {
    this.tokens = burst;
  }
  async decide(req: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) throw new RateLimitError();
    this.tokens -= 1;
    return this.inner.decide(req, signal);
  }
}

// ---------------------------------------------------------------------------

export class ModelDrift extends Error {
  constructor(
    public expected: string,
    public got: string,
  ) {
    super(`model drift: expected ${expected}, got ${got}`);
  }
}

/** Compares the model that answered with the one we pinned. */
export class ModelVersionGuard implements JevEngine {
  private warned = new Set<string>();
  constructor(
    private inner: JevEngine,
    private expected: string | undefined,
    private mode: "IGNORE" | "WARN" | "FAIL" = "WARN",
    private log: (msg: string) => void = console.warn,
  ) {}
  async decide(req: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    const res = await this.inner.decide(req, signal);
    if (this.mode === "IGNORE" || !this.expected || !res.model) return res;
    if (!res.model.startsWith(this.expected)) {
      if (this.mode === "FAIL") throw new ModelDrift(this.expected, res.model);
      if (!this.warned.has(res.model)) {
        this.warned.add(res.model);
        this.log(`[jev] model drift: pinned ${this.expected}, answered ${res.model}`);
      }
    }
    return res;
  }
}

// ---------------------------------------------------------------------------

export class SpendLimitExceeded extends Error {
  constructor(
    public spentUsd: number,
    public limitUsd: number,
  ) {
    super(`spend limit: ${spentUsd.toFixed(5)} of ${limitUsd} USD`);
  }
}

export interface SpendLedger {
  spentUsd: number;
  limitUsd: number;
  requests: number;
  inputTokens: number;
}

/**
 * Reserve an estimate before the call, book the real usage after. A failed
 * attempt is still booked at the estimate because the provider may have billed.
 */
export class SpendLimiting implements JevEngine {
  readonly ledger: SpendLedger;
  constructor(
    private inner: JevEngine,
    limitUsd: number,
    private usdPerMillionInputTokens = 0.042,
  ) {
    this.ledger = { spentUsd: 0, limitUsd, requests: 0, inputTokens: 0 };
  }
  private estimate(req: JevRequest): number {
    const chars = JSON.stringify(req).length;
    return (chars / 3 / 1e6) * this.usdPerMillionInputTokens;
  }
  async decide(req: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    const est = this.estimate(req);
    if (this.ledger.spentUsd + est > this.ledger.limitUsd) throw new SpendLimitExceeded(this.ledger.spentUsd, this.ledger.limitUsd);
    this.ledger.spentUsd += est;
    this.ledger.requests += 1;
    try {
      const res = await this.inner.decide(req, signal);
      const tokens = res.usage?.input_tokens ?? 0;
      const actual = res.usage?.cost ?? (tokens / 1e6) * this.usdPerMillionInputTokens;
      this.ledger.inputTokens += tokens;
      if (tokens > 0 || res.usage?.cost != null) this.ledger.spentUsd += actual - est;
      return res;
    } catch (e) {
      throw e; // estimate stays booked
    }
  }
}
