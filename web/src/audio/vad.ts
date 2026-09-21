// Pause cutter. Frames go in, whole utterances come out. Thresholds are
// relative to a measured noise floor; nothing leaves the device unless it
// passes the length and loudness checks.

import { percentile, rmsDb } from "./features";

export interface VadOptions {
  noiseDb: number;
  startMarginDb: number;
  stopMarginDb: number;
  startFrames: number;
  hangoverMs: number;
  preRollMs: number;
  minSpeechMs: number;
  maxSpeechMs: number;
  minPeakOverNoiseDb: number;
  /** dB above the calibrated "normal voice" that counts as a shout */
  shoutDb: number;
  voiceDb: number;
}

export const DEFAULT_VAD: VadOptions = {
  noiseDb: -55,
  startMarginDb: 12,
  stopMarginDb: 6,
  startFrames: 2,
  hangoverMs: 350,
  preRollMs: 300,
  minSpeechMs: 200,
  maxSpeechMs: 6000,
  minPeakOverNoiseDb: 14,
  shoutDb: 8,
  voiceDb: -28,
};

export interface Utterance {
  frames: Float32Array[];
  speechMs: number;
  peakDb: number;
  loud: boolean;
  /** performance.now() when speech was judged to have ended */
  endedAt: number;
}

export type VadReject = "short" | "quiet";

export class Vad {
  speaking = false;
  private pre: Float32Array[] = [];
  private cur: Float32Array[] = [];
  private loudDbs: number[] = [];
  private loudStreak = 0;
  private quietMs = 0;
  private speechMs = 0;
  private lastLoudAt = 0;
  level = -90;

  constructor(
    private o: VadOptions,
    private frameMs: number,
    private onUtterance: (u: Utterance) => void,
    private onReject: (why: VadReject, speechMs: number) => void = () => {},
  ) {}

  setNoise(db: number) {
    this.o.noiseDb = db;
  }
  setVoice(db: number) {
    this.o.voiceDb = db;
  }

  push(frame: Float32Array) {
    const db = rmsDb(frame);
    this.level = db;
    const margin = this.speaking ? this.o.stopMarginDb : this.o.startMarginDb;
    const loud = db > this.o.noiseDb + margin;

    if (!this.speaking) {
      this.pre.push(frame);
      const keep = Math.ceil(this.o.preRollMs / this.frameMs);
      while (this.pre.length > keep) this.pre.shift();
      this.loudStreak = loud ? this.loudStreak + 1 : 0;
      if (this.loudStreak >= this.o.startFrames) {
        this.speaking = true;
        this.cur = [...this.pre];
        this.loudDbs = [];
        this.speechMs = 0;
        this.quietMs = 0;
      }
      return;
    }

    this.cur.push(frame);
    this.speechMs += this.frameMs;
    if (loud) {
      this.loudDbs.push(db);
      this.quietMs = 0;
      this.lastLoudAt = performance.now();
    } else {
      this.quietMs += this.frameMs;
    }
    if (this.quietMs >= this.o.hangoverMs || this.speechMs >= this.o.maxSpeechMs) this.finish();
  }

  private finish() {
    this.speaking = false;
    const frames = this.cur;
    this.cur = [];
    this.pre = [];
    const speechMs = this.speechMs - this.quietMs;
    const peakDb = this.loudDbs.length ? percentile(this.loudDbs, 90) : -90;
    if (speechMs < this.o.minSpeechMs) return this.onReject("short", speechMs);
    if (peakDb < this.o.noiseDb + this.o.minPeakOverNoiseDb) return this.onReject("quiet", speechMs);
    this.onUtterance({
      frames,
      speechMs,
      peakDb,
      loud: peakDb >= this.o.voiceDb + this.o.shoutDb,
      endedAt: this.lastLoudAt || performance.now(),
    });
  }
}
