// NYC DOHMH Restaurant Inspections (43nn-pn8j)
// One row per violation per inspection — we deduplicate to one per restaurant (most recent)
export interface RestaurantRow {
  camis: string;
  dba?: string;
  boro?: string;
  building?: string;
  street?: string;
  zipcode?: string;
  cuisine_description?: string;
  inspection_date?: string;
  action?: string;
  violation_code?: string;
  violation_description?: string;
  critical_flag?: string;   // "Critical" | "Not Critical" | "Not Applicable"
  score?: string;
  grade?: string;           // "A" | "B" | "C" | "Z" | "P" | "N"
  grade_date?: string;
  inspection_type?: string;
  latitude?: string;
  longitude?: string;
  nta?: string;
}

// Deduplicated — one per restaurant, most recent inspection
export interface Restaurant {
  camis: string;
  name: string;
  boro: string;
  address: string;
  zipcode: string;
  cuisine: string;
  grade: string;             // A / B / C / Z / P / N / ?
  score: number;             // lower = better
  inspectionDate: string;
  gradeDate: string;
  inspectionType: string;
  violations: ViolationSummary[];
  latitude: number;
  longitude: number;
  nta: string;
}

export interface ViolationSummary {
  code: string;
  description: string;
  critical: boolean;
}

export type GradeFilter = 'all' | 'A' | 'B' | 'C' | 'warn';
