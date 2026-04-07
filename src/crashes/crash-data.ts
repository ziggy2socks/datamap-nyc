import type { Crash, ModeFilter, SeverityFilter } from './types';

const BASE = '/api/crashes';

export const ALL_BOROUGHS = ['MANHATTAN', 'BROOKLYN', 'QUEENS', 'BRONX', 'STATEN ISLAND'];
export const MIN_DATE = '2013-07-01'; // Vision Zero dataset starts ~2012; reliable from mid-2013

// ── Severity ──────────────────────────────────────────────────────────────────

export function getSeverity(c: Crash): 'fatal' | 'injury' | 'none' {
  const killed =
    parseInt(c.number_of_persons_killed || '0') +
    parseInt(c.number_of_pedestrians_killed || '0') +
    parseInt(c.number_of_cyclist_killed || '0') +
    parseInt(c.number_of_motorist_killed || '0');
  if (killed > 0) return 'fatal';

  const injured =
    parseInt(c.number_of_persons_injured || '0') +
    parseInt(c.number_of_pedestrians_injured || '0') +
    parseInt(c.number_of_cyclist_injured || '0') +
    parseInt(c.number_of_motorist_injured || '0');
  if (injured > 0) return 'injury';

  return 'none';
}

export function getMode(c: Crash): 'pedestrian' | 'cyclist' | 'motorist' | 'multi' {
  const ped  = parseInt(c.number_of_pedestrians_injured || '0') + parseInt(c.number_of_pedestrians_killed || '0');
  const cyc  = parseInt(c.number_of_cyclist_injured || '0') + parseInt(c.number_of_cyclist_killed || '0');
  const mot  = parseInt(c.number_of_motorist_injured || '0') + parseInt(c.number_of_motorist_killed || '0');
  const hits = [ped > 0, cyc > 0, mot > 0].filter(Boolean).length;
  if (hits > 1) return 'multi';
  if (ped > 0) return 'pedestrian';
  if (cyc > 0) return 'cyclist';
  return 'motorist';
}

// Dot color by severity
export function getCrashColor(severity: 'fatal' | 'injury' | 'none'): string {
  if (severity === 'fatal')  return '#ef4444'; // red
  if (severity === 'injury') return '#f59e0b'; // amber
  return 'rgba(148,163,184,0.35)';             // dim slate — no injury
}

export const SEVERITY_LABELS: Record<string, string> = {
  fatal:  'Fatal',
  injury: 'Injury',
  none:   'No Injury',
};

export const MODE_LABELS: Record<string, string> = {
  pedestrian: 'Pedestrian',
  cyclist:    'Cyclist',
  motorist:   'Motorist',
  multi:      'Multiple',
};

// ── Fetch ─────────────────────────────────────────────────────────────────────

export async function fetchCrashes(
  dateFrom: string,
  dateTo:   string,
  limit = 50000,
  severity: SeverityFilter = 'all',
  mode: ModeFilter = 'all',
  boroughs?: Set<string>,
): Promise<Crash[]> {
  const toISO = (s: string) => `${s}T00:00:00.000`;
  const toDate = new Date(dateTo); toDate.setDate(toDate.getDate() + 1);
  const toStr = toDate.toISOString().split('T')[0] + 'T00:00:00.000';

  // Build where clause
  const clauses: string[] = [
    `crash_date >= '${toISO(dateFrom)}'`,
    `crash_date < '${toStr}'`,
    `latitude IS NOT NULL`,
    `longitude IS NOT NULL`,
  ];

  // Severity filter
  if (severity === 'fatal') {
    clauses.push(`(number_of_persons_killed > 0 OR number_of_pedestrians_killed > 0 OR number_of_cyclist_killed > 0 OR number_of_motorist_killed > 0)`);
  } else if (severity === 'injury') {
    clauses.push(`(number_of_persons_injured > 0 OR number_of_pedestrians_injured > 0 OR number_of_cyclist_injured > 0 OR number_of_motorist_injured > 0)`);
  }

  // Mode filter (server-side pre-filter; client refines)
  if (mode === 'pedestrian') {
    clauses.push(`(number_of_pedestrians_injured > 0 OR number_of_pedestrians_killed > 0)`);
  } else if (mode === 'cyclist') {
    clauses.push(`(number_of_cyclist_injured > 0 OR number_of_cyclist_killed > 0)`);
  } else if (mode === 'motorist') {
    clauses.push(`(number_of_motorist_injured > 0 OR number_of_motorist_killed > 0)`);
  }

  // Borough filter
  if (boroughs && boroughs.size > 0 && boroughs.size < ALL_BOROUGHS.length) {
    const boros = [...boroughs].map(b => `'${b}'`).join(',');
    clauses.push(`borough IN(${boros})`);
  }

  const where = clauses.join(' AND ');
  const params = new URLSearchParams({
    $where:  where,
    $order:  'crash_date DESC',
    $limit:  String(limit),
  });

  const res = await fetch(`${BASE}?${params}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Crashes API ${res.status}`);
  const rows: Crash[] = await res.json();

  return rows.map(c => ({
    ...c,
    severity: getSeverity(c),
    mode:     getMode(c),
  }));
}

// ── Display helpers ───────────────────────────────────────────────────────────

export function formatCrashAddress(c: Crash): string {
  if (c.on_street_name && c.cross_street_name) {
    return `${c.on_street_name.trim()} & ${c.cross_street_name.trim()}`;
  }
  if (c.on_street_name) return c.on_street_name.trim();
  if (c.off_street_name) return c.off_street_name.trim();
  return 'Unknown location';
}

export function formatCrashDate(c: Crash): string {
  if (!c.crash_date) return '';
  try {
    const d = new Date(c.crash_date);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return c.crash_date; }
}

export function crashSummary(c: Crash): string {
  const parts: string[] = [];
  const killed  = parseInt(c.number_of_persons_killed  || '0');
  const injured = parseInt(c.number_of_persons_injured || '0');
  if (killed  > 0) parts.push(`${killed} killed`);
  if (injured > 0) parts.push(`${injured} injured`);
  if (!parts.length) parts.push('No injuries reported');
  return parts.join(', ');
}
