import { fetchStatus, postCall, postInterpret, type SpendLedger, type VoiceEvent } from "./api";
import { openMic, type Mic } from "./audio/mic";
import { DEFAULT_VAD, Vad, type Utterance } from "./audio/vad";
import { encodeWav } from "./audio/wav";
import { median, percentile, rmsDb } from "./audio/features";
import { renderClaw } from "./rig/claw";
import { renderFly } from "./rig/fly";
import { createSim, decodeLog, encodeLog, resolve, snapshot, step, TICK_MS } from "./sim/sim";
import type { CallEvent, Decision, InputLog, SimState } from "./sim/types";

// ---------------------------------------------------------------------------
// DOM

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const pitSvg = $("pit") as unknown as SVGSVGElement;
const flySvg = $("fly") as unknown as SVGSVGElement;
const bubble = $("bubble");
const bubbleIdle = $("bubble-idle");
const bubbleOpts = $("bubble-opts");
const logBody = $("log");
const micLabel = $("mic-label");
const micIcon = $("mic-icon");
const seedInput = $<HTMLInputElement>("seed");
const langSel = $<HTMLSelectElement>("lang");
const micBtn = $<HTMLButtonElement>("micbtn");
const status = $("implant-status");

// ---------------------------------------------------------------------------
// State

const url = new URL(location.href);
const replayLog: InputLog | null = url.searchParams.get("log") ? safeDecode(url.searchParams.get("log")!) : null;
let seed = replayLog?.seed ?? (Number(url.searchParams.get("seed") ?? seedInput.value) || 1337);
seedInput.value = String(seed);

let sim: SimState = createSim(seed, replayLog?.roundSeconds ?? 90);
let inputLog: InputLog = { seed, roundSeconds: sim.roundSeconds, calls: [] };
let replayQueue: InputLog["calls"] = replayLog ? [...replayLog.calls].sort((a, b) => a.t - b.t) : [];
let running = true;
let inFlight = 0;
const latencies: number[] = [];
let spend: SpendLedger | null = null;
let backendLabel = "…";

if (replayLog) {
  $("replay-badge").hidden = false;
  $("chain-label").firstChild!.textContent = "REPLAY FROM LOG · SEED ";
}

// ---------------------------------------------------------------------------
// Game loop: fixed 100 ms logic ticks, render every frame.

