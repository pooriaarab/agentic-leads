export { VERSION } from "./version.js";
export {
  defineBrand,
  createLogger,
  GuardError,
  VendorError,
  createGuards,
  LocalRouterAdapter,
  HttpRouterAdapter,
  recordCost,
  getCostReport,
  resetCosts,
  createDryRunResult,
  dispatchText,
  summarizeText,
} from "./core.js";
export type {
  BrandConfig,
  LogLevel,
  Logger,
  LoggerOptions,
  CapsConfig,
  QuietHoursConfig,
  GuardsConfig,
  Guards,
  DispatchReceipt,
  RouterAdapter,
  HttpRouterOptions,
  CostEntry,
  CostReport,
  DispatchOptions,
  DispatchResult,
  TopWord,
  TextSummary,
  SummarizeOptions,
} from "./core.js";

import { defineBrand, type BrandConfig } from "./core.js";
import { VERSION } from "./version.js";

export * from "./leads.js";
export * from "./treg.js";
export const DEFAULT_BRAND: BrandConfig = defineBrand({
  name: "Agentic leads", command: "agentic-leads",
  description: "Find prospects from places, files, and feeds.",
  keywords: ["lead-generation", "prospecting", "apollo", "treg", "agentic-suite", "claude-code", "codex", "cli", "mcp"],
  version: VERSION,
});
