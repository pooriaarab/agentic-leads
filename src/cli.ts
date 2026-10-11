#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getCostReport, GuardError, VendorError } from "./core.js";
import { defaultAdapters, findLeads, listSources, selectAdapters, type LeadAdapter, type LeadQuery } from "./leads.js";
import { DEFAULT_BRAND } from "./index.js";
import { VERSION } from "./version.js";
export class UsageError extends Error { constructor(message: string) { super(message); this.name = "UsageError"; } }
export type CliCommand = "search" | "sources" | "costs" | "doctor" | "mcp" | "help" | "version";
export interface CliRequest extends LeadQuery { command: CliCommand; dryRun: boolean; source: string }
export function parseArgs(argv: string[]): CliRequest {
  const args = [...argv]; const first = args.shift() ?? "help";
  const command = first === "--help" || first === "-h" ? "help" : first === "--version" || first === "-V" ? "version" : first;
  if (!["search", "sources", "costs", "doctor", "mcp", "help", "version"].includes(command)) throw new UsageError(`unknown command "${first}"`);
  const request: CliRequest = { command: command as CliCommand, query: "", dryRun: true, source: "all" };
  while (args.length) {
    const flag = args.shift()!;
    if (command !== "search") throw new UsageError(`unknown flag "${flag}"`);
    if (flag === "--live") { request.dryRun = false; continue; }
    if (!["--query", "--area", "--source", "--limit", "--file"].includes(flag)) throw new UsageError(`unknown flag "${flag}"`);
    const value = args.shift(); if (!value || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (flag === "--limit") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw new UsageError("--limit needs a positive integer");
      request.limit = Number(value);
    } else if (flag === "--query") request.query = value;
    else if (flag === "--area") request.area = value;
    else if (flag === "--source") request.source = value;
    else request.file = value;
  }
  if (command === "search" && !request.query.trim()) throw new UsageError("search needs --query");
  if (command === "search" && !defaultAdapters().some(a => a.name === request.source) && request.source !== "all") throw new UsageError(`unknown source: ${request.source}`);
  return request;
}
export interface CliIo { out(line: string): void; err(line: string): void; adapters?: LeadAdapter[]; fetchFn?: typeof fetch }
function helpText(): string {
  return `${DEFAULT_BRAND.name} ${VERSION}
${DEFAULT_BRAND.description}

Usage: agentic-leads <command> [flags]

Commands:
  search --query <q> [--area <a>] [--source <name|all>]
         [--limit <n>] [--file <p>] [--live]
  sources   List sources and key status.
  costs     Print session cost totals.
  doctor    Check catalog reach, token tier, and balance.
  mcp       Start the MCP server on stdio.
  help      Print this help.
  version   Print the version.

Search defaults to a dry run with no vendor calls.
Flags: --help, -h; --version, -V`;
}
export async function runCli(argv: string[], io: CliIo = { out: console.log, err: console.error }): Promise<number> {
  let request: CliRequest;
  try { request = parseArgs(argv); } catch (error) { io.err(error instanceof Error ? error.message : String(error)); io.err('Run "agentic-leads --help" for usage.'); return 2; }
  try {
    const adapters = io.adapters ?? defaultAdapters();
    switch (request.command) {
      case "help": io.out(helpText()); return 0;
      case "version": io.out(VERSION); return 0;
      case "sources": io.out(JSON.stringify(listSources(adapters))); return 0;
      case "costs": io.out(JSON.stringify(getCostReport())); return 0;
      case "doctor": { const { readDoctor } = await import("./treg.js"); io.out(JSON.stringify(await readDoctor({ fetchFn: io.fetchFn }))); return 0; }
      case "mcp": { const { startMcp } = await import("./mcp.js"); await startMcp({ adapters }); return 0; }
      case "search": {
        const { query, area, limit, file } = request;
        const result = await findLeads({ query, area, limit, file }, { adapters: selectAdapters(adapters, request.source), dryRun: request.dryRun });
        io.out(JSON.stringify(result)); return !result.dryRun && result.results.some(r => !r.ok) ? 1 : 0;
      }
    }
  } catch (error) {
    if (error instanceof GuardError || error instanceof VendorError || error instanceof UsageError) { io.err(`${error.name}: ${error.message}`); return 1; }
    throw error;
  }
}
function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      // Exit nonzero at once. On zero, fall off the end so a running
      // server (mcp) keeps its stdio handles open. Plain commands
      // hold no handles and exit 0 on their own.
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
