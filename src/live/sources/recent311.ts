/**
 * NYC 311 complaints — last 24 hours
 * Proxied via /api/311 in vercel.json → data.cityofnewyork.us
 */

export interface Complaint311 {
  id: string;
  lat: number;
  lon: number;
  type: string;
  createdAt: number; // unix ms
  color: string;
}

// Complaint type → accent color
const TYPE_COLORS: Record<string, string> = {
  'Noise - Residential':          '#F5A623',
  'Noise - Commercial':            '#F5A623',
  'Noise - Street/Sidewalk':       '#F5A623',
  'Noise - Vehicle':               '#F5A623',
  'Noise - Helicopter':            '#F5A623',
  'HEAT/HOT WATER':                '#E8441A',
  'HEATING':                       '#E8441A',
  'Rodent':                        '#6CBE45',
  'Dirty Conditions':              '#A0956B',
  'Illegal Parking':               '#7B68EE',
  'Blocked Driveway':              '#7B68EE',
  'Street Light Condition':        '#FFD700',
  'Street Condition':              '#9E8C6E',
  'Graffiti':                      '#FF6B9D',
  'Building/Use':                   '#4A9EBF',
  'PLUMBING':                      '#4A9EBF',
  'PAINT/PLASTER':                 '#C8A882',
  'Derelict Vehicles':             '#888888',
  'Sanitation Condition':          '#8BC34A',
  'Homeless Person Assistance':    '#BA68C8',
};

const DEFAULT_COLOR = '#60A0C8';

function getColor(type: string): string {
  return TYPE_COLORS[type] ?? DEFAULT_COLOR;
}

export async function fetch311Recent(): Promise<Complaint311[]> {
  try {
    // Socrata needs 'YYYY-MM-DDTHH:MM:SS' — no trailing Z, no milliseconds
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19);
    const url = `/api/311?$where=created_date>'${since}'&$limit=500&$order=created_date DESC&$select=unique_key,complaint_type,created_date,latitude,longitude`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return [];
    const data: Record<string, string>[] = await res.json();

    return data
      .filter(d => d.latitude && d.longitude)
      .map(d => ({
        id: d.unique_key,
        lat: parseFloat(d.latitude),
        lon: parseFloat(d.longitude),
        type: d.complaint_type ?? 'Other',
        createdAt: new Date(d.created_date).getTime(),
        color: getColor(d.complaint_type ?? ''),
      }))
      .filter(d => !isNaN(d.lat) && !isNaN(d.lon));
  } catch {
    return [];
  }
}
