import { describe, expect, test, vi } from "vitest";
import { parseArgs, runCli, UsageError } from "./cli.js";
const setup = () => { const out = vi.fn(), err = vi.fn(), search = vi.fn().mockResolvedValue([{ name: "Shop", source: "county-file" }]); return { out, err, search, adapters: [{ name: "county-file", search }] }; };
describe("CLI", () => {
  test("parses defaults and flags", () => { expect(parseArgs([]).command).toBe("help"); expect(parseArgs(["--version"]).command).toBe("version"); expect(parseArgs(["search", "--query", "Shop", "--area", "CA", "--limit", "2", "--file", "data.csv", "--source", "county-file", "--live"])).toEqual({ command: "search", query: "Shop", area: "CA", limit: 2, file: "data.csv", source: "county-file", dryRun: false }); });
  test.each([["bogus"], ["summary"], ["search"], ["search", "--query"], ["search", "--query", "x", "--limit", "2x"], ["search", "--query", "x", "--source", "unknown"], ["sources", "--live"]].map(args => [args]))("rejects %j", args => { expect(() => parseArgs(args)).toThrow(UsageError); });
  test("search previews by default", async () => { const io = setup(); expect(await runCli(["search", "--query", "Shop", "--source", "county-file"], io)).toBe(0); expect(JSON.parse(io.out.mock.calls[0][0])).toMatchObject({ dryRun: true }); expect(io.search).not.toHaveBeenCalled(); });
  test("live search runs selected adapter", async () => { const io = setup(); expect(await runCli(["search", "--query", "Shop", "--source", "county-file", "--live"], io)).toBe(0); expect(io.search).toHaveBeenCalledOnce(); });
  test("failed source returns exit 1", async () => { const io = setup(); io.search.mockRejectedValue(new Error("down")); expect(await runCli(["search", "--query", "Shop", "--live"], io)).toBe(1); expect(JSON.parse(io.out.mock.calls[0][0]).results[0]).toMatchObject({ ok: false, error: "down" }); });
  test("bad usage returns exit 2", async () => { const io = setup(); expect(await runCli(["bad"], io)).toBe(2); expect(io.err).toHaveBeenCalled(); });
  test.each(["help", "version", "sources", "costs"])("runs %s", async command => { const io = setup(); expect(await runCli([command], io)).toBe(0); expect(io.out).toHaveBeenCalledOnce(); });
});
