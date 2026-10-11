import { afterEach, describe, expect, test, vi } from "vitest";
import { TregAdapter, callEndpoint, getEndpointPrice, readBalance, readDoctor, searchCatalog } from "./treg.js";
import { findLeads } from "./leads.js";
import { VendorError, resetCosts } from "./core.js";

const q = { query: "services", area: "CA", limit: 2 };
const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { headers });
const price = (usd: number | null = 0, id = "treg.people.search") => ({ endpoint: { id, cost: { type: "per_success", unit: "call", usd } } });
afterEach(() => { vi.unstubAllEnvs(); resetCosts(); });

describe("searchCatalog", () => {
  test("maps hits and sends no token when anonymous", async () => {
    vi.stubEnv("TREG_TOKEN", "");
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ results: [{ id: "a.b", provider: "a", name: "B", method: "GET", cost: { usd: 0.01 } }] }));
    expect(await searchCatalog("people", { fetchFn })).toEqual([{ id: "a.b", provider: "a", name: "B", method: "GET", usd: 0.01 }]);
    expect(fetchFn.mock.calls[0][0]).toBe("https://treg.to/catalog/search?q=people");
    expect(fetchFn.mock.calls[0][1]?.headers).not.toHaveProperty("X-Treg-Token");
  });
  test("rejects an empty query before any fetch", async () => { const fetchFn = vi.fn(); await expect(searchCatalog("  ", { fetchFn })).rejects.toBeInstanceOf(VendorError); expect(fetchFn).not.toHaveBeenCalled(); });
  test("throws on HTTP failure and bad payload", async () => {
    await expect(searchCatalog("x", { fetchFn: vi.fn().mockResolvedValue(new Response("", { status: 500 })) })).rejects.toMatchObject({ code: "VENDOR_FAILED", status: 500 });
    await expect(searchCatalog("x", { fetchFn: vi.fn().mockResolvedValue(json({ results: [{ id: "a" }] })) })).rejects.toBeInstanceOf(VendorError);
  });
});

describe("getEndpointPrice", () => {
  test("maps the price block including a null usd", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json(price(null)));
    expect(await getEndpointPrice("treg.people.search", { fetchFn })).toEqual({ id: "treg.people.search", usd: null, type: "per_success", unit: "call", note: undefined });
    expect(fetchFn.mock.calls[0][0]).toBe("https://treg.to/catalog/endpoints/treg.people.search");
  });
  test("rejects an empty id and bad payloads", async () => {
    const fetchFn = vi.fn();
    await expect(getEndpointPrice("", { fetchFn })).rejects.toBeInstanceOf(VendorError); expect(fetchFn).not.toHaveBeenCalled();
    await expect(getEndpointPrice("x", { fetchFn: vi.fn().mockResolvedValue(json({})) })).rejects.toBeInstanceOf(VendorError);
  });
});

describe("callEndpoint", () => {
  test("posts a body with token, org, and default cost ceiling", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ output: {} }, { "X-Treg-Cost-Micro": "12", "X-Treg-Call-Id": "c1", "X-Treg-Served-By": "apollo" }));
    const call = await callEndpoint("treg.people.search", { method: "POST", body: { q: "x" } }, { fetchFn, token: "tok", org: "team" });
    expect(call).toEqual({ result: { output: {} }, costMicro: 12, callId: "c1", servedBy: "apollo" });
    expect(fetchFn.mock.calls[0][0]).toBe("https://treg.to/call/treg.people.search");
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ method: "POST", body: '{"q":"x"}' });
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({ "X-Treg-Token": "tok", "X-Treg-Org": "team", "X-Treg-Route-Max-Cost": "1", "content-type": "application/json" });
    expect(fetchFn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
  test("gets with a query string and a custom ceiling, defaulting cost to zero", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ data: {} }));
    const call = await callEndpoint("e", { query: { domain: "shop.test", limit: 2 } }, { fetchFn, token: "tok", maxCostUsd: 0.05 });
    expect(call.costMicro).toBe(0);
    expect(fetchFn.mock.calls[0][0]).toBe("https://treg.to/call/e?domain=shop.test&limit=2");
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({ "X-Treg-Route-Max-Cost": "0.05" });
  });
  test("reads TREG_TOKEN from the env and stays anonymous without one", async () => {
    vi.stubEnv("TREG_TOKEN", "env-token");
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    await callEndpoint("e", {}, { fetchFn });
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({ "X-Treg-Token": "env-token" });
    vi.stubEnv("TREG_TOKEN", "");
    const anon = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    await callEndpoint("e", {}, { fetchFn: anon });
    expect(anon.mock.calls[0][1]?.headers).not.toHaveProperty("X-Treg-Token");
  });
  test("reports HTTP failures with the server detail", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{"detail":"not authenticated"}', { status: 401 }));
    await expect(callEndpoint("e", {}, { fetchFn })).rejects.toMatchObject({ code: "VENDOR_FAILED", status: 401, message: expect.stringContaining("not authenticated") });
    await expect(callEndpoint("e", {}, { fetchFn: vi.fn().mockResolvedValue(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) })).rejects.toBeInstanceOf(VendorError);
  });
});

