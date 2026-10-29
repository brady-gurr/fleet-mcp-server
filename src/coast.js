// Coast fuel card API (https://docs.coastpay.com/openapi/v2/coast-api). READ-ONLY:
// coastRequest() only ever sends GET, and only to the resources listed below.

import { z } from 'zod';
import { safe, summarize, pickFields } from './common.js';

const BASE = () => (process.env.COAST_BASE_URL || 'https://public.coastpay.com').replace(/\/$/, '');

export const coastConfigured = () => Boolean(process.env.COAST_API_KEY);

// resource name -> API path
const RESOURCES = {
  purchases: '/v2/transactions/purchases', // card purchases (fuel transactions)
  credits: '/v2/transactions/credits',
  fees: '/v2/transactions/fees',
  payments: '/v2/transactions/payments',
  cards: '/v2/cards',
  people: '/v2/people',
  vehicles: '/v2/vehicles',
  locations: '/v2/locations',
  departments: '/v2/departments',
  policies: '/v2/policies',
  roles: '/v2/roles',
  merchant_brands: '/v2/merchant-brands',
  merchant_locations: '/v2/merchant-locations',
  merchant_categories: '/v2/merchant-categories'
};

export async function coastRequest(path, query = {}, attempt = 0) {
  if (!Object.values(RESOURCES).some((p) => path === p || path.startsWith(p + '/'))) {
    throw new Error(`Blocked: ${path} is not an allowed read-only Coast path.`);
  }
  const url = new URL(BASE() + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${process.env.COAST_API_KEY}`, Accept: 'application/json' } });
  if (res.status === 429 && attempt < 2) {
    const wait = Math.min(10, Number(res.headers.get('retry-after') || res.headers.get('x-retry-after') || 2));
    await new Promise((r) => setTimeout(r, wait * 1000));
    return coastRequest(path, query, attempt + 1);
  }
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (!res.ok) {
    const err = new Error(`Coast API GET ${path} -> ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

const resourceEnum = z.enum(Object.keys(RESOURCES));
const summaryShape = z.object({
  groupBy: z.string().optional().describe('Field path to group by, e.g. "assignedVehicle.name" (look at a few rows first to see real field names).'),
  sum: z.string().optional().describe('Numeric field path to add up, e.g. "amount".')
});

export function registerCoastTools(server) {
  if (!coastConfigured()) return;

  server.registerTool(
    'coast_list',
    {
      title: 'List Coast records',
      description:
        'Read-only list from Coast (fuel cards). resource: purchases (fuel transactions), credits, fees, payments, cards, people (drivers), vehicles, locations, departments, policies, roles, merchant_brands, merchant_locations, merchant_categories. ' +
        'query holds Coast filters exactly as the API names them, e.g. for purchases: completedStartingAt / completedEndingBefore (dates), assignedPersonId, assignedVehicleId, cardId, merchantBrandId, flagStatus, status; for cards: personId, vehicleId, status, last4; for people: email, active, departmentId. ' +
        'Start with a small list (limit 5) to see the real field names, then use summary {groupBy, sum} to total spend by vehicle, driver, merchant, etc. Set all=true to page through up to maxPages pages.',
      inputSchema: {
        resource: resourceEnum,
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        all: z.boolean().optional().describe('Fetch multiple pages (default false = first page only).'),
        maxPages: z.number().int().min(1).max(20).optional().describe('Pages to fetch when all=true (100 rows each, default 5).'),
        fields: z.array(z.string()).optional().describe('Only return these field paths per row.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows to show in the result (default 25; ignored when summary is set).'),
        summary: summaryShape.optional()
      }
    },
    async ({ resource, query = {}, all = false, maxPages = 5, fields, limit = 25, summary }) =>
      safe(async () => {
        // Coast wants full date-times; accept plain YYYY-MM-DD too.
        for (const [k, v] of Object.entries(query)) {
          if (/(StartingAt|EndingBefore)$/.test(k) && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) query[k] = `${v}T00:00:00Z`;
        }
        const rows = [];
        let token;
        let totalCount;
        let pages = 0;
        do {
          const data = await coastRequest(RESOURCES[resource], { ...query, pageSize: all || summary ? 100 : Math.min(limit, 100), nextPageToken: token });
          const batch = Array.isArray(data) ? data : data?.data || [];
          rows.push(...batch);
          totalCount = data?.totalCount ?? totalCount;
          token = Array.isArray(data) ? undefined : data?.nextPageToken || undefined;
          pages += 1;
        } while (token && (all || summary) && pages < maxPages);
        const out = { resource, fetched: rows.length, totalCount, moreAvailable: Boolean(token) || undefined };
        if (summary?.groupBy || summary?.sum) out.summary = summarize(rows, summary);
        if (!summary) out.rows = rows.slice(0, limit).map((r) => pickFields(r, fields));
        else out.sampleRow = rows[0];
        if (token) out.note = 'More records exist beyond what was fetched; raise maxPages or narrow the date range.';
        return out;
      })
  );

  server.registerTool(
    'coast_get',
    {
      title: 'Get one Coast record',
      description: 'Read-only: fetch a single Coast record by ID (a purchase, card, person, vehicle, location, etc.).',
      inputSchema: { resource: resourceEnum, id: z.string() }
    },
    async ({ resource, id }) =>
      safe(async () => {
        return coastRequest(`${RESOURCES[resource]}/${encodeURIComponent(id)}`);
      })
  );
}
