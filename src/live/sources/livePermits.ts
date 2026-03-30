/**
 * Live permits — active permits filed in last 48h
 * Uses the same DOB NOW API as the permits view, filtered to very recent
 */

export interface LivePermit {
  id: string;
  lat: number;
  lon: number;
  jobType: string;
  address: string;
  issuedDate: string;
  isCrane: boolean;
}

// Job types that indicate crane/derrick work
const CRANE_KEYWORDS = ['crane', 'derrick', 'hoist', 'tower crane'];

function isCranePermit(desc: string, jobType: string): boolean {
  const text = (desc + ' ' + jobType).toLowerCase();
  return CRANE_KEYWORDS.some(k => text.includes(k));
}

function jobColor(jobType: string): string {
  switch ((jobType || '').toUpperCase()) {
    case 'NB':  return '#60b8ff'; // new building — blue
    case 'DM':  return '#ff6060'; // demolition — red
    case 'A1':  return '#ffa040'; // major alteration — orange
    case 'A2':  return '#ffd060'; // minor alteration — yellow
    case 'A3':  return '#c0d060'; // minor alteration — yellow-green
    default:    return '#a0a0c0';
  }
}

export { jobColor };

export async function fetchLivePermits(): Promise<LivePermit[]> {
  try {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000)
      .toISOString().slice(0, 10); // YYYY-MM-DD

    // DOB NOW permits issued in last 48h with coordinates
    const params = new URLSearchParams({
      '$where': `issued_date >= '${since}' AND latitude IS NOT NULL`,
      '$limit': '300',
      '$order': 'issued_date DESC',
      '$select': 'job_filing_number,job_type,job_description,issued_date,house_no,street_name,borough,latitude,longitude',
    });

    const res = await fetch(
      `https://data.cityofnewyork.us/resource/rbx6-tga4.json?${params}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return [];

    const data: Record<string, string>[] = await res.json();

    return data
      .filter(d => d.latitude && d.longitude)
      .map(d => ({
        id: d.job_filing_number ?? Math.random().toString(36),
        lat: parseFloat(d.latitude),
        lon: parseFloat(d.longitude),
        jobType: d.job_type ?? '',
        address: [d.house_no, d.street_name, d.borough].filter(Boolean).join(' '),
        issuedDate: d.issued_date ?? '',
        isCrane: isCranePermit(d.job_description ?? '', d.job_type ?? ''),
      }))
      .filter(d => !isNaN(d.lat) && !isNaN(d.lon));
  } catch {
    return [];
  }
}
