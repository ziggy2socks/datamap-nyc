import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './GlobeApp.css';

// ── Binary format ─────────────────────────────────────────────────────────────
interface GlobeHeader {
  year: number; width: number; height: number; weeks: number;
  temp_min: number; temp_max: number; ocean_sentinel: number; dates: string[];
}
interface GlobeData { header: GlobeHeader; pixels: Uint8Array; }

// 2020–2025 bins hosted on R2 (pending credentials) — only 2026 on Vercel for now
const AVAILABLE_YEARS = [2026];
const DEFAULT_YEAR    = 2026;
const FORECAST_YEAR   = 'forecast' as const;
type YearSelection    = number | typeof FORECAST_YEAR;

// ── Forecast manifest ─────────────────────────────────────────────────────────
// Nightly cron (api/cron-forecast.js) bakes 7 forecast tiles to Vercel Blob.
// Manifest at forecast/manifest.json lists the blob URLs for each day.
interface ForecastManifest {
  generated: string;
  startDate: string;
  endDate: string;
  days: number;
  files: { day: number; date: string; url: string }[];
}

const OCEAN_SENTINEL = 255;

async function loadForecastManifest(): Promise<ForecastManifest> {
  const r = await fetch('/data/forecast/manifest.json');
  if (!r.ok) throw new Error(`Forecast not available yet. Check back after 2am UTC.`);
  const raw = await r.json();
  // Normalise: ensure files have a `url` field (GitHub Action bake uses `path`)
  const files = (raw.files ?? []).map((f: { day: number; date: string; url?: string; path?: string }) => ({
    ...f,
    url: f.url ?? f.path,
  }));
  return { ...raw, files };
}

