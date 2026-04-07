// NYC Motor Vehicle Collisions (h9gi-nx95)
export interface Crash {
  collision_id: string;
  crash_date: string;         // ISO: "2026-03-31T00:00:00.000"
  crash_time: string;         // "14:23"
  borough?: string;
  zip_code?: string;
  latitude?: string;
  longitude?: string;
  on_street_name?: string;
  cross_street_name?: string;
  off_street_name?: string;

  number_of_persons_injured: string;
  number_of_persons_killed: string;
  number_of_pedestrians_injured: string;
  number_of_pedestrians_killed: string;
  number_of_cyclist_injured: string;
  number_of_cyclist_killed: string;
  number_of_motorist_injured: string;
  number_of_motorist_killed: string;

  contributing_factor_vehicle_1?: string;
  contributing_factor_vehicle_2?: string;
  contributing_factor_vehicle_3?: string;

  vehicle_type_code1?: string;
  vehicle_type_code2?: string;

  // Derived client-side
  severity?: 'fatal' | 'injury' | 'none';
  mode?: 'pedestrian' | 'cyclist' | 'motorist' | 'multi';
}

export type SeverityFilter = 'all' | 'fatal' | 'injury';
export type ModeFilter = 'all' | 'pedestrian' | 'cyclist' | 'motorist';
