import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApolloAdapter, ApifyAdapter, CountyFileAdapter, GooglePlacesAdapter, StormFeedAdapter, findLeads, type AdapterOptions } from "./leads.js";
import { VendorError, createGuards, getCostReport, resetCosts } from "./core.js";
const q = { query: "services", area: "CA", limit: 2 };
const json = (value: unknown) => new Response(JSON.stringify(value));
const fixtures = [
  { name: "google-places", make: (o: AdapterOptions) => new GooglePlacesAdapter(o), payload: { places: [{ displayName: { text: "Shop" }, formattedAddress: "Main", internationalPhoneNumber: "123", websiteUri: "https://shop.test" }] }, mapped: { name: "Shop", address: "Main", phone: "123", website: "https://shop.test" } },
  { name: "apollo", make: (o: AdapterOptions) => new ApolloAdapter(o), payload: { people: [{ name: "Person", title: "Owner", organization: { name: "Shop" }, city: "City", state: "CA" }] }, mapped: { name: "Person", area: "City, CA", meta: { title: "Owner", organization: { name: "Shop" } } } },
  { name: "storm-feed", make: (o: AdapterOptions) => new StormFeedAdapter(o), payload: { features: [{ properties: { event: "Storm", headline: "Warning", onset: "2026-01-01" } }] }, mapped: { name: "Storm", area: "CA", meta: { headline: "Warning", onset: "2026-01-01" } } },
];
afterEach(() => { vi.unstubAllEnvs(); resetCosts(); });
describe.each(fixtures)("$name", ({ make, payload, mapped, name }) => {
  test("maps response and sends a timeout signal", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json(payload));
    expect(await make({ apiKey: "key", fetchFn }).search(q)).toEqual([expect.objectContaining({ ...mapped, source: name })]);
    expect(fetchFn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    if (name === "google-places") {
      expect(fetchFn.mock.calls[0][0]).toBe("https://places.googleapis.com/v1/places:searchText");
      expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({ "X-Goog-Api-Key": "key", "X-Goog-FieldMask": expect.stringContaining("places.displayName") });
      expect(JSON.parse(fetchFn.mock.calls[0][1]?.body as string)).toEqual({ textQuery: "services CA", maxResultCount: 2 });
    }
    if (name === "apollo") expect(JSON.parse(fetchFn.mock.calls[0][1]?.body as string)).toEqual({ q_keywords: "services", person_locations: ["CA"], page: 1, per_page: 2 });
    if (name === "storm-feed") expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({ "User-Agent": expect.stringContaining("agentic-leads") });
  });
  test("throws on HTTP failure", async () => { await expect(make({ apiKey: "key", fetchFn: vi.fn().mockResolvedValue(new Response("", { status: 503 })) }).search(q)).rejects.toMatchObject({ code: "VENDOR_FAILED", status: 503 }); });
  test("throws on network failure", async () => { await expect(make({ apiKey: "key", fetchFn: vi.fn().mockRejectedValue(new Error("offline")) }).search(q)).rejects.toBeInstanceOf(VendorError); });
  test("throws on bad payload", async () => { await expect(make({ apiKey: "key", fetchFn: vi.fn().mockResolvedValue(json({})) }).search(q)).rejects.toBeInstanceOf(VendorError); });
  test("throws on timeout", async () => { const fetchFn: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)); }); const keepAlive = setTimeout(() => {}, 100); try { await expect(make({ apiKey: "key", fetchFn, timeoutMs: 1 }).search(q)).rejects.toBeInstanceOf(VendorError); } finally { clearTimeout(keepAlive); } });
});
test.each(["google-places", "apollo", "apify"])("%s rejects missing key", async source => {
  for (const env of ["GOOGLE_PLACES_API_KEY", "APOLLO_API_KEY", "APIFY_TOKEN"]) vi.stubEnv(env, "");
  const fetchFn = vi.fn();
  const adapter = source === "google-places" ? new GooglePlacesAdapter({ fetchFn }) : source === "apollo" ? new ApolloAdapter({ fetchFn }) : new ApifyAdapter({ actorId: "actor", fetchFn });
  await expect(adapter.search(q)).rejects.toBeInstanceOf(VendorError); expect(fetchFn).not.toHaveBeenCalled();
});
test("storm requires state code", async () => { await expect(new StormFeedAdapter({ fetchFn: vi.fn() }).search({ query: "x", area: "California" })).rejects.toBeInstanceOf(VendorError); });
describe("apify", () => {
  test("starts, polls, reads dataset, and maps custom fields", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ data: { id: "run" } })).mockResolvedValueOnce(json({ data: { status: "RUNNING" } })).mockResolvedValueOnce(json({ data: { status: "SUCCEEDED", defaultDatasetId: "dataset" } })).mockResolvedValueOnce(json([{ label: "Shop", tel: "123" }]));
    const adapter = new ApifyAdapter({ actorId: "owner/actor", apiKey: "key", fetchFn, input: { custom: true }, fieldMap: { name: "label", phone: "tel" }, pollIntervalMs: 0 });
    expect(await adapter.search(q)).toEqual([expect.objectContaining({ name: "Shop", phone: "123", source: "apify" })]);
    expect(fetchFn.mock.calls.map(c => c[0])).toEqual(["https://api.apify.com/v2/acts/owner~actor/runs?token=key", "https://api.apify.com/v2/actor-runs/run?token=key", "https://api.apify.com/v2/actor-runs/run?token=key", "https://api.apify.com/v2/datasets/dataset/items?token=key"]);
    expect(fetchFn.mock.calls[0][1]?.body).toBe('{"custom":true}');
  });
  test.each(["FAILED", "ABORTED", "TIMED-OUT"])("rejects %s", async status => { const fetchFn = vi.fn().mockResolvedValueOnce(json({ data: { id: "run" } })).mockResolvedValue(json({ data: { status } })); await expect(new ApifyAdapter({ actorId: "actor", apiKey: "key", fetchFn }).search(q)).rejects.toBeInstanceOf(VendorError); });
  test.each(["http", "network", "payload"])("rejects %s failures", async mode => { const fetchFn = mode === "network" ? vi.fn().mockRejectedValue(new Error("offline")) : vi.fn().mockResolvedValue(mode === "http" ? new Response("", { status: 500 }) : json({})); await expect(new ApifyAdapter({ actorId: "actor", apiKey: "key", fetchFn }).search(q)).rejects.toBeInstanceOf(VendorError); });
  test("poll deadline stops running jobs", async () => { const fetchFn = vi.fn().mockResolvedValueOnce(json({ data: { id: "run" } })).mockImplementation(async () => json({ data: { status: "RUNNING" } })); await expect(new ApifyAdapter({ actorId: "actor", apiKey: "key", fetchFn, pollIntervalMs: 1, pollTimeoutMs: 5 }).search(q)).rejects.toThrow("poll timeout"); });
  test("wraps Apify request timeouts", async () => {
    const fetchFn: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)); });
    const keepAlive = setTimeout(() => {}, 100);
    try { await expect(new ApifyAdapter({ actorId: "actor", apiKey: "key", fetchFn, timeoutMs: 1 }).search(q)).rejects.toBeInstanceOf(VendorError); }
    finally { clearTimeout(keepAlive); }
  });
  test("requires actor", () => { expect(() => new ApifyAdapter({ actorId: "" })).toThrow(VendorError); });
});
describe("county CSV", () => {
  test("parses quoted fields, filters and maps custom headers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "leads-")); const file = join(dir, "data.csv");
    try { await writeFile(file, 'owner,street,state,tel\r\n"Shop, \\"One\\"",Main,CA,123\r\nOther,Oak,NY,456'.replaceAll('\\"', '""')); const leads = await new CountyFileAdapter({ file, fieldMap: { name: "owner", address: "street", area: "state", phone: "tel" } }).search({ query: "Shop", area: "CA" }); expect(leads).toEqual([{ name: 'Shop, "One"', address: "Main", area: "CA", phone: "123", source: "county-file" }]); } finally { await rm(dir, { recursive: true }); }
  });
  test.each(["", "wrong,address\na,b", 'name\n"broken'])("rejects invalid CSV %j", async text => { const dir = await mkdtemp(join(tmpdir(), "leads-")); const file = join(dir, "bad.csv"); try { await writeFile(file, text); await expect(new CountyFileAdapter({ file }).search(q)).rejects.toBeInstanceOf(VendorError); } finally { await rm(dir, { recursive: true }); } });
  test("rejects absent file", async () => { await expect(new CountyFileAdapter().search(q)).rejects.toBeInstanceOf(VendorError); await expect(new CountyFileAdapter({ file: "/file-that-does-not-exist" }).search(q)).rejects.toBeInstanceOf(VendorError); });
});
describe("findLeads", () => {
  test("preview calls no fetch and records no cost", async () => { const fetchFn = vi.fn(); const result = await findLeads(q, { adapters: [new GooglePlacesAdapter({ fetchFn })], dryRun: true }); expect(result).toMatchObject({ dryRun: true, adapters: ["google-places"] }); expect(fetchFn).not.toHaveBeenCalled(); expect(getCostReport().entries).toEqual([]); });
  test("guard blocks all calls", async () => { const search = vi.fn(); await expect(findLeads(q, { adapters: [{ name: "stub", search }], guards: createGuards({ blocklist: ["services"] }) })).rejects.toThrow(); expect(search).not.toHaveBeenCalled(); });
  test("fans out and records one entry per call, including failure", async () => { resetCosts(); const result = await findLeads(q, { adapters: [{ name: "yes", search: async () => [{ name: "Shop", source: "yes" }] }, { name: "no", search: async () => { throw new VendorError("down"); } }] }); expect(result).toMatchObject({ dryRun: false, results: [{ adapter: "yes", ok: true }, { adapter: "no", ok: false, error: "down" }] }); expect(getCostReport().entries).toEqual([expect.objectContaining({ kind: "search", adapter: "yes", units: 1 }), expect.objectContaining({ kind: "search", adapter: "no", units: 0 })]); });
});
