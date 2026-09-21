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

/** Optional access token: ?token=… in the URL once, then localStorage (survives tabs and restarts). */
function tokenHeaders(): Record<string, string> {
  try {
    const u = new URL(location.href);
    const fromUrl = u.searchParams.get("token");
    if (fromUrl) {
      localStorage.setItem("jevgeni_token", fromUrl);
      u.searchParams.delete("token");
      history.replaceState(null, "", u.toString());
    }
    const t = localStorage.getItem("jevgeni_token");
    return t ? { "X-Token": t } : {};
  } catch {
    return {};
  }
}

export async function postCall(wav: Blob, meta: CallMeta, onEvent: (e: VoiceEvent) => void): Promise<void> {
  const res = await fetch("/api/call", {
    method: "POST",
    headers: {
      ...tokenHeaders(),
      "Content-Type": "audio/wav",
      "X-Meta": btoa(unescape(encodeURIComponent(JSON.stringify(meta)))),
    },
    body: wav,
  });
  if (!res.ok) throw new Error(httpMessage(res.status));
  await readStream(res, onEvent);
}

function httpMessage(status: number): string {
  if (status === 401) return "locked: open the page once with ?token=… (the token is kept in this browser)";
  if (status === 413) return "recording too long for one call";
  return `call failed: HTTP ${status}`;
}

export async function postInterpret(text: string, meta: CallMeta, onEvent: (e: VoiceEvent) => void): Promise<void> {
  const res = await fetch("/api/interpret", {
    method: "POST",
    headers: { ...tokenHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...meta }),
  });
  if (!res.ok) throw new Error(httpMessage(res.status));
  await readStream(res, onEvent);
}

export async function fetchStatus(): Promise<{ jev: { road: string; model: string }; stt: string; spend: SpendLedger }> {
  const res = await fetch("/api/status", { headers: tokenHeaders() });
  if (res.status === 401) throw new Error("token required");
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
