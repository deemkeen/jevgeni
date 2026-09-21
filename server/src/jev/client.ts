// Raw Jev HTTP client. Two roads to the same model:
//   - direct:     https://api.typesafe.ai/v1/systemone   (TYPESAFE_API_KEY, model "jev-1.13.0")
//   - openrouter: https://openrouter.ai/api/alpha/decisions (OPENROUTER_API_KEY, model "typesafe/jev-1.13")
// Both take the same body and answer with the same shape.

import type { JevRequest, JevResponse } from "./questions.js";

export interface JevEngine {
  decide(req: JevRequest, signal?: AbortSignal): Promise<JevResponse>;
}

export class JevHttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    public retryAfterMs: number | null,
  ) {
    super(`jev http ${status}`);
  }
  get retryable() {
    return [408, 429, 500, 502, 503, 524, 529].includes(this.status) || (this.status >= 500 && this.status < 600);
  }
}

export interface JevRoad {
  name: "direct" | "openrouter";
  url: string;
  apiKey: string;
  model: string;
}

export function pickRoad(env: NodeJS.ProcessEnv): JevRoad | null {
  if (env.TYPESAFE_API_KEY) {
    return {
      name: "direct",
      url: env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1/systemone",
      apiKey: env.TYPESAFE_API_KEY,
      model: env.JEV_MODEL ?? "jev-1.13.0",
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      name: "openrouter",
      url: (env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api") + "/alpha/decisions",
      apiKey: env.OPENROUTER_API_KEY,
      model: env.JEV_MODEL ?? "typesafe/jev-1.13",
    };
  }
  return null;
}

export class HttpJev implements JevEngine {
  constructor(
    private road: JevRoad,
    private timeoutMs = 3000,
  ) {}

  async decide(req: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    signal?.addEventListener("abort", () => ctrl.abort());
    try {
      const res = await fetch(this.road.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.road.apiKey}`,
          "Content-Type": "application/json",
          ...(this.road.name === "openrouter" ? { "X-Title": "JevGeni" } : {}),
        },
        body: JSON.stringify({ ...req, model: this.road.model }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new JevHttpError(res.status, text.slice(0, 500), retryAfter(res));
      return JSON.parse(text) as JevResponse;
    } finally {
      clearTimeout(t);
    }
  }
}

function retryAfter(res: Response): number | null {
  const ms = res.headers.get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const s = res.headers.get("retry-after");
  if (s && Number.isFinite(Number(s))) return Number(s) * 1000;
  return null;
}