describe("readBalance", () => {
  test("resolves the org then reads micro and usd", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ email: "a@b.c", org_id: 7 })).mockResolvedValueOnce(json({ balance_micro: 250000, balance_usd: 0.25 }));
    expect(await readBalance({ fetchFn, token: "tok" })).toEqual({ usd: 0.25, micro: 250000 });
    expect(fetchFn.mock.calls.map(c => c[0])).toEqual(["https://treg.to/auth/me", "https://treg.to/orgs/7/balance?limit=1"]);
  });
  test("derives usd from micro when the twin is missing", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ org_id: 7 })).mockResolvedValueOnce(json({ balance_micro: 1000000 }));
    expect(await readBalance({ fetchFn, token: "tok" })).toEqual({ usd: 1, micro: 1000000 });
  });
  test("needs a token and an org", async () => {
    vi.stubEnv("TREG_TOKEN", "");
    const fetchFn = vi.fn();
    await expect(readBalance({ fetchFn })).rejects.toThrow("TREG_TOKEN"); expect(fetchFn).not.toHaveBeenCalled();
    await expect(readBalance({ fetchFn: vi.fn().mockResolvedValue(json({ email: "x" })), token: "tok" })).rejects.toThrow("no org");
  });
});

describe("readDoctor", () => {
  test("anonymous tier checks the catalog and skips balance", async () => {
    vi.stubEnv("TREG_TOKEN", "");
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ public_url: "https://treg.to" }));
    expect(await readDoctor({ fetchFn })).toEqual({ tier: "anonymous", catalog: { ok: true }, balance: { usd: null, micro: null, error: "anonymous tier carries no balance" } });
    expect(fetchFn.mock.calls[0][0]).toBe("https://treg.to/meta");
  });
  test("token tier reads the balance", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ org_id: 3 })).mockResolvedValueOnce(json({ balance_micro: 500000, balance_usd: 0.5 }));
    expect(await readDoctor({ fetchFn, token: "tok" })).toEqual({ tier: "token", catalog: { ok: true }, balance: { usd: 0.5, micro: 500000 } });
  });
  test("records failures instead of throwing", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(new Response("", { status: 401 }));
    const report = await readDoctor({ fetchFn, token: "bad" });
    expect(report.catalog).toEqual({ ok: false, error: "HTTP 503" });
    expect(report.balance).toMatchObject({ usd: null, micro: null, error: expect.stringContaining("401") });
  });
});

