import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test, vi } from "vitest";
import { createMcpServer } from "./mcp.js";
import { createGuards } from "./core.js";
const textOf = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
test("MCP tools use injected sources and default to preview", async () => {
  const search = vi.fn().mockResolvedValue([{ name: "Shop", source: "stub" }]);
  const [ct, st] = InMemoryTransport.createLinkedPair(); const server = createMcpServer({ adapters: [{ name: "stub", search }], guards: createGuards({ blocklist: ["denied"] }) }); const client = new Client({ name: "probe", version: "0.0.0" });
  await server.connect(st); await client.connect(ct);
  try {
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(["get_cost_report", "list_sources", "search_leads"]);
    expect(textOf(await client.callTool({ name: "search_leads", arguments: { query: "Shop", sources: ["stub"] } }))).toMatchObject({ dryRun: true, adapters: ["stub"] }); expect(search).not.toHaveBeenCalled();
    expect(textOf(await client.callTool({ name: "search_leads", arguments: { query: "Shop", source: "stub", dryRun: false } }))).toMatchObject({ dryRun: false, results: [{ ok: true }] }); expect(search).toHaveBeenCalledOnce();
    expect(textOf(await client.callTool({ name: "list_sources", arguments: {} }))).toEqual([{ name: "stub", keyRequired: false, keySet: false }]);
    expect(textOf(await client.callTool({ name: "get_cost_report", arguments: {} }))).toHaveProperty("entries");
    expect(await client.callTool({ name: "search_leads", arguments: { query: "denied" } })).toMatchObject({ isError: true });
    expect(await client.callTool({ name: "search_leads", arguments: { query: "Shop", source: "unknown" } })).toMatchObject({ isError: true });
    search.mockRejectedValue(new Error("down")); expect(await client.callTool({ name: "search_leads", arguments: { query: "Shop", dryRun: false } })).toMatchObject({ isError: true });
  } finally { await client.close(); await server.close(); }
});
