// Whisper Large v3 Turbo via Groq. One shot, no retries: in a live round a
// late transcript is useless. The point of the demo is how fast this returns.

export interface Transcript {
  text: string;
  ms: number;
  noSpeechProb: number | null;
  avgLogprob: number | null;
  language: string | null;
}

export class SttError extends Error {
  constructor(
    public code: "stt_unavailable" | "stt_auth" | "stt_rate_limited" | "stt_http" | "stt_timeout",
    message: string,
  ) {
    super(message);
  }
}

const WHISPER_PROMPT =
  "JevGeni, Jev, left, right, forward, back, down, up, grab, wait, poop, dung, banana, apple, wine, cheese. " +
  "JevGeni, links, rechts, vor, zurück, runter, hoch, greifen, warten, Kot, Banane, Apfel, Wein, Käse.";

export interface SttOptions {
  apiKey: string | undefined;
  model?: string;
  timeoutMs?: number;
  url?: string;
}

export async function transcribeWav(wav: Buffer, language: string | undefined, o: SttOptions): Promise<Transcript> {
  if (!o.apiKey) throw new SttError("stt_unavailable", "GROQ_API_KEY not set");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "call.wav");
  form.append("model", o.model ?? "whisper-large-v3-turbo");
  if (language) form.append("language", language);
  form.append("prompt", WHISPER_PROMPT);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 4000);
  const start = process.hrtime.bigint();
  try {
    const res = await fetch(o.url ?? "https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}` },
      body: form,
      signal: ctrl.signal,
    });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (res.status === 401 || res.status === 403) throw new SttError("stt_auth", await res.text());
    if (res.status === 429) throw new SttError("stt_rate_limited", await res.text());
    if (!res.ok) throw new SttError("stt_http", `${res.status} ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      text?: string;
      language?: string;
      segments?: { no_speech_prob?: number; avg_logprob?: number }[];
    };
    const segs = json.segments ?? [];
    return {
      text: (json.text ?? "").trim(),
      ms: Math.round(ms),
      noSpeechProb: segs.length ? Math.max(...segs.map((s) => s.no_speech_prob ?? 0)) : null,
      avgLogprob: segs.length ? Math.min(...segs.map((s) => s.avg_logprob ?? 0)) : null,
      language: json.language ?? null,
    };
  } catch (e) {
    if (e instanceof SttError) throw e;
    if ((e as Error).name === "AbortError") throw new SttError("stt_timeout", "whisper took too long");
    throw new SttError("stt_http", String(e));
  } finally {
    clearTimeout(t);
  }
}

/** Phantom filter: Whisper hallucinates on silence. Same limits as before. */
export function isPhantom(t: Transcript): boolean {
  if (!t.text) return true;
  if (t.noSpeechProb != null && t.noSpeechProb > 0.6) return true;
  if (t.avgLogprob != null && t.avgLogprob < -1.2) return true;
  return false;
}
