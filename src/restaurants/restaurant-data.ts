import type { RestaurantRow, Restaurant, GradeFilter } from './types';

const BASE = '/api/restaurants';

export const ALL_BOROUGHS = ['MANHATTAN', 'BROOKLYN', 'QUEENS', 'BRONX', 'STATEN ISLAND'];

// Grade display color
export function getGradeColor(grade: string): string {
  if (grade === 'A') return '#34d399';  // green
  if (grade === 'B') return '#f59e0b';  // amber
  if (grade === 'C') return '#ef4444';  // red
  if (grade === 'Z' || grade === 'P') return '#a78bfa'; // purple — grade pending
  return 'rgba(148,163,184,0.5)';       // gray — no grade / N
}

export function getGradeLabel(grade: string): string {
  if (grade === 'A') return 'Grade A';
  if (grade === 'B') return 'Grade B';
  if (grade === 'C') return 'Grade C';
  if (grade === 'Z') return 'Grade Pending';
  if (grade === 'P') return 'Pre-Grade Pending';
  return 'No Grade';
}

// ── Fetch + deduplicate ───────────────────────────────────────────────────────

export async function fetchRestaurants(
  limit = 20000,
  gradeFilter: GradeFilter = 'all',
  boroughs?: Set<string>,
  cuisine?: string,
): Promise<Restaurant[]> {
  const clauses: string[] = [
    `latitude IS NOT NULL`,
    `longitude IS NOT NULL`,
    `inspection_date IS NOT NULL`,
  ];

  if (gradeFilter === 'A') clauses.push(`grade = 'A'`);
  else if (gradeFilter === 'B') clauses.push(`grade = 'B'`);
  else if (gradeFilter === 'C') clauses.push(`grade = 'C'`);
  else if (gradeFilter === 'warn') clauses.push(`grade IN('B','C')`);

  if (boroughs && boroughs.size > 0 && boroughs.size < ALL_BOROUGHS.length) {
    // Socrata stores boro as title-case ("Manhattan"), not uppercase
    const boros = [...boroughs]
      .map(b => b.charAt(0) + b.slice(1).toLowerCase())
      .map(b => `'${b}'`).join(',');
    clauses.push(`boro IN(${boros})`);
  }

  if (cuisine) {
    clauses.push(`cuisine_description = '${cuisine.replace(/'/g, "''")}'`);
  }

  const where = clauses.join(' AND ');
  // Fetch most recent inspection rows — order by inspection_date DESC so latest comes first
  const qs = [
    `$where=${encodeURIComponent(where)}`,
    `$order=inspection_date%20DESC`,
    `$limit=${limit}`,
  ].join('&');

  const res = await fetch(`${BASE}?${qs}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Restaurants API ${res.status}`);
  const rows: RestaurantRow[] = await res.json();

  // Deduplicate: one entry per camis, keeping most recent inspection
  // Collect all violations for that inspection
  const byRestaurant = new Map<string, { row: RestaurantRow; violations: RestaurantRow[] }>();

  rows.forEach(r => {
    const key = r.camis;
    if (!key) return;
    const existing = byRestaurant.get(key);
    if (!existing) {
      byRestaurant.set(key, { row: r, violations: [r] });
    } else {
      // Same inspection date → add violation
      if (r.inspection_date === existing.row.inspection_date) {
        existing.violations.push(r);
      }
      // More recent inspection → replace (rows already ordered DESC so this shouldn't happen often)
      else if ((r.inspection_date ?? '') > (existing.row.inspection_date ?? '')) {
        byRestaurant.set(key, { row: r, violations: [r] });
      }
    }
  });

  const results: Restaurant[] = [];
  byRestaurant.forEach(({ row, violations }) => {
    const lat = parseFloat(row.latitude ?? '');
    const lng = parseFloat(row.longitude ?? '');
    if (isNaN(lat) || isNaN(lng)) return;

    results.push({
      camis:          row.camis,
      name:           row.dba?.trim() || 'Unknown',
      boro:           (row.boro ?? '').toUpperCase(),
      address:        [row.building, row.street].filter(Boolean).join(' '),
      zipcode:        row.zipcode ?? '',
      cuisine:        row.cuisine_description ?? '',
      grade:          row.grade ?? '?',
      score:          parseInt(row.score ?? '0') || 0,
      inspectionDate: row.inspection_date ?? '',
      gradeDate:      row.grade_date ?? '',
      inspectionType: row.inspection_type ?? '',
      violations: violations
        .filter(v => v.violation_code && v.violation_description)
        .map(v => ({
          code:        v.violation_code!,
          description: v.violation_description!,
          critical:    v.critical_flag === 'Critical',
        })),
      latitude:  lat,
      longitude: lng,
      nta:       row.nta ?? '',
    });
  });

  return results;
}

// Distinct cuisine types for filter — fetched once
export async function fetchCuisines(): Promise<string[]> {
  const qs = `$select=cuisine_description&$group=cuisine_description&$order=cuisine_description ASC&$limit=200`;
  const res = await fetch(`${BASE}?${encodeURIComponent(qs)}`, { cache: 'no-store' });
  if (!res.ok) return [];
  const rows: { cuisine_description?: string }[] = await res.json();
  return rows.map(r => r.cuisine_description ?? '').filter(Boolean);
}

export function formatInspectionDate(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}
