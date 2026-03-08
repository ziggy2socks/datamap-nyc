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
  // Parking / vehicles — yellows & ambers
  'Illegal Parking':         '#ffe600',
  'Blocked Driveway':        '#ffaa00',
  'Abandoned Vehicle':       '#e6a800',
  'Derelict Vehicle':        '#cc8800',

  // Heat / water / plumbing — oranges & warm reds
  'HEAT/HOT WATER':          '#ff6b35',
  'WATER LEAK':              '#ff5522',
  'PLUMBING':                '#e04830',
  'Water System':            '#d4603a',

  // Noise — cyans & teals
  'Noise - Residential':     '#00ddff',
  'Noise - Commercial':      '#00bbdd',
  'Noise - Street/Sidewalk': '#009fbb',
  'Noise - Vehicle':         '#00889e',
  'Noise':                   '#00ccee',

  // Streets / infrastructure — lime & green
  'Street Condition':        '#88dd22',
  'Traffic Signal Condition':'#66cc44',
  'Street Light Condition':  '#44ee88',
  'Sidewalk Condition':      '#22cc66',
  'Sewer':                   '#33bb77',

  // Building / interior — purples & magentas
  'PAINT/PLASTER':           '#cc66ff',
  'DOOR/WINDOW':             '#aa44ee',
  'ELECTRIC':                '#dd55cc',
  'FLOORING/STAIRS':         '#bb55dd',
  'APPLIANCE':               '#9955cc',
  'GENERAL':                 '#aa77dd',
  'General Construction/Plumbing': '#9966cc',

  // Sanitation — pinks & roses
  'UNSANITARY CONDITION':    '#ff5599',
  'Dirty Condition':         '#ff77aa',
  'Illegal Dumping':         '#ee4488',
  'Sanitation Condition':    '#ff6699',
  'Rodent':                  '#ff3366',
  'Graffiti':                '#ff44bb',

  // Trees / nature — bright greens
  'Damaged Tree':            '#00ff88',
  'Dead/Dying Tree':         '#33ff77',
  'Overgrown Tree/Branches': '#55ff66',

  // People — blues
  'Homeless Person Assistance': '#4499ff',
  'Encampment':              '#5577ff',
  'Drug Activity':           '#7755ff',

  // Other
  'Building/Use':            '#66bbff',
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
  // Check up to 3 days back to find a complete dataset
  for (let i = 1; i <= 3; i++) {
    const dateStr = nycYesterday(i);
    const count = await countForDate(dateStr);
    if (count >= 500) {
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
