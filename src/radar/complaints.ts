// NYC 311 complaint data via NYC Open Data
// Dataset: 311 Service Requests from 2020 to Present (erm2-nwe9)


export interface Complaint {
  unique_key: string;
  complaint_type: string;
  descriptor?: string;
  created_date: string;
  latitude?: string;
  longitude?: string;
  borough?: string;
  status?: string;
  agency?: string;
  agency_name?: string;
  incident_address?: string;
  intersection_street_1?: string;
  intersection_street_2?: string;
  incident_zip?: string;
  resolution_description?: string;
  community_board?: string;
}

// Distinct colors for top complaint types — spread across the full spectrum
export const COMPLAINT_COLORS: Record<string, string> = {
  // ── Noise — warm spectrum, max internal contrast (2nd busiest category)
  'Noise - Residential':          '#ff6b35',  // orange-red
  'Noise - Street/Sidewalk':      '#ffa94d',  // amber
  'Noise - Commercial':           '#ffe066',  // gold
  'Noise - Vehicle':              '#c0eb75',  // lime
  'Noise':                        '#96f2d7',  // mint

  // ── Parking / vehicles — magenta/pink family
  'Illegal Parking':              '#f06595',  // hot pink
  'Blocked Driveway':             '#e64980',  // deep pink
  'Abandoned Vehicle':            '#c2255c',  // rose
  'Derelict Vehicles':            '#a61e4d',  // dark rose
  'Derelict Vehicle':             '#a61e4d',

  // ── Heat / water / plumbing — red + blues (semantically hot vs cold)
  'HEAT/HOT WATER':               '#ff4444',  // electric red
  'WATER LEAK':                   '#74c0fc',  // sky blue
  'Water System':                 '#4dabf7',  // blue
  'PLUMBING':                     '#339af0',  // medium blue
  'General Construction/Plumbing':'#1c7ed6',  // deep blue

  // ── Building interior — purples/violets
  'PAINT/PLASTER':                '#9775fa',  // periwinkle
  'DOOR/WINDOW':                  '#7950f2',  // violet
  'ELECTRIC':                     '#6741d9',  // deep violet
  'FLOORING/STAIRS':              '#b197fc',  // lavender
  'APPLIANCE':                    '#d0bfff',  // pale violet
  'GENERAL':                      '#845ef7',  // medium violet
  'Building/Use':                 '#5f3dc4',  // dark violet

  // ── Sanitation — teals
  'UNSANITARY CONDITION':         '#20c997',  // teal
  'Dirty Condition':              '#38d9a9',  // light teal
  'Illegal Dumping':              '#0ca678',  // dark teal
  'Sanitation Condition':         '#099268',  // forest teal
  'Missed Collection':            '#63e6be',  // pale teal
  'Rodent':                       '#087f5b',  // deep green

  // ── Streets / infrastructure — greens
  'Street Condition':             '#a9e34b',  // bright lime
  'Traffic Signal Condition':     '#74b816',  // olive green
  'Street Light Condition':       '#5c940d',  // dark green
  'Sidewalk Condition':           '#d8f5a2',  // pale lime
  'Sewer':                        '#66a80f',  // medium green

  // ── Trees / nature — distinct bright greens
  'Damaged Tree':                 '#00e676',  // neon green
  'Dead/Dying Tree':              '#69db7c',  // soft green
  'Overgrown Tree/Branches':      '#b2f2bb',  // pale green

  // ── Homelessness / people — purples
  'Encampment':                   '#cc5de8',  // bright purple
  'Homeless Person Assistance':   '#ae3ec9',  // medium purple
  'Drug Activity':                '#862e9c',  // dark purple

  // ── Graffiti / quality of life — cyans (kept for visual variety)
  'Graffiti':                     '#22d3ee',  // bright cyan
  'Disorderly Youth':             '#06b6d4',  // medium cyan

  // ── Catch-all
  'GENERAL CONSTRUCTION':         '#94a3b8',  // slate
};

export const DEFAULT_COLOR = '#00ccff';

