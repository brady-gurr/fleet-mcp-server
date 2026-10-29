// Shared helpers for the Coast and Fleetio tools. Everything in this wrapper is
// read-only: the clients below only ever issue GET requests.

export function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export async function safe(fn) {
  try {
    return textResult(await fn());
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message, status: err.status, details: err.body }, null, 2) }],
      isError: true
    };
  }
}

// "vehicle.name" -> value at that path (arrays: first element of the path is applied to each).
export function getPath(obj, path) {
  return String(path)
    .split('.')
    .reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}

const num = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  // money objects like { amount: 1234, currency: 'USD' } or { cents: 1234 }
  if (v && typeof v === 'object') {
    for (const k of ['amount', 'value', 'cents']) if (typeof v[k] === 'number' || typeof v[k] === 'string') return num(v[k]);
  }
  return undefined;
};

// Group rows by a field path and sum a numeric field path. Generic on purpose:
// run a small list first to see the real field names, then summarize.
export function summarize(rows, { groupBy, sum, count = true }) {
  const groups = new Map();
  let total = 0;
  let counted = 0;
  for (const row of rows) {
    const key = groupBy ? String(getPath(row, groupBy) ?? '(none)') : 'all';
    const g = groups.get(key) || { group: key, count: 0, sum: 0 };
    g.count += 1;
    const n = sum ? num(getPath(row, sum)) : undefined;
    if (n !== undefined) {
      g.sum += n;
      total += n;
      counted += 1;
    }
    groups.set(key, g);
  }
  const list = [...groups.values()].map((g) => ({ group: g.group, ...(count ? { count: g.count } : {}), ...(sum ? { sum: Math.round(g.sum * 100) / 100 } : {}) }));
  list.sort((a, b) => (b.sum ?? b.count ?? 0) - (a.sum ?? a.count ?? 0));
  return { rows: rows.length, ...(sum ? { total: Math.round(total * 100) / 100, rowsWithNumericValue: counted } : {}), groups: list };
}

export function pickFields(row, fields) {
  if (!fields?.length) return row;
  const out = {};
  for (const f of fields) out[f] = getPath(row, f);
  return out;
}
