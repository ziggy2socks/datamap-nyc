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

export interface Layer {
  id: string;
  label: string;
  description: string;
  property: keyof ParcelProperties;
  type: 'continuous' | 'categorical' | 'binary';
  colorScale: string[];
  accentColor: string;
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
