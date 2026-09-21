// Shared glue for the Vercel functions: one App per lambda instance, an
// NDJSON sink on a web ReadableStream, and the optional token gate.
import { createApp, type EventSink } from "../server/src/app.js";

export const app = createApp(process.env);

export function gate(req: Request): Response | null {
  if (app.token && req.headers.get("x-token") !== app.token) {
    return Response.json({ error: "token required" }, { status: 401 });
  }
  return null;
}

export function ndjsonResponse(run: (out: EventSink) => Promise<void>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false;
      const out: EventSink = {
        send(ev) {
          if (!ended) controller.enqueue(enc.encode(JSON.stringify({ ...ev, at: Date.now() }) + "\n"));
        },
        end() {
          if (ended) return;
          ended = true;
          controller.close();
        },
      };
      run(out)
        .catch((e) => out.send({ type: "error", message: String(e) }))
        .finally(() => out.end());
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}
