export interface SchoolZoneProperties {
  dbn: string;
  school_name: string;
  ela_score: number | null;
  math_score: number | null;
  attendance: number | null;
  ela_percentile: number | null;
  math_percentile: number | null;
  zone_type: 'elementary' | 'middle' | 'high';
}

export interface ParcelProperties {
  bbl: string;
  address: string;
  borough: string;
  numfloors: number;
  landuse: string;
  zonedist1: string;
  lotarea: number;
  yearbuilt: number;
  unitsres: number;
  bldgclass: string;
  park_score: number;    // 0–100 percentile rank (−1 = excluded open space parcel)
  park_gravity: number;  // raw gravity value: Σ acres/(dist_m + 50)²
  density: number;       // derived: unitsres / lotarea * 1000
  flood_100yr: number;   // 0 or 1 — in FEMA 100yr floodplain
  flood_storm: number;   // 0 or 1 — in NYC DEP moderate stormwater zone
}

export interface LayerInfo {
  what: string;       // What this layer shows (1–2 sentences, plain language)
  how: string;        // How it was calculated / what the value means
  source: string;     // Dataset name, agency, year, URL if useful
  caveats?: string;   // Known limitations, exclusions, or things to watch out for
  formula?: string;   // Optional: formula string displayed in mono
}

export interface Layer {
  id: string;
  label: string;
  description: string;  // Short sidebar tooltip (kept for backwards compat)
  info: LayerInfo;       // Rich structured info for ⓘ panels
  property: keyof ParcelProperties;
  type: 'continuous' | 'categorical' | 'binary';
  colorScale: string[];
  accentColor: string;
  legendMin?: string;  // Label for low end of gradient (default "Low")
  legendMax?: string;  // Label for high end of gradient (default "High")
  categories?: Record<string, string>;
  enabled: boolean;
  opacity: number;
}

export interface LayerGroup {
  id: string;
  label: string;
  layers: Layer[];
}

export interface SearchResult {
  label: string;
  lat: number;
  lng: number;
  bbl?: string;
}

// ── Overlay (McHarg composite) types ─────────────────────────

export type OverlayLayerId =
  | 'park_score'
  | 'el_ela_pct'
  | 'floors_pct'
  | 'year_pct'
  | 'density_pct'
  | 'flood_100yr'
  | 'flood_storm';

export interface OverlayLayer {
  id: OverlayLayerId;
  label: string;
  weight: number;    // 0–100 (auto-normalised before use)
  invert: boolean;   // true = higher raw value is worse (e.g. flood risk)
}

export interface Overlay {
  id: string;        // uuid
  name: string;
  created: string;   // ISO date string
  layers: OverlayLayer[];
}

// Parcel field accessor for overlay scoring (all 0–100 or binary 0/1)
export const OVERLAY_FIELDS: Record<OverlayLayerId, {
  label: string;
  description: string;
  defaultInvert: boolean;
  isBinary: boolean;
}> = {
  park_score:   { label: 'Park Access',        description: 'Percentile rank of gravity-model park access score',           defaultInvert: false, isBinary: false },
  el_ela_pct:   { label: 'School Quality (ES)', description: 'ELA proficiency percentile for zoned elementary school',       defaultInvert: false, isBinary: false },
  floors_pct:   { label: 'Building Height',     description: 'Percentile rank of floors above grade',                        defaultInvert: false, isBinary: false },
  year_pct:     { label: 'Year Built',          description: 'Percentile rank of construction year (newer = higher)',        defaultInvert: false, isBinary: false },
  density_pct:  { label: 'Residential Density', description: 'Percentile rank of residential units per 1,000 sf lot area',  defaultInvert: false, isBinary: false },
  flood_100yr:  { label: '100yr Flood Risk',    description: 'In FEMA 100-year floodplain (1 = yes, 0 = no)',               defaultInvert: true,  isBinary: true  },
  flood_storm:  { label: 'Stormwater Risk',     description: 'In NYC DEP moderate stormwater flood zone (1 = yes, 0 = no)', defaultInvert: true,  isBinary: true  },
};
