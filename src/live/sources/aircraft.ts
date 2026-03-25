/**
 * Aircraft data via ADS-B Exchange (adsb.lol)
 * Shows all aircraft over NYC — planes, helicopters, military
 */

const NYC_LAT = 40.75;
const NYC_LON = -74.00;
const DIST_NM = 30;

// Known helicopter ICAO type codes
const HELI_TYPES = new Set([
  'H25B','H500','H60','H64','H69','H72','H76','H47',
  'B06','B06X','B07','B212','B222','B230','B407','B412','B427','B429','B430','B47G','B47J',
  'EC20','EC25','EC30','EC35','EC45','EC55','EC75','AS32','AS35','AS50','AS55','AS65',
  'S300','S330','S333','S61','S64','S70','S76','S92',
  'R22','R44','R66',
  'AW09','AW19','AW89','AW01','AW39',
  'MD52','MD60',
]);

// Military type prefixes / known types
const MILITARY_TYPES = new Set([
  'B52','C130','C17','C5','E3','P8','KC135','KC46','F16','F18','F22','F35',
  'C12','C21','C37','C40','T38','T6','U2','RC135','E8','E6','EP3',
]);

const MILITARY_CALLSIGN_PREFIXES = [
  'RCH','SAM','ASCOT','REACH','DUKE','EAGLE','VIPER','GHOST','SNAKE',
  'HAVOC','COBRA','WOLF','FALCON','HAWK','BLADE','KNIFE',
];

export type AircraftKind = 'helicopter' | 'military' | 'plane';

export interface AircraftState {
  hex: string;
  lat: number;
  lon: number;
  alt: number;
  alt_baro?: number;
  track: number;      // degrees 0=N
  gs: number;         // knots
  flight?: string;    // callsign
  t?: string;         // ICAO type
  r?: string;         // tail/registration
  kind: AircraftKind;
}

function classifyAircraft(t: string, flight: string): AircraftKind {
  const type = t.toUpperCase();
  const call = flight.toUpperCase().trim();

  if (HELI_TYPES.has(type) || type.startsWith('H') && type.length <= 4) return 'helicopter';

  for (const prefix of MILITARY_CALLSIGN_PREFIXES) {
    if (call.startsWith(prefix)) return 'military';
  }
  for (const mt of MILITARY_TYPES) {
    if (type.startsWith(mt)) return 'military';
  }

  return 'plane';
}

export async function fetchAircraft(): Promise<AircraftState[]> {
  try {
    const res = await fetch(
      `/api/adsb/lat/${NYC_LAT}/lon/${NYC_LON}/dist/${DIST_NM}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const ac: Record<string, unknown>[] = data.ac ?? [];

    return ac
      .filter(a => {
        const notGround = a.alt_baro !== 'ground' && typeof a.alt_baro === 'number';
        return notGround && typeof a.lat === 'number' && typeof a.lon === 'number';
      })
      .map(a => {
        const t = typeof a.t === 'string' ? a.t.toUpperCase() : '';
        const flight = typeof a.flight === 'string' ? a.flight.trim() : '';
        return {
          hex: a.hex as string,
          lat: a.lat as number,
          lon: a.lon as number,
          alt: typeof a.alt_baro === 'number' ? a.alt_baro : 0,
          alt_baro: typeof a.alt_baro === 'number' ? a.alt_baro : undefined,
          track: typeof a.track === 'number' ? a.track : 0,
          gs: typeof a.gs === 'number' ? a.gs : 0,
          flight: flight || undefined,
          t: t || undefined,
          r: typeof a.r === 'string' ? a.r.trim() : undefined,
          kind: classifyAircraft(t, flight),
        };
      });
  } catch {
    return [];
  }
}
