/**
 * F Line subway — shape-following smooth movement
 *
 * Architecture:
 * 1. Load /data/f_line.json (baked from MTA GTFS static — 28KB)
 * 2. Poll /api/mta-f every 15s → train positions (stopId + status)
 * 3. For each train: find its current + next stop indices on the canonical shape
 * 4. Interpolate position along the shape polyline based on elapsed time
 * 5. Render as a dot that follows track geometry exactly
 */

import { latlngToImagePx, IMAGE_DIMS } from '../../permits/coordinates';

export const F_COLOR = '#FF6319';
const POLL_MS = 15000;
const AVG_STOP_SEC = 90; // average travel time between F stops (seconds)

// ── Types ─────────────────────────────────────────────────────

interface FLineData {
  shape_n: [number, number][];  // northbound: Coney Island(0) → Jamaica(350)
  shape_s: [number, number][];  // southbound: Jamaica(0) → Coney Island(350)
  stops: Record<string, {
    lat: number; lon: number; name: string;
    n_idx: number; s_idx: number;
  }>;
}

interface MTAVehicle {
  tripId: string;
  routeId: string;
  stopId: string;
  stopSeq: number;
  status: number; // 0=INCOMING_AT, 1=STOPPED_AT, 2=IN_TRANSIT_TO
  timestamp: number; // unix seconds
}

export interface FTrain {
  tripId: string;
  // Viewport coordinates (OSD space)
  vpX: number;
  vpY: number;
  // Heading in degrees (for future icon rotation)
  heading: number;
  // Current stop name (for tooltip)
  stopName: string;
  // Direction
  direction: 'N' | 'S';
}

// ── Shape geometry helpers ────────────────────────────────────

function toVp(lat: number, lon: number): { x: number; y: number } {
  const { x, y } = latlngToImagePx(lat, lon);
  return { x: x / IMAGE_DIMS.width, y: y / IMAGE_DIMS.width };
}

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Walk a shape polyline from startIdx to endIdx and return
 * the interpolated [lat, lon] at fractional progress (0–1).
 */
function interpolateShape(
  shape: [number, number][],
  startIdx: number,
  endIdx: number,
  t: number
): { lat: number; lon: number; heading: number } {
  const from = Math.min(startIdx, endIdx);
  const to   = Math.max(startIdx, endIdx);
  // Clamp indices
  const i0 = Math.max(0, Math.min(from, shape.length - 1));
  const i1 = Math.max(0, Math.min(to,   shape.length - 1));

  if (i0 === i1) {
    return { lat: shape[i0][0], lon: shape[i0][1], heading: 0 };
  }

  // Total segment count
  const segCount = i1 - i0;
  const fracIdx = t * segCount; // 0 → segCount
  const seg = Math.min(Math.floor(fracIdx), segCount - 1);
  const segT = fracIdx - seg;

  const pA = shape[i0 + seg];
  const pB = shape[Math.min(i0 + seg + 1, i1)];

  const lat = pA[0] + (pB[0] - pA[0]) * segT;
  const lon = pA[1] + (pB[1] - pA[1]) * segT;
  const hdg = bearing(pA[0], pA[1], pB[0], pB[1]);

  return { lat, lon, heading: hdg };
}

// ── Module state ──────────────────────────────────────────────

let fLineData: FLineData | null = null;
let loadingData = false;

async function loadFLineData(): Promise<FLineData | null> {
  if (fLineData) return fLineData;
  if (loadingData) return null;
  loadingData = true;
  try {
    // Served from CF Worker — avoids Vercel SPA catch-all swallowing /data/*.json
    const res = await fetch('https://mta-proxy.zig191476.workers.dev/f-line');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fLineData = await res.json() as FLineData;
    return fLineData;
  } catch {
    loadingData = false;
    return null;
  }
}

// Determine direction from trip_id convention:
// MTA trip IDs contain direction: e.g. "AFA23GEN-F059-Weekday-00_000600_F..N07R"
// "..N" = northbound, "..S" = southbound
function getDirection(tripId: string): 'N' | 'S' {
  if (tripId.includes('..N') || tripId.includes('_N_') || tripId.endsWith('N')) return 'N';
  if (tripId.includes('..S') || tripId.includes('_S_') || tripId.endsWith('S')) return 'S';
  // Fallback: check shape suffix in trip_id
  return tripId.includes('N0') || tripId.includes('N1') || tripId.includes('N2') ? 'N' : 'S';
}

// ── Main export: compute current F train positions ────────────

export async function computeFTrainPositions(
  vehicles: MTAVehicle[],
  nowMs: number = Date.now()
): Promise<FTrain[]> {
  const data = await loadFLineData();
  if (!data) return [];

  const trains: FTrain[] = [];

  for (const v of vehicles) {
    const dir = getDirection(v.tripId);
    const shape = dir === 'N' ? data.shape_n : data.shape_s;
    const idxKey = dir === 'N' ? 'n_idx' : 's_idx';

    // Find current stop in our stop map
    const currentStop = data.stops[v.stopId];
    if (!currentStop) continue;

    const currentIdx = currentStop[idxKey];
    const currentStopName = currentStop.name;

    // Elapsed since last update
    const elapsedSec = v.timestamp > 0
      ? (nowMs / 1000) - v.timestamp
      : 0;

    let vpX: number, vpY: number, heading: number;

    if (v.status === 1) {
      // STOPPED_AT: place exactly at stop
      const pos = toVp(currentStop.lat, currentStop.lon);
      vpX = pos.x; vpY = pos.y; heading = 0;
    } else {
      // IN_TRANSIT_TO or INCOMING_AT: interpolate toward currentStop
      // The train is heading *to* currentStop — find previous stop on shape
      // Estimate progress based on elapsed time since timestamp
      const t = Math.min(elapsedSec / AVG_STOP_SEC, 0.99);

      // Previous stop = the one just before currentIdx on the shape
      // Find nearest stop with a lower shape index
      let prevIdx = Math.max(0, currentIdx - 15); // fallback: 15 shape pts back
      let prevName = '';

      // Look for a real previous stop
      const otherStops = Object.values(data.stops).filter(
        s => s[idxKey] < currentIdx && s[idxKey] > currentIdx - 40
      );
      if (otherStops.length > 0) {
        const prev = otherStops.reduce((a, b) =>
          Math.abs(a[idxKey] - currentIdx) < Math.abs(b[idxKey] - currentIdx) ? a : b
        );
        prevIdx = prev[idxKey];
        prevName = prev.name;
      }

      const { lat, lon, heading: hdg } = interpolateShape(shape, prevIdx, currentIdx, t);
      const pos = toVp(lat, lon);
      vpX = pos.x; vpY = pos.y; heading = hdg;
      void prevName; // used for future tooltip
    }

    trains.push({
      tripId: v.tripId,
      vpX, vpY, heading,
      stopName: currentStopName,
      direction: dir,
    });
  }

  return trains;
}

// ── Poll MTA and return computed positions ────────────────────

export async function fetchFTrains(): Promise<FTrain[]> {
  try {
    // CF Worker proxy — bypasses MTA's Vercel IP block
    const res = await fetch(
      'https://mta-proxy.zig191476.workers.dev/subway?route=F',
      { cache: 'no-store' }
    );
    if (!res.ok) return [];
    const vehicles: MTAVehicle[] = await res.json();
    return computeFTrainPositions(vehicles);
  } catch {
    return [];
  }
}

export { POLL_MS };
