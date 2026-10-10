import { defaultAdapters, findLeads, selectAdapters } from "./leads.js";
import { VERSION } from "./version.js";
export interface WorkerEnv { PACK_NAME?: string }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, pack: env.PACK_NAME ?? "agentic-leads", version: VERSION });
    if (request.method === "POST" && url.pathname === "/search") {
      let body: unknown;
      try { body = await request.json(); } catch { return json({ error: "body must be JSON" }, 400); }
      if (!body || typeof body !== "object") return json({ error: "body needs query" }, 400);
      const b = body as Record<string, unknown>;
      if (typeof b.query !== "string" || !b.query.trim() || (b.area !== undefined && typeof b.area !== "string") || (b.file !== undefined && typeof b.file !== "string") || (b.source !== undefined && typeof b.source !== "string") || (b.live !== undefined && typeof b.live !== "boolean") || (b.limit !== undefined && (!Number.isSafeInteger(b.limit) || Number(b.limit) < 1))) return json({ error: "invalid search body" }, 400);
      try {
        const result = await findLeads({ query: b.query, area: b.area as string | undefined, file: b.file as string | undefined, limit: b.limit as number | undefined }, { adapters: selectAdapters(defaultAdapters(), b.source as string | undefined), dryRun: b.live !== true });
        return json(result, !result.dryRun && result.results.some(r => !r.ok) ? 502 : 200);
      } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
    }
    return json({ error: "not found" }, 404);
  },
};
