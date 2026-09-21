# JevGeni — a fly brain at the claw machine

A tech demo for [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) and Whisper Large v3 Turbo (Groq).

A fruit fly with a thoracic implant sits at a tiny claw machine and tries to fish 💩 out of the pile. You are the voice in the implant. You shout "JevGeni, left, now!" and 140,000 neurons make of it what they make of it.

The joke is the gap: a state-of-the-art interface, and at the other end someone who just wants to get to the pile.

## What it shows

| | |
|---|---|
| **Whisper Large v3 Turbo (Groq)** | How fast a short, shouted call arrives. Target: under 1 s from end of speech to the thought bubble, p50 measured and shown. |
| **Jev** | Three structured questions per call, asked in parallel in one request, with visible probabilities. Pinned model version, spend cap, retry, rate limit. |
| **The punchline** | The misunderstanding is itself a Jev question. Not "what was said" but "what does a fly brain make of it". |

## Run it

```bash
npm install
cp .env.example .env    # add GROQ_API_KEY and OPENROUTER_API_KEY (or TYPESAFE_API_KEY)
npm run dev             # server on :8787, vite on :5173
```

Open http://localhost:5173, tap the mic, stay quiet 1.5 s for calibration, then shout. Without keys the server runs a deterministic mock for Jev; without `GROQ_API_KEY` the mic path cannot work. For testing without a microphone, `say("JevGeni, left!")` in the browser console runs a typed call through the same pipeline (`POST /api/interpret`).

Production: `npm run build && npm start` serves `web/dist` from the Node server.

## The loop

1. You call. Control is voice only: one mic button, nothing else. The pause cutter (`web/src/audio/vad.ts`) cuts the utterance, measures loudness against your calibrated voice, encodes 16 kHz WAV.
2. **Heard.** `POST /api/call` sends the WAV to Groq Whisper. The transcript comes back as an NDJSON event with its latency.
3. **Understood.** `server/src/jev/questions.ts` asks Jev three things about the call and the board:
   - `command` (choice): left, right, forward, back, down, up, grab, wait, none, unclear
   - `urgency` (score, 3 levels): calm / normal / now
   - `temptation` (choice): dung, banana, apple, wine, cheese, none
4. **Thought bubble.** Shows the two strongest options with percentages, and which one wins.
5. **Acted.** Joystick moves, claw drives, drops, grabs, rises.
6. **Result.** 💩 retrieved, something wrong grabbed, or the fly took a detour to the wine.

Event order on the wire: `received → transcript → decision → done`. Errors are events too and the stream always ends with `done`.

## What the fly wants (deterministic, no dice)

Three visible meters decide whether your command gets through:

- **Signal** (0–1): implant quality. Falls with the claw's distance from the RX antenna over the middle of the pit, rises when you call short and clear (≤ 3 words +10 %, ≥ 7 words −20 %).
- **Hunger** (0–1): rises over the round. High hunger → your command loses against the nearest temptation, or the one your call named.
- **Startle**: loud calls set it to 1, it decays. Above 0.5 the fly flinches and the claw jerks the wrong way first.

The rule, in `web/src/sim/sim.ts`:

```
strength = P(command) × signal
pull     = hunger × 0.7 + P(named bait) × 0.5
static     if both below 0.25
temptation if pull > strength
command    otherwise
```

Everything derives from the seed plus the ordered input log. The **REPLAY LINK** encodes both into the URL, so a run can be replayed exactly for recordings and demos.

## Jev adapter

`server/src/jev/` is a decorator chain, outermost first:

| Layer | What |
|---|---|
| `Retrying` | 2 attempts, 150→500 ms backoff, honours `retry-after` |
| `RateLimiting` | token bucket, 10/s burst 8 (Jev allows 1200/min) |
| `ModelVersionGuard` | warns when the answering model doesn't match the pinned one |
| `SpendLimiting` | reserves an estimate before, books real usage after, refuses above `SPEND_LIMIT_USD` |
| `HttpJev` | direct (`api.typesafe.ai/v1/systemone`) or via OpenRouter (`/api/alpha/decisions`), whichever key is set |

A call is about 1,500 input tokens, 0.00006 USD. A demo run costs fractions of a cent. The cap is there anyway.

## Layout

```
shared/protocol.ts     types shared by server and web
server/src/index.ts    http + NDJSON pipeline
server/src/jev/        questions, client, decorators, mock
server/src/stt/        Groq Whisper + phantom filter
web/src/sim/           deterministic simulation + tests
web/src/audio/         mic, VAD, WAV
web/src/rig/           fly and claw machine (SVG)
web/src/main.ts        game loop, UI, log, p50, replay
```

Tests: `npm test`.

## Not in scope

No levels, no stars, no progress, no pack, no languages beyond German and English, no streaming STT. Only the posted Whisper road, because that's the speed being shown.
