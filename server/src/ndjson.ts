import type { ServerResponse } from "node:http";

/** One JSON object per line, flushed immediately, always ends with `done`. */
export class Ndjson {
  private ended = false;
  constructor(private res: ServerResponse) {
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
  }
  send(ev: Record<string, unknown>) {
    if (this.ended) return;
    this.res.write(JSON.stringify({ ...ev, at: Date.now() }) + "\n");
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.res.end();
  }
}
