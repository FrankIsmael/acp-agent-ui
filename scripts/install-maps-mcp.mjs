/**
 * Registers Maps Grounding Lite (Google's remote MCP, `https://mapstools.googleapis.com/mcp`)
 * as an HTTP extension in this client's database. Nothing is installed locally: the server is run
 * by Google, and the agent calls it directly using the key in `X-Goog-Api-Key`.
 *
 * Tools: search_places, lookup_weather, compute_routes, resolve_names, resolve_maps_urls.
 * The `.agents/skills/trip-planner` skill tells the agent how to combine them.
 *
 *   node --env-file=.env scripts/install-maps-mcp.mjs
 *
 * Variables: GM_MCP_KEY (or GM_DEMO_KEY if not provided), ACP_EXTENSIONS_DB (optional).
 * After: **new thread** — the currently open thread will not have the extension.
 */
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const NAME = 'google-maps';
const URL_MCP = 'https://mapstools.googleapis.com/mcp';
const DESCRIPTION =
  'Google Maps Grounding Lite: access capabilities for places, weather, and routes, and to resolve location names and Google Maps URLs to Place IDs';

// Separate key for the server if available: the GM_DEMO_KEY also goes to the browser.
const key = process.env.GM_MCP_KEY || process.env.GM_DEMO_KEY;
if (!key) {
  console.error('[maps] missing GM_MCP_KEY o GM_DEMO_KEY in the environment');
  process.exit(1);
}

// Check the key before saving it: tools/list responds even if the key is bad, so
// we test it with a real and cheap API call.
const response = await fetch(URL_MCP, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-goog-api-key': key,
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'lookup_weather',
      arguments: { location: { address: 'Ciudad de México' } },
    },
  }),
  signal: AbortSignal.timeout(20_000),
});
const body = await response.json().catch(() => null);
if (!response.ok || !body?.result || body.result.isError) {
  console.error(
    `[maps] Grounding Lite rejected the key (${response.status}):`,
    JSON.stringify(body?.result?.content ?? body?.error ?? body).slice(0, 300),
  );
  process.exit(1);
}

const dbPath = process.env.ACP_EXTENSIONS_DB || '.data/extensions.db';
const db = new DatabaseSync(resolve(dbPath));
db.exec('PRAGMA busy_timeout = 5000;');
const headers = JSON.stringify([{ name: 'X-Goog-Api-Key', value: key }]);
const exists = db.prepare('SELECT id FROM extensions WHERE name = ?').get(NAME);
if (exists) {
  db.prepare(
    "UPDATE extensions SET transport = 'http', url = ?, headers = ?, description = ?, enabled = 1 WHERE name = ?",
  ).run(URL_MCP, headers, DESCRIPTION, NAME);
  console.log(`[maps] extension \`${NAME}\` updated in`, dbPath);
} else {
  db.prepare(
    `INSERT INTO extensions (id, name, transport, command, args, url, headers, env, enabled, created_at, description)
    VALUES (?, ?, 'http', NULL, '[]', ?, ?, '[]', 1, ?, ?)`,
  ).run(randomUUID(), NAME, URL_MCP, headers, Date.now(), DESCRIPTION);
  console.log(`[maps] extension \`${NAME}\` recorded in`, dbPath);
}
db.close();
console.log(
  `[maps] ready. Opens NEW THREAD: the opened doesn't see the extension`,
);
