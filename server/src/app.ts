// The JevGeni pipeline, independent of how HTTP is served. Used by the
// Node server (server/src/index.ts) and by the Vercel functions (api/*.ts).

import type { Decision, WorldSnapshot } from "../../shared/protocol.js";
import { HttpJev, pickRoad, type JevEngine } from "./jev/client.js";
import { ModelVersionGuard, RateLimiting, Retrying, SpendLimiting, SpendLimitExceeded, RateLimitError } from "./jev/decorators.js";
import { MockJev } from "./jev/mock.js";
import { buildQuestions, toDecision } from "./jev/questions.js";
import { isPhantom, SttError, transcribeWav } from "./stt/groq.js";

export interface EventSink {
  send(ev: Record<string, unknown>): void;
  end(): void;
}

export interface CallMeta {
  loud: boolean;
  language?: string;
  world: WorldSnapshot;
}

export interface App {
  pipeline(out: EventSink, meta: CallMeta, wav: Buffer | null, typedText: string | null): Promise<void>;
  status(): Record<string, unknown>;
  /** null = open; otherwise every /api call must carry this token */
  token: string | null;
}

export function createApp(env: NodeJS.ProcessEnv): App {
  const SPEND_LIMIT = Number(env.SPEND_LIMIT_USD ?? 0.1);
  const road = pickRoad(env);
  const spend = new SpendLimiting(road ? new HttpJev(road) : new MockJev(), SPEND_LIMIT);
  const jev: JevEngine = new Retrying(new RateLimiting(new ModelVersionGuard(spend, road?.model, road ? "WARN" : "IGNORE")));
  const jevSource: Decision["source"] = road ? "jev" : "mock";
  const jevModel = road?.model ?? "mock-jev";
  const groqKey = env.GROQ_API_KEY;

  console.log(`[jev] ${road ? `${road.name} → ${road.model}` : "no key: deterministic mock"}  spend cap ${SPEND_LIMIT} USD`);
  console.log(`[stt] ${groqKey ? "groq whisper-large-v3-turbo" : "no GROQ_API_KEY: typed calls only"}`);

  async function pipeline(out: EventSink, meta: CallMeta, wav: Buffer | null, typedText: string | null) {
    const t0 = process.hrtime.bigint();
    const ms = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    out.send({ type: "received", bytes: wav?.length ?? 0, typed: typedText != null });

    let text = typedText ?? "";
    let sttMs = 0;
    if (wav) {
      try {
        const tr = await transcribeWav(wav, meta.language, { apiKey: groqKey });
        sttMs = tr.ms;
        if (isPhantom(tr)) {
          out.send({ type: "phantom", text: tr.text, noSpeechProb: tr.noSpeechProb, avgLogprob: tr.avgLogprob, sttMs });
          out.send({ type: "done", totalMs: ms(), sttMs, jevMs: 0, ok: false });
          return;
        }
        text = tr.text;
        out.send({ type: "transcript", text, sttMs, language: tr.language, source: "groq" });
      } catch (e) {
        const code = e instanceof SttError ? e.code : "stt_http";
        out.send({ type: "stt_error", code, message: (e as Error).message });
        out.send({ type: "done", totalMs: ms(), sttMs: 0, jevMs: 0, ok: false });
        return;
      }
    } else {
      out.send({ type: "transcript", text, sttMs: 0, language: meta.language ?? null, source: "typed" });
    }

    const req = buildQuestions(jevModel, text, meta.loud, meta.world);
    const j0 = process.hrtime.bigint();
    try {
      const res = await jev.decide(req);
      const jevMs = Math.round(Number(process.hrtime.bigint() - j0) / 1e6);
      const decision = toDecision(res, jevSource);
      out.send({ type: "decision", decision, jevMs, raw: res.answers });
      out.send({ type: "done", totalMs: ms(), sttMs, jevMs, ok: true, spend: spend.ledger });
    } catch (e) {
      const code =
        e instanceof SpendLimitExceeded ? "spend_limit" : e instanceof RateLimitError ? "rate_limited" : "jev_error";
      out.send({ type: "decision_error", code, message: (e as Error).message });
      out.send({ type: "done", totalMs: ms(), sttMs, jevMs: 0, ok: false, spend: spend.ledger });
    }
  }

  return {
    pipeline,
    status: () => ({
      jev: road ? { road: road.name, model: road.model } : { road: "mock", model: "mock-jev" },
      stt: groqKey ? "groq" : "none",
      spend: spend.ledger,
    }),
    token: env.JEVGENI_TOKEN || null,
  };
}

export const MAX_WAV_BYTES = 1_500_000;

export function decodeMeta(header: string | null | undefined): CallMeta | null {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as CallMeta;
  } catch {
    return null;
  }
}