let acc = 0;
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(250, now - last);
  last = now;
  if (running && !sim.over) {
    acc += dt;
    while (acc >= TICK_MS) {
      // replay: fire logged calls when the round clock reaches them
      while (replayQueue.length && replayQueue[0].t <= sim.t) {
        const call = replayQueue.shift()!;
        applyCall(call, { sttMs: 0, jevMs: 0, latencyMs: null, replay: true });
      }
      sim = step(sim, { type: "tick", dt: TICK_MS });
      acc -= TICK_MS;
    }
  }
  render(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function render(now: number) {
  renderClaw(pitSvg, sim, camClock(sim.t));
  renderFly(flySvg, sim, now);
  $("score").textContent = String(sim.score.dung);
  const left = Math.max(0, Math.ceil((sim.roundSeconds * 1000 - sim.t) / 1000));
  $("clock").textContent = String(left);
  meter("signal", sim.fly.signal);
  meter("hunger", sim.fly.hunger);
  meter("startle", sim.fly.startle);
  $("seed-label").textContent = String(sim.seed);
  $("inputs-label").textContent = String(replayLog ? replayLog.calls.length : inputLog.calls.length);
  if (sim.over && !micBtn.classList.contains("over")) {
    $("caption").textContent = `Round over. ${sim.score.dung} 💩 retrieved, ${sim.score.wrong} snacks eaten.`;
    if (mic) stopMic();
    micBtn.classList.add("over");
    micIcon.textContent = "↺";
    setStatus("", "ROUND OVER · TAP FOR ANOTHER");
  }
}

function meter(name: string, v: number) {
  $(`${name}-fill`).style.width = `${Math.round(v * 100)}%`;
  $(`${name}-pct`).textContent = `${Math.round(v * 100)}%`;
}

function camClock(t: number) {
  const s = Math.floor(t / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `03:${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// Calls

interface CallTiming {
  sttMs: number;
  jevMs: number;
  latencyMs: number | null;
  replay?: boolean;
}

function applyCall(call: Omit<CallEvent, "type">, timing: CallTiming, heard?: { text: string; source: string }) {
  const ev: CallEvent = { type: "call", ...call };
  const before = sim;
  sim = step(sim, ev);
  if (!timing.replay) inputLog.calls.push(call);
  showBubble(before, call);
  $("caption").textContent = captionFor(sim);
  if (timing.latencyMs != null) latencies.push(timing.latencyMs);
  updateP50();
  addLogRow(call, timing, heard ?? { text: call.text, source: timing.replay ? "log" : "typed" });
  updateReplayLink();
}

function captionFor(s: SimState): string {
  switch (s.fly.mood) {
    case "static":
      return "…nothing arrived. Closer to the antenna, or call shorter.";
    case "tempted":
      return `JevGeni heard you. Went for the snack anyway.`;
    case "startled":
      return "Too loud! She flinched.";
    case "obeys":
      return `Command taken: ${s.lastAction}.`;
    case "win":
      return "💩! Good fly.";
    case "yum":
      return "She ate it. Hunger down, dignity too.";
    case "miss":
      return "Empty claw. Try again.";
    default:
      return "Say something.";
  }
}

function showBubble(before: SimState, call: Omit<CallEvent, "type">) {
  const r = resolve(before, call);
  const opts = [
    { label: r.command, pct: Math.round(r.strength * 100), win: r.winner === "command", raw: call.decision.command.probabilities[r.command] },
    ...(r.target
      ? [{ label: r.target.kind, pct: Math.round(r.pull * 100), win: r.winner === "temptation", raw: call.decision.temptation.probabilities[r.target.kind] }]
      : []),
  ].sort((a, b) => b.pct - a.pct);
  const verdict =
    r.winner === "static" ? "STATIC · SIGNAL TOO WEAK" : r.winner === "temptation" ? "HUNGER WINS" : r.jerked ? "COMMAND WINS · FLINCHED" : "COMMAND WINS";
  bubbleOpts.innerHTML =
    opts
      .map(
        (o) =>
          `<div class="opt ${o.win ? "win" : "lose"}"><span>${o.label}</span><span>${o.pct}%</span></div>`,
      )
      .join("") + `<div class="verdict">${verdict}</div>`;
  bubble.hidden = false;
  bubbleIdle.hidden = true;
  bubble.classList.remove("pop");
  void bubble.offsetWidth;
  bubble.classList.add("pop");
}

function updateP50() {
  const el = $("p50");
  if (!latencies.length) {
    el.textContent = "—";
    $("p50unit").textContent = "";
    return;
  }
  const p50 = Math.round(median(latencies));
  el.textContent = String(p50);
  $("p50unit").textContent = ` ms · p90 ${Math.round(percentile(latencies, 90))}`;
  el.parentElement!.classList.toggle("slow", p50 >= 1000);
}

function addLogRow(call: Omit<CallEvent, "type">, timing: CallTiming, heard: { text: string; source: string }) {
  const d = call.decision;
  const top = (p: Record<string, number>, n = 2) =>
    Object.entries(p)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v], i) => (i === 0 ? `<b>${k}</b> ${Math.round(v * 100)}%` : `${k} ${Math.round(v * 100)}%`))
      .join(" · ");
  const tr = document.createElement("tr");
  const lat = timing.latencyMs;
  const parts = [timing.sttMs ? `stt ${timing.sttMs}` : "", timing.jevMs ? `jev ${timing.jevMs}` : ""].filter(Boolean).join(" · ");
  tr.innerHTML = `
    <td class="t">${(call.t / 1000).toFixed(0)}s</td>
    <td class="heard">“${escapeHtml(heard.text)}”${call.loud ? " 📢" : ""}<span class="src">${heard.source}</span></td>
    <td class="u">${top(d.command.probabilities)} · bait ${top(d.temptation.probabilities, 1)} · ${d.urgency.level}</td>
    <td class="did">${escapeHtml(sim.lastAction ?? "")}</td>
    <td class="num ${lat == null ? "" : lat < 1000 ? "fast" : "slow"}">${lat == null ? "—" : lat + " ms"}<span class="src">${parts}</span></td>`;
  logBody.prepend(tr);
}

function addErrorRow(text: string, msg: string) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td class="t">${(sim.t / 1000).toFixed(0)}s</td><td class="heard">“${escapeHtml(text)}”</td><td class="err" colspan="3">${escapeHtml(msg)}</td>`;
  logBody.prepend(tr);
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Runs one call through the server and applies the decision when it lands. */
async function submit(kind: "typed" | "wav", payload: string | Blob, loud: boolean, startedAt: number) {
  if (sim.over || replayLog) return;
  inFlight++;
  setStatus("busy", kind === "wav" ? "UPLINK · WHISPER → JEV" : "UPLINK · JEV");
  const meta = { loud, language: langSel.value || undefined, world: snapshot(sim) };
  let heardText = kind === "typed" ? (payload as string) : "";
  let heardSource = kind === "typed" ? "typed" : "whisper";
  let sttMs = 0;
  let decision: Decision | null = null;
  let jevMs = 0;
  let latency: number | null = null;
  const onEvent = (e: VoiceEvent) => {
    switch (e.type) {
      case "transcript":
        heardText = e.text;
        sttMs = e.sttMs;
        heardSource = e.source === "groq" ? "whisper v3 turbo" : "typed";
        break;
      case "phantom":
        addErrorRow(e.text || "(silence)", `phantom filtered (no_speech ${e.noSpeechProb ?? "?"}, logprob ${e.avgLogprob ?? "?"})`);
        break;
      case "stt_error":
        addErrorRow("(audio)", `${e.code}: ${e.message}`);
        break;
      case "decision":
        decision = e.decision;
        jevMs = e.jevMs;
        latency = Math.round(performance.now() - startedAt);
        break;
      case "decision_error":
        addErrorRow(heardText, `${e.code}: ${e.message}`);
        break;
      case "done":
        if (e.spend) spend = e.spend;
        break;
    }
  };
  try {
    if (kind === "typed") await postInterpret(payload as string, meta, onEvent);
    else await postCall(payload as Blob, meta, onEvent);
    if (decision) {
      applyCall({ t: sim.t, text: heardText, loud, decision }, { sttMs, jevMs, latencyMs: latency }, { text: heardText, source: heardSource });
    }
  } catch (err) {
    addErrorRow(heardText, String(err));
  } finally {
    inFlight--;
    updateSpend();
    if (inFlight === 0 && !sim.over) setStatus(mic ? "live" : "", mic ? "IMPLANT LIVE · LISTENING" : "IMPLANT IDLE · TAP THE MIC");
  }
}

function setStatus(cls: string, text: string) {
  status.className = `status ${cls}`;
  status.textContent = text;
  micLabel.className = `mic-label ${cls}`;
  micLabel.textContent = text.toLowerCase();
  micBtn.classList.toggle("busy", cls === "busy");
}

function updateSpend() {
  $("spend-label").textContent = spend
    ? `SPEND ${spend.spentUsd.toFixed(5)} / ${spend.limitUsd} USD · ${spend.requests} REQ · ${spend.inputTokens} TOK`
    : "SPEND —";
}

// ---------------------------------------------------------------------------
// Microphone

let mic: Mic | null = null;
let vad: Vad | null = null;
let calibrating: number[] | null = null;

function stopMic() {
  mic?.stop();
  mic = null;
  vad = null;
  micBtn.classList.remove("live", "shout");
  micBtn.style.setProperty("--level", "0");
  setStatus("", "IMPLANT IDLE · TAP THE MIC");
}

micBtn.addEventListener("click", async () => {
  if (sim.over) {
    restart();
    return;
  }
  if (mic) {
    stopMic();
    return;
  }
  try {
    const frames: number[] = [];
    calibrating = frames;
    const m = await openMic((frame) => {
      if (calibrating) {
        // first 1.5 s: measure the noise floor
        calibrating.push(rmsDb(frame));
        if (calibrating.length * m.frameMs >= 1500) {
          const noise = Math.min(-25, Math.max(-80, median(calibrating)));
          vad?.setNoise(noise);
          vad?.setVoice(noise + 22);
          calibrating = null;
          setStatus("live", `IMPLANT LIVE · LISTENING (noise ${Math.round(noise)} dB)`);
        }
        return;
      }
      vad?.push(frame);
      levelMeter(vad?.level ?? -90);
    });
    mic = m;
    vad = new Vad(
      { ...DEFAULT_VAD },
      m.frameMs,
      (u) => onUtterance(u, m.sampleRate),
      (why, ms) => {
        if (why === "quiet") return;
        setStatus("live", `IMPLANT LIVE · ${why === "short" ? `too short (${Math.round(ms)} ms)` : why}`);
      },
    );
    micBtn.classList.add("live");
    setStatus("live", "CALIBRATING · STAY QUIET 1.5 s");
  } catch (err) {
    addErrorRow("(mic)", String(err));
  }
});

function onUtterance(u: Utterance, sampleRate: number) {
  const wav = encodeWav(u.frames, sampleRate);
  setStatus("busy", `HEARD ${Math.round(u.speechMs)} ms${u.loud ? " · SHOUT" : ""} · SENDING ${(wav.size / 1024).toFixed(0)} kB`);
  void submit("wav", wav, u.loud, u.endedAt);
}

function levelMeter(db: number) {
  const pct = Math.max(0, Math.min(100, ((db + 70) / 60) * 100));
  micBtn.style.setProperty("--level", pct.toFixed(0));
  micBtn.classList.toggle("shout", vad != null && db >= vad.shoutThresholdDb());
}

// ---------------------------------------------------------------------------
// Restart / seed / replay link

function restart() {
  const u = new URL(location.href);
  u.searchParams.delete("log");
  u.searchParams.set("seed", seedInput.value || "1337");
  location.href = u.toString();
}
$("restart").addEventListener("click", restart);
seedInput.addEventListener("change", () => {
  seed = Number(seedInput.value) || 1337;
});

function updateReplayLink() {
  const u = new URL(location.href);
  u.searchParams.delete("seed");
  u.searchParams.set("log", encodeLog(inputLog));
  ($("replay-link") as HTMLAnchorElement).href = u.toString();
}
$("replay-link").addEventListener("click", (e) => {
  if (!inputLog.calls.length) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  const href = ($("replay-link") as HTMLAnchorElement).href;
  void navigator.clipboard?.writeText(href);
  window.open(href, "_blank");
});

function safeDecode(b64: string): InputLog | null {
  try {
    return decodeLog(b64);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backend status

void fetchStatus()
  .then((s) => {
    backendLabel = `${s.stt === "groq" ? "whisper-large-v3-turbo" : "no stt (typed only)"} · ${s.jev.model}${s.jev.road === "mock" ? " (mock)" : " via " + s.jev.road}`;
    $("backends").textContent = backendLabel;
    spend = s.spend;
    updateSpend();
    if (s.stt !== "groq") setStatus("busy", "NO GROQ_API_KEY ON THE SERVER · MIC WILL NOT WORK");
  })
  .catch(() => ($("backends").textContent = "server unreachable"));

// pause the round while the tab is hidden, so hunger doesn't run away
document.addEventListener("visibilitychange", () => {
  running = !document.hidden;
  last = performance.now();
});

// Dev hook: `say("JevGeni, left!")` in the console runs a typed call through
// the same pipeline, for testing without a microphone. Not part of the UI.
(window as unknown as { say: (t: string, loud?: boolean) => void }).say = (t, loud = false) =>
  void submit("typed", t, loud, performance.now());
