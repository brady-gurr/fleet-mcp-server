// Convenience tools built on top of the Coast and Fleetio clients. READ-ONLY.
// Units (verified against live Coast data): purchase.amount and costPerUnit and rebate are
// cents; purchaseDetails.fuel.volume is thousandths of a US gallon.

import { z } from 'zod';
import { safe } from './common.js';
import { coastRequest, coastConfigured } from './coast.js';
import { fleetioRequest, fleetioConfigured } from './fleetio.js';

const usd = (cents) => Math.round(cents) / 100;
const gal = (v) => (typeof v === 'number' ? v / 1000 : null);
const r2 = (n) => Math.round(n * 100) / 100;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const toIso = (d, endOfDay = false) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T${endOfDay ? '23:59:59' : '00:00:00'}Z` : d);

async function coastAll(path, query, maxPages = 20) {
  const rows = [];
  let token;
  let pages = 0;
  let truncated = false;
  do {
    const data = await coastRequest(path, { ...query, pageSize: 100, nextPageToken: token });
    rows.push(...(Array.isArray(data) ? data : data?.data || []));
    token = Array.isArray(data) ? undefined : data?.nextPageToken || undefined;
    pages += 1;
    if (token && pages >= maxPages) truncated = true;
  } while (token && pages < maxPages);
  return { rows, truncated };
}

async function fleetioAll(resource, query = {}, maxPages = 10) {
  const rows = [];
  let cursor;
  let pages = 0;
  let truncated = false;
  do {
    const body = await fleetioRequest(resource, { query: { ...query, per_page: 100, start_cursor: cursor } });
    const list = Array.isArray(body) ? body : body?.records || body?.data || Object.values(body || {}).find(Array.isArray) || [];
    rows.push(...list);
    cursor = (!Array.isArray(body) && body?.next_cursor) || undefined;
    pages += 1;
    if (cursor && pages >= maxPages) truncated = true;
  } while (cursor && pages < maxPages);
  return { rows, truncated };
}

const driverName = (p) => (p ? `${(p.firstName || '').trim()} ${(p.lastName || '').trim()}`.trim() : null);

async function purchasesBetween(from, to, extra = {}) {
  const q = { status: 'completed', completedStartingAt: toIso(from), completedEndingBefore: toIso(to, true), ...extra };
  return coastAll('/v2/transactions/purchases', q);
}

function weekStart(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday start
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function bucketKey(p, by) {
  const when = p.completedTime || p.createdTime || '';
  switch (by) {
    case 'vehicle':
      return p.vehicleSnapshot?.name || '(no vehicle)';
    case 'driver':
      return driverName(p.personSnapshot) || '(no driver)';
    case 'department':
      return p.personSnapshot?.department?.name || p.vehicleSnapshot?.department?.name || '(none)';
    case 'location':
      return p.personSnapshot?.location?.name || p.vehicleSnapshot?.location?.name || '(none)';
    case 'merchant':
      return p.merchantSnapshot?.brand?.name || p.merchantSnapshot?.name || '(none)';
    case 'week':
      return weekStart(when);
    case 'month':
      return when.slice(0, 7);
    case 'card':
      return p.card?.coastId || p.card?.last4 || '(none)';
    default:
      return 'all';
  }
}

export function fuelSpendReport(purchases, by) {
  const groups = new Map();
  let totalCents = 0;
  let totalGal = 0;
  let totalRebate = 0;
  for (const p of purchases) {
    const k = bucketKey(p, by);
    const g = groups.get(k) || { group: k, fills: 0, cents: 0, gallons: 0, gallonCents: 0, rebate: 0 };
    g.fills += 1;
    g.cents += p.amount || 0;
    const v = gal(p.purchaseDetails?.fuel?.volume);
    if (v !== null) {
      g.gallons += v;
      g.gallonCents += p.amount || 0;
    }
    g.rebate += p.rebate || 0;
    groups.set(k, g);
    totalCents += p.amount || 0;
    totalGal += v || 0;
    totalRebate += p.rebate || 0;
  }
  const list = [...groups.values()].map((g) => ({
    group: g.group,
    fills: g.fills,
    spend: usd(g.cents),
    gallons: r2(g.gallons),
    avgPricePerGallon: g.gallons ? r2(g.gallonCents / 100 / g.gallons) : null,
    rebate: usd(g.rebate)
  }));
  if (by === 'week' || by === 'month') list.sort((a, b) => a.group.localeCompare(b.group));
  else list.sort((a, b) => b.spend - a.spend);
  return {
    totals: { purchases: purchases.length, spend: usd(totalCents), gallons: r2(totalGal), avgPricePerGallon: totalGal ? r2(totalCents / 100 / totalGal) : null, rebate: usd(totalRebate) },
    groups: list
  };
}

export function fuelFlags(purchases, vehiclesByCoastId = new Map(), opts = {}) {
  const { mpgLow = 8, mpgHigh = 40, bigFillGallons = 40 } = opts;
  const out = [];
  const add = (p, type, detail) =>
    out.push({
      type,
      detail,
      purchaseId: p.id,
      when: p.completedTime || p.createdTime,
      vehicle: p.vehicleSnapshot?.name,
      driver: driverName(p.personSnapshot),
      card: p.card?.coastId,
      merchant: p.merchantSnapshot?.name,
      city: p.merchantSnapshot ? `${p.merchantSnapshot.city || ''}, ${p.merchantSnapshot.state || ''}` : undefined,
      amount: usd(p.amount || 0),
      gallons: gal(p.purchaseDetails?.fuel?.volume)
    });

  const sorted = [...purchases].sort((a, b) => String(a.completedTime || a.createdTime).localeCompare(String(b.completedTime || b.createdTime)));

  for (const p of sorted) {
    if (p.flags?.length) add(p, 'coast_flag', p.flags.map((f) => (typeof f === 'string' ? f : f.type || f.name || JSON.stringify(f))).join('; '));
    const g = gal(p.purchaseDetails?.fuel?.volume);
    const v = vehiclesByCoastId.get(p.vehicleSnapshot?.id);
    const tank = p.vehicleSnapshot?.fuelTankCapacity || v?.tankCapacity;
    if (g !== null && tank && g > tank * 1.05) add(p, 'fill_exceeds_tank', `${g} gal vs ${tank} gal tank`);
    else if (g !== null && !tank && g > bigFillGallons) add(p, 'very_large_fill', `${g} gal (no tank size on file)`);
    if (p.merchantSnapshot?.category && p.merchantSnapshot.categoryCode !== '5542' && p.merchantSnapshot.categoryCode !== '5541') {
      add(p, 'non_fuel_merchant', `${p.merchantSnapshot.category}`);
    }
    if (p.purchaseDetails && !p.purchaseDetails.fuel) add(p, 'no_fuel_details', 'purchase has no fuel volume (non-fuel item?)');
  }

  // duplicates: same card + merchant + amount within 30 minutes
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      const dt = (new Date(b.completedTime || b.createdTime) - new Date(a.completedTime || a.createdTime)) / 60000;
      if (dt > 30) break;
      if (a.card?.id && a.card.id === b.card?.id && a.amount === b.amount && a.merchantSnapshot?.id === b.merchantSnapshot?.id) {
        add(b, 'possible_duplicate', `same card, merchant and amount as ${a.id} within ${Math.round(dt)} min`);
      }
    }
  }

  // card used on more than one truck in the range
  const byCard = new Map();
  for (const p of sorted) {
    const c = p.card?.coastId;
    if (!c) continue;
    const s = byCard.get(c) || new Map();
    s.set(p.vehicleSnapshot?.name || '(none)', (s.get(p.vehicleSnapshot?.name || '(none)') || 0) + 1);
    byCard.set(c, s);
  }
  for (const [card, s] of byCard) {
    if (s.size > 1) {
      const ex = sorted.find((p) => p.card?.coastId === card);
      out.push({ type: 'card_on_multiple_vehicles', detail: [...s].map(([n, c]) => `${n} x${c}`).join(', '), card, driver: driverName(ex?.personSnapshot) });
    }
  }

  // odometer / MPG between consecutive fills on one vehicle
  const byVeh = new Map();
  for (const p of sorted) {
    const id = p.vehicleSnapshot?.id;
    if (!id || typeof p.vehicleSnapshot.odometer !== 'number') continue;
    (byVeh.get(id) || byVeh.set(id, []).get(id)).push(p);
  }
  for (const list of byVeh.values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      const miles = cur.vehicleSnapshot.odometer - prev.vehicleSnapshot.odometer;
      const g = gal(cur.purchaseDetails?.fuel?.volume);
      if (miles < 0) add(cur, 'odometer_went_backwards', `${prev.vehicleSnapshot.odometer} -> ${cur.vehicleSnapshot.odometer}`);
      else if (g && miles > 0) {
        const mpg = miles / g;
        if (mpg < mpgLow) add(cur, 'low_mpg', `${r2(mpg)} mpg (${miles} mi on ${g} gal)`);
        else if (mpg > mpgHigh) add(cur, 'high_mpg', `${r2(mpg)} mpg (${miles} mi on ${g} gal) - odometer may be stale or fill was partial`);
      } else if (miles === 0 && g && g > 5) add(cur, 'odometer_unchanged', `no miles since last fill but ${g} gal bought`);
    }
  }
  const counts = {};
  for (const f of out) counts[f.type] = (counts[f.type] || 0) + 1;
  return { counts, flags: out };
}

// Match Coast vehicles to Fleetio vehicles: VIN, then plate, then normalized name.
export function matchVehicles(coastVehicles, fleetioVehicles) {
  const used = new Set();
  const matched = [];
  const unmatchedCoast = [];
  const byVin = new Map();
  const byPlate = new Map();
  const byName = new Map();
  for (const f of fleetioVehicles) {
    if (f.vin) byVin.set(norm(f.vin), f);
    if (f.license_plate) byPlate.set(norm(f.license_plate), f);
    if (f.name) byName.set(norm(f.name), f);
  }
  for (const c of coastVehicles) {
    let f;
    let by;
    if (c.vin && byVin.has(norm(c.vin))) [f, by] = [byVin.get(norm(c.vin)), 'vin'];
    else if (c.licensePlate && byPlate.has(norm(c.licensePlate))) [f, by] = [byPlate.get(norm(c.licensePlate)), 'plate'];
    else if (c.name && byName.has(norm(c.name))) [f, by] = [byName.get(norm(c.name)), 'name'];
    if (f && !used.has(f.id)) {
      used.add(f.id);
      matched.push({
        matchedBy: by,
        confidence: by === 'vin' ? 'high' : by === 'plate' ? 'medium' : 'low',
        coast: { id: c.id, name: c.name, vin: c.vin, plate: c.licensePlate, active: c.active },
        fleetio: { id: f.id, name: f.name, vin: f.vin, plate: f.license_plate, status: f.vehicle_status_name }
      });
    } else unmatchedCoast.push({ id: c.id, name: c.name, vin: c.vin, plate: c.licensePlate, active: c.active });
  }
  const unmatchedFleetio = fleetioVehicles
    .filter((f) => !used.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, vin: f.vin, plate: f.license_plate, status: f.vehicle_status_name }));
  return { counts: { matched: matched.length, coastOnly: unmatchedCoast.length, fleetioOnly: unmatchedFleetio.length }, matched, unmatchedCoast, unmatchedFleetio };
}

export function attentionRollup({ vehicles, issues, faults, renewals, inspections, workOrders }, now = new Date()) {
  const per = new Map();
  const get = (v) => {
    const key = v?.id;
    if (!key) return null;
    if (!per.has(key)) per.set(key, { vehicle: v.name, vin: v.vin, vehicleId: key, openIssues: [], openFaults: [], renewals: [], inspections: [], openWorkOrders: [] });
    return per.get(key);
  };
  for (const i of issues) if (i.state === 'Open') get(i.vehicle)?.openIssues.push({ number: i.number, name: i.name, overdue: i.overdue, reported: i.reported_at?.slice(0, 10), priority: i.issue_priority?.name });
  for (const f of faults) if (f.status === 'open') get(f.vehicle)?.openFaults.push({ code: f.code, name: f.name, last: f.last_occurred_at?.slice(0, 10), severity: /Severity: (\w+)/.exec(f.description || '')?.[1] });
  for (const r of renewals) {
    if (!r.active) continue;
    const st = r.vehicle_renewal_reminder_status;
    if (st && st !== 'ok') get(r.vehicle)?.renewals.push({ status: st, due: r.next_due_at?.slice(0, 10) });
  }
  for (const s of inspections) {
    if (!s.active) continue;
    const st = s.inspection_schedule_status;
    if (st && st !== 'ok') get(s.vehicle)?.inspections.push({ status: st, due: s.next_due_at?.slice(0, 10) });
  }
  for (const w of workOrders) if (w.state === 'active' || /open|progress/i.test(w.work_order_status_name || '')) get(w.vehicle)?.openWorkOrders.push({ number: w.number, status: w.work_order_status_name, issues: (w.issues || []).map((x) => x.name) });
  const list = [...per.values()]
    .map((v) => ({ ...v, score: v.openIssues.length * 2 + v.openFaults.length + v.renewals.length * 2 + v.inspections.length + v.openWorkOrders.length }))
    .filter((v) => v.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    asOf: now.toISOString().slice(0, 10),
    vehiclesChecked: vehicles.length,
    vehiclesNeedingAttention: list.length,
    totals: { openIssues: list.reduce((n, v) => n + v.openIssues.length, 0), openFaults: list.reduce((n, v) => n + v.openFaults.length, 0), renewalsDueOrOverdue: list.reduce((n, v) => n + v.renewals.length, 0), inspectionsDueOrOverdue: list.reduce((n, v) => n + v.inspections.length, 0), openWorkOrders: list.reduce((n, v) => n + v.openWorkOrders.length, 0) },
    vehicles: list
  };
}

export function registerFleetTools(server) {
  const both = coastConfigured() && fleetioConfigured();

  if (coastConfigured()) {
    const by = z.enum(['vehicle', 'driver', 'department', 'location', 'merchant', 'week', 'month', 'card']);
    server.registerTool(
      'fuel_spend_report',
      {
        title: 'Fuel spend report (Coast)',
        description:
          'Read-only fuel spend from Coast for a date range, with dollars, gallons, average price per gallon and rebates, grouped by vehicle, driver, department, location, merchant, card, week or month. Use this instead of computing from raw purchases. Dates are YYYY-MM-DD (UTC).',
        inputSchema: {
          from: z.string().describe('Start date YYYY-MM-DD (inclusive).'),
          to: z.string().describe('End date YYYY-MM-DD (inclusive).'),
          groupBy: by.optional().describe('Default vehicle.'),
          vehicle: z.string().optional().describe('Only this vehicle (Coast name, e.g. "F-150 - 02").'),
          driver: z.string().optional().describe('Only this driver (part of the name).')
        }
      },
      async ({ from, to, groupBy = 'vehicle', vehicle, driver }) =>
        safe(async () => {
          const { rows, truncated } = await purchasesBetween(from, to);
          let list = rows;
          if (vehicle) list = list.filter((p) => norm(p.vehicleSnapshot?.name).includes(norm(vehicle)));
          if (driver) list = list.filter((p) => norm(driverName(p.personSnapshot)).includes(norm(driver)));
          return { range: { from, to }, groupBy, units: 'spend in USD, gallons in US gallons', ...(truncated ? { warning: 'Hit the page cap; narrow the date range for complete numbers.' } : {}), ...fuelSpendReport(list, groupBy) };
        })
    );

    server.registerTool(
      'fuel_flags',
      {
        title: 'Fuel exceptions (Coast)',
        description:
          'Read-only review of Coast fuel purchases in a date range for things worth a look: Coast-flagged purchases, fills larger than the tank, very large fills, possible duplicates, a card used on more than one truck, non-fuel merchants, odometer going backwards or unchanged, and mileage (MPG) outliers. Results are leads to check, not proof of misuse.',
        inputSchema: {
          from: z.string().describe('Start date YYYY-MM-DD.'),
          to: z.string().describe('End date YYYY-MM-DD.'),
          mpgLow: z.number().optional().describe('Flag below this MPG (default 8).'),
          mpgHigh: z.number().optional().describe('Flag above this MPG (default 40).')
        }
      },
      async ({ from, to, mpgLow, mpgHigh }) =>
        safe(async () => {
          const [{ rows, truncated }, veh] = await Promise.all([purchasesBetween(from, to), coastAll('/v2/vehicles', {})]);
          const map = new Map(veh.rows.map((v) => [v.id, v]));
          return { range: { from, to }, purchasesReviewed: rows.length, ...(truncated ? { warning: 'Hit the page cap; narrow the date range.' } : {}), ...fuelFlags(rows, map, { mpgLow, mpgHigh }) };
        })
    );
  }

  if (both) {
    server.registerTool(
      'vehicle_match',
      {
        title: 'Match Coast and Fleetio vehicles',
        description: 'Read-only: pairs each Coast vehicle with its Fleetio vehicle by VIN, then plate, then name, and lists vehicles that exist in only one system.',
        inputSchema: {}
      },
      async () =>
        safe(async () => {
          const [c, f] = await Promise.all([coastAll('/v2/vehicles', {}), fleetioAll('vehicles')]);
          return matchVehicles(c.rows, f.rows);
        })
    );
  }

  if (fleetioConfigured()) {
    server.registerTool(
      'trucks_needing_attention',
      {
        title: 'Trucks needing attention (Fleetio)',
        description: 'Read-only rollup per vehicle of open issues, open engine faults, overdue or due-soon renewals, overdue inspections and open work orders, worst first.',
        inputSchema: {}
      },
      async () =>
        safe(async () => {
          const [vehicles, issues, faults, renewals, inspections, workOrders] = await Promise.all([
            fleetioAll('vehicles'),
            fleetioAll('issues'),
            fleetioAll('faults'),
            fleetioAll('vehicle_renewal_reminders'),
            fleetioAll('inspection_schedules'),
            fleetioAll('work_orders')
          ]);
          return attentionRollup({ vehicles: vehicles.rows, issues: issues.rows, faults: faults.rows, renewals: renewals.rows, inspections: inspections.rows, workOrders: workOrders.rows });
        })
    );
  }

  if (both) {
    server.registerTool(
      'vehicle_360',
      {
        title: 'Vehicle 360',
        description:
          'Read-only everything about one truck: Fleetio record, latest odometer, open issues/faults/renewals/work orders, plus the Coast vehicle, assigned drivers, cards and recent fill-ups. Pass a name ("Mav 07", "F-150 - 02"), VIN or plate.',
        inputSchema: {
          vehicle: z.string().describe('Name, VIN or license plate.'),
          fills: z.number().int().min(1).max(50).optional().describe('Recent fills to show (default 10).')
        }
      },
      async ({ vehicle, fills = 10 }) =>
        safe(async () => {
          const q = norm(vehicle);
          const [c, f] = await Promise.all([coastAll('/v2/vehicles', {}), fleetioAll('vehicles')]);
          const hit = (name, vin, plate) => norm(name) === q || norm(vin) === q || norm(plate) === q;
          let cv = c.rows.find((v) => hit(v.name, v.vin, v.licensePlate));
          let fv = f.rows.find((v) => hit(v.name, v.vin, v.license_plate));
          if (!cv && !fv) {
            cv = c.rows.find((v) => norm(v.name).includes(q));
            fv = f.rows.find((v) => norm(v.name).includes(q));
          }
          if (!cv && fv) cv = c.rows.find((v) => (v.vin && norm(v.vin) === norm(fv.vin)) || (v.licensePlate && norm(v.licensePlate) === norm(fv.license_plate)));
          if (!fv && cv) fv = f.rows.find((v) => (v.vin && norm(v.vin) === norm(cv.vin)) || (v.license_plate && norm(v.license_plate) === norm(cv.licensePlate)));
          if (!cv && !fv) return { found: false, searched: vehicle, hint: 'No vehicle matched in Coast or Fleetio by name, VIN or plate.' };

          const out = { found: true, matchedIn: { coast: Boolean(cv), fleetio: Boolean(fv) } };
          const jobs = [];
          if (fv) {
            const vf = { 'filter[vehicle_id][eq]': fv.id };
            jobs.push(
              fleetioRequest('meter_entries', { query: { ...vf, per_page: 1 } }).then((b) => (out.latestMeter = (b.records || b.data || [])[0] || null)),
              fleetioAll('issues', vf, 3).then((r) => (out.openIssues = r.rows.filter((i) => i.state === 'Open').map((i) => ({ number: i.number, name: i.name, reported: i.reported_at?.slice(0, 10), overdue: i.overdue })))),
              fleetioAll('faults', vf, 3).then((r) => (out.openFaults = r.rows.filter((x) => x.status === 'open').map((x) => ({ code: x.code, name: x.name, last: x.last_occurred_at?.slice(0, 10) })))),
              fleetioAll('vehicle_renewal_reminders', vf, 2).then((r) => (out.renewals = r.rows.map((x) => ({ status: x.vehicle_renewal_reminder_status, due: x.next_due_at?.slice(0, 10), active: x.active })))),
              fleetioAll('work_orders', vf, 2).then((r) => (out.workOrders = r.rows.map((w) => ({ number: w.number, status: w.work_order_status_name, issues: (w.issues || []).map((x) => x.name) }))))
            );
            out.fleetio = {
              id: fv.id, name: fv.name, vin: fv.vin, plate: fv.license_plate, year: fv.year, make: fv.make, model: fv.model,
              status: fv.vehicle_status_name, odometer: fv.primary_meter_value, odometerDate: fv.primary_meter_date,
              tankGallons: fv.specs?.fuel_tank_capacity, driver: fv.driver?.name || null, group: fv.group_name
            };
          }
          if (cv) {
            out.coast = { id: cv.id, name: cv.name, vin: cv.vin, plate: cv.licensePlate, active: cv.active, tankCapacity: cv.tankCapacity, department: cv.departmentDetails?.name, location: cv.locationDetails?.name, assignedPeopleIds: cv.assignedPeopleIds };
            jobs.push(
              coastRequest('/v2/transactions/purchases', { assignedVehicleId: cv.id, status: 'completed', pageSize: fills }).then((d) => {
                const rows = Array.isArray(d) ? d : d?.data || [];
                out.recentFills = rows.slice(0, fills).map((p) => ({ when: p.completedTime, driver: driverName(p.personSnapshot), card: p.card?.coastId, merchant: p.merchantSnapshot?.name, city: p.merchantSnapshot?.city, amount: usd(p.amount || 0), gallons: gal(p.purchaseDetails?.fuel?.volume), pricePerGallon: p.purchaseDetails?.fuel?.costPerUnit ? usd(p.purchaseDetails.fuel.costPerUnit) : null, odometer: p.vehicleSnapshot?.odometer }));
              }),
              coastRequest('/v2/cards', { vehicleId: cv.id }).then((d) => (out.coastCards = (Array.isArray(d) ? d : d?.data || []).map((x) => ({ id: x.id, fleetCardId: x.fleetCardId, last4: x.last4, status: x.status, assignedPersonId: x.assignedPersonId }))))
            );
            if (cv.assignedPeopleIds?.length) {
              jobs.push(
                Promise.all(cv.assignedPeopleIds.slice(0, 5).map((id) => coastRequest(`/v2/people/${encodeURIComponent(id)}`).catch(() => null))).then((ps) => (out.coastDrivers = ps.filter(Boolean).map((p) => ({ name: `${p.firstName || ''} ${p.lastName || ''}`.trim(), email: p.email }))))
              );
            }
          }
          await Promise.all(jobs);
          return out;
        })
    );
  }
}
