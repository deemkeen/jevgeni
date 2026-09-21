// Shared types for the JevGeni simulation and the server protocol.

export const COMMANDS = [
  "left",
  "right",
  "forward",
  "back",
  "down",
  "up",
  "grab",
  "wait",
  "none",
  "unclear",
] as const;
export type Command = (typeof COMMANDS)[number];

export const ITEMS = ["dung", "banana", "apple", "wine", "cheese"] as const;
export type ItemKind = (typeof ITEMS)[number];

export const TEMPTATIONS = [...ITEMS, "none"] as const;
export type Temptation = (typeof TEMPTATIONS)[number];

export const URGENCY = ["calm", "normal", "now"] as const;
export type Urgency = (typeof URGENCY)[number];

/** Jev's three answers for one call, already normalised. */
export interface Decision {
  command: { choice: Command; probabilities: Record<Command, number>; confidence: number };
  urgency: { level: Urgency; score: number; probabilities: Record<Urgency, number> };
  temptation: { choice: Temptation; probabilities: Record<Temptation, number>; confidence: number };
  /** Which backend produced it: real Jev, or the deterministic mock. */
  source: "jev" | "mock";
  model: string;
  inputTokens: number;
}

/** What the browser tells the server about the fly, so Jev sees the same board. */
export interface WorldSnapshot {
  visibleObjects: { kind: ItemKind; x: number }[];
  claw: { x: number; y: number; phase: ClawPhase };
  fly: { signal: number; hunger: number; startle: number };
}

export type ClawPhase = "idle" | "moving" | "descending" | "grabbing" | "rising";

export interface Item {
  id: number;
  kind: ItemKind;
  /** 0..1 across the pit */
  x: number;
}

export interface SimState {
  seed: number;
  roundSeconds: number;
  /** ms of round clock elapsed */
  t: number;
  over: boolean;
  claw: {
    x: number;
    y: number;
    phase: ClawPhase;
    phaseT: number;
    targetX: number;
    holding: Item | null;
    /** the fly is going for a temptation: grab as soon as the claw arrives */
    autoGrab: boolean;
    /** flinch detour: drive here first, then on to targetX */
    viaX: number | null;
  };
  /** how many 💩 end the round as a win */
  goal: number;
  result: "win" | "loss" | null;
  items: Item[];
  nextItemId: number;
  fly: { signal: number; hunger: number; startle: number; mood: string };
  score: { dung: number; wrong: number; calls: number };
  /** Thought bubble content: top two options */
  thought: { label: string; pct: number }[] | null;
  /** Last resolved action, for the log and the render */
  lastAction: string | null;
  rng: number;
}

export interface CallEvent {
  type: "call";
  /** round clock at which the call resolved */
  t: number;
  text: string;
  loud: boolean;
  decision: Decision;
}

export interface TickEvent {
  type: "tick";
  dt: number;
}

export type SimEvent = CallEvent | TickEvent;

/** The replayable input log: seed plus the calls (ticks are implied by t). */
export interface InputLog {
  seed: number;
  roundSeconds: number;
  calls: Omit<CallEvent, "type">[];
}
