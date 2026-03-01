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
  park_score: number; // 0–100 normalized gravity score
}

export interface Layer {
  id: string;
  label: string;
  description: string;
  property: keyof ParcelProperties;
  type: 'continuous' | 'categorical';
  colorScale: string[]; // low→high for continuous, categorical values for categorical
  categories?: Record<string, string>; // for categorical: value → label
  enabled: boolean;
  opacity: number;
}

export interface SearchResult {
  label: string;
  lat: number;
  lng: number;
  bbl?: string;
}
