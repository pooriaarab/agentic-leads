# Agentic leads

Find prospects from places, files, and feeds.

Build a call list for a local service area.
Enrich a contact list with public titles.
Watch public alert feeds for an area.

## Start

Use Node.js 18 or later. Install and check the package:

```sh
npm install
npm run build
npm run typecheck
npm test
node dist/cli.js --help
node dist/cli.js sources
node dist/cli.js search --query "services" --area CA --source google-places --limit 5
node dist/cli.js search --query "Sample" --source county-file --file examples/county.csv --live
node dist/cli.js costs
```

Search defaults to a dry run. It calls no source and records no cost.
Add `--live` to call sources. Select one with `--source`, or use `all`.
Each source returns its own success or error. Failed sources cause CLI exit 1.
Bad CLI usage exits 2. Cost entries count leads, not currency.
Reports stay in the current process and reset when it exits.

## Sources

| Source | Setup | Result |
| --- | --- | --- |
| google-places | GOOGLE_PLACES_API_KEY | Names, addresses, phones, websites |
| apify | APIFY_TOKEN; APIFY_ACTOR_ID selects an actor | Mapped dataset items |
| apollo | APOLLO_API_KEY | People, public titles, organizations, locations |
| county-file | --file or constructor file | Local CSV records |
| storm-feed | --area with a two-letter state code | Active NWS events and headlines |

Keys also accept `apiKey` in adapter constructors.
Network adapters accept `fetchFn` and `timeoutMs`.
Storm feeds need no key and send a User-Agent.
Apollo search does not promise email addresses or contact enrichment by email.
Alerts describe events, not people or businesses.
Google Places accepts limits from 1 to 20.

The sample CSV uses `name,address,area,phone`.
CountyFileAdapter accepts a fieldMap for different column names.
It filters rows by query text and area, then applies the limit.
Quoted commas, escaped quotes, and multiline fields parse as CSV.

## SDK

```js
import { findLeads, CountyFileAdapter, ApifyAdapter } from "./dist/index.js";

const preview = await findLeads({ query: "Sample" }, {
  adapters: [new CountyFileAdapter({ file: "examples/county.csv" })],
  dryRun: true,
});
console.log(preview);

// Maps actor example. Supply APIFY_TOKEN before a live search.
const maps = new ApifyAdapter({
  actorId: "compass/crawler-google-places",
  input: { searchStringsArray: ["services in CA"], maxCrawledPlacesPerSearch: 5 },
  fieldMap: { name: "title", address: "address", phone: "phone", website: "website" },
});
console.log(maps.name);
```

ApifyAdapter requires actorId. Inputs depend on the actor.
The CLI defaults to the maps actor above. Set APIFY_ACTOR_ID to change it.
Apify polls the run, rejects failed runs, and reads the completed dataset.
Use pollIntervalMs and pollTimeoutMs to control polling.

findLeads accepts adapters, guards, logger, and dryRun.
It checks guards before any adapter call and fans out live searches.
Each live adapter call records a search entry, including zero units on failure.
The SDK defaults to live mode; set dryRun true to preview.
The package re-exports the frozen agentic-core API.

## MCP and worker

The `mcp` command and `agentic-leads-mcp` bin serve stdio MCP.
Use search_leads with query, area, source or sources, limit, file, and dryRun.
DryRun defaults to true. list_sources shows key status.
get_cost_report reads session entries and unit totals.
.mcp.json configures agentic-leads through npx.

The worker serves GET /health and POST /search.
Send query, area, source, limit, file, and live in a JSON body.
It previews unless live is true. Local files require a Node filesystem.

## License

MIT. See LICENSE.
