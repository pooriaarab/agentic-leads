import { readFile } from "node:fs/promises";
import { VendorError, recordCost, type Guards, type Logger } from "./core.js";
import { TregAdapter } from "./treg.js";
import { VERSION } from "./version.js";

export interface Lead { name: string; source: string; address?: string; phone?: string; website?: string; email?: string; area?: string; meta?: Record<string, unknown> }
export interface LeadQuery { query: string; area?: string; limit?: number; file?: string }
export interface LeadAdapter { name: string; search(q: LeadQuery): Promise<Lead[]> }
export interface FindOptions { adapters: LeadAdapter[]; guards?: Guards; logger?: Logger; dryRun?: boolean }
export interface AdapterResult { adapter: string; ok: boolean; leads?: Lead[]; error?: string }
export type FindResult = { dryRun: true; query: LeadQuery; adapters: string[] } | { dryRun: false; results: AdapterResult[] };
export async function findLeads(query: LeadQuery, options: FindOptions): Promise<FindResult> {
  options.guards?.checkDispatch(query.query);
  if (options.dryRun) return { dryRun: true, query, adapters: options.adapters.map(a => a.name) };
  // Reserve guard capacity before starting concurrent vendor calls.
  for (const adapter of options.adapters) {
    options.guards?.checkDispatch(query.query);
    options.guards?.recordDispatch();
    options.logger?.debug(`search via ${adapter.name}`);
  }
  const results = await Promise.all(options.adapters.map(async adapter => {
    let units = 0;
    try {
      const leads = await adapter.search(query); units = leads.length;
      return { adapter: adapter.name, ok: true, leads };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.error(`${adapter.name}: ${message}`);
      return { adapter: adapter.name, ok: false, error: message };
    } finally { recordCost({ kind: "search", adapter: adapter.name, units }); }
  }));
  return { dryRun: false, results };
}
export interface AdapterOptions { apiKey?: string; fetchFn?: typeof fetch; timeoutMs?: number }
type Row = Record<string, unknown>;
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VendorError("bad payload: expected object");
  return value as Row;
}
function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new VendorError("bad payload: expected array");
  return value.map(object);
}
function str(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function name(value: unknown): string { const n = str(value); if (!n?.trim()) throw new VendorError("bad payload: missing name"); return n; }
abstract class RemoteAdapter implements LeadAdapter {
  abstract readonly name: string;
  constructor(protected options: AdapterOptions = {}) {}
  abstract search(q: LeadQuery): Promise<Lead[]>;
  protected key(env: string): string {
    const key = this.options.apiKey ?? process.env[env];
    if (!key?.trim()) throw new VendorError(`${this.name}: missing ${env}`);
    return key;
  }
  protected async request(url: string, init: RequestInit = {}, timeoutMs = this.options.timeoutMs ?? 10000): Promise<unknown> {
    try {
      const response = await (this.options.fetchFn ?? fetch)(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new VendorError(`${this.name}: HTTP ${response.status}`, { status: response.status });
      return await response.json();
    } catch (error) {
      if (error instanceof VendorError) throw error;
      throw new VendorError(`${this.name}: request failed`, { cause: error });
    }
  }
}
export class GooglePlacesAdapter extends RemoteAdapter {
  readonly name = "google-places";
  async search(q: LeadQuery): Promise<Lead[]> {
    const payload = object(await this.request("https://places.googleapis.com/v1/places:searchText", {
      method: "POST", headers: { "content-type": "application/json", "X-Goog-Api-Key": this.key("GOOGLE_PLACES_API_KEY"), "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri" },
      body: JSON.stringify({ textQuery: [q.query, q.area].filter(Boolean).join(" "), maxResultCount: q.limit ?? 20 }),
    }));
    return rows(payload.places).map(p => ({ name: name(object(p.displayName).text), source: this.name, address: str(p.formattedAddress), phone: str(p.internationalPhoneNumber), website: str(p.websiteUri), area: q.area }));
  }
}
export interface ApifyOptions extends AdapterOptions { actorId: string; input?: Row; fieldMap?: { name: string; address?: string; phone?: string; website?: string; email?: string }; pollIntervalMs?: number; pollTimeoutMs?: number }
export class ApifyAdapter extends RemoteAdapter {
  readonly name = "apify";
  constructor(private config: ApifyOptions) { super(config); if (!config.actorId?.trim()) throw new VendorError("apify: actorId is required"); }
  async search(q: LeadQuery): Promise<Lead[]> {
    const token = encodeURIComponent(this.key("APIFY_TOKEN"));
    const start = object(object(await this.request(`https://api.apify.com/v2/acts/${encodeURIComponent(this.config.actorId.replaceAll("/", "~"))}/runs?token=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(this.config.input ?? { searchStringsArray: [[q.query, q.area].filter(Boolean).join(" ")], maxCrawledPlacesPerSearch: q.limit ?? 20 }) })).data);
    const runId = name(start.id);
    const deadline = Date.now() + (this.config.pollTimeoutMs ?? 120000);
    let run: Row;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new VendorError("apify: poll timeout");
      run = object(object(await this.request(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}?token=${token}`, {}, Math.min(remaining, this.options.timeoutMs ?? 10000))).data);
      if (run.status === "SUCCEEDED") break;
      if (["FAILED", "ABORTED", "TIMED-OUT"].includes(String(run.status))) throw new VendorError(`apify: run ${run.status}`);
      if (!["READY", "RUNNING", "TIMING-OUT", "ABORTING"].includes(String(run.status))) throw new VendorError("apify: bad run status");
      await new Promise(resolve => setTimeout(resolve, Math.min(this.config.pollIntervalMs ?? 1000, Math.max(0, deadline - Date.now()))));
    }
    const dataset = name(run.defaultDatasetId);
    const items = rows(await this.request(`https://api.apify.com/v2/datasets/${encodeURIComponent(dataset)}/items?token=${token}`));
    const m = this.config.fieldMap ?? { name: "title", address: "address", phone: "phone", website: "website", email: "email" };
    return items.slice(0, q.limit).map(p => ({ name: name(p[m.name]), source: this.name, address: m.address ? str(p[m.address]) : undefined, phone: m.phone ? str(p[m.phone]) : undefined, website: m.website ? str(p[m.website]) : undefined, email: m.email ? str(p[m.email]) : undefined, area: q.area }));
  }
}
export class ApolloAdapter extends RemoteAdapter {
  readonly name = "apollo";
  async search(q: LeadQuery): Promise<Lead[]> {
    const payload = object(await this.request("https://api.apollo.io/api/v1/mixed_people/api_search", { method: "POST", headers: { "content-type": "application/json", "x-api-key": this.key("APOLLO_API_KEY") }, body: JSON.stringify({ q_keywords: q.query, person_locations: q.area ? [q.area] : [], page: 1, per_page: q.limit ?? 25 }) }));
    return rows(payload.people).map(p => ({ name: name(p.name ?? [p.first_name, p.last_name ?? p.last_name_obfuscated].filter(Boolean).join(" ")), source: this.name, area: [p.city, p.state].filter(Boolean).join(", ") || q.area, meta: { title: p.title, organization: p.organization } }));
  }
}
export interface CountyFileOptions extends AdapterOptions { file?: string; fieldMap?: { name: string; address?: string; area?: string; phone?: string } }
function parseCsv(text: string): string[][] {
  const result: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(cell); cell = ""; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(Boolean)) result.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (quoted) throw new VendorError("county-file: unclosed CSV quote");
  row.push(cell); if (row.some(Boolean)) result.push(row); return result;
}
export class CountyFileAdapter implements LeadAdapter {
  readonly name = "county-file";
  constructor(private options: CountyFileOptions = {}) {}
  async search(q: LeadQuery): Promise<Lead[]> {
    try {
      const file = q.file ?? this.options.file; if (!file) throw new VendorError("county-file: missing file");
      const data = parseCsv((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
      if (!data.length) throw new VendorError("county-file: empty file");
      const headers = data.shift()!.map(h => h.trim());
      const m = this.options.fieldMap ?? { name: "name", address: "address", area: "area", phone: "phone" };
      if (!headers.includes(m.name)) throw new VendorError("county-file: missing mapped name column");
      return data.map(values => {
        const get = (key?: string) => key ? values[headers.indexOf(key)] || undefined : undefined;
        return { name: name(get(m.name)), source: this.name, address: get(m.address), area: get(m.area), phone: get(m.phone) };
      }).filter(p => (!q.query || JSON.stringify(p).toLowerCase().includes(q.query.toLowerCase())) && (!q.area || p.area?.toLowerCase() === q.area.toLowerCase())).slice(0, q.limit);
    } catch (error) { if (error instanceof VendorError) throw error; throw new VendorError("county-file: cannot read CSV", { cause: error }); }
  }
}
export class StormFeedAdapter extends RemoteAdapter {
  readonly name = "storm-feed";
  async search(q: LeadQuery): Promise<Lead[]> {
    if (!q.area || !/^[a-z]{2}$/i.test(q.area)) throw new VendorError("storm-feed: area needs a two-letter state code");
    const area = q.area.toUpperCase();
    const payload = object(await this.request(`https://api.weather.gov/alerts/active?area=${area}`, { headers: { "User-Agent": `agentic-leads/${VERSION} (https://github.com/pooriaarab/agentic-leads)`, accept: "application/geo+json" } }));
    return rows(payload.features).slice(0, q.limit).map(f => { const p = object(f.properties); return { name: name(p.event), source: this.name, area, meta: { headline: p.headline, onset: p.onset } }; });
  }
}
export function defaultAdapters(): LeadAdapter[] {
  return [new GooglePlacesAdapter(), new ApifyAdapter({ actorId: process.env.APIFY_ACTOR_ID ?? "compass/crawler-google-places" }), new ApolloAdapter(), new CountyFileAdapter(), new StormFeedAdapter(), new TregAdapter()];
}
export function selectAdapters(adapters: LeadAdapter[], source = "all"): LeadAdapter[] {
  if (source === "all") return adapters;
  const selected = adapters.filter(a => a.name === source);
  if (!selected.length) throw new VendorError(`unknown source: ${source}`);
  return selected;
}
export function listSources(adapters: LeadAdapter[] = defaultAdapters()) {
  const keys: Record<string, string> = { "google-places": "GOOGLE_PLACES_API_KEY", apify: "APIFY_TOKEN", apollo: "APOLLO_API_KEY" };
  const optional: Record<string, string> = { treg: "TREG_TOKEN" };
  return adapters.map(a => {
    const env = keys[a.name] ?? optional[a.name];
    return { name: a.name, keyRequired: !!keys[a.name], keySet: env ? !!process.env[env]?.trim() : false };
  });
}
