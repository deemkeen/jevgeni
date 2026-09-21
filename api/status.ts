import { app, gate } from "./_app.js";

export async function GET(req: Request): Promise<Response> {
  const denied = gate(req);
  if (denied) return denied;
  return Response.json(app.status(), { headers: { "Cache-Control": "no-store" } });
}