async function loadForecastDay(url: string): Promise<{ pixels: Uint8Array; date: string }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Forecast day unavailable (${r.status})`);
  const buf = await r.arrayBuffer();
  const view = new DataView(buf);
  const hlen = view.getUint32(0, true);
  const headerText = new TextDecoder().decode(new Uint8Array(buf, 4, hlen));
  const header = JSON.parse(headerText);
  const pixels = new Uint8Array(buf.slice(4 + hlen, 4 + hlen + 720 * 360));
  const date = header.dates?.[0] ?? header.date ?? '';
  return { pixels, date };
}



// ── Threshold definitions ─────────────────────────────────────────────────────
interface Threshold {
  id: string; label: string; temp_c: number;
  color: string; lineWidth: number; defaultOn: boolean; description: string;
}

const THRESHOLDS: Threshold[] = [
  { id: 'frost',    label: 'Frost line',       temp_c: 0,  color: '#0a0aee', lineWidth: 2.0, defaultOn: true,  description: '0°C — soil freezing threshold' },
  { id: 'crocus',   label: 'Crocus emergence', temp_c: 5,  color: '#0088cc', lineWidth: 1.5, defaultOn: false, description: '5°C / 41°F — earliest spring signal' },
  { id: 'bulb',     label: 'Bulb awakening',   temp_c: 10, color: '#007744', lineWidth: 1.5, defaultOn: false, description: '10°C / 50°F — tulips & daffodils break dormancy' },
  { id: 'planting', label: 'Planting window',  temp_c: 13, color: '#cc8800', lineWidth: 1.5, defaultOn: false, description: '13°C / 55°F — fall bulb planting; tomato transplant zone' },
  { id: 'corn',     label: 'Corn belt',        temp_c: 18, color: '#cc4400', lineWidth: 1.5, defaultOn: false, description: '18°C / 64°F — optimal corn germination' },
  { id: 'heat',     label: 'Heat stress',      temp_c: 35, color: '#cc0000', lineWidth: 1.5, defaultOn: false, description: '35°C / 95°F — crops under heat stress' },
];

// ── Color ramp ────────────────────────────────────────────────────────────────
const COLOR_STOPS: { v: number; r: number; g: number; b: number }[] = [
  { v: 0,   r: 10,  g: 20,  b: 80  },
  { v: 50,  r: 30,  g: 80,  b: 180 },
  { v: 90,  r: 60,  g: 140, b: 220 },
  { v: 115, r: 140, g: 210, b: 255 },
  { v: 120, r: 200, g: 235, b: 255 },
  { v: 125, r: 220, g: 245, b: 255 },
  { v: 130, r: 190, g: 235, b: 200 },
  { v: 150, r: 160, g: 220, b: 140 },
  { v: 175, r: 240, g: 230, b: 80  },
  { v: 210, r: 255, g: 150, b: 30  },
  { v: 254, r: 220, g: 30,  b: 30  },
];

const LUMA = new Uint8ClampedArray(256 * 4);
for (let i = 0; i < 255; i++) {
  let lo = COLOR_STOPS[0], hi = COLOR_STOPS[1];
  for (let s = 0; s < COLOR_STOPS.length - 1; s++) {
    if (i >= COLOR_STOPS[s].v && i <= COLOR_STOPS[s + 1].v) { lo = COLOR_STOPS[s]; hi = COLOR_STOPS[s + 1]; break; }
  }
  const f = lo.v === hi.v ? 0 : (i - lo.v) / (hi.v - lo.v);
  LUMA[i*4]   = Math.round(lo.r + (hi.r - lo.r) * f);
  LUMA[i*4+1] = Math.round(lo.g + (hi.g - lo.g) * f);
  LUMA[i*4+2] = Math.round(lo.b + (hi.b - lo.b) * f);
  LUMA[i*4+3] = 255;
}
LUMA[255*4+3] = 0;

const TEMP_MIN = -55, TEMP_RANGE = 105;
function tempToU8(t: number): number { return Math.round((t - TEMP_MIN) / TEMP_RANGE * 254); }

// ── Draw temperature texture ──────────────────────────────────────────────────
function drawFrame(pixels: Uint8Array, frameIdx: number, w: number, h: number, imgData: ImageData) {
  const offset = frameIdx * w * h;
  const out = imgData.data;
  for (let i = 0; i < w * h; i++) {
    const v = pixels[offset + i], src = v * 4, dst = i * 4;
    out[dst] = LUMA[src]; out[dst+1] = LUMA[src+1]; out[dst+2] = LUMA[src+2]; out[dst+3] = LUMA[src+3];
  }
}

// ── lat/lon → unit sphere xyz ─────────────────────────────────────────────────
// dataSphere has rotation.y = Math.PI to fix equirectangular UV alignment,
// so contour points need the same rotation applied (negate x and z).
function latLonToSphere(lat: number, lon: number): THREE.Vector3 {
  const phi   = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  // Base coords
  const x = -Math.sin(phi) * Math.cos(theta);
  const y =  Math.cos(phi);
  const z =  Math.sin(phi) * Math.sin(theta);
  // Apply rotation.y = Math.PI: x → -x, z → -z
  return new THREE.Vector3(-x, y, -z);
}

// ── Extract contour segments via marching squares ────────────────────────────
// Works on the downsampled grid (every STEP pixels) to produce clean polylines.
// Returns array of polyline segments, each as array of THREE.Vector3 on unit sphere.
function extractContourSegments(
  pixels: Uint8Array,
  frameIdx: number,
  w: number, h: number,
  u8target: number
): THREE.Vector3[][] {
  const offset = frameIdx * w * h;
  const OCEAN  = 255;
  const STEP   = 1; // sample every pixel for maximum resolution

  // Helper: get value at pixel, treating ocean as NaN-equivalent (use -999)
  function val(px: number, py: number): number {
    const ix = Math.min(w - 1, Math.max(0, Math.round(px)));
    const iy = Math.min(h - 1, Math.max(0, Math.round(py)));
    const v  = pixels[offset + iy * w + ix];
    return v === OCEAN ? -999 : v;
  }

  // Convert texture pixel coords to lat/lon
  function pixToLatLon(px: number, py: number): [number, number] {
    const lon = px * 0.5 - 179.75;
    const lat = 89.75 - py * 0.5;
    return [lat, lon];
  }

  // Build edge crossing map: for each cell (gx, gy), find horizontal & vertical crossings
  // Each crossing = fractional pixel position where temp == u8target
  // Store as Map: "gx,gy,dir" → [tx, ty] crossing point

  type EdgeKey = string;
  const edgeCrossings = new Map<EdgeKey, [number, number]>();

  const gw = Math.floor(w / STEP);
  const gh = Math.floor(h / STEP);

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const px = gx * STEP, py = gy * STEP;

      // Horizontal edge: (gx,gy) → (gx+1, gy)
      if (gx < gw - 1) {
        const vL = val(px, py), vR = val(px + STEP, py);
        if (vL !== -999 && vR !== -999 && (vL < u8target) !== (vR < u8target)) {
          // Interpolate exact crossing position
          const t = (u8target - vL) / (vR - vL);
          edgeCrossings.set(`h,${gx},${gy}`, [px + t * STEP, py]);
        }
      }

      // Vertical edge: (gx,gy) → (gx, gy+1)
      if (gy < gh - 1) {
        const vT = val(px, py), vB = val(px, py + STEP);
        if (vT !== -999 && vB !== -999 && (vT < u8target) !== (vB < u8target)) {
          const t = (u8target - vT) / (vB - vT);
          edgeCrossings.set(`v,${gx},${gy}`, [px, py + t * STEP]);
        }
      }
    }
  }

  if (edgeCrossings.size === 0) return [];

  // Chain edges into polylines using marching squares connectivity
  // For each cell, determine which edges are crossed and connect pairs
  // Marching squares: 4 corners, 16 cases, connect crossing edges pairwise

  const segments: THREE.Vector3[][] = [];
  const usedEdges = new Set<EdgeKey>();

  function getEdge(key: EdgeKey): [number, number] | undefined {
    return edgeCrossings.get(key);
  }

  // For each cell, find its active edges and chain them
  // Collect all active edge pairs per cell
  const cellEdgePairs: Array<[EdgeKey, EdgeKey]> = [];

  for (let gy = 0; gy < gh - 1; gy++) {
    for (let gx = 0; gx < gw - 1; gx++) {
      const px = gx * STEP, py = gy * STEP;
      const tl = val(px,        py);
      const tr = val(px + STEP, py);
      const bl = val(px,        py + STEP);
      const br = val(px + STEP, py + STEP);

      // Skip cells with ocean
      if (tl === -999 || tr === -999 || bl === -999 || br === -999) continue;

      const corners = [
        (tl < u8target) ? 1 : 0,
        (tr < u8target) ? 1 : 0,
        (br < u8target) ? 1 : 0,
        (bl < u8target) ? 1 : 0,
      ];
      const caseIdx = corners[0]*8 + corners[1]*4 + corners[2]*2 + corners[3];

      // Edge keys: top=h,gx,gy  right=v,gx+1,gy  bottom=h,gx,gy+1  left=v,gx,gy
      const top    = `h,${gx},${gy}`;
      const right  = `v,${gx+1},${gy}`;
      const bottom = `h,${gx},${gy+1}`;
      const left   = `v,${gx},${gy}`;

      // 16 marching squares cases → edge pairs to connect
      const connections: [EdgeKey, EdgeKey][] = [];
      switch (caseIdx) {
        case 1:  case 14: connections.push([bottom, left]);   break;
        case 2:  case 13: connections.push([right,  bottom]); break;
        case 3:  case 12: connections.push([right,  left]);   break;
        case 4:  case 11: connections.push([top,    right]);  break;
        case 5:           connections.push([top,    left], [right, bottom]); break;
        case 6:  case 9:  connections.push([top,    bottom]); break;
        case 7:  case 8:  connections.push([top,    left]);   break;
        case 10:          connections.push([top,    right], [bottom, left]); break;
      }

      for (const pair of connections) {
        if (edgeCrossings.has(pair[0]) && edgeCrossings.has(pair[1])) {
          cellEdgePairs.push(pair);
        }
      }
    }
  }

  // Build adjacency: edge → list of edges it connects to
  const adj = new Map<EdgeKey, EdgeKey[]>();
  for (const [a, b] of cellEdgePairs) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }

  // Walk chains starting from unvisited edges
  for (const startKey of adj.keys()) {
    if (usedEdges.has(startKey)) continue;

    // Walk in one direction
    const chain: EdgeKey[] = [startKey];
    usedEdges.add(startKey);

    let current = startKey;
    while (true) {
      const neighbors = adj.get(current) ?? [];
      const next = neighbors.find(n => !usedEdges.has(n));
      if (!next) break;
      usedEdges.add(next);
      chain.push(next);
      current = next;
    }

    if (chain.length < 2) continue;

    // Convert chain of edge keys → 3D sphere points
    const pts: THREE.Vector3[] = [];
    for (const key of chain) {
      const cp = getEdge(key);
      if (!cp) continue;
      const [lat, lon] = pixToLatLon(cp[0], cp[1]);
      pts.push(latLonToSphere(lat, lon));
    }
    if (pts.length >= 2) {
      // Close the loop if endpoints are within ~2° of each other
      const first = pts[0], last = pts[pts.length - 1];
      if (first.distanceTo(last) < 0.035) {
        pts.push(pts[0].clone());
      }
      segments.push(pts);
    }
  }

  return segments;
}

// ── Project 3D point to screen space ─────────────────────────────────────────
const _v3 = new THREE.Vector3();
function projectToScreen(
  point: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  w: number, h: number,
  dpr: number
): { x: number; y: number; visible: boolean } {
  _v3.copy(point);
  // Back-face cull: clip slightly before the horizon to avoid edge bleed
  const camDir = camera.position.clone().normalize();
  const visible = _v3.dot(camDir) > 0.12;

  _v3.project(camera);
  return {
    x: (_v3.x * 0.5 + 0.5) * w * dpr,
    y: (-_v3.y * 0.5 + 0.5) * h * dpr,
    visible,
  };
}

// ── Chaikin smoothing on sphere points ───────────────────────────────────────
// Repeatedly cuts corners: each edge AB → two new points at 25% and 75%.
// Applied in 3D then re-normalized to unit sphere so points stay on surface.
function chaikinSphere(pts: THREE.Vector3[], iterations = 2): THREE.Vector3[] {
  let cur = pts;
  for (let iter = 0; iter < iterations; iter++) {
    if (cur.length < 3) break;
    const next: THREE.Vector3[] = [];
    next.push(cur[0].clone());
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i], b = cur[i + 1];
      const q = new THREE.Vector3().lerpVectors(a, b, 0.25).normalize();
      const r = new THREE.Vector3().lerpVectors(a, b, 0.75).normalize();
      next.push(q, r);
    }
    next.push(cur[cur.length - 1].clone());
    cur = next;
  }
  return cur;
}

// ── Extract coastline segments ────────────────────────────────────────────────
// Traces the land/ocean boundary using the ocean sentinel value (255).
// Land = any value < 255. Ocean = 255.
// Same marching squares approach as temperature contours but on the static mask.
// Result cached once — coastline never changes between frames.
function extractCoastlineSegments(pixels: Uint8Array, w: number, h: number): THREE.Vector3[][] {
  const OCEAN  = 255;
  const STEP   = 1;
  const gw     = Math.floor(w / STEP);
  const gh     = Math.floor(h / STEP);
  // Use frame 0 only — mask is identical across all frames
  const offset = 0;

  function isLand(px: number, py: number): boolean {
    const ix = Math.min(w - 1, Math.max(0, Math.round(px)));
    const iy = Math.min(h - 1, Math.max(0, Math.round(py)));
    return pixels[offset + iy * w + ix] !== OCEAN;
  }

  function pixToLatLon(px: number, py: number): [number, number] {
    return [89.75 - py * 0.5, px * 0.5 - 179.75];
  }

  const edgeCrossings = new Map<string, [number, number]>();

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const px = gx * STEP, py = gy * STEP;
      // Horizontal edge
      if (gx < gw - 1) {
        const l = isLand(px, py), r = isLand(px + STEP, py);
        if (l !== r) edgeCrossings.set(`h,${gx},${gy}`, [px + STEP * 0.5, py]);
      }
      // Vertical edge
      if (gy < gh - 1) {
        const t = isLand(px, py), b = isLand(px, py + STEP);
        if (t !== b) edgeCrossings.set(`v,${gx},${gy}`, [px, py + STEP * 0.5]);
      }
    }
  }

  if (edgeCrossings.size === 0) return [];

  // Build adjacency via marching squares cell connections
  const cellEdgePairs: Array<[string, string]> = [];
  for (let gy = 0; gy < gh - 1; gy++) {
    for (let gx = 0; gx < gw - 1; gx++) {
      const px = gx * STEP, py = gy * STEP;
      const corners = [
        isLand(px, py) ? 1 : 0,
        isLand(px + STEP, py) ? 1 : 0,
        isLand(px + STEP, py + STEP) ? 1 : 0,
        isLand(px, py + STEP) ? 1 : 0,
      ];
      const caseIdx = corners[0]*8 + corners[1]*4 + corners[2]*2 + corners[3];
      const top    = `h,${gx},${gy}`;
      const right  = `v,${gx+1},${gy}`;
      const bottom = `h,${gx},${gy+1}`;
      const left   = `v,${gx},${gy}`;
      const connections: [string, string][] = [];
      switch (caseIdx) {
        case 1: case 14: connections.push([bottom, left]);   break;
        case 2: case 13: connections.push([right,  bottom]); break;
        case 3: case 12: connections.push([right,  left]);   break;
        case 4: case 11: connections.push([top,    right]);  break;
        case 5:          connections.push([top,    left], [right, bottom]); break;
        case 6: case 9:  connections.push([top,    bottom]); break;
        case 7: case 8:  connections.push([top,    left]);   break;
        case 10:         connections.push([top,    right], [bottom, left]); break;
      }
      for (const pair of connections) {
        if (edgeCrossings.has(pair[0]) && edgeCrossings.has(pair[1])) {
          cellEdgePairs.push(pair);
        }
      }
    }
  }

  const adj = new Map<string, string[]>();
  for (const [a, b] of cellEdgePairs) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }

  const segments: THREE.Vector3[][] = [];
  const used = new Set<string>();

  for (const startKey of adj.keys()) {
    if (used.has(startKey)) continue;
    const chain: string[] = [startKey];
    used.add(startKey);
    let current = startKey;
    while (true) {
      const next = (adj.get(current) ?? []).find(n => !used.has(n));
      if (!next) break;
      used.add(next); chain.push(next); current = next;
    }
    if (chain.length < 2) continue;
    const pts: THREE.Vector3[] = [];
    for (const key of chain) {
      const cp = edgeCrossings.get(key);
      if (!cp) continue;
      const [lat, lon] = pixToLatLon(cp[0], cp[1]);
      pts.push(latLonToSphere(lat, lon));
    }
    if (pts.length >= 2) {
      const f = pts[0], l = pts[pts.length - 1];
      if (f.distanceTo(l) < 0.035) pts.push(pts[0].clone());
      segments.push(chaikinSphere(pts, 2));
    }
  }
  return segments;
}

// ── Per-frame contour cache ───────────────────────────────────────────────────
interface ContourCache {
  frameIdx: number;
  segments: Map<string, THREE.Vector3[][]>; // threshId → segments
}

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Component ─────────────────────────────────────────────────────────────────
export default function GlobeApp() {
  const mountRef      = useRef<HTMLDivElement>(null);
  const uiRef         = useRef<HTMLDivElement>(null);
  const overlayRef    = useRef<HTMLCanvasElement>(null); // 2D screen-space contour canvas
  const rendererRef   = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef     = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef   = useRef<OrbitControls | null>(null);
  const textureRef    = useRef<THREE.CanvasTexture | null>(null);
  const texCanvasRef  = useRef<HTMLCanvasElement | null>(null);
  const imgDataRef    = useRef<ImageData | null>(null);
  const rafRef        = useRef<number>(0);
  const frameIdxRef   = useRef(0);
  const contourCache    = useRef<ContourCache>({ frameIdx: -1, segments: new Map() });
  const coastlineRef    = useRef<THREE.Vector3[][] | null>(null); // computed once per dataset
  const activeIdsRef    = useRef<Set<string>>(new Set(['frost']));

  const [globeData, setGlobeData]   = useState<GlobeData | null>(null);
  const [loading, setLoading]       = useState(true);
  const [loadProgress, setProgress] = useState(0);
  const [error, setError]           = useState<string | null>(null);
  const [frameIdx, setFrameIdx]     = useState(0);
  const [playing, setPlaying]       = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [selectedYear, setSelectedYear] = useState<YearSelection>(DEFAULT_YEAR);
  const [yearStatus, setYearStatus] = useState<Record<string, 'loading'|'ready'|'error'>>({});
  const [liveProgress, setLiveProgress] = useState(0);
  // Forecast state
  const [forecastManifest, setForecastManifest] = useState<ForecastManifest | null>(null);
  const [forecastDayIdx, setForecastDayIdx] = useState(0);
  const forecastCache = useRef<Map<number, GlobeData>>(new Map());
  const [tooltip, setTooltip]       = useState<{ x: number; y: number; lat: number; lon: number; temp: number | null } | null>(null);
  const raycasterRef                = useRef(new THREE.Raycaster());
  const mousePosRef                 = useRef(new THREE.Vector2());
  const [activeIds, setActiveIds]   = useState<Set<string>>(
    () => new Set(THRESHOLDS.filter(t => t.defaultOn).map(t => t.id))
  );

  // Keep ref in sync for use inside rAF loop
  useEffect(() => { activeIdsRef.current = activeIds; }, [activeIds]);
  useEffect(() => { frameIdxRef.current = frameIdx; }, [frameIdx]);

  // Year data cache — avoid re-fetching already loaded years
  const yearCache = useRef<Map<number, GlobeData>>(new Map());

  // ── Forecast: load manifest when forecast mode selected ───────────────────
  useEffect(() => {
    if (selectedYear !== FORECAST_YEAR) return;
    setLoading(true); setError(null); setLiveProgress(20);
    setYearStatus(s => ({ ...s, forecast: 'loading' }));

    loadForecastManifest()
      .then(manifest => {
        setForecastManifest(manifest);
        setForecastDayIdx(0);
        setLiveProgress(50);
        // Load day 0 immediately
        return loadForecastDay(manifest.files[0].url).then(({ pixels, date }) => ({ pixels, date, manifest }));
      })
      .then(({ pixels, date, manifest }) => {
        const header: GlobeHeader = {
          year: new Date().getFullYear(),
          width: 720, height: 360, weeks: manifest.days,
          temp_min: -55, temp_max: 50,
          ocean_sentinel: OCEAN_SENTINEL,
          dates: manifest.files.map(f => f.date),
        };
        const fullPixels = new Uint8Array(720 * 360);
        fullPixels.set(pixels);
        forecastCache.current.set(0, { header, pixels: fullPixels });
        coastlineRef.current = null;
        setGlobeData({ header, pixels: fullPixels });
        setFrameIdx(0);
        setLiveProgress(100);
        setLoading(false);
        setYearStatus(s => ({ ...s, forecast: 'ready' }));
        void date;
      })
      .catch(() => {
        // Don't set global error — just mark forecast as unavailable so
        // the user can click a year and recover without hard refresh
        setLoading(false);
        setYearStatus(s => ({ ...s, forecast: 'error' }));
        // Fall back to 2026 data so globe isn't blank
        setSelectedYear(DEFAULT_YEAR);
      });
  }, [selectedYear]);

  // ── Forecast: load a specific day when scrubber moves ─────────────────────
  useEffect(() => {
    if (selectedYear !== FORECAST_YEAR || !forecastManifest) return;
    const d = forecastDayIdx;
    if (forecastCache.current.has(d)) {
      const cached = forecastCache.current.get(d)!;
      setGlobeData(cached);
      return;
    }
    const fileEntry = forecastManifest.files[d];
    if (!fileEntry) return;

    loadForecastDay(fileEntry.url).then(({ pixels }) => {
      const header: GlobeHeader = {
        year: new Date().getFullYear(),
        width: 720, height: 360, weeks: forecastManifest.days,
        temp_min: -55, temp_max: 50,
        ocean_sentinel: OCEAN_SENTINEL,
        dates: forecastManifest.files.map(f => f.date),
      };
      const fullPixels = new Uint8Array(720 * 360);
      fullPixels.set(pixels);
      forecastCache.current.set(d, { header, pixels: fullPixels });
      setGlobeData({ header, pixels: fullPixels });
    }).catch(() => {/* silently skip failed day */});
  }, [forecastDayIdx, forecastManifest, selectedYear]);

  // ── Load binary for selected year ─────────────────────────────────────────
  useEffect(() => {
    if (selectedYear === FORECAST_YEAR) return; // handled by forecast effects above
    if (yearCache.current.has(selectedYear as number)) {
      setGlobeData(yearCache.current.get(selectedYear as number)!);
      setFrameIdx(0);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setProgress(0);
    setYearStatus(s => ({ ...s, [selectedYear]: 'loading' }));

    fetch(`/data/soil_globe_texture_${selectedYear}.bin?v=3`)
      .then(async r => {
        if (!r.ok) throw new Error(`${selectedYear} data not yet available`);
        const total = Number(r.headers.get('content-length') ?? 0);
        const reader = r.body!.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); received += value.length;
          if (total > 0) setProgress(Math.round(received / total * 100));
        }
        const full = new Uint8Array(received);
        let pos = 0; for (const c of chunks) { full.set(c, pos); pos += c.length; }
        return full.buffer;
      })
      .then(buf => {
        const view = new DataView(buf);
        const headerLen = view.getUint32(0, true);
        const header: GlobeHeader = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)));
        const pixels = new Uint8Array(buf, 4 + headerLen);
        const data = { header, pixels };
        yearCache.current.set(selectedYear as number, data);
            coastlineRef.current = null; // reset so it rebuilds for new year
        setGlobeData(data);
        setFrameIdx(0);
        setLoading(false);
        setYearStatus(s => ({ ...s, [selectedYear]: 'ready' }));
      })
      .catch(e => {
        setError(e.message);
        setLoading(false);
        setYearStatus(s => ({ ...s, [selectedYear]: 'error' }));
      });
  }, [selectedYear]);

  // ── Init Three.js + overlay canvas rAF loop ────────────────────────────────
  useEffect(() => {
    if (!mountRef.current) return;
    const W = mountRef.current.clientWidth, H = mountRef.current.clientHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0xedecea, 1);
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 1000);
    camera.position.set(0, 0, 3.6);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false; controls.enableDamping = true;
    controls.dampingFactor = 0.05; controls.minDistance = 1.8; controls.maxDistance = 6;
    controls.autoRotate = true; controls.autoRotateSpeed = 0.8;
    controlsRef.current = controls;

    // Ocean sphere — pure white, matches paper background so coastline bleed is invisible
    scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(1.0, 64, 64),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    ));

    const texCanvas = document.createElement('canvas');
    texCanvas.width = 720; texCanvas.height = 360;
    texCanvasRef.current = texCanvas;
    const texture = new THREE.CanvasTexture(texCanvas);
    textureRef.current = texture;

    // Land texture sphere — unlit, full brightness
    const dataSphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.001, 128, 64),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true })
    );
    dataSphere.rotation.y = Math.PI;
    scene.add(dataSphere);



    // Lat/lon grid lines — very thin, semi-transparent white
    {
      const gridGeo = new THREE.BufferGeometry();
      const pts: number[] = [];
      const SEGMENTS = 180; // points per line
      const R = 1.004; // just above all sphere layers
      const toXYZ = (lat: number, lon: number) => {
        const phi   = (90 - lat) * Math.PI / 180;
        const theta = (lon + 180) * Math.PI / 180;
        return [
          R * -Math.sin(phi) * Math.cos(theta),
          R *  Math.cos(phi),
          R *  Math.sin(phi) * Math.sin(theta),
        ];
      };
      // Latitude lines every 10°
      for (let lat = -80; lat <= 80; lat += 10) {
        for (let i = 0; i < SEGMENTS; i++) {
          const lon0 = (i / SEGMENTS) * 360 - 180;
          const lon1 = ((i + 1) / SEGMENTS) * 360 - 180;
          pts.push(...toXYZ(lat, lon0), ...toXYZ(lat, lon1));
        }
      }
      // Longitude lines every 10°
      for (let lon = -180; lon < 180; lon += 10) {
        for (let i = 0; i < SEGMENTS; i++) {
          const lat0 = (i / SEGMENTS) * 180 - 90;
          const lat1 = ((i + 1) / SEGMENTS) * 180 - 90;
          pts.push(...toXYZ(lat0, lon), ...toXYZ(lat1, lon));
        }
      }
      gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const gridMat = new THREE.LineBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.35, depthWrite: false });
      const grid = new THREE.LineSegments(gridGeo, gridMat);
      scene.add(grid);
    }

    // Limb darkening sphere — shader darkens toward edges based on surface normal vs camera
    // This is the correct way to fake spherical depth without a light source
    const limbMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {},
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vViewDir = normalize(-mvPos.xyz);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          float fresnel = 1.0 - max(dot(vNormal, vViewDir), 0.0);
          float dark = pow(fresnel, 2.5) * 0.45;
          gl_FragColor = vec4(0.0, 0.0, 0.0, dark);
        }
      `,
    });
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.002, 128, 64), limbMat));



    const handleResize = () => {
      if (!mountRef.current || !overlayRef.current) return;
      const w = mountRef.current.clientWidth, h = mountRef.current.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      overlayRef.current.width  = w * dpr;
      overlayRef.current.height = h * dpr;
      overlayRef.current.style.width  = w + 'px';
      overlayRef.current.style.height = h + 'px';
    };
    window.addEventListener('resize', handleResize);

    // ── rAF loop: render Three.js + draw contours on overlay canvas ──────────
    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);

      // Draw screen-space contours
      const overlay = overlayRef.current;
      const globeDataSnap = (window as any).__globeData as GlobeData | null;
      if (!overlay || !globeDataSnap) return;

      const ow = overlay.width, oh = overlay.height;
      const ctx2 = overlay.getContext('2d')!;
      ctx2.clearRect(0, 0, ow, oh);

      const activeNow = activeIdsRef.current;
      if (activeNow.size === 0) return;

      const fi = frameIdxRef.current;
      const { header: { width: tw, height: th }, pixels } = globeDataSnap;

      // Rebuild contour cache if frame changed
      if (contourCache.current.frameIdx !== fi) {
        contourCache.current.frameIdx = fi;
        contourCache.current.segments.clear();
      }

      const camW = mountRef.current?.clientWidth ?? ow / dpr;
      const camH = mountRef.current?.clientHeight ?? oh / dpr;

      for (const thresh of THRESHOLDS) {
        if (!activeNow.has(thresh.id)) continue;

        // Build segments if not cached for this frame
        if (!contourCache.current.segments.has(thresh.id)) {
          const raw  = extractContourSegments(pixels, fi, tw, th, tempToU8(thresh.temp_c));
          const segs = raw.map(s => {
            const smoothed = chaikinSphere(s, 3);
            // Re-close after smoothing if endpoints drifted apart but were already near
            const f = smoothed[0], l = smoothed[smoothed.length - 1];
            if (f.distanceTo(l) < 0.05 && smoothed[smoothed.length - 1] !== smoothed[0]) {
              smoothed.push(smoothed[0].clone());
            }
            return smoothed;
          });
          contourCache.current.segments.set(thresh.id, segs);
        }
        const segments = contourCache.current.segments.get(thresh.id)!;

        ctx2.strokeStyle = thresh.color;
        ctx2.lineWidth   = thresh.lineWidth * dpr;
        ctx2.lineCap     = 'round';
        ctx2.lineJoin    = 'round';
        ctx2.shadowBlur  = 0;

        for (const seg of segments) {
          ctx2.beginPath();
          let drawing = false;
          for (const pt of seg) {
            const { x, y, visible } = projectToScreen(pt, camera, camW, camH, dpr);
            if (!visible) { drawing = false; continue; }
            if (!drawing) { ctx2.moveTo(x, y); drawing = true; }
            else { ctx2.lineTo(x, y); }
          }
          ctx2.stroke();
        }
      }

      // Draw coastline — computed once, cached permanently
      if (!coastlineRef.current) {
        coastlineRef.current = extractCoastlineSegments(globeDataSnap.pixels, tw, th);
      }
      if (coastlineRef.current.length > 0) {
        ctx2.strokeStyle = 'rgba(0,0,0,0.22)';
        ctx2.lineWidth   = 0.8 * dpr;
        ctx2.lineCap     = 'round';
        ctx2.lineJoin    = 'round';
        ctx2.shadowBlur  = 0;
        for (const seg of coastlineRef.current) {
          ctx2.beginPath();
          let drawing = false;
          for (const pt of seg) {
            const { x, y, visible } = projectToScreen(pt, camera, camW, camH, dpr);
            if (!visible) { drawing = false; continue; }
            if (!drawing) { ctx2.moveTo(x, y); drawing = true; }
            else { ctx2.lineTo(x, y); }
          }
          ctx2.stroke();
        }
      }
    };
    animate();
    setSceneReady(true);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', handleResize);
      controls.dispose(); texture.dispose(); renderer.dispose();
      if (mountRef.current && renderer.domElement.parentNode === mountRef.current) mountRef.current.removeChild(renderer.domElement);
      cameraRef.current = null; rendererRef.current = null;
      setSceneReady(false);
    };
  }, []);

  // ── Expose globeData to rAF loop via window ref ────────────────────────────
  useEffect(() => { (window as any).__globeData = globeData; }, [globeData]);

  // ── Update texture when frame changes ─────────────────────────────────────
  useEffect(() => {
    if (!globeData || !sceneReady) return;
    const { header: { width: w, height: h }, pixels } = globeData;
    const texCanvas = texCanvasRef.current!;
    const ctx = texCanvas.getContext('2d')!;
    if (!imgDataRef.current) imgDataRef.current = ctx.createImageData(w, h);
    ctx.clearRect(0, 0, w, h);
    drawFrame(pixels, frameIdx, w, h, imgDataRef.current);
    ctx.putImageData(imgDataRef.current, 0, 0);
    if (textureRef.current) textureRef.current.needsUpdate = true;
    // Bust contour cache so segments rebuild on next rAF
    contourCache.current.frameIdx = -1;
  }, [globeData, frameIdx, sceneReady]);

  // ── Playback ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing || !globeData) return;
    const iv = setInterval(() => {
      const next = (frameIdxRef.current + 1) % globeData.header.weeks;
      frameIdxRef.current = next; setFrameIdx(next);
    }, 200);
    return () => clearInterval(iv);
  }, [playing, globeData]);

  // Mouse move → raycast → tooltip
  useEffect(() => {
    if (!sceneReady) return;
    const canvas = rendererRef.current?.domElement;
    if (!canvas) return;

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
      const y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
      mousePosRef.current.set(x, y);

      const camera = cameraRef.current;
      const globeData = (window as any).__globeData as GlobeData | null;
      if (!camera || !globeData) return;

      raycasterRef.current.setFromCamera(mousePosRef.current, camera);
      // Intersect unit sphere (radius 1.001)
      const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1.001);
      const ray = raycasterRef.current.ray;
      const target = new THREE.Vector3();
      const hit = ray.intersectSphere(sphere, target);

      if (!hit) { setTooltip(null); return; }

      // Convert hit point back to lat/lon
      // Sphere coords with rotation.y = Math.PI applied (reversed)
      // latLonToSphere applies: x = -sin(phi)*cos(theta) rotated by PI → x,z negated
      // So to reverse: un-rotate by -PI first (negate x and z)
      const ux = -target.x, uy = target.y, uz = -target.z;
      const lat = 90 - Math.acos(Math.max(-1, Math.min(1, uy))) * 180 / Math.PI;
      const lon = (Math.atan2(uz, -ux) * 180 / Math.PI + 360) % 360 - 180;

      // Look up temperature in pixel array
      const { header: { width: w, height: h, temp_min, temp_max, ocean_sentinel }, pixels } = globeData;
      const fi = frameIdxRef.current;
      const tx = Math.floor(((lon + 180) / 360) * w);
      const ty = Math.floor(((90 - lat) / 180) * h);
      const idx = fi * w * h + ty * w + tx;
      const u8 = pixels[idx];
      const temp = u8 === ocean_sentinel ? null : u8 / 254 * (temp_max - temp_min) + temp_min;

      setTooltip({ x: e.clientX, y: e.clientY, lat, lon, temp });
    };

    const onLeave = () => setTooltip(null);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
    };
  }, [sceneReady]);

  // Stop auto-rotate on drag
  useEffect(() => {
    const canvas = rendererRef.current?.domElement;
    if (!canvas) return;
    const stop = () => { if (controlsRef.current) controlsRef.current.autoRotate = false; };
    canvas.addEventListener('pointerdown', stop);
    return () => canvas.removeEventListener('pointerdown', stop);
  }, [sceneReady]);

  // Block OrbitControls from UI overlay
  useEffect(() => {
    const ui = uiRef.current; if (!ui) return;
    const block = (e: PointerEvent) => e.stopPropagation();
    ui.addEventListener('pointerdown', block, true);
    ui.addEventListener('pointermove', block, true);
    return () => {
      ui.removeEventListener('pointerdown', block, true);
      ui.removeEventListener('pointermove', block, true);
    };
  }, []);

  const toggleThreshold = (id: string) => {
    setActiveIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      contourCache.current.segments.delete(id); // force rebuild
      return next;
    });
  };

  const dateLabel = (() => {
    if (!globeData?.header.dates[frameIdx]) return '';
    const d = new Date(globeData.header.dates[frameIdx] + 'T00:00:00Z');
    return `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  })();

  const weeks = globeData?.header.weeks ?? 53;
  function threshPct(temp_c: number): number {
    return Math.max(0, Math.min(100, (temp_c - TEMP_MIN) / TEMP_RANGE * 100));
  }

  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio, 2) : 1;
  const initW = typeof window !== 'undefined' ? window.innerWidth : 800;
  const initH = typeof window !== 'undefined' ? window.innerHeight : 600;

  return (
    <div className="globe-shell">
      <div ref={mountRef} className="globe-canvas" />

      {/* Screen-space contour overlay — sits directly on top of WebGL canvas */}
      <canvas
        ref={overlayRef}
        className="globe-overlay-canvas"
        width={initW * dpr}
        height={initH * dpr}
        style={{ width: initW, height: initH }}
      />



      {loading && (
        <div className="globe-overlay">
          <div className="globe-loading">
            <div className="globe-spinner" />
            <div>{selectedYear === FORECAST_YEAR ? 'Loading forecast…' : 'Loading soil temperature data…'}</div>
            <div className="globe-progress-bar"><div className="globe-progress-fill" style={{ width: `${selectedYear === FORECAST_YEAR ? liveProgress : loadProgress}%` }} /></div>
            <div className="globe-loading-sub">{selectedYear === FORECAST_YEAR ? '7-day forecast · 720×360 · updated nightly' : `${loadProgress}% · 720×360 · ${weeks} weeks · ${selectedYear}`}</div>
          </div>
        </div>
      )}
      {error && (
        <div className="globe-overlay">
          <div className="globe-error">
            <div>⚠ Data not ready</div>
            <div className="globe-error-sub">Try refreshing — if this persists, the data file may be temporarily unavailable.</div>
            <div className="globe-error-detail">{error}</div>
          </div>
        </div>
      )}

      {!loading && !error && globeData && (
        <div ref={uiRef} className="globe-ui">
          <div className="globe-hud-title">
            <div className="globe-eyebrow">ERA5 · 2020–2026</div>
            <div className="globe-title">Soil Temperature</div>
          </div>

          <div className="globe-hud-date">
            {selectedYear === FORECAST_YEAR && <div className="globe-live-badge">● FORECAST</div>}
            <div className="globe-date-label">
              {selectedYear === FORECAST_YEAR && forecastManifest
                ? (() => { const d = new Date(forecastManifest.files[forecastDayIdx]?.date + 'T00:00:00Z'); return `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; })()
                : dateLabel}
            </div>
            {selectedYear === FORECAST_YEAR && forecastManifest
              ? <div className="globe-week-label">Day {forecastDayIdx + 1} of {forecastManifest.days} · Open-Meteo · updated nightly</div>
              : <div className="globe-week-label">Week {frameIdx + 1} of {weeks}</div>}
          </div>

          <div className="globe-controls">
            <div className="globe-year-selector">
              {AVAILABLE_YEARS.map(y => (
                <button key={y}
                  className={`globe-year-btn ${y === selectedYear ? 'active' : ''} ${yearStatus[String(y)] === 'error' ? 'unavailable' : ''}`}
                  onClick={() => { setPlaying(false); setSelectedYear(y); }}
                  disabled={yearStatus[String(y)] === 'loading'}
                >{y}</button>
              ))}
              <button
                className={`globe-year-btn globe-live-btn ${selectedYear === FORECAST_YEAR ? 'active' : ''} ${yearStatus['forecast'] === 'error' ? 'unavailable' : ''}`}
                onClick={() => { setPlaying(false); forecastCache.current.clear(); setSelectedYear(FORECAST_YEAR); }}
                disabled={yearStatus['forecast'] === 'loading'}
                title={yearStatus['forecast'] === 'error' ? 'Forecast not yet available — check back after 2am UTC' : 'View 7-day forecast'}
              >FORECAST</button>
            </div>
            {selectedYear === FORECAST_YEAR && forecastManifest ? (
              <div className="globe-playback-row">
                <div className="globe-forecast-days">
                  {forecastManifest.files.map((f, i) => {
                    const d = new Date(f.date + 'T00:00:00Z');
                    const label = i === 0 ? 'Today' : `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCDate()}`;
                    return (
                      <button key={i}
                        className={`globe-forecast-day-btn ${i === forecastDayIdx ? 'active' : ''}`}
                        onClick={() => setForecastDayIdx(i)}
                      >{label}</button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="globe-playback-row">
                <button className="globe-play-btn" onClick={() => setPlaying(p => !p)}>{playing ? '⏸' : '▶'}</button>
                <input type="range" min={0} max={weeks - 1} value={frameIdx}
                  onChange={e => { setPlaying(false); setFrameIdx(Number(e.target.value)); }}
                  className="globe-scrubber" />
              </div>
            )}
          </div>

          <div className="globe-legend-panel">
            <div className="globe-legend-title">Soil temperature</div>
            <div className="globe-legend-wrap">
              <div className="globe-legend-bar" />
              {THRESHOLDS.map(t => (
                <div key={t.id}
                  className={`globe-thresh-tick ${activeIds.has(t.id) ? 'active' : ''}`}
                  style={{ left: `${threshPct(t.temp_c)}%`, borderColor: t.color }}
                />
              ))}
            </div>
            <div className="globe-legend-labels">
              <span>−55°C</span><span>0°C</span><span>+50°C</span>
            </div>
            <div className="globe-thresh-chips">
              {THRESHOLDS.map(t => (
                <button key={t.id}
                  className={`globe-thresh-chip ${activeIds.has(t.id) ? 'on' : ''}`}
                  style={{ '--chip-color': t.color } as React.CSSProperties}
                  onClick={() => toggleThreshold(t.id)}
                  title={t.description}
                >
                  <span className="chip-dot" />
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="globe-tip">Drag to rotate · scroll to zoom</div>
        </div>
      )}
      {tooltip && (
        <div className="globe-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="globe-tooltip-coord">
            {Math.abs(tooltip.lat).toFixed(1)}°{tooltip.lat >= 0 ? 'N' : 'S'} &nbsp;
            {Math.abs(tooltip.lon).toFixed(1)}°{tooltip.lon >= 0 ? 'E' : 'W'}
          </div>
          {tooltip.temp !== null ? (
            <>
              <div className="globe-tooltip-temp">
                {tooltip.temp.toFixed(1)}°C &nbsp; {(tooltip.temp * 9/5 + 32).toFixed(1)}°F
              </div>
              <div className="globe-tooltip-label">soil temp · 0–7cm</div>
            </>
          ) : (
            <div className="globe-tooltip-label">ocean</div>
          )}
        </div>
      )}
    </div>
  );
}
