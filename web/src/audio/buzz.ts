// JevGeni's voice. No samples: a sawtooth "wing" oscillator, amplitude-
// modulated at wingbeat rate (real Drosophila beat at ~200 Hz, we cheat
// lower so it reads as "bz bz"), through a lowpass. Every mood is a short
// phrase of pitch/gain envelopes on the same voice.

export type BuzzKind = "obeys" | "tempted" | "startled" | "win" | "yum" | "miss" | "static" | "hello";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
let motor: { osc: OscillatorNode; gain: GainNode } | null = null;

function ensure(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    return ctx;
  } catch {
    return null;
  }
}

/** Call from a user gesture once so the browser lets us make noise. */
export function unlockAudio() {
  const c = ensure();
  if (c && c.state === "suspended") void c.resume();
}

export function setMuted(m: boolean) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.5;
}
export function isMuted() {
  return muted;
}

interface Segment {
  /** base pitch in Hz */
  f: number;
  /** duration in seconds */
  d: number;
  /** wingbeat rate in Hz (tremolo) */
  beat?: number;
  /** pitch glide target at end of the segment */
  to?: number;
  /** gain 0..1 */
  g?: number;
}

const PHRASES: Record<BuzzKind, Segment[]> = {
  hello: [{ f: 190, d: 0.12, beat: 28 }, { f: 0, d: 0.05 }, { f: 210, d: 0.12, beat: 28 }],
  // two crisp blips, second one higher: "bz bz!" = got it
  obeys: [{ f: 200, d: 0.09, beat: 32 }, { f: 0, d: 0.05 }, { f: 260, d: 0.11, beat: 34, to: 300 }],
  // long greedy descending buzz, wings slow down: "bzzzzzuuuh"
  tempted: [{ f: 240, d: 0.5, beat: 22, to: 150, g: 0.9 }, { f: 0, d: 0.04 }, { f: 150, d: 0.16, beat: 16, to: 120 }],
  // sharp high "BZZT!" with a stutter
  startled: [{ f: 420, d: 0.06, beat: 60, g: 1 }, { f: 0, d: 0.03 }, { f: 460, d: 0.05, beat: 60, g: 1 }, { f: 0, d: 0.03 }, { f: 380, d: 0.12, beat: 45, to: 240 }],
  // rising triple: "bz bz bzee!"
  win: [{ f: 220, d: 0.08, beat: 30 }, { f: 0, d: 0.04 }, { f: 280, d: 0.08, beat: 34 }, { f: 0, d: 0.04 }, { f: 340, d: 0.24, beat: 40, to: 420 }],
  // content chewing wobble
  yum: [{ f: 180, d: 0.14, beat: 12, to: 200 }, { f: 0, d: 0.05 }, { f: 170, d: 0.14, beat: 12, to: 190 }, { f: 0, d: 0.05 }, { f: 160, d: 0.2, beat: 10, to: 140 }],
  // deflating "bzzuh"
  miss: [{ f: 230, d: 0.3, beat: 24, to: 110, g: 0.7 }],
  // barely anything: a faint questioning tick
  static: [{ f: 260, d: 0.05, beat: 50, g: 0.35 }, { f: 0, d: 0.08 }, { f: 260, d: 0.05, beat: 50, g: 0.35 }],
};

export function buzz(kind: BuzzKind) {
  const c = ensure();
  if (!c || !master || muted) return;
  if (c.state === "suspended") return; // not unlocked yet
  let t = c.currentTime + 0.01;
  for (const seg of PHRASES[kind]) {
    if (seg.f === 0) {
      t += seg.d;
      continue;
    }
    voice(c, master, t, seg);
    t += seg.d;
  }
}

function voice(c: AudioContext, out: AudioNode, t: number, seg: Segment) {
  const osc = c.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(seg.f, t);
  if (seg.to) osc.frequency.exponentialRampToValueAtTime(seg.to, t + seg.d);

  // a second, slightly detuned oscillator makes it insect-y instead of synth-y
  const osc2 = c.createOscillator();
  osc2.type = "square";
  osc2.frequency.setValueAtTime(seg.f * 1.01, t);
  if (seg.to) osc2.frequency.exponentialRampToValueAtTime(seg.to * 1.01, t + seg.d);

  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1400;
  lp.Q.value = 2;

  // wingbeat tremolo
  const trem = c.createGain();
  trem.gain.value = 0.5;
  const lfo = c.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = seg.beat ?? 28;
  const lfoDepth = c.createGain();
  lfoDepth.gain.value = 0.5;
  lfo.connect(lfoDepth).connect(trem.gain);

  const env = c.createGain();
  const g = (seg.g ?? 0.8) * 0.35;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(g, t + 0.012);
  env.gain.setValueAtTime(g, t + Math.max(0.013, seg.d - 0.03));
  env.gain.exponentialRampToValueAtTime(0.0001, t + seg.d);

  const mix = c.createGain();
  mix.gain.value = 0.6;
  osc.connect(mix);
  osc2.connect(mix);
  mix.connect(lp).connect(trem).connect(env).connect(out);

  osc.start(t);
  osc2.start(t);
  lfo.start(t);
  osc.stop(t + seg.d + 0.02);
  osc2.stop(t + seg.d + 0.02);
  lfo.stop(t + seg.d + 0.02);
}

/** Continuous low wing hum while the claw trolley moves; call with true/false. */
export function motorHum(on: boolean) {
  const c = ensure();
  if (!c || !master) return;
  if (on && !motor) {
    const osc = c.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 95;
    const lfo = c.createOscillator();
    lfo.frequency.value = 18;
    const depth = c.createGain();
    depth.gain.value = 12;
    lfo.connect(depth).connect(osc.frequency);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, c.currentTime + 0.08);
    osc.connect(gain).connect(master);
    osc.start();
    lfo.start();
    motor = { osc, gain };
  } else if (!on && motor) {
    const m = motor;
    motor = null;
    m.gain.gain.cancelScheduledValues(c.currentTime);
    m.gain.gain.setValueAtTime(m.gain.gain.value, c.currentTime);
    m.gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.12);
    m.osc.stop(c.currentTime + 0.15);
  }
}

/** Joystick click and claw clack: short filtered noise bursts. */
export function click(kind: "stick" | "clack") {
  const c = ensure();
  if (!c || !master || muted || c.state === "suspended") return;
  const len = kind === "clack" ? 0.06 : 0.025;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * len), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = kind === "clack" ? 1800 : 3200;
  bp.Q.value = 3;
  const g = c.createGain();
  g.gain.value = kind === "clack" ? 0.5 : 0.25;
  src.connect(bp).connect(g).connect(master);
  src.start();
}
