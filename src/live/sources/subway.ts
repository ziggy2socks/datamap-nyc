/**
 * MTA Subway train positions via GTFS-RT
 * Requires API key via Vercel proxy — gracefully returns [] on failure.
 *
 * MTA GTFS-RT endpoint: https://api-endpoint.mta.info/Feeds/gtfs-rt
 * Proxied via /api/mta/gtfs-rt in vercel.json
 *
 * Since GTFS-RT is protobuf and complex to parse without a dependency,
 * we use the MTA's simpler subway data via their public API:
 * https://bustime.mta.info/api/siri/vehicle-monitoring.json
 *
 * For now, uses the MTA's GTFS static stop positions to place trains at their
 * last known stop. Positions update every ~15 seconds.
 */

export const SUBWAY_COLORS: Record<string, string> = {
  '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
  '4': '#00933C', '5': '#00933C', '6': '#00933C',
  '7': '#B933AD',
  'A': '#0039A6', 'C': '#0039A6', 'E': '#0039A6',
  'B': '#FF6319', 'D': '#FF6319', 'F': '#FF6319', 'M': '#FF6319',
  'G': '#6CBE45',
  'J': '#996633', 'Z': '#996633',
  'L': '#A7A9AC',
  'N': '#FCCC0A', 'Q': '#FCCC0A', 'R': '#FCCC0A', 'W': '#FCCC0A',
  'S': '#808183',
};

export interface SubwayTrain {
  id: string;
  line: string;
  lat: number;
  lon: number;
  bearing?: number;
  status?: string; // IN_TRANSIT_TO, STOPPED_AT, etc.
  stopId?: string;
}

// Key NYC subway station positions (compact lookup for stop_id → lat/lon)
// These are approximate centroids — good enough for isometric map dots
// Full GTFS stops.txt has 500+ entries; this covers the major trunk lines
export const STOP_POSITIONS: Record<string, [number, number]> = {
  // IRT 1/2/3 (Seventh Ave / Broadway-7th Ave)
  '101': [40.8681,-73.9178], '102': [40.8527,-73.9322], '103': [40.8448,-73.9392],
  '104': [40.8367,-73.9448], '106': [40.8283,-73.9508], '107': [40.8203,-73.9550],
  '108': [40.8147,-73.9584], '109': [40.8074,-73.9631], '110': [40.8000,-73.9681],
  '111': [40.7934,-73.9724], '112': [40.7880,-73.9757], '113': [40.7834,-73.9804],
  '114': [40.7764,-73.9818], '115': [40.7718,-73.9835], '116': [40.7661,-73.9877],
  '117': [40.7614,-73.9930], '118': [40.7554,-73.9869], '119': [40.7504,-73.9939],
  '120': [40.7454,-73.9881], '121': [40.7404,-73.9900], '122': [40.7354,-73.9963],
  '123': [40.7299,-74.0001], '124': [40.7248,-74.0038], '125': [40.7180,-74.0099],
  '126': [40.7121,-74.0131], '127': [40.7028,-74.0158], '128': [40.6924,-74.0152],
  // IND A/C/E (Eighth Ave)
  'A02': [40.7681,-73.9519], 'A03': [40.7627,-73.9581], 'A05': [40.7537,-73.9671],
  'A06': [40.7484,-73.9720], 'A07': [40.7432,-73.9777], 'A09': [40.7358,-73.9892],
  'A10': [40.7308,-73.9982], 'A11': [40.7253,-74.0019], 'A12': [40.7180,-74.0113],
  'A14': [40.7108,-74.0138], 'A15': [40.7028,-74.0158], 'A16': [40.6887,-74.0179],
  // BMT N/Q/R/W (Broadway)
  'R01': [40.7614,-73.9960], 'R03': [40.7551,-73.9869], 'R04': [40.7492,-73.9873],
  'R06': [40.7421,-73.9892], 'R08': [40.7362,-73.9900], 'R09': [40.7308,-73.9932],
  'R11': [40.7253,-73.9984], 'R13': [40.7180,-74.0071], 'R14': [40.7108,-74.0099],
  // L train (14th St - Canarsie)
  'L01': [40.7413,-74.0015], 'L02': [40.7413,-73.9967], 'L03': [40.7413,-73.9897],
  'L05': [40.7413,-73.9814], 'L06': [40.7413,-73.9744], 'L08': [40.7057,-73.9458],
  // 4/5/6 (Lexington Ave)
  '601': [40.7681,-73.9638], '602': [40.7625,-73.9656], '603': [40.7558,-73.9674],
  '604': [40.7504,-73.9697], '606': [40.7444,-73.9717], '607': [40.7381,-73.9767],
  '608': [40.7328,-73.9812], '609': [40.7261,-73.9849], '610': [40.7181,-73.9868],
  '611': [40.7108,-73.9869], '612': [40.7028,-73.9869], '613': [40.6924,-73.9866],
};

export async function fetchSubwayTrains(): Promise<SubwayTrain[]> {
  // TODO: When MTA API key is available, proxy via /api/mta/vehicles
  // The MTA GTFS-RT protobuf feed requires either:
  //   1. A protobuf parser dependency (heavy)
  //   2. A server-side decode (Vercel Edge Function)
  // For now return empty — stub for future wiring
  return [];
}
