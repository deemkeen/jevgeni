// Deterministic simulation. No Math.random anywhere: everything derives from
// the seed plus the ordered list of events (ticks and calls). Replaying the
// same seed and the same input log gives the same run, frame for frame.

import type {
  CallEvent,
  Command,
  Decision,
  InputLog,
  Item,
  ItemKind,
  SimEvent,
  SimState,
  Temptation,
  WorldSnapshot,
} from "./types";

export const TICK_MS = 100;
export const ANTENNA_X = 0.5;
export const GRAB_TOLERANCE = 0.055;
export const MOVE_SPEED = 0.45; // pit widths per second
export const DESCEND_MS = 900;
export const GRAB_MS = 350;
export const RISE_MS = 900;
export const HUNGER_AT_END = 0.9;
export const STARTLE_DECAY_PER_S = 0.25;
export const SIGNAL_THRESHOLD = 0.25;

const INITIAL_KINDS: ItemKind[] = ["dung", "dung", "dung", "banana", "wine", "cheese", "apple"];
const RESPAWN_KINDS: ItemKind[] = ["dung", "dung", "banana", "wine", "cheese", "apple"];

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32), threaded through the state so it stays pure.

function mulberry32(a: number): [number, number] {
  let t = (a += 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, a >>> 0];
}

function rand(s: SimState): number {
  const [v, next] = mulberry32(s.rng);
  s.rng = next;
  return v;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Signal: implant quality. Falls with the claw's distance from the RX antenna
// (which hangs over the middle of the pit).

export function signalAt(x: number): number {
  return clamp(1 - 0.9 * (Math.abs(x - ANTENNA_X) / 0.5));
}

/** Short and clear calls get a bonus, long rambling ones a penalty. */
export function clarityAdjust(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words <= 3) return 0.1;
  if (words >= 7) return -0.2;
  return 0;
}

// ---------------------------------------------------------------------------

export function createSim(seed: number, roundSeconds = 90): SimState {
  const s: SimState = {
    seed,
    roundSeconds,
    t: 0,
    over: false,
    claw: { x: ANTENNA_X, y: 0, phase: "idle", phaseT: 0, targetX: ANTENNA_X, holding: null, autoGrab: false },
    items: [],
    nextItemId: 1,
    fly: { signal: 1, hunger: 0.2, startle: 0, mood: "idle" },
    score: { dung: 0, wrong: 0, calls: 0 },
    thought: null,
    lastAction: null,
    rng: seed >>> 0,
  };
  // Shuffle kinds (Fisher–Yates with the seeded RNG), then spread across the pit.
  const kinds = [...INITIAL_KINDS];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rand(s) * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  const n = kinds.length;
  kinds.forEach((kind, i) => {
    const slot = (i + 0.5) / n;
    s.items.push({ id: s.nextItemId++, kind, x: slot });
  });
  s.fly.signal = signalAt(s.claw.x);
  return s;
}