export function getComplaintColor(type: string): string {
  if (COMPLAINT_COLORS[type]) return COMPLAINT_COLORS[type];
  const key = Object.keys(COMPLAINT_COLORS).find(k =>
    type.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(type.toLowerCase())
  );
  return key ? COMPLAINT_COLORS[key] : DEFAULT_COLOR;
}

/**
 * Fetch a full day of complaints for a given date string (YYYY-MM-DD).
 * Returns sorted by created_date ASC (chronological for replay).
 */
export async function fetchComplaintsForDate(dateStr: string): Promise<Complaint[]> {
  // NOTE: Never use URLSearchParams — encodes '$' as '%24' breaking Socrata
  const nextDay = new Date(new Date(dateStr + 'T00:00:00').getTime() + 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  const qs = `$where=latitude+IS+NOT+NULL+AND+longitude+IS+NOT+NULL+AND+created_date>='${dateStr}'+AND+created_date<'${nextDay}'&$order=created_date+ASC&$limit=12000`;

  const res = await fetch(`/api/311?${qs}`, { cache: 'no-store' });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`311 API error: ${res.status} — ${txt.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Fetch complaints of a specific type within a date range — for feed panel on chart click.
 * Returns up to 50 most recent.
 */
export async function fetchComplaintsByType(
  complaintType: string,
  dateFrom: string,
  dateTo: string,
): Promise<Complaint[]> {
  const typeEnc = encodeURIComponent(complaintType).replace(/%20/g, '+');
  const qs = `$where=complaint_type='${typeEnc}'+AND+created_date>='${dateFrom}'+AND+created_date<'${dateTo}'&$order=created_date+DESC&$limit=50`;
  const res = await fetch(`/api/311?${qs}`, { cache: 'no-store' });
  if (!res.ok) return [];
  return res.json();
}

/** Quick count check — avoids downloading 14MB just to discover a date is incomplete */
async function countForDate(dateStr: string): Promise<number> {
  const nextDay = new Date(new Date(dateStr + 'T00:00:00').getTime() + 86400000)
    .toISOString().split('T')[0];
  const qs = `$select=count(*)&$where=created_date>='${dateStr}'+AND+created_date<'${nextDay}'`;
  const res = await fetch(`/api/311?${qs}`, { cache: 'no-store' });
  if (!res.ok) return 0;
  const rows = await res.json();
  return parseInt(rows?.[0]?.count ?? '0', 10);
}

/** NYC-relative "yesterday" — always uses America/New_York */
function nycYesterday(daysBack: number): string {
  const nycNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const d = new Date(nycNow.getFullYear(), nycNow.getMonth(), nycNow.getDate());
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

/**
 * Get the best available date. Checks counts first (tiny request) to find a
 * complete day, then fetches only that day's full data.
 */
export async function fetchComplaints(): Promise<{ data: Complaint[]; date: string }> {
  // NYC Open Data uploads daily in batch overnight — a "complete" day has 5k+ records.
  // Partial uploads (a few hundred) mean the batch hasn't finished yet; skip to prior day.
  const COMPLETE_DAY_THRESHOLD = 3000;
  for (let i = 1; i <= 4; i++) {
    const dateStr = nycYesterday(i);
    const count = await countForDate(dateStr);
    if (count >= COMPLETE_DAY_THRESHOLD) {
      const data = await fetchComplaintsForDate(dateStr);
      return { data, date: dateStr };
    }
  }
  // Last resort — fetch whatever 3 days ago has
  const fallbackDate = nycYesterday(3);
  const data = await fetchComplaintsForDate(fallbackDate);
  return { data, date: fallbackDate };
}

/** Pre-aggregated daily counts for a month — one row per (day, complaint_type) */
export interface DailyCount {
  day: string;         // YYYY-MM-DD
  complaint_type: string;
  count: number;
}

/**
 * Fetch aggregated daily complaint counts for a full month.
 * Uses Socrata $group to get ~600 rows instead of ~400K raw records.
 * Fast — under 500ms.
 */
export async function fetchMonthAggregate(dateStr: string): Promise<DailyCount[]> {
  const d = new Date(dateStr + 'T12:00:00');
  const year = d.getFullYear();
  const month = d.getMonth();
  const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const nextMonthStart = new Date(year, month + 1, 1).toISOString().split('T')[0];

  // Socrata date_trunc_ymd returns truncated date string
  const qs = [
    `$select=date_trunc_ymd(created_date)+AS+day,complaint_type,count(*)+AS+cnt`,
    `$where=created_date>='${monthStart}'+AND+created_date<'${nextMonthStart}'`,
    `$group=date_trunc_ymd(created_date),complaint_type`,
    `$order=day+ASC`,
    `$limit=5000`,
  ].join('&');

  const res = await fetch(`/api/311?${qs}`, { cache: 'no-store' });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`311 API error: ${res.status} — ${txt.slice(0, 200)}`);
  }
  const raw: { day: string; complaint_type: string; cnt: string }[] = await res.json();
  return raw.map(r => ({
    day: r.day.split('T')[0],
    complaint_type: r.complaint_type,
    count: parseInt(r.cnt, 10),
  }));
}

/**
 * Build a consistent stack order for both charts.
 * Pure volume sort — most frequent type at bottom (index 0), least at top.
 * Pass in a Map of complaint_type → total count across the full dataset being charted.
 */
export function getStackOrder(typeTotals: Map<string, number>): string[] {
  return [...typeTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0]);
}

export interface MonthCount {
  month: number;        // 0-based
  complaint_type: string;
  count: number;
}

/**
 * Fetch monthly aggregates for a full year grouped by complaint type.
 * Returns ~12×N rows (months × types). Fast — Socrata $group query.
 */
const YEAR_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — for current year static file

export async function fetchYearAggregate(year: number): Promise<MonthCount[]> {
  const isCurrentYear = year === new Date().getFullYear();

  // 1. Try static pre-built file (fast — Vercel CDN, <100ms)
  try {
    const res = await fetch(`/data/311_year_${year}.json`, {
      cache: isCurrentYear ? 'no-cache' : 'force-cache',
    });
    if (res.ok) {
      const json: { year: number; generated: string; rows: { month: number; type: string; count: number }[] } = await res.json();
      return json.rows.map(r => ({
        month: r.month,
        complaint_type: r.type,
        count: r.count,
      }));
    }
  } catch { /* static file not available yet — fall through to Socrata */ }

  // 2. Fallback: fetch live from Socrata (slow ~20s, but always works)
  //    Also check localStorage cache to avoid repeat slow fetches
  const cacheKey = `311_year_${year}`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const { ts, data } = JSON.parse(cached);
      if (!isCurrentYear || Date.now() - ts < YEAR_CACHE_TTL_MS) {
        return data as MonthCount[];
      }
    }
  } catch { /* ignore */ }

  const yearStart = `${year}-01-01`;
  const yearEnd   = `${year + 1}-01-01`;
  const qs = [
    `$select=date_trunc_ym(created_date)+AS+month,complaint_type,count(*)+AS+cnt`,
    `$where=created_date>='${yearStart}'AND+created_date<'${yearEnd}'`,
    `$group=date_trunc_ym(created_date),complaint_type`,
    `$order=month+ASC`,
    `$limit=5000`,
  ].join('&');

  const res = await fetch(`/api/311?${qs}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`311 API ${res.status}`);
  const raw: { month: string; complaint_type: string; cnt: string }[] = await res.json();
  const data: MonthCount[] = raw.map(r => ({
    month: new Date(r.month).getMonth(),
    complaint_type: r.complaint_type,
    count: parseInt(r.cnt, 10),
  }));

  try {
    localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* ignore */ }

  return data;
}

export function getTopComplaintTypes(complaints: Complaint[], n = 12): string[] {
  const counts = new Map<string, number>();
  for (const c of complaints) {
    counts.set(c.complaint_type, (counts.get(c.complaint_type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(e => e[0]);
}
