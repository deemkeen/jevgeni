import type { CallMeta } from "../server/src/app.js";
import { app, gate, ndjsonResponse } from "./_app.js";

export const config = { maxDuration: 20 };

export async function POST(req: Request): Promise<Response> {
  const denied = gate(req);
  if (denied) return denied;
  const { text, loud, world, language } = (await req.json()) as CallMeta & { text: string };
  return ndjsonResponse((out) => app.pipeline(out, { loud: !!loud, world, language }, null, String(text ?? "")));
}
