import express from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { registerCoastTools, coastConfigured } from './coast.js';
import { registerFleetioTools, fleetioConfigured } from './fleetio.js';

const SERVER_INSTRUCTIONS =
  'Kin Home fleet data connector (read-only): Coast fuel cards and Fleetio / Ford Pro. ' +
  'Coast: coast_list and coast_get (purchases are the fuel transactions; also cards, people/drivers, vehicles, locations). ' +
  'Fleetio / Ford Pro: fleetio_list and fleetio_get (vehicles, fuel entries, odometer readings, work orders, issues, faults, inspections, contacts). ' +
  'Field names differ by system and are not documented here, so for any new question first list a few rows (limit 5) to see the real field names, then use filters and the summary option (groupBy + sum) to total things up. ' +
  'Always narrow by a date range when listing transactions or fill-ups. Do not guess field names or IDs; if something cannot be determined, say what you checked and what you are unsure about. ' +
  'Coast and Fleetio are separate systems, so a vehicle or driver may be named differently in each; match on name, VIN or unit number and say when a match is uncertain.';

const PORT = process.env.PORT || 3000;

// MCP_SHARED_SECRETS holds one or more named secrets, e.g.
//   brady:3f9a...,sarah:7c2d...
// so each person gets their own key and can be revoked individually by
// removing their "name:secret" pair from the env var and saving (Railway
// redeploys automatically on an env var change). Falls back to the older
// single-secret MCP_SHARED_SECRET var if present, for compatibility.
const SHARED_SECRETS = parseSharedSecrets(process.env.MCP_SHARED_SECRETS);
if (process.env.MCP_SHARED_SECRET) {
  SHARED_SECRETS.set(process.env.MCP_SHARED_SECRET, 'default');
}

function parseSharedSecrets(raw) {
  const map = new Map(); // secret -> name
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const sep = entry.indexOf(':');
    if (sep === -1) continue;
    const name = entry.slice(0, sep).trim();
    const secret = entry.slice(sep + 1).trim();
    if (name && secret) map.set(secret, name);
  }
  return map;
}

if (SHARED_SECRETS.size === 0) {
  console.warn(
    '[fleet-mcp-wrapper] No shared secrets configured (MCP_SHARED_SECRETS) — the /mcp endpoint is open to anyone who finds the URL. ' +
      'Set MCP_SHARED_SECRETS before deploying for real use.'
  );
}

const app = express();

// Some MCP clients probe with an OPTIONS preflight, and a browser-hosted
// client enforces CORS — allow it. The shared-secret check below still
// protects the endpoint; this only controls who's allowed to *ask*.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Accept, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '2mb' }));

// Health check — useful for the hosting platform and for a quick manual check.
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'fleet-mcp-wrapper', coast: coastConfigured(), fleetio: fleetioConfigured() });
});

// Gate the MCP endpoint behind one of the named shared secrets. Give each
// person's Claude custom connector their own value as an
// `Authorization: Bearer <their secret>` request header
// (Add custom connector -> No sign-in -> Request headers).
app.use('/mcp', (req, res, next) => {
  if (SHARED_SECRETS.size === 0) return next();
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
  const name = token ? SHARED_SECRETS.get(token) : undefined;
  if (name) {
    req.connectorUser = name;
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
});

function buildServer() {
  const server = new McpServer({ name: 'kin-fleet', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS });
  // Every tool in this wrapper is read-only. Declare that on each one so Claude
  // can group them as "read-only" in its tool-permission settings.
  const register = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) =>
    register(
      name,
      { ...config, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true, ...(config.annotations || {}) } },
      handler
    );
  registerCoastTools(server); // no-op unless COAST_API_KEY is set
  registerFleetioTools(server); // no-op unless FLEETIO_API_KEY is set
  return server;
}

// Stateless: a fresh server + transport for every request (the pattern the
// MCP SDK recommends), so no state is shared between requests or users.
app.post('/mcp', async (req, res) => {
  try {
    const server = buildServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[fleet-mcp-wrapper] MCP request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

// No server-initiated streams or sessions in stateless mode.
const methodNotAllowed = (req, res) => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

app.listen(PORT, () => {
  console.log(`fleet-mcp-wrapper listening on port ${PORT}`);
});
