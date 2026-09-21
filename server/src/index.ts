// JevGeni Node server. No framework: node:http, raw WAV bodies in, NDJSON out.
//   POST /api/call       body: audio/wav, header X-Meta: base64 JSON {loud, language, world}
//   POST /api/interpret  body: JSON {text, loud, world}   (dev hook, typed calls)
//   GET  /api/status     which backends are live, spend ledger
//   static               web/dist in production
// The same pipeline runs on Vercel through api/*.ts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp, decodeMeta, MAX_WAV_BYTES, type CallMeta } from "./app.js";
import { Ndjson } from "./ndjson.js";

loadDotEnv();

const PORT = Number(process.env.JEVGENI_PORT ?? 8787);
const app = createApp(process.env);

const here = fileURLToPath(new URL(".", import.meta.url));
const candidates = [join(here, "..", "..", "..", "web", "dist"), join(here, "..", "..", "web", "dist")];
const staticRoot = candidates.find((p) => existsSync(p)) ?? candidates[0];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/api/") && app.token && req.headers["x-token"] !== app.token) {
      return json(res, 401, { error: "token required" });
    }
    if (req.method === "POST" && url.pathname === "/api/call") return await handleCall(req, res);
    if (req.method === "POST" && url.pathname === "/api/interpret") return await handleInterpret(req, res);
    if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, app.status());
    return await serveStatic(url.pathname, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e) });
    else res.end();
  }
});

async function handleCall(req: IncomingMessage, res: ServerResponse) {
  const meta = decodeMeta(req.headers["x-meta"] as string | undefined);
  if (!meta) return json(res, 400, { error: "missing X-Meta" });
  const wav = await readBody(req, MAX_WAV_BYTES);
  if (!wav) return json(res, 413, { error: "wav too large" });
  const out = new Ndjson(res);
  await app.pipeline(out, meta, wav, null);
  out.end();
}

async function handleInterpret(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req, 64_000);
  if (!body) return json(res, 413, { error: "too large" });
  const { text, loud, world, language } = JSON.parse(body.toString("utf8")) as CallMeta & { text: string };
  const out = new Ndjson(res);
  await app.pipeline(out, { loud: !!loud, world, language }, null, String(text ?? ""));
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
