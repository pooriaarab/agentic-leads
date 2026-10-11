import { VendorError } from "./core.js";
import type { AdapterOptions, Lead, LeadAdapter, LeadQuery } from "./leads.js";

export const TREG_BASE_URL = "https://treg.to";
export const TREG_TOKEN_ENV = "TREG_TOKEN";
export const TREG_ORG_ENV = "TREG_ORG";
export const TREG_DEFAULT_MAX_COST_USD = 1;

export interface TregOptions extends AdapterOptions { token?: string; org?: string; baseUrl?: string; maxCostUsd?: number }
export type TregCapability = "people" | "companies" | "signals" | "emails";
export interface TregAdapterOptions extends TregOptions { capability?: TregCapability; endpointId?: string; method?: string; query?: Record<string, string | number | boolean>; body?: unknown }
export interface TregPrice { id: string; usd: number | null; type: string; unit?: string; note?: string }
export interface CatalogHit { id: string; provider: string; name: string; method?: string; usd: number | null }
export interface TregCallRequest { method?: string; query?: Record<string, string | number | boolean>; body?: unknown }
export interface TregCall { result: unknown; costMicro: number; callId?: string; servedBy?: string }
export interface TregBalance { usd: number | null; micro: number | null }
export interface DoctorReport { tier: "token" | "anonymous"; catalog: { ok: boolean; error?: string }; balance: TregBalance & { error?: string } }

