import { app, gate } from "./_app.js";

export default async function handler(req: Request): Promise<Response> {
  const denied = gate(req);
  if (denied) return denied;
  return Response.json(app.status(), { headers: { "Cache-Control": "no-store" } });
}
