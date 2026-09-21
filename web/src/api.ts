import type { Decision, WorldSnapshot } from "./sim/types";

export type VoiceEvent =
  | { type: "received"; bytes: number; typed: boolean; at: number }
  | { type: "transcript"; text: string; sttMs: number; language: string | null; source: "groq" | "typed"; at: number }
  | { type: "phantom"; text: string; noSpeechProb: number | null; avgLogprob: number | null; sttMs: number; at: number }
  | { type: "stt_error"; code: string; message: string; at: number }
  | { type: "decision"; decision: Decision; jevMs: number; raw: unknown; at: number }
  | { type: "decision_error"; code: string; message: string; at: number }
  | { type: "done"; totalMs: number; sttMs: number; jevMs: number; ok: boolean; spend?: SpendLedger; at: number };

export interface SpendLedger {
  spentUsd: number;
  limitUsd: number;
  requests: number;
  inputTokens: number;
}

export interface CallMeta {
  loud: boolean;
  language?: string;
  world: WorldSnapshot;
}

export async function postCall(wav: Blob, meta: CallMeta, onEvent: (e: VoiceEvent) => void): Promise<void> {
  const res = await fetch("/api/call", {
    method: "POST",
    headers: {
      "Content-Type": "audio/wav",
      "X-Meta": btoa(unescape(encodeURIComponent(JSON.stringify(meta)))),
    },
    body: wav,
  });
  if (!res.ok) throw new Error(`call failed: ${res.status}`);
  await readStream(res, onEvent);
}

export async function postInterpret(text: string, meta: CallMeta, onEvent: (e: VoiceEvent) => void): Promise<void> {
  const res = await fetch("/api/interpret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...meta }),
  });
  if (!res.ok) throw new Error(`interpret failed: ${res.status}`);
  await readStream(res, onEvent);
}

export async function fetchStatus(): Promise<{ jev: { road: string; model: string }; stt: string; spend: SpendLedger }> {
  const res = await fetch("/api/status");
  return res.json();
}

async function readStream(res: Response, onEvent: (e: VoiceEvent) => void) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as VoiceEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as VoiceEvent);
}
