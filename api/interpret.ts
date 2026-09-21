import type { CallMeta } from "../server/src/app.js";
import { app, gate, ndjsonResponse } from "./_app.js";

export const config = { maxDuration: 20 };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const denied = gate(req);
  if (denied) return denied;
  const { text, loud, world, language } = (await req.json()) as CallMeta & { text: string };
  return ndjsonResponse((out) => app.pipeline(out, { loud: !!loud, world, language }, null, String(text ?? "")));
}
