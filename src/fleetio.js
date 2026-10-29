// Fleetio / Ford Pro API (https://developer.fleetio.com). READ-ONLY: fleetioRequest()
// only ever sends GET, and only to the resources listed below.

import { z } from 'zod';
import { safe, summarize, pickFields } from './common.js';

const BASE = () => (process.env.FLEETIO_BASE_URL || 'https://fleetio.fordpro.com/api').replace(/\/$/, '');

export const fleetioConfigured = () => Boolean(process.env.FLEETIO_API_KEY);

// resource name == API path segment
const RESOURCES = [
  'vehicles',
  'fuel_entries',
  'meter_entries',
  'contacts',
  'issues',
  'work_orders',
  'service_entries',
  'faults',
  'vehicle_assignments',
  'vehicle_status_changes',
  'vehicle_statuses',
  'vehicle_types',
  'submitted_inspection_forms',
  'inspection_schedules',
  'vehicle_renewal_reminders',
  'expense_entries',
  'places',
  'groups',
  'labels',
  'vendors',
  'parts',
  'equipment',
  'service_tasks',
  'fuel_types',
  'purchase_orders'
];

export async function fleetioRequest(resource, { id, query = {} } = {}) {
  if (!RESOURCES.includes(resource)) throw new Error(`Blocked: ${resource} is not an allowed read-only Fleetio resource.`);
  const url = new URL(`${BASE()}/${resource}${id ? '/' + encodeURIComponent(id) : ''}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = {
    Authorization: `Token ${process.env.FLEETIO_API_KEY}`,
    Accept: 'application/json'
  };
  if (process.env.FLEETIO_ACCOUNT_TOKEN) headers[process.env.FLEETIO_ACCOUNT_TOKEN_HEADER || 'Account-Token'] = process.env.FLEETIO_ACCOUNT_TOKEN;
  const res = await fetch(url, { method: 'GET', headers });
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (!res.ok) {
    const err = new Error(`Fleetio API GET /${resource}${id ? '/' + id : ''} -> ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Find the array of records in a list response whatever the envelope is called.
function recordsOf(body) {
  if (Array.isArray(body)) return body;
  for (const k of ['records', 'data', 'results', 'items']) if (Array.isArray(body?.[k])) return body[k];
  const firstArray = Object.values(body || {}).find(Array.isArray);
  return firstArray || [];
}

const resourceEnum = z.enum(RESOURCES);

export function registerFleetioTools(server) {
  if (!fleetioConfigured()) return;

  server.registerTool(
    'fleetio_list',
    {
      title: 'List Fleetio (Ford Pro) records',
      description:
        'Read-only list from Fleetio / Ford Pro. resource: vehicles, fuel_entries (fill-ups), meter_entries (odometer), contacts (drivers), issues, work_orders, service_entries, faults, vehicle_assignments, vehicle_status_changes, submitted_inspection_forms, expense_entries, places, groups, vendors, parts, equipment, and more. ' +
        'filters: [{field, op, value}] become Fleetio filter[field][op]=value (op defaults to eq; others include like, gt, gte, lt, lte). Example: fuel_entries for one vehicle: [{field:"vehicle_id", value:"123"}]. ' +
        'Start with a small list (limit 5) to see the real field names, then use summary {groupBy, sum} to total fuel cost or gallons by vehicle. Set all=true to page through up to maxPages pages.',
      inputSchema: {
        resource: resourceEnum,
        filters: z
          .array(z.object({ field: z.string(), op: z.string().optional(), value: z.union([z.string(), z.number(), z.boolean()]) }))
          .optional(),
        all: z.boolean().optional().describe('Fetch multiple pages (default false = first page only).'),
        maxPages: z.number().int().min(1).max(20).optional().describe('Pages to fetch when all=true (100 rows each, default 5).'),
        fields: z.array(z.string()).optional().describe('Only return these field paths per row.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows to show in the result (default 25; ignored when summary is set).'),
        summary: z
          .object({
            groupBy: z.string().optional().describe('Field path to group by, e.g. "vehicle_name".'),
            sum: z.string().optional().describe('Numeric field path to add up, e.g. "total_amount".')
          })
          .optional()
      }
    },
    async ({ resource, filters = [], all = false, maxPages = 5, fields, limit = 25, summary }) =>
      safe(async () => {
        const query = {};
        for (const f of filters) query[`filter[${f.field}][${f.op || 'eq'}]`] = f.value;
        const rows = [];
        let cursor;
        let pages = 0;
        let envelope;
        do {
          const body = await fleetioRequest(resource, { query: { ...query, per_page: all || summary ? 100 : Math.min(limit, 100), start_cursor: cursor } });
          envelope = body && !Array.isArray(body) ? { next_cursor: body.next_cursor, estimated_remaining_count: body.estimated_remaining_count } : {};
          rows.push(...recordsOf(body));
          cursor = envelope.next_cursor || undefined;
          pages += 1;
        } while (cursor && (all || summary) && pages < maxPages);
        const out = { resource, fetched: rows.length, moreAvailable: Boolean(cursor) || undefined, estimatedRemaining: envelope.estimated_remaining_count };
        if (summary?.groupBy || summary?.sum) out.summary = summarize(rows, summary);
        if (!summary) out.rows = rows.slice(0, limit).map((r) => pickFields(r, fields));
        else out.sampleRow = rows[0];
        if (cursor) out.note = 'More records exist beyond what was fetched; raise maxPages or add filters (for example a date range).';
        return out;
      })
  );

  server.registerTool(
    'fleetio_get',
    {
      title: 'Get one Fleetio record',
      description: 'Read-only: fetch a single Fleetio record by ID (a vehicle, work order, issue, fuel entry, etc.).',
      inputSchema: { resource: resourceEnum, id: z.string() }
    },
    async ({ resource, id }) => safe(async () => fleetioRequest(resource, { id }))
  );
}
