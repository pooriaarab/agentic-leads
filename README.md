# agentic-leads

[![npm version](https://img.shields.io/npm/v/agentic-leads)](https://www.npmjs.com/package/agentic-leads) [![Downloads/month](https://img.shields.io/npm/dm/agentic-leads)](https://www.npmjs.com/package/agentic-leads) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package and API types](https://www.npmjs.com/package/agentic-leads)

agentic-leads is an open-source prospecting adapter package for developers searching business data, local CSV records, enrichment endpoints, and weather alerts.

## Install

```sh
npm install agentic-leads
```

Requires Node.js 18 or later. Includes TypeScript types and three direct runtime dependencies.

## Find your first local lead

Create a CSV file, then preview the search before reading it:

```sh
printf 'name,address,area,phone\nSample Services,1 Main St,CA,555-0100\n' > leads.csv
npx agentic-leads search --query Sample --source county-file --file leads.csv
npx agentic-leads search --query Sample --source county-file --file leads.csv --live
```

The preview prints `dryRun: true`. The live local search prints `ok: true` and a lead named `Sample Services`.
This example needs no credentials and makes no network request.

```js
import { findLeads, CountyFileAdapter, getCostReport } from "agentic-leads";
const options = { adapters: [new CountyFileAdapter({ file: "leads.csv" })] };
console.log(await findLeads({ query: "Sample" }, { ...options, dryRun: true }));
console.log(await findLeads({ query: "Sample" }, { ...options, dryRun: false }));
console.log(getCostReport());
```

## How it works

```text
SDK / CLI / MCP -> selected sources -> per-source leads OR error
```

## Source coverage

| Source | Status and result | Setup |
| --- | --- | --- |
| Google Places | Implemented HTTP; business names, addresses, phones, websites | `GOOGLE_PLACES_API_KEY` |
| Apify | Implemented HTTP + polling; mapped actor dataset | `APIFY_TOKEN`; optional `APIFY_ACTOR_ID` |
| Apollo | Implemented HTTP; people, titles, organizations | `APOLLO_API_KEY` |
| Local county file | CSV; filtered local records | `--file` or constructor `file` |
| National Weather Service | Implemented HTTP; active alerts, not contacts | `--area` with a two-letter state code |
| Treg | Implemented HTTP; people, companies, job signals, emails | Optional `TREG_TOKEN`, `TREG_ORG` |

The registry contains six sources. Remote integration credential checks are pending in this README review; local CSV behavior is tested.
Export keys in your shell; the package does not load `.env` files. Key presence does not prove account access.

## Features and runtime surfaces

- CLI commands: `search`, `sources`, `costs`, `doctor`, `mcp`, `help`, `version`. Search previews unless `--live` is set.
- Model Context Protocol (MCP): `search_leads`, `list_sources`, `get_cost_report`; start `npx agentic-leads mcp`.
- MCP accepts `source` or `sources`; CLI uses `--source`. The default selection is all six sources.
- CSV defaults to `name,address,area,phone`; constructor `fieldMap` supports other columns. Quoted and multiline cells are supported.
- Apify requires SDK `actorId`; CLI defaults to `compass/crawler-google-places`. Configure actor-specific `input` and `fieldMap` when needed.
- Treg presets: `people`, `companies`, `signals`, `emails`; the email preset uses `hunter.companies.emails` through Treg.
- Use `new TregAdapter({ capability: "companies" })` or `"signals"` for company enrichment or job signals.
- Treg exports `searchCatalog`, `getEndpointPrice`, `callEndpoint`, `readBalance`, and `readDoctor`; CLI `doctor` checks reachability and token balance.

## Behavior limits and status

The SDK defaults to live searches. Set `dryRun: true` explicitly for previews; MCP and CLI preview by default.
HTTP requests default to 10 seconds without automatic retries. Apify polling defaults to a 120-second deadline.
Apollo search does not return email fields. Weather alerts describe events; they are not business or person leads.
TregAdapter rejects missing prices and prices above `maxCostUsd` (default $1); calls send that ceiling as a request header.
Direct `callEndpoint` sends the ceiling header without a local price lookup. Server enforcement and endpoint access depend on Treg.
Costs count returned leads, not currency, and remain process-local; Treg metadata also exposes reported micro-costs.
The repository includes a self-hosted Worker with health and search routes. Local CSV access requires a Node filesystem.
Version 0.2.0 APIs can change. No managed prospect database is provided. Support uses repository issues; access may require permission.

## Contributing and license

Preview searches first, respect guard denials, report source failures, and read the session cost report after live work.
Run `npm run build && npm run typecheck && npm test` before pushing. The `release` branch publishes new versions.
License: MIT.