describe("TregAdapter", () => {
  const priced = (fetchFn: ReturnType<typeof vi.fn>, result: unknown, usd: number | null = 0) =>
    (fetchFn as ReturnType<typeof vi.fn<typeof fetch>>).mockResolvedValueOnce(json(price(usd))).mockResolvedValueOnce(json(result, { "X-Treg-Cost-Micro": "5", "X-Treg-Call-Id": "c9" }));
  test("people preset posts q/location/limit and maps names", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    priced(fetchFn, { output: { people: [{ first_name: "Sam", last_name_obfuscated: "Sm***h", title: "Owner", organization: { name: "Shop" }, location: "Austin" }] } });
    const leads = await new TregAdapter({ fetchFn, token: "tok" }).search(q);
    expect(leads).toEqual([{ name: "Sam Sm***h", source: "treg", email: undefined, area: "Austin", meta: { title: "Owner", organization: { name: "Shop" }, treg: { callId: "c9", costMicro: 5, servedBy: undefined } } }]);
    expect(fetchFn.mock.calls[1][0]).toBe("https://treg.to/call/treg.people.search");
    expect(JSON.parse(fetchFn.mock.calls[1][1]?.body as string)).toEqual({ q: "services", location: "CA", limit: 2 });
  });
  test("companies preset sends a domain and treats a null name as a miss", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    priced(fetchFn, { output: { name: null } }, 0.0018);
    expect(await new TregAdapter({ capability: "companies", fetchFn, token: "tok" }).search({ query: "https://www.shop.test/about" })).toEqual([]);
    expect(JSON.parse(fetchFn.mock.calls[1][1]?.body as string)).toEqual({ domain: "shop.test" });
    const named = vi.fn<typeof fetch>();
    priced(named, { output: { name: "Shop", domain: "shop.test", industry: "Retail", employees: "1-10", founded: 2019, location: "Austin", linkedin_url: "https://linkedin.test/shop" } }, 0.0018);
    expect(await new TregAdapter({ capability: "companies", fetchFn: named, token: "tok" }).search({ query: "Shop" })).toEqual([
      expect.objectContaining({ name: "Shop", website: "https://shop.test", area: "Austin", meta: expect.objectContaining({ industry: "Retail", employees: "1-10", founded: 2019 }) }),
    ]);
    expect(JSON.parse(named.mock.calls[1][1]?.body as string)).toEqual({ name: "Shop" });
  });
  test("signals preset maps job rows and rejects a missing title", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    priced(fetchFn, { output: { jobs: [{ title: "Baker", url: "https://shop.test/jobs", location: "Austin", company: "Shop" }] } });
    expect(await new TregAdapter({ capability: "signals", fetchFn, token: "tok" }).search(q)).toEqual([
      expect.objectContaining({ name: "Baker", website: "https://shop.test/jobs", area: "Austin", meta: expect.objectContaining({ company: "Shop" }) }),
    ]);
    const bad = vi.fn<typeof fetch>();
    priced(bad, { output: { jobs: [{}] } });
    await expect(new TregAdapter({ capability: "signals", fetchFn: bad, token: "tok" }).search(q)).rejects.toBeInstanceOf(VendorError);
  });
  test("emails preset sends domain or company and maps values", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    priced(fetchFn, { data: { emails: [{ value: "sam@shop.test", first_name: "Sam", last_name: "Smith", position: "Owner", type: "personal" }] } }, 0.00245);
    expect(await new TregAdapter({ capability: "emails", fetchFn, token: "tok" }).search({ query: "shop.test", limit: 2 })).toEqual([
      expect.objectContaining({ name: "Sam Smith", email: "sam@shop.test", meta: expect.objectContaining({ position: "Owner", type: "personal" }) }),
    ]);
    expect(fetchFn.mock.calls[1][0]).toBe("https://treg.to/call/hunter.companies.emails?domain=shop.test&limit=2");
    const named = vi.fn<typeof fetch>();
    priced(named, { data: { emails: [] } });
    await new TregAdapter({ capability: "emails", fetchFn: named, token: "tok" }).search({ query: "Shop" });
    expect(named.mock.calls[1][0]).toBe("https://treg.to/call/hunter.companies.emails?company=Shop");
  });
  test("refuses an unpriced endpoint and a price over the cap before any call", async () => {
    const unpriced = vi.fn<typeof fetch>().mockResolvedValue(json(price(null)));
    await expect(new TregAdapter({ fetchFn: unpriced, token: "tok" }).search(q)).rejects.toThrow("no price");
    expect(unpriced).toHaveBeenCalledTimes(1);
    const dear = vi.fn<typeof fetch>().mockResolvedValue(json(price(2)));
    await expect(new TregAdapter({ fetchFn: dear, token: "tok", maxCostUsd: 1 }).search(q)).rejects.toThrow("tops the $1 cap");
    expect(dear).toHaveBeenCalledTimes(1);
  });
  test("custom endpoint id uses generic rows and a request override", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json(price(0.01, "custom.rows"))).mockResolvedValueOnce(json({ output: { items: [{ title: "Row", url: "https://row.test" }] } }));
    const leads = await new TregAdapter({ endpointId: "custom.rows", method: "POST", body: { n: 1 }, fetchFn, token: "tok" }).search(q);
    expect(leads).toEqual([expect.objectContaining({ name: "Row", website: "https://row.test" })]);
    expect(fetchFn.mock.calls[1][1]).toMatchObject({ method: "POST", body: '{"n":1}' });
  });
  test("rejects an unknown capability", async () => {
    await expect(new TregAdapter({ capability: "bogus" as never, fetchFn: vi.fn(), token: "tok" }).search(q)).rejects.toThrow("unknown capability");
  });
  test("dry run calls no fetch and records no cost", async () => {
    const fetchFn = vi.fn();
    const result = await findLeads(q, { adapters: [new TregAdapter({ fetchFn, token: "tok" })], dryRun: true });
    expect(result).toMatchObject({ dryRun: true, adapters: ["treg"] });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
