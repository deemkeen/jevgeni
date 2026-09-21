import { decodeMeta, MAX_WAV_BYTES } from "../server/src/app.js";
import { app, gate, ndjsonResponse } from "./_app.js";

export const config = { maxDuration: 20 };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const denied = gate(req);
  if (denied) return denied;
  const meta = decodeMeta(req.headers.get("x-meta"));
  if (!meta) return Response.json({ error: "missing X-Meta" }, { status: 400 });
  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length > MAX_WAV_BYTES) return Response.json({ error: "wav too large" }, { status: 413 });
  return ndjsonResponse((out) => app.pipeline(out, meta, bytes, null));
}