export function snapshot(s: SimState): WorldSnapshot {
  return {
    visibleObjects: s.items.map((i) => ({ kind: i.kind, x: round2(i.x) })),
    claw: { x: round2(s.claw.x), y: round2(s.claw.y), phase: s.claw.phase },
    fly: { signal: round2(s.fly.signal), hunger: round2(s.fly.hunger), startle: round2(s.fly.startle) },
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Reducer. Mutates a copy and returns it.

export function step(prev: SimState, ev: SimEvent): SimState {
  const s: SimState = structuredClone(prev);
  if (s.over) return s;
  if (ev.type === "tick") tick(s, ev.dt);
  else resolveCall(s, ev);
  return s;
}

function tick(s: SimState, dt: number) {
  s.t += dt;
  if (s.t >= s.roundSeconds * 1000) {
    s.t = s.roundSeconds * 1000;
    s.over = true;
  }
  const dts = dt / 1000;
  s.fly.hunger = clamp(s.fly.hunger + (HUNGER_AT_END / s.roundSeconds) * dts * 0.8);
  s.fly.startle = clamp(s.fly.startle - STARTLE_DECAY_PER_S * dts);

  const c = s.claw;
  switch (c.phase) {
    case "moving": {
      const dir = Math.sign(c.targetX - c.x);
      const maxMove = MOVE_SPEED * dts;
      if (Math.abs(c.targetX - c.x) <= maxMove) {
        c.x = c.targetX;
        c.phase = c.autoGrab ? "descending" : "idle";
        c.phaseT = 0;
      } else {
        c.x += dir * maxMove;
      }
      break;
    }
    case "descending": {
      c.phaseT += dt;
      c.y = clamp(c.phaseT / DESCEND_MS);
      if (c.phaseT >= DESCEND_MS) {
        c.phase = "grabbing";
        c.phaseT = 0;
        const under = s.items.find((i) => Math.abs(i.x - c.x) <= GRAB_TOLERANCE);
        c.holding = under ?? null;
        if (under) s.items = s.items.filter((i) => i.id !== under.id);
      }
      break;
    }
    case "grabbing": {
      c.phaseT += dt;
      if (c.phaseT >= GRAB_MS) {
        c.phase = "rising";
        c.phaseT = 0;
      }
      break;
    }
    case "rising": {
      c.phaseT += dt;
      c.y = clamp(1 - c.phaseT / RISE_MS);
      if (c.phaseT >= RISE_MS) {
        c.y = 0;
        c.phase = "idle";
        c.phaseT = 0;
        c.autoGrab = false;
        settle(s);
      }
      break;
    }
    case "idle":
      break;
  }
  s.fly.signal = signalAt(c.x);
}

/** Claw is back at the top: score what it holds, respawn an item. */
function settle(s: SimState) {
  const held = s.claw.holding;
  s.claw.holding = null;
  if (!held) {
    s.fly.mood = "miss";
    s.lastAction = "claw came up empty";
    return;
  }
  if (held.kind === "dung") {
    s.score.dung += 1;
    s.fly.hunger = clamp(s.fly.hunger - 0.1);
    s.fly.mood = "win";
    s.lastAction = "💩 retrieved";
  } else {
    s.score.wrong += 1;
    s.fly.hunger = clamp(s.fly.hunger - 0.35);
    s.fly.mood = "yum";
    s.lastAction = `ate the ${held.kind} instead`;
  }
  // Respawn deterministically in the same slot, so the claw is still right above it.
  const kind = RESPAWN_KINDS[Math.floor(rand(s) * RESPAWN_KINDS.length)];
  s.items.push({ id: s.nextItemId++, kind, x: held.x });
  s.items.sort((a, b) => a.x - b.x);
}

// ---------------------------------------------------------------------------
// The rule: Signal decides whether a command arrives at all. Hunger decides
// what it has to beat: the nearest temptation, or the one the call named.

export interface Resolution {
  strength: number; // effective command weight
  pull: number; // effective temptation weight
  winner: "static" | "command" | "temptation";
  command: Command;
  temptation: Temptation;
  target: Item | null;
  jerked: boolean;
}

export function resolve(s: SimState, ev: Omit<CallEvent, "type">): Resolution {
  const d = ev.decision;
  const sig = clamp(s.fly.signal + clarityAdjust(ev.text));
  const command = d.command.choice;
  const pCmd = d.command.probabilities[command] ?? 0;
  const actionable = !["wait", "none", "unclear"].includes(command);
  const strength = actionable ? pCmd * sig : 0;

  const named = d.temptation.choice;
  const pTemp = d.temptation.probabilities[named] ?? 0;
  const isBait = (k: Temptation) => k !== "none" && k !== "dung";
  const baits = s.items.filter((i) => i.kind !== "dung");
  let target: Item | null = null;
  if (isBait(named)) target = baits.find((i) => i.kind === named) ?? null;
  if (!target && baits.length) {
    target = baits.reduce((a, b) => (Math.abs(a.x - s.claw.x) < Math.abs(b.x - s.claw.x) ? a : b));
  }
  const pull = target ? clamp(s.fly.hunger * 0.7 + (isBait(named) ? pTemp * 0.5 : 0)) : 0;

  const jerked = s.fly.startle > 0.5;
  let winner: Resolution["winner"];
  if (strength < SIGNAL_THRESHOLD && pull < SIGNAL_THRESHOLD) winner = "static";
  else if (pull > strength) winner = "temptation";
  else winner = "command";
  return { strength, pull, winner, command, temptation: named, target, jerked };
}

/** The item `steps` slots to the left (-1) or right (+1) of the claw, clamped to the row. */
function neighbour(s: SimState, dir: -1 | 1, steps: number): Item | null {
  const xs = [...s.items].sort((a, b) => a.x - b.x);
  if (!xs.length) return null;
  const eps = 0.01;
  const side = dir < 0 ? xs.filter((i) => i.x < s.claw.x - eps).reverse() : xs.filter((i) => i.x > s.claw.x + eps);
  if (!side.length) return null;
  return side[Math.min(steps, side.length) - 1];
}

function resolveCall(s: SimState, ev: CallEvent) {
  s.score.calls += 1;
  if (ev.loud) s.fly.startle = 1;
  const r = resolve(s, ev);
  s.thought = thoughtBubble(r, ev.decision);

  const c = s.claw;
  const busy = c.phase !== "idle" && c.phase !== "moving";
  const urg = ev.decision.urgency.level === "now" ? 1.6 : ev.decision.urgency.level === "calm" ? 0.7 : 1;

  if (r.winner === "static") {
    s.fly.mood = "static";
    s.lastAction = `nothing got through (signal ${Math.round(s.fly.signal * 100)}%)`;
    return;
  }

  if (r.winner === "temptation" && r.target) {
    if (busy) {
      s.lastAction = "wants the " + r.target.kind + ", but the claw is busy";
      return;
    }
    c.targetX = r.target.x;
    c.phase = "moving";
    c.autoGrab = true;
    s.fly.mood = "tempted";
    s.lastAction = `ignored you, went for the ${r.target.kind}`;
    return;
  }

  // Command wins. A startled fly jerks the joystick the wrong way first.
  let jerkNote = "";
  if (r.jerked && !busy && (r.command === "left" || r.command === "right")) {
    const wrong = neighbour(s, r.command === "left" ? 1 : -1, 1);
    if (wrong) {
      c.x = wrong.x;
      jerkNote = " (flinched first)";
    }
  }
  switch (r.command) {
    case "left":
    case "right": {
      if (busy) break;
      // one item over; "now!" skips one, "calm" still moves one
      const target = neighbour(s, r.command === "left" ? -1 : 1, urg > 1 ? 2 : 1);
      if (!target) {
        s.lastAction = `${r.command}: already at the edge`;
        s.fly.mood = "miss";
        return;
      }
      c.targetX = target.x;
      c.phase = "moving";
      c.autoGrab = false;
      break;
    }
    case "forward":
    case "back": {
      if (busy || c.phase === "moving") break;
      // side view: forward leans the claw a bit deeper, back pulls it up
      c.y = clamp(c.y + (r.command === "forward" ? 0.25 : -0.25), 0, 0.6);
      break;
    }
    case "down":
    case "grab": {
      if (busy) break;
      c.targetX = c.x;
      c.phase = "descending";
      c.phaseT = Math.round(c.y * DESCEND_MS);
      c.autoGrab = false;
      break;
    }
    case "up": {
      if (c.phase === "descending") {
        c.phase = "rising";
        c.phaseT = Math.round((1 - c.y) * RISE_MS);
      } else if (c.phase === "idle") c.y = 0;
      break;
    }
    default:
      break;
  }
  s.fly.mood = r.jerked ? "startled" : "obeys";
  s.lastAction = `${r.command}${urg > 1 ? "!" : ""}${jerkNote}`;
}

function thoughtBubble(r: Resolution, d: Decision): SimState["thought"] {
  const opts: { label: string; pct: number }[] = [];
  opts.push({ label: r.command, pct: Math.round(r.strength * 100) });
  if (r.target) opts.push({ label: r.target.kind, pct: Math.round(r.pull * 100) });
  else {
    // no bait on the board: show Jev's runner-up command instead
    const runnerUp = Object.entries(d.command.probabilities)
      .filter(([k]) => k !== r.command)
      .sort((a, b) => b[1] - a[1])[0];
    if (runnerUp) opts.push({ label: runnerUp[0], pct: Math.round(runnerUp[1] * 100) });
  }
  return opts.sort((a, b) => b.pct - a.pct);
}

// ---------------------------------------------------------------------------
// Replay: seed + input log → final state (and every intermediate state).

export function replay(log: InputLog, onState?: (s: SimState) => void): SimState {
  let s = createSim(log.seed, log.roundSeconds);
  const calls = [...log.calls].sort((a, b) => a.t - b.t);
  let ci = 0;
  while (!s.over) {
    while (ci < calls.length && calls[ci].t <= s.t) {
      s = step(s, { type: "call", ...calls[ci] });
      onState?.(s);
      ci++;
    }
    s = step(s, { type: "tick", dt: TICK_MS });
    onState?.(s);
  }
  return s;
}

export function encodeLog(log: InputLog): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(log))));
}

export function decodeLog(b64: string): InputLog {
  return JSON.parse(decodeURIComponent(escape(atob(b64)))) as InputLog;
}
