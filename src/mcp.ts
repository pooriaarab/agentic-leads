import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getCostReport, type Guards, type Logger } from "./core.js";
import { DEFAULT_BRAND } from "./index.js";
import { defaultAdapters, findLeads, listSources, selectAdapters, type LeadAdapter } from "./leads.js";
export interface McpDeps { adapters?: LeadAdapter[]; guards?: Guards; logger?: Logger }
function reply(value: unknown, isError = false) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }; }
export function createMcpServer(deps: McpDeps = {}): McpServer {
  const adapters = deps.adapters ?? defaultAdapters();
  const server = new McpServer({ name: DEFAULT_BRAND.command, version: DEFAULT_BRAND.version });
  server.registerTool("search_leads", {
    description: "Find prospects from selected sources. Preview by default.",
    inputSchema: { query: z.string().min(1), area: z.string().optional(), limit: z.number().int().positive().optional(), file: z.string().optional(), source: z.string().optional(), sources: z.array(z.string()).min(1).optional(), dryRun: z.boolean().optional() },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, async ({ query, area, limit, file, source, sources, dryRun }) => {
    try {
      const selected = [...new Set(sources ? sources.flatMap(s => selectAdapters(adapters, s)) : selectAdapters(adapters, source))];
      const result = await findLeads({ query, area, limit, file }, { ...deps, adapters: selected, dryRun: dryRun ?? true });
      return reply(result, !result.dryRun && result.results.some(r => !r.ok));
    } catch (error) { return reply({ error: error instanceof Error ? error.message : String(error) }, true); }
  });
  server.registerTool("list_sources", { description: "List sources and key status.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => reply(listSources(adapters)));
  server.registerTool("get_cost_report", { description: "Read session cost entries and unit totals.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => reply(getCostReport()));
  return server;
}
export async function startMcp(deps: McpDeps = {}): Promise<void> { await createMcpServer(deps).connect(new StdioServerTransport()); }
