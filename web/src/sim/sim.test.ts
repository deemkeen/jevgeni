import { test } from "node:test";
import assert from "node:assert/strict";
import { createSim, replay, step, TICK_MS, resolve } from "./sim";
import type { Decision, InputLog } from "./types";

function decision(cmd: Decision["command"]["choice"], bait: Decision["temptation"]["choice"] = "none", p = 0.9): Decision {
  const cp = Object.fromEntries(["left","right","forward","back","down","up","grab","wait","none","unclear"].map(k => [k, k === cmd ? p : (1 - p) / 9])) as Decision["command"]["probabilities"];
  const tp = Object.fromEntries(["dung","banana","apple","wine","cheese","none"].map(k => [k, k === bait ? p : (1 - p) / 5])) as Decision["temptation"]["probabilities"];
  return {
    command: { choice: cmd, probabilities: cp, confidence: p },
    urgency: { level: "normal", score: 1, probabilities: { calm: 0, normal: 1, now: 0 } },
    temptation: { choice: bait, probabilities: tp, confidence: p },
    source: "mock", model: "test", inputTokens: 0,
  };
}

test("same seed and log replay to the same run", () => {
  const log: InputLog = { seed: 1337, roundSeconds: 20, calls: [
    { t: 1000, text: "left", loud: false, decision: decision("left") },
    { t: 3000, text: "down", loud: false, decision: decision("down") },
    { t: 8000, text: "right right right", loud: true, decision: decision("right") },
    { t: 12000, text: "get the wine", loud: false, decision: decision("right", "wine") },
  ]};
  const a = replay(log), b = replay(log);
  assert.deepEqual(a, b);
  assert.equal(a.over, true);
  assert.equal(a.score.calls, 4);
});

test("seed only moves the board", () => {
  const a = createSim(1), b = createSim(2);
  assert.notDeepEqual(a.items.map(i => i.kind), b.items.map(i => i.kind));
  assert.equal(a.items.length, 7);
  assert.equal(a.items.filter(i => i.kind === "dung").length, 3);
});

test("signal decides whether a command arrives", () => {
  let s = createSim(1337, 30);
  // drag the claw to the far left edge: signal ~0.1
  s.claw.x = 0.03; s.claw.targetX = 0.03; s.fly.signal = 0.1; s.fly.hunger = 0;
  const r = resolve(s, { t: 0, text: "right", loud: false, decision: decision("right") });
  assert.equal(r.winner, "static");
  s.fly.signal = 1;
  const r2 = resolve(s, { t: 0, text: "right", loud: false, decision: decision("right") });
  assert.equal(r2.winner, "command");
});

test("hunger decides what a command must beat", () => {
  const s = createSim(1337, 30);
  s.fly.hunger = 0.95;
  const r = resolve(s, { t: 0, text: "left, the wine looks nice", loud: false, decision: decision("left", "wine", 0.6) });
  assert.equal(r.winner, "temptation");
  assert.ok(r.target && r.target.kind !== "dung");
});

test("a loud call startles and the claw flinches first", () => {
  let s = createSim(1337, 30);
  s = step(s, { type: "call", t: 0, text: "LEFT", loud: true, decision: decision("left") });
  assert.equal(s.fly.startle, 1);
  s = step(s, { type: "call", t: 0, text: "left", loud: false, decision: decision("left") });
  assert.equal(s.fly.mood, "startled");
  assert.match(s.lastAction ?? "", /flinched/);
  assert.ok(s.claw.viaX != null && s.claw.viaX > s.claw.x, "detour goes the wrong way first");
  const startX = s.claw.x;
  s = step(s, { type: "tick", dt: TICK_MS });
  assert.ok(s.claw.x > startX, "the claw drives, it does not teleport");
});

test("three dung win the round early, timeout without them is a loss", () => {
  let s = createSim(1337, 10);
  for (let n = 0; n < 3; n++) {
    const dung = s.items.find(i => i.kind === "dung")!;
    s.claw.x = dung.x; s.claw.targetX = dung.x;
    s = step(s, { type: "call", t: s.t, text: "down", loud: false, decision: decision("down") });
    for (let i = 0; i < 25; i++) s = step(s, { type: "tick", dt: TICK_MS });
  }
  assert.equal(s.score.dung, 3);
  assert.equal(s.over, true);
  assert.equal(s.result, "win");
  assert.equal(s.fly.mood, "victory");
  const loss = replay({ seed: 1, roundSeconds: 5, calls: [] });
  assert.equal(loss.result, "loss");
});

test("a grab over dung scores", () => {
  let s = createSim(1337, 30);
  const dung = s.items.find(i => i.kind === "dung")!;
  s.claw.x = dung.x; s.claw.targetX = dung.x;
  s = step(s, { type: "call", t: 0, text: "down", loud: false, decision: decision("down") });
  for (let i = 0; i < 40; i++) s = step(s, { type: "tick", dt: TICK_MS });
  assert.equal(s.score.dung, 1);
  assert.equal(s.items.length, 7);
});
