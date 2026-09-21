// Deterministic stand-in for Jev when no API key is set. Keyword heuristics
// with soft probabilities, so the thought bubble still shows two options and
// the demo can be run and replayed offline. Marked "mock" in every event.

import { COMMANDS, TEMPTATIONS, type Command, type Temptation } from "../../../shared/protocol.js";
import type { JevEngine } from "./client.js";
import type { JevRequest, JevResponse } from "./questions.js";

const CMD_WORDS: Record<Command, string[]> = {
  left: ["left", "links", "linke"],
  right: ["right", "rechts", "rechte"],
  forward: ["forward", "vor", "closer", "näher"],
  back: ["back", "zurück", "pull"],
  down: ["down", "runter", "drop", "lower", "unten"],
  up: ["up", "hoch", "lift", "raise"],
  grab: ["grab", "greif", "take", "hol", "catch", "nimm", "zugreifen"],
  wait: ["wait", "warte", "stop", "halt", "hold", "still"],
  none: [],
  unclear: [],
};

const TMP_WORDS: Record<Temptation, string[]> = {
  dung: ["poop", "dung", "kot", "haufen", "shit", "scheiß", "turd", "💩"],
  banana: ["banana", "banane"],
  apple: ["apple", "apfel"],
  wine: ["wine", "wein", "drink", "glass", "glas", "merlot"],
  cheese: ["cheese", "käse"],
  none: [],
};

export class MockJev implements JevEngine {
  async decide(req: JevRequest): Promise<JevResponse> {
    const call = String(req.state.call ?? "").toLowerCase();
    const loud = String(req.state.tone ?? "").includes("shouted");
    const words = call.replace(/[^\p{L}\p{N}\s💩]/gu, " ").split(/\s+/).filter(Boolean);

    const cmdScores = scoreBy(COMMANDS, CMD_WORDS, words);
    const cmdProbs = softmax(cmdScores, words.length ? "unclear" : "none", 0.08);
    const cmdChoice = argmax(cmdProbs);

    const tmpScores = scoreBy(TEMPTATIONS, TMP_WORDS, words);
    const tmpProbs = softmax(tmpScores, "none", 0.05);
    const tmpChoice = argmax(tmpProbs);

    const urgentWords = ["now", "jetzt", "quick", "schnell", "sofort", "hurry", "go"];
    const calmWords = ["easy", "slowly", "langsam", "ruhig", "gently", "maybe", "vielleicht"];
    let u = 1;
    if (words.some((w) => urgentWords.includes(w)) || call.includes("!")) u += 0.7;
    if (loud) u += 0.4;
    if (words.some((w) => calmWords.includes(w))) u -= 0.7;
    u = Math.min(2, Math.max(0, u));
    const up = { "0": 0, "1": 0, "2": 0 } as Record<string, number>;
    const lo = Math.floor(u);
    const hi = Math.min(2, lo + 1);
    up[String(lo)] = 1 - (u - lo);
    up[String(hi)] += u - lo;

    return {
      model: "mock-jev",
      answers: {
        command: { type: "choice", choice: cmdChoice, probabilities: cmdProbs, confidence: cmdProbs[cmdChoice] },
        urgency: { type: "score", score: u, probabilities: up, legend: { "0": "calm", "1": "normal", "2": "now" } },
        temptation: { type: "choice", choice: tmpChoice, probabilities: tmpProbs, confidence: tmpProbs[tmpChoice] },
      },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
    };
  }
}

function scoreBy<K extends string>(keys: readonly K[], dict: Record<K, string[]>, words: string[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) {
    let s = 0;
    for (const w of dict[k]) {
      const idx = words.findIndex((x) => x.startsWith(w) || w.startsWith(x) && x.length >= 3);
      if (idx >= 0) s += 1 + (words.length - idx) / (words.length + 1); // earlier words weigh more
    }
    out[k] = s;
  }
  return out;
}

function softmax<K extends string>(scores: Record<K, number>, fallback: K, floor: number): Record<K, number> {
  const keys = Object.keys(scores) as K[];
  const total = keys.reduce((a, k) => a + scores[k], 0);
  const out = {} as Record<K, number>;
  if (total === 0) {
    for (const k of keys) out[k] = k === fallback ? 1 - floor * (keys.length - 1) : floor;
    return out;
  }
  const exps = keys.map((k) => Math.exp(2.2 * scores[k]));
  const sum = exps.reduce((a, b) => a + b, 0);
  keys.forEach((k, i) => (out[k] = Math.round((exps[i] / sum) * 1000) / 1000));
  return out;
}

function argmax<K extends string>(p: Record<K, number>): K {
  return (Object.keys(p) as K[]).reduce((a, b) => (p[a] >= p[b] ? a : b));
}
