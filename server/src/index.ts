// JevGeni server. No framework: Node's http module, raw WAV bodies in,
// NDJSON out. Routes:
//   POST /api/call       body: audio/wav, header X-Meta: base64 JSON {loud, language, world}
//   POST /api/interpret  body: JSON {text, loud, world}   (typed calls, simulated chain)
//   GET  /api/status     which backends are live, spend ledger
//   static               web/dist in production

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import type { Decision, WorldSnapshot } from "../../shared/protocol.js";
import { HttpJev, pickRoad, type JevEngine } from "./jev/client.js";
import { ModelVersionGuard, RateLimiting, Retrying, SpendLimiting, SpendLimitExceeded, RateLimitError } from "./jev/decorators.js";
import { MockJev } from "./jev/mock.js";
import { buildQuestions, toDecision } from "./jev/questions.js";
import { Ndjson } from "./ndjson.js";
import { isPhantom, SttError, transcribeWav } from "./stt/groq.js";

loadDotEnv();

const PORT = Number(process.env.JEVGENI_PORT ?? 8787);
const MAX_WAV_BYTES = 1_500_000;
const SPEND_LIMIT = Number(process.env.SPEND_LIMIT_USD ?? 0.1);

// --- Jev chain ---------------------------------------------------------------
const road = pickRoad(process.env);
const spend = new SpendLimiting(road ? new HttpJev(road) : new MockJev(), SPEND_LIMIT);
const jev: JevEngine = new Retrying(new RateLimiting(new ModelVersionGuard(spend, road?.model, road ? "WARN" : "IGNORE")));
const jevSource: Decision["source"] = road ? "jev" : "mock";
const jevModel = road?.model ?? "mock-jev";

console.log(`[jev] ${road ? `${road.name} → ${road.model}` : "no key: deterministic mock"}  spend cap ${SPEND_LIMIT} USD`);
console.log(`[stt] ${process.env.GROQ_API_KEY ? "groq whisper-large-v3-turbo" : "no GROQ_API_KEY: typed calls only"}`);

// --- Pipeline ----------------------------------------------------------------

interface CallMeta {
  loud: boolean;
  language?: string;
  world: WorldSnapshot;
  /** browser timestamp (performance.now) of speech end, echoed back for the p50 stat */
  speechEndedAt?: number;
}

async function pipeline(out: Ndjson, meta: CallMeta, wav: Buffer | null, typedText: string | null) {
  const t0 = process.hrtime.bigint();
  const ms = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  out.send({ type: "received", bytes: wav?.length ?? 0, typed: typedText != null });

  let text = typedText ?? "";
  let sttMs = 0;
  if (wav) {
    try {
      const tr = await transcribeWav(wav, meta.language, { apiKey: process.env.GROQ_API_KEY });
      sttMs = tr.ms;
      if (isPhantom(tr)) {
        out.send({ type: "phantom", text: tr.text, noSpeechProb: tr.noSpeechProb, avgLogprob: tr.avgLogprob, sttMs });
        out.send({ type: "done", totalMs: ms(), sttMs, jevMs: 0, ok: false });
        return;
      }
      text = tr.text;
      out.send({ type: "transcript", text, sttMs, language: tr.language, source: "groq" });
    } catch (e) {
      const code = e instanceof SttError ? e.code : "stt_http";
      out.send({ type: "stt_error", code, message: (e as Error).message });
      out.send({ type: "done", totalMs: ms(), sttMs: 0, jevMs: 0, ok: false });
      return;
    }
  } else {
    out.send({ type: "transcript", text, sttMs: 0, language: meta.language ?? null, source: "typed" });
  }

  const req = buildQuestions(jevModel, text, meta.loud, meta.world);
  const j0 = process.hrtime.bigint();
  try {
    const res = await jev.decide(req);
    const jevMs = Math.round(Number(process.hrtime.bigint() - j0) / 1e6);
    const decision = toDecision(res, jevSource);
    out.send({ type: "decision", decision, jevMs, raw: res.answers });
    out.send({ type: "done", totalMs: ms(), sttMs, jevMs, ok: true, spend: spend.ledger });
  } catch (e) {
    const code =
      e instanceof SpendLimitExceeded ? "spend_limit" : e instanceof RateLimitError ? "rate_limited" : "jev_error";
    out.send({ type: "decision_error", code, message: (e as Error).message });
    out.send({ type: "done", totalMs: ms(), sttMs, jevMs: 0, ok: false, spend: spend.ledger });
  }
}

// --- HTTP --------------------------------------------------------------------

const webDist = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "web", "dist");
const webDistDev = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "web", "dist");
const staticRoot = existsSync(webDist) ? webDist : webDistDev;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname === "/api/call") return await handleCall(req, res);
    if (req.method === "POST" && url.pathname === "/api/interpret") return await handleInterpret(req, res);
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, {
        jev: road ? { road: road.name, model: road.model } : { road: "mock", model: "mock-jev" },
        stt: process.env.GROQ_API_KEY ? "groq" : "none",
        spend: spend.ledger,
      });
    }
    return await serveStatic(url.pathname, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e) });
    else res.end();
  }
});

async function handleCall(req: IncomingMessage, res: ServerResponse) {
  const metaHeader = req.headers["x-meta"];
  if (typeof metaHeader !== "string") return json(res, 400, { error: "missing X-Meta" });
  const meta = JSON.parse(Buffer.from(metaHeader, "base64").toString("utf8")) as CallMeta;
  const wav = await readBody(req, MAX_WAV_BYTES);
  if (!wav) return json(res, 413, { error: "wav too large" });
  const out = new Ndjson(res);
  await pipeline(out, meta, wav, null);
  out.end();
}

async function handleInterpret(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req, 64_000);
  if (!body) return json(res, 413, { error: "too large" });
  const { text, loud, world, language } = JSON.parse(body.toString("utf8")) as CallMeta & { text: string };
  const out = new Ndjson(res);
  await pipeline(out, { loud: !!loud, world, language }, null, String(text ?? ""));
  out.end();
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

async function serveStatic(pathname: string, res: ServerResponse) {
  if (!existsSync(staticRoot)) return json(res, 404, { error: "web/dist not built; run `npm run dev` for the vite server" });
  let file = normalize(join(staticRoot, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(staticRoot)) return json(res, 403, {});
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    const index = await readFile(join(staticRoot, "index.html"));
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    res.end(index);
  }
}

function loadDotEnv() {
  for (const p of [".env", join(process.cwd(), ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    break;
  }
}

server.listen(PORT, () => console.log(`[http] JevGeni server on http://localhost:${PORT}`));