type Row = Record<string, unknown>;
function object(value: unknown, what: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VendorError(`treg: bad payload (${what}: expected object)`);
  return value as Row;
}
function rows(value: unknown, what: string): Row[] {
  if (!Array.isArray(value)) throw new VendorError(`treg: bad payload (${what}: expected array)`);
  return value.map(item => object(item, what));
}
function str(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function num(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function tokenOf(options: TregOptions = {}): string | undefined {
  const token = options.token ?? options.apiKey ?? process.env[TREG_TOKEN_ENV];
  return token?.trim() ? token.trim() : undefined;
}
function baseOf(options: TregOptions = {}): string { return (options.baseUrl ?? TREG_BASE_URL).replace(/\/+$/, ""); }
function headersOf(options: TregOptions = {}, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = tokenOf(options);
  if (token) headers["X-Treg-Token"] = token;
  const org = options.org ?? process.env[TREG_ORG_ENV];
  if (org?.trim()) headers["X-Treg-Org"] = org.trim();
  return headers;
}
async function tregFetch(url: string, init: RequestInit, options: TregOptions, what: string): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10000;
  try {
    const response = await (options.fetchFn ?? fetch)(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      let detail = "";
      try {
        const body: unknown = await response.json();
        if (typeof body === "string") detail = body;
        else if (body && typeof body === "object") {
          const row = body as Row;
          detail = str(row.detail) ?? str(row.message) ?? (row.detail && typeof row.detail === "object" ? str((row.detail as Row).message) ?? "" : "");
        }
      } catch { /* keep status only */ }
      throw new VendorError(`treg: ${what} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`, { status: response.status });
    }
    return response;
  } catch (error) {
    if (error instanceof VendorError) throw error;
    throw new VendorError(`treg: ${what} request failed`, { cause: error });
  }
}
async function getJson(url: string, options: TregOptions, what: string): Promise<unknown> {
  const response = await tregFetch(url, { headers: headersOf(options) }, options, what);
  try { return await response.json(); } catch (error) { throw new VendorError(`treg: bad payload (${what}: expected JSON)`, { cause: error }); }
}

export async function searchCatalog(query: string, options: TregOptions = {}): Promise<CatalogHit[]> {
  if (!query.trim()) throw new VendorError("treg: catalog search needs a query");
  const payload = object(await getJson(`${baseOf(options)}/catalog/search?q=${encodeURIComponent(query.trim())}`, options, "catalog search"), "catalog search");
  return rows(payload.results, "catalog search").map(hit => {
    const cost = object(hit.cost, "catalog price");
    const usd = cost.usd === null ? null : num(cost.usd);
    if (usd === undefined) throw new VendorError("treg: bad payload (catalog price: expected usd)");
    const id = str(hit.id);
    if (!id) throw new VendorError("treg: bad payload (catalog search: missing id)");
    return { id, provider: str(hit.provider) ?? "", name: str(hit.name) ?? id, method: str(hit.method), usd };
  });
}

export async function getEndpointPrice(endpointId: string, options: TregOptions = {}): Promise<TregPrice> {
  if (!endpointId.trim()) throw new VendorError("treg: price lookup needs an endpoint id");
  const payload = object(await getJson(`${baseOf(options)}/catalog/endpoints/${encodeURIComponent(endpointId.trim())}`, options, "price lookup"), "price lookup");
  const endpoint = object(payload.endpoint, "price lookup");
  const cost = object(endpoint.cost, "price lookup");
  const usd = cost.usd === null ? null : num(cost.usd);
  if (usd === undefined) throw new VendorError("treg: bad payload (price lookup: expected usd)");
  return { id: str(endpoint.id) ?? endpointId.trim(), usd, type: str(cost.type) ?? "unknown", unit: str(cost.unit), note: str(cost.note) };
}

function queryString(query: Record<string, string | number | boolean> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.append(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}
export async function callEndpoint(endpointId: string, request: TregCallRequest = {}, options: TregOptions = {}): Promise<TregCall> {
  if (!endpointId.trim()) throw new VendorError("treg: call needs an endpoint id");
  const maxCost = options.maxCostUsd ?? TREG_DEFAULT_MAX_COST_USD;
  const init: RequestInit = { method: request.method ?? (request.body === undefined ? "GET" : "POST"), headers: headersOf(options, { "X-Treg-Route-Max-Cost": String(maxCost) }) };
  if (request.body !== undefined) { (init.headers as Record<string, string>)["content-type"] = "application/json"; init.body = JSON.stringify(request.body); }
  const response = await tregFetch(`${baseOf(options)}/call/${endpointId.trim()}${queryString(request.query)}`, init, options, `call ${endpointId.trim()}`);
  let result: unknown;
  try { result = await response.json(); } catch (error) { throw new VendorError("treg: bad payload (call: expected JSON)", { cause: error }); }
  return { result, costMicro: num(Number(response.headers.get("X-Treg-Cost-Micro"))) ?? 0, callId: response.headers.get("X-Treg-Call-Id") ?? undefined, servedBy: response.headers.get("X-Treg-Served-By") ?? undefined };
}

export async function readBalance(options: TregOptions = {}): Promise<TregBalance> {
  if (!tokenOf(options)) throw new VendorError("treg: balance needs TREG_TOKEN");
  const me = object(await getJson(`${baseOf(options)}/auth/me`, options, "auth check"), "auth check");
  const orgId = num(me.org_id);
  if (orgId === undefined) throw new VendorError("treg: token carries no org");
  const balance = object(await getJson(`${baseOf(options)}/orgs/${orgId}/balance?limit=1`, options, "balance read"), "balance read");
  const micro = num(balance.balance_micro);
  if (micro === undefined) throw new VendorError("treg: bad payload (balance read: expected balance_micro)");
  return { usd: num(balance.balance_usd) ?? micro / 1_000_000, micro };
}

export async function readDoctor(options: TregOptions = {}): Promise<DoctorReport> {
  const report: DoctorReport = { tier: tokenOf(options) ? "token" : "anonymous", catalog: { ok: false }, balance: { usd: null, micro: null } };
  try {
    const response = await (options.fetchFn ?? fetch)(`${baseOf(options)}/meta`, { signal: AbortSignal.timeout(options.timeoutMs ?? 10000) });
    report.catalog = response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
  } catch (error) { report.catalog = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  if (report.tier === "anonymous") report.balance = { usd: null, micro: null, error: "anonymous tier carries no balance" };
  else {
    try { report.balance = await readBalance(options); }
    catch (error) { report.balance = { usd: null, micro: null, error: error instanceof Error ? error.message : String(error) }; }
  }
  return report;
}

export interface TregPreset { endpointId: string; build(q: LeadQuery): TregCallRequest; extract(result: unknown): Row[]; map(row: Row, q: LeadQuery): Lead }
function isDomain(text: string): boolean { return /^[^\s@]+\.[a-z]{2,}$/i.test(text.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0]); }
function domainOf(text: string): string { return text.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0]; }
function personName(p: Row): string | undefined {
  return str(p.name) ?? str(p.full_name) ?? ([str(p.first_name), str(p.last_name) ?? str(p.last_name_obfuscated)].filter(Boolean).join(" ") || undefined);
}
function outputOf(result: unknown): Row {
  const body = object(result, "call result");
  return body.output === undefined ? body : object(body.output, "call result");
}
export const TREG_PRESETS: Record<TregCapability, TregPreset> = {
  people: {
    endpointId: "treg.people.search",
    build: q => ({ method: "POST", body: { q: q.query, ...(q.area ? { location: q.area } : {}), ...(q.limit ? { limit: q.limit } : {}) } }),
    extract: result => rows(outputOf(result).people, "people search"),
    map: (p, q) => {
      const name = personName(p);
      if (!name) throw new VendorError("treg: bad payload (people search: missing name)");
      return { name, source: "treg", email: str(p.email), area: str(p.location) ?? str(p.country) ?? q.area, meta: { title: str(p.title) ?? str(p.headline), organization: p.organization ?? p.company } };
    },
  },
  companies: {
    endpointId: "treg.companies.enrich",
    build: q => ({ method: "POST", body: isDomain(q.query) ? { domain: domainOf(q.query) } : { name: q.query } }),
    extract: result => { const out = outputOf(result); return out.name == null ? [] : [out]; },
    map: (c, q) => ({ name: str(c.name) ?? q.query, source: "treg", website: str(c.website) ?? (str(c.domain) ? `https://${c.domain}` : undefined), area: str(c.location) ?? q.area, meta: { industry: str(c.industry), employees: str(c.employees), founded: num(c.founded), description: str(c.description) } }),
  },
  signals: {
    endpointId: "treg.companies.jobs.search",
    build: q => ({ method: "POST", body: { ...(isDomain(q.query) ? { domain: domainOf(q.query) } : { name: q.query }), ...(q.limit ? { limit: q.limit } : {}) } }),
    extract: result => rows(outputOf(result).jobs, "signals search"),
    map: (j, q) => {
      const title = str(j.title) ?? str(j.name);
      if (!title) throw new VendorError("treg: bad payload (signals search: missing title)");
      return { name: title, source: "treg", website: str(j.url) ?? str(j.apply_url), area: str(j.location) ?? q.area, meta: { company: j.company ?? j.company_name } };
    },
  },
  emails: {
    endpointId: "hunter.companies.emails",
    build: q => ({ method: "GET", query: { ...(isDomain(q.query) ? { domain: domainOf(q.query) } : { company: q.query }), ...(q.limit ? { limit: q.limit } : {}) } }),
    extract: result => { const body = object(result, "email search"); return rows((body.data === undefined ? body : object(body.data, "email search")).emails, "email search"); },
    map: (e, q) => {
      const email = str(e.value);
      if (!email) throw new VendorError("treg: bad payload (email search: missing value)");
      return { name: personName(e) ?? email, source: "treg", email, area: q.area, meta: { position: str(e.position), type: str(e.type) } };
    },
  },
};
function genericRows(result: unknown): Row[] {
  const body = object(result, "call result");
  const scope = body.output === undefined ? body : object(body.output, "call result");
  for (const value of Object.values(scope)) {
    if (Array.isArray(value) && value.length && value.every(item => item && typeof item === "object" && !Array.isArray(item))) return value as Row[];
  }
  return [scope];
}
function genericLead(row: Row, q: LeadQuery): Lead {
  const name = personName(row) ?? str(row.title) ?? str(row.headline);
  if (!name) throw new VendorError("treg: bad payload (call result: missing name)");
  return { name, source: "treg", website: str(row.website) ?? str(row.url), email: str(row.email), area: str(row.location) ?? q.area, meta: { title: str(row.title) } };
}

export class TregAdapter implements LeadAdapter {
  readonly name = "treg";
  constructor(private options: TregAdapterOptions = {}) {}
  async search(q: LeadQuery): Promise<Lead[]> {
    const capability = this.options.capability ?? "people";
    const preset = TREG_PRESETS[capability];
    if (!preset) throw new VendorError(`treg: unknown capability "${capability}"`);
    const endpointId = this.options.endpointId ?? preset.endpointId;
    const maxCost = this.options.maxCostUsd ?? TREG_DEFAULT_MAX_COST_USD;
    const price = await getEndpointPrice(endpointId, this.options);
    if (price.usd === null) throw new VendorError(`treg: ${endpointId} publishes no price`);
    if (price.usd > maxCost) throw new VendorError(`treg: ${endpointId} at $${price.usd} tops the $${maxCost} cap`);
    const custom = endpointId !== preset.endpointId;
    const request = this.options.method || this.options.query || this.options.body !== undefined
      ? { method: this.options.method, query: this.options.query, body: this.options.body }
      : preset.build(q);
    const call = await callEndpoint(endpointId, request, this.options);
    const rows = custom ? genericRows(call.result) : preset.extract(call.result);
    const leads = rows.map(row => custom ? genericLead(row, q) : preset.map(row, q));
    return leads.map(lead => ({ ...lead, meta: { ...lead.meta, treg: { callId: call.callId, costMicro: call.costMicro, servedBy: call.servedBy } } }));
  }
}
