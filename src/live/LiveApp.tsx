/**
 * LiveApp — /live route — v2
 * Real-time city feed on the isometric NYC map.
 * Layers: aircraft, F train (shape-following), 311/48h, permits, cranes, weather radar (stub) — v3
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import OpenSeadragon from 'openseadragon';
import { latlngToImagePx, IMAGE_DIMS } from '../permits/coordinates';
import { fetchAircraft, type AircraftState, type AircraftKind } from './sources/aircraft';
import { fetchSubwayTrains, type SubwayTrain, SUBWAY_COLORS } from './sources/subway';
import { fetch311Recent, type Complaint311 } from './sources/recent311';
import { fetchFTrains, type FTrain, F_COLOR, POLL_MS as F_POLL_MS } from './sources/fLine';
import { fetchLivePermits, type LivePermit, jobColor } from './sources/livePermits';
import './LiveApp.css';

// ── OSD tile config (identical to IsoView) ────────────────────
const TILE_BASE  = '/dzi/tiles_files';
const DZI_DIMS   = { width: 123904, height: 100864 };
const MAX_LEVEL  = 8;
const TILE_SIZE  = 512;

const AC_BASE_ZOOM = 3.5;
const AC_MIN_PX    = 8;

function buildTileSource() {
  const osdMax = Math.ceil(Math.log2(Math.max(DZI_DIMS.width, DZI_DIMS.height)));
  return {
    width: DZI_DIMS.width, height: DZI_DIMS.height,
    tileSize: TILE_SIZE, tileOverlap: 0,
    minLevel: osdMax - MAX_LEVEL, maxLevel: osdMax,
    getTileUrl: (level: number, x: number, y: number) => {
      const sl = level - (osdMax - MAX_LEVEL);
      if (sl < 0 || sl > MAX_LEVEL) return '';
      return `${TILE_BASE}/${sl}/${x}_${y}.webp`;
    },
  };
}

// ── Coordinate helpers ────────────────────────────────────────
function toVp(lat: number, lon: number): { x: number; y: number } {
  const { x, y } = latlngToImagePx(lat, lon);
  return { x: x / IMAGE_DIMS.width, y: y / IMAGE_DIMS.width };
}

// ── Aircraft icon ─────────────────────────────────────────────
function acIcon(kind: AircraftKind): string {
  if (kind === 'helicopter') return '🚁';
  if (kind === 'military')   return '✈';   // rendered distinctly via CSS if needed
  return '✈️';
}

function acColor(kind: AircraftKind): string {
  if (kind === 'helicopter') return '#60d0ff';
  if (kind === 'military')   return '#ff6060';
  return '#c0d8ff';
}

// ── Layer toggle state ────────────────────────────────────────
interface LayerState {
  aircraft: boolean;
  fTrain: boolean;
  subway: boolean;
  complaints: boolean;
  permits: boolean;
  cranes: boolean;
  radar: boolean;
}

// ── Tooltip state ─────────────────────────────────────────────
interface TooltipState {
  lines: string[];
  x: number;
  y: number;
}

// ── Interpolation map ─────────────────────────────────────────
interface TweenPos {
  fromX: number; fromY: number;
  toX: number; toY: number;
  startTime: number; duration: number;
}

// ── NYC clock ─────────────────────────────────────────────────
function useNYCTime() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const tick = () => {
      setTime(new Date().toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }));
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, []);
  return time;
}

// ── Main component ────────────────────────────────────────────
export default function LiveApp() {
  const viewerRef = useRef<HTMLDivElement>(null);
  const osdRef    = useRef<OpenSeadragon.Viewer | null>(null);
  const [dziLoaded, setDziLoaded] = useState(false);

  // Layer visibility
  const [layers, setLayers] = useState<LayerState>({
    aircraft: true, fTrain: true, subway: true,
    complaints: true, permits: true, cranes: true, radar: false,
  });
  const layersRef = useRef(layers);
  useEffect(() => { layersRef.current = layers; }, [layers]);

  // Live counts
  const [counts, setCounts] = useState({ aircraft: 0, fTrain: 0, subway: 0, complaints: 0, permits: 0, cranes: 0 });

  // Tooltip
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  // NYC clock
  const nycTime = useNYCTime();

  // ── Aircraft overlay state ────────────────────────────────
  const acOverlaysRef   = useRef<Map<string, HTMLElement>>(new Map());
  const acTweensRef     = useRef<Map<string, TweenPos>>(new Map());
  const acDataRef       = useRef<Map<string, AircraftState>>(new Map());
  const acRafRef        = useRef<number | null>(null);
  const acActiveRef     = useRef(false);

  // ── Subway overlay state ──────────────────────────────────
  const subwayOverlaysRef = useRef<Map<string, HTMLElement>>(new Map());

  // ── F train overlay state ─────────────────────────────────
  const fTrainOverlaysRef = useRef<Map<string, HTMLElement>>(new Map());
  const fTrainRafRef      = useRef<number | null>(null);
  const fTrainActiveRef   = useRef(false);
  // Tween state for smooth movement between polls
  interface FTween { fromX: number; fromY: number; toX: number; toY: number; startMs: number; durationMs: number }
  const fTrainTweensRef   = useRef<Map<string, FTween>>(new Map());
  const fTrainDataRef     = useRef<Map<string, FTrain>>(new Map());

  // ── 311 overlay state ─────────────────────────────────────
  const c311OverlaysRef = useRef<Map<string, HTMLElement>>(new Map());
  const c311DataRef     = useRef<Complaint311[]>([]);

  // ── Permits/cranes overlay state ──────────────────────────
  const permitOverlaysRef = useRef<Map<string, HTMLElement>>(new Map());
  const permitDataRef     = useRef<LivePermit[]>([]);

  // ── OSD init ──────────────────────────────────────────────
  useEffect(() => {
    if (!viewerRef.current || osdRef.current) return;
    const viewer = OpenSeadragon({
      element: viewerRef.current,
      prefixUrl: '',
      showNavigationControl: false,
      showNavigator: window.innerWidth > 768,
      navigatorPosition: 'BOTTOM_RIGHT',
      navigatorSizeRatio: 0.1,
      navigatorBackground: '#0a0c14',
      animationTime: 0.3, blendTime: 0.1,
      crossOriginPolicy: 'Anonymous',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tileSources: buildTileSource() as any,
      gestureSettingsMouse: { scrollToZoom: true, clickToZoom: false, dblClickToZoom: true },
      imageSmoothingEnabled: false,
      drawer: 'canvas',
    });

    viewer.addHandler('open', () => {
      setDziLoaded(true);
      viewer.viewport.panTo(new OpenSeadragon.Point(0.3637, 0.3509), true);
      viewer.viewport.zoomTo(window.innerWidth <= 768 ? 10 : 3.5, undefined, true);
    });

    // Scale aircraft icons at different zoom levels
    viewer.addHandler('zoom', () => {
      const zoom = viewer.viewport.getZoom();
      const effective = 10 * (AC_BASE_ZOOM / zoom);
      const s = effective < AC_MIN_PX ? AC_MIN_PX / effective : 1;
      acOverlaysRef.current.forEach(el => {
        const inner = el.querySelector('.ac-scale') as HTMLElement;
        if (inner) inner.style.transform = `scale(${s})`;
      });
    });

    osdRef.current = viewer;
    return () => {
      acActiveRef.current = false;
      if (acRafRef.current !== null) cancelAnimationFrame(acRafRef.current);
      viewer.destroy();
      osdRef.current = null;
    };
  }, []);

  // ── Aircraft polling + rendering ──────────────────────────
  const placeAircraft = useCallback((aircraft: AircraftState[]) => {
    const viewer = osdRef.current;
    if (!viewer) return;
    const existing = acOverlaysRef.current;
    const tweens   = acTweensRef.current;
    const dataMap  = acDataRef.current;
    const POLL_MS  = 10000;
    const now      = performance.now();
    const seen     = new Set<string>();

    for (const ac of aircraft) {
      const { hex, lat, lon, track, kind } = ac;
      if (isNaN(lat) || isNaN(lon)) continue;
      seen.add(hex);
      dataMap.set(hex, ac);
      const { x: vpX, y: vpY } = toVp(lat, lon);
      const facingLeft = track > 90 && track < 270;

      let el = existing.get(hex);
      if (!el) {
        el = document.createElement('div');
        el.className = 'ac-marker';
        const icon = acIcon(kind);
        const color = acColor(kind);
        el.innerHTML = `<div class="ac-scale"><span style="display:inline-block;font-size:${kind === 'helicopter' ? 10 : 11}px;color:${color};${facingLeft ? 'transform:scaleX(-1)' : ''}">${icon}</span></div>`;

        el.addEventListener('mouseenter', (e: MouseEvent) => {
          e.stopImmediatePropagation();
          const d = dataMap.get(hex);
          if (!d) return;
          const ident = d.r ?? d.flight ?? d.hex.toUpperCase();
          const type  = d.t ?? '';
          const kindLabel = d.kind === 'helicopter' ? 'Helicopter' : d.kind === 'military' ? 'Military' : 'Aircraft';
          setTooltip({
            lines: [
              `${ident}${type ? ` · ${type}` : ''}`,
              `${Math.round(d.alt_baro ?? d.alt).toLocaleString()}ft · ${Math.round(d.gs)}kt · ${Math.round(d.track)}°`,
              kindLabel,
            ],
            x: e.clientX + 14,
            y: e.clientY - 10,
          });
        });
        el.addEventListener('mousemove', (e: MouseEvent) => {
          e.stopImmediatePropagation();
          setTooltip(prev => prev ? { ...prev, x: e.clientX + 14, y: e.clientY - 10 } : null);
        });
        el.addEventListener('mouseleave', (e: MouseEvent) => {
          e.stopImmediatePropagation();
          setTooltip(null);
        });
        el.addEventListener('pointerdown', (e: PointerEvent) => e.stopImmediatePropagation());

        viewer.addOverlay({
          element: el,
          location: new OpenSeadragon.Point(vpX, vpY),
          placement: OpenSeadragon.Placement.CENTER,
        });
        existing.set(hex, el);
        tweens.set(hex, { fromX: vpX, fromY: vpY, toX: vpX, toY: vpY, startTime: now, duration: POLL_MS });
      } else {
        // Update tween target
        const cur = tweens.get(hex) ?? { fromX: vpX, fromY: vpY, toX: vpX, toY: vpY, startTime: now, duration: POLL_MS };
        const elapsed = now - cur.startTime;
        const t = Math.min(elapsed / cur.duration, 1);
        const curX = cur.fromX + (cur.toX - cur.fromX) * t;
        const curY = cur.fromY + (cur.toY - cur.fromY) * t;
        tweens.set(hex, { fromX: curX, fromY: curY, toX: vpX, toY: vpY, startTime: now, duration: POLL_MS });
        // Update icon direction
        const span = el.querySelector('span') as HTMLElement;
        if (span) span.style.transform = facingLeft ? 'scaleX(-1)' : '';
      }
    }

    // Remove stale
    for (const [hex, el] of existing) {
      if (!seen.has(hex)) {
        try { viewer.removeOverlay(el); } catch { /* ignore */ }
        existing.delete(hex);
        tweens.delete(hex);
        dataMap.delete(hex);
      }
    }

    // Apply zoom scale
    const zoom = viewer.viewport.getZoom();
    const effective = 10 * (AC_BASE_ZOOM / zoom);
    const s = effective < AC_MIN_PX ? AC_MIN_PX / effective : 1;
    existing.forEach(el => {
      const inner = el.querySelector('.ac-scale') as HTMLElement;
      if (inner) inner.style.transform = `scale(${s})`;
    });

    // Animate tweens
    const animate = (ts: number) => {
      if (!acActiveRef.current) return;
      for (const [hex, pos] of tweens) {
        const el = existing.get(hex);
        if (!el) continue;
        const elapsed = ts - pos.startTime;
        const t2 = Math.min(elapsed / pos.duration, 1);
        const x = pos.fromX + (pos.toX - pos.fromX) * t2;
        const y = pos.fromY + (pos.toY - pos.fromY) * t2;
        try { viewer.updateOverlay(el, new OpenSeadragon.Point(x, y), OpenSeadragon.Placement.CENTER); } catch { /* ignore */ }
      }
      acRafRef.current = requestAnimationFrame(animate);
    };
    if (acRafRef.current !== null) cancelAnimationFrame(acRafRef.current);
    acRafRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    acActiveRef.current = true;
    const poll = async () => {
      if (!acActiveRef.current) return;
      try {
        const aircraft = await fetchAircraft();
        const visible = layersRef.current.aircraft;
        setCounts(prev => ({ ...prev, aircraft: aircraft.length }));
        if (visible) {
          placeAircraft(aircraft);
        } else {
          // Hide all
          const viewer = osdRef.current;
          if (viewer) {
            acOverlaysRef.current.forEach(el => { try { viewer.removeOverlay(el); } catch { /* ignore */ } });
            acOverlaysRef.current.clear();
            acTweensRef.current.clear();
          }
        }
      } catch { /* silent */ }
    };
    poll();
    const iv = setInterval(poll, 10000);
    return () => { acActiveRef.current = false; clearInterval(iv); };
  }, [placeAircraft]);

  // Re-place/remove aircraft when layer toggled
  useEffect(() => {
    if (!layers.aircraft) {
      const viewer = osdRef.current;
      if (viewer) {
        acOverlaysRef.current.forEach(el => { try { viewer.removeOverlay(el); } catch { /* ignore */ } });
        acOverlaysRef.current.clear();
        acTweensRef.current.clear();
      }
    }
  }, [layers.aircraft]);

  // ── F train rendering ─────────────────────────────────────
  const placeFTrains = useCallback((trains: FTrain[]) => {
    const viewer = osdRef.current;
    if (!viewer) return;
    const existing = fTrainOverlaysRef.current;
    const tweens   = fTrainTweensRef.current;
    const dataMap  = fTrainDataRef.current;
    const nowMs    = Date.now();
    const seen     = new Set<string>();

    for (const train of trains) {
      const { tripId, vpX, vpY, direction } = train;
      seen.add(tripId);
      dataMap.set(tripId, train);

      let el = existing.get(tripId);
      if (!el) {
        el = document.createElement('div');
        el.style.cssText = `
          width: 10px; height: 10px; border-radius: 50%;
          background: ${F_COLOR}; border: 1.5px solid rgba(255,255,255,0.5);
          pointer-events: auto; cursor: pointer;
          box-shadow: 0 0 4px rgba(255,99,25,0.6);
        `;
        el.addEventListener('mouseenter', (e: MouseEvent) => {
          e.stopImmediatePropagation();
          const d = dataMap.get(tripId);
          if (!d) return;
          setTooltip({
            lines: [
              `F Train · ${d.direction === 'N' ? 'Northbound' : 'Southbound'}`,
              d.stopName,
            ],
            x: e.clientX + 12,
            y: e.clientY - 10,
          });
        });
        el.addEventListener('mousemove', (e: MouseEvent) => {
          e.stopImmediatePropagation();
          setTooltip(prev => prev ? { ...prev, x: e.clientX + 12, y: e.clientY - 10 } : null);
        });
        el.addEventListener('mouseleave', (e: MouseEvent) => {
          e.stopImmediatePropagation();
          setTooltip(null);
        });
        el.addEventListener('pointerdown', (e: PointerEvent) => e.stopImmediatePropagation());

        viewer.addOverlay({
          element: el,
          location: new OpenSeadragon.Point(vpX, vpY),
          placement: OpenSeadragon.Placement.CENTER,
        });
        existing.set(tripId, el);
        tweens.set(tripId, { fromX: vpX, fromY: vpY, toX: vpX, toY: vpY, startMs: nowMs, durationMs: F_POLL_MS });
      } else {
        // Update tween: pick up from current interpolated position
        const cur = tweens.get(tripId);
        if (cur) {
          const elapsed = nowMs - cur.startMs;
          const t = Math.min(elapsed / cur.durationMs, 1);
          const curX = cur.fromX + (cur.toX - cur.fromX) * t;
          const curY = cur.fromY + (cur.toY - cur.fromY) * t;
          tweens.set(tripId, { fromX: curX, fromY: curY, toX: vpX, toY: vpY, startMs: nowMs, durationMs: F_POLL_MS });
        }
      }
      void direction; // available for future icon rotation
    }

    // Remove stale trains
    for (const [id, el] of existing) {
      if (!seen.has(id)) {
        try { viewer.removeOverlay(el); } catch { /* ignore */ }
        existing.delete(id);
        tweens.delete(id);
        dataMap.delete(id);
      }
    }

    // Start/restart RAF animation loop
    if (fTrainRafRef.current !== null) cancelAnimationFrame(fTrainRafRef.current);
    const animate = () => {
      if (!fTrainActiveRef.current) return;
      const nowRaf = Date.now();
      for (const [id, tween] of tweens) {
        const el = existing.get(id);
        if (!el) continue;
        const elapsed = nowRaf - tween.startMs;
        const t = Math.min(elapsed / tween.durationMs, 1);
        const x = tween.fromX + (tween.toX - tween.fromX) * t;
        const y = tween.fromY + (tween.toY - tween.fromY) * t;
        try { viewer.updateOverlay(el, new OpenSeadragon.Point(x, y), OpenSeadragon.Placement.CENTER); } catch { /* ignore */ }
      }
      fTrainRafRef.current = requestAnimationFrame(animate);
    };
    fTrainActiveRef.current = true;
    fTrainRafRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    fTrainActiveRef.current = true;
    const poll = async () => {
      if (!fTrainActiveRef.current) return;
      try {
        const trains = await fetchFTrains();
        setCounts(prev => ({ ...prev, fTrain: trains.length }));
        if (layersRef.current.fTrain) placeFTrains(trains);
      } catch { /* silent */ }
    };
    if (dziLoaded) { poll(); }
    const iv = setInterval(poll, F_POLL_MS);
    return () => { fTrainActiveRef.current = false; clearInterval(iv); if (fTrainRafRef.current !== null) cancelAnimationFrame(fTrainRafRef.current); };
  }, [dziLoaded, placeFTrains]);

  useEffect(() => {
    if (!layers.fTrain) {
      fTrainActiveRef.current = false;
      if (fTrainRafRef.current !== null) { cancelAnimationFrame(fTrainRafRef.current); fTrainRafRef.current = null; }
      const viewer = osdRef.current;
      if (viewer) {
        fTrainOverlaysRef.current.forEach(el => { try { viewer.removeOverlay(el); } catch { /* ignore */ } });
        fTrainOverlaysRef.current.clear();
        fTrainTweensRef.current.clear();
      }
    }
  }, [layers.fTrain]);

  // ── Subway (stub — ready for MTA wiring) ─────────────────
  const placeSubway = useCallback((trains: SubwayTrain[]) => {
    const viewer = osdRef.current;
    if (!viewer) return;
    const existing = subwayOverlaysRef.current;
    const seen = new Set<string>();

    for (const train of trains) {
      seen.add(train.id);
      const { x: vpX, y: vpY } = toVp(train.lat, train.lon);
      const color = SUBWAY_COLORS[train.line] ?? '#808183';

      let el = existing.get(train.id);
      if (!el) {
        el = document.createElement('div');
        el.style.cssText = `width:8px;height:8px;border-radius:50%;background:${color};border:1px solid rgba(255,255,255,0.3);pointer-events:auto;cursor:pointer;`;
        el.addEventListener('mouseenter', (e: MouseEvent) => {
          e.stopImmediatePropagation();
          setTooltip({
            lines: [`${train.line} Train`, train.status ?? ''],
            x: e.clientX + 14,
            y: e.clientY - 10,
          });
        });
        el.addEventListener('mouseleave', (e: MouseEvent) => {
          e.stopImmediatePropagation();
          setTooltip(null);
        });
        el.addEventListener('pointerdown', (e: PointerEvent) => e.stopImmediatePropagation());
        viewer.addOverlay({
          element: el,
          location: new OpenSeadragon.Point(vpX, vpY),
          placement: OpenSeadragon.Placement.CENTER,
        });
        existing.set(train.id, el);
      } else {
        try { viewer.updateOverlay(el, new OpenSeadragon.Point(vpX, vpY), OpenSeadragon.Placement.CENTER); } catch { /* ignore */ }
      }
    }

    for (const [id, el] of existing) {
      if (!seen.has(id)) {
        try { viewer.removeOverlay(el); } catch { /* ignore */ }
        existing.delete(id);
      }
    }
  }, []);

  useEffect(() => {
    const poll = async () => {
      try {
        const trains = await fetchSubwayTrains();
        setCounts(prev => ({ ...prev, subway: trains.length }));
        if (layersRef.current.subway) placeSubway(trains);
      } catch { /* silent */ }
    };
    poll();
    const iv = setInterval(poll, 15000);
    return () => clearInterval(iv);
  }, [placeSubway]);

  useEffect(() => {
    if (!layers.subway) {
      const viewer = osdRef.current;
      if (viewer) {
        subwayOverlaysRef.current.forEach(el => { try { viewer.removeOverlay(el); } catch { /* ignore */ } });
        subwayOverlaysRef.current.clear();
      }
    }
  }, [layers.subway]);

  // ── 311 complaints ────────────────────────────────────────
  const place311 = useCallback((complaints: Complaint311[]) => {
    const viewer = osdRef.current;
    if (!viewer) return;
    const existing = c311OverlaysRef.current;
    const now = Date.now();
    const seen = new Set<string>();

    for (const c of complaints) {
      seen.add(c.id);
      if (existing.has(c.id)) continue; // already placed
      const { x: vpX, y: vpY } = toVp(c.lat, c.lon);
      const age = now - c.createdAt;
      const isRecent = age < 2 * 60 * 60 * 1000; // < 2h = pulse

      const el = document.createElement('div');
      el.style.cssText = `position:relative;width:6px;height:6px;pointer-events:auto;cursor:pointer;`;

      const dot = document.createElement('div');
      dot.className = 'complaint-dot';
      dot.style.cssText = `width:6px;height:6px;background:${c.color};opacity:0.7;position:absolute;top:0;left:0;`;
      el.appendChild(dot);

      if (isRecent) {
        const ring = document.createElement('div');
        ring.className = 'pulse-ring';
        ring.style.cssText = `width:6px;height:6px;border:1.5px solid ${c.color};position:absolute;top:0;left:0;`;
        el.appendChild(ring);
      }

      el.addEventListener('mouseenter', (e: MouseEvent) => {
        e.stopImmediatePropagation();
        const ageHrs = Math.round(age / 3600000);
        setTooltip({
          lines: [c.type, ageHrs === 0 ? 'Just now' : `${ageHrs}h ago`],
          x: e.clientX + 10,
          y: e.clientY - 10,
        });
      });
      el.addEventListener('mouseleave', (e: MouseEvent) => {
        e.stopImmediatePropagation();
        setTooltip(null);
      });
      el.addEventListener('pointerdown', (e: PointerEvent) => e.stopImmediatePropagation());

      viewer.addOverlay({
        element: el,
        location: new OpenSeadragon.Point(vpX, vpY),
        placement: OpenSeadragon.Placement.CENTER,
      });
      existing.set(c.id, el);
    }

    // Remove any that dropped out of the 24h window
    for (const [id, el] of existing) {
      if (!seen.has(id)) {
        try { viewer.removeOverlay(el); } catch { /* ignore */ }
        existing.delete(id);
      }
    }
  }, []);

  useEffect(() => {
    const poll = async () => {
      try {
        const data = await fetch311Recent();
        c311DataRef.current = data;
        setCounts(prev => ({ ...prev, complaints: data.length }));
        if (layersRef.current.complaints && dziLoaded) place311(data);
      } catch { /* silent */ }
    };
    if (dziLoaded) poll();
    const iv = setInterval(poll, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [dziLoaded, place311]);

  // Place 311 on load when viewer is ready
  useEffect(() => {
    if (dziLoaded && c311DataRef.current.length > 0 && layers.complaints) {
      place311(c311DataRef.current);
    }
  }, [dziLoaded, layers.complaints, place311]);

  useEffect(() => {
    if (!layers.complaints) {
      const viewer = osdRef.current;
      if (viewer) {
        c311OverlaysRef.current.forEach(el => { try { viewer.removeOverlay(el); } catch { /* ignore */ } });
        c311OverlaysRef.current.clear();
      }
    }
  }, [layers.complaints]);

  // ── Permits + cranes rendering ────────────────────────────
  const placePermits = useCallback((permits: LivePermit[], showPermits: boolean, showCranes: boolean) => {
    const viewer = osdRef.current;
    if (!viewer) return;
    const existing = permitOverlaysRef.current;
    const seen = new Set<string>();

    for (const p of permits) {
      const visible = p.isCrane ? showCranes : showPermits;
      seen.add(p.id);

      if (!visible) {
        // If toggled off, remove if exists
        const el = existing.get(p.id);
        if (el) { try { viewer.removeOverlay(el); } catch { /* ignore */ } existing.delete(p.id); }
        continue;
      }

      if (existing.has(p.id)) continue;

      const { x: vpX, y: vpY } = toVp(p.lat, p.lon);
      const el = document.createElement('div');

      if (p.isCrane) {
        // Crane: yellow diamond marker with 🏗️ emoji
        el.style.cssText = `width:14px;height:14px;pointer-events:auto;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;`;
        el.innerHTML = '🏗️';
        el.title = p.address;
      } else {
        // Permit: small colored square
        const color = jobColor(p.jobType);
        el.style.cssText = `width:7px;height:7px;background:${color};opacity:0.75;border-radius:1px;pointer-events:auto;cursor:pointer;`;
      }

      el.addEventListener('mouseenter', (e: MouseEvent) => {
        e.stopImmediatePropagation();
        const age = Math.round((Date.now() - new Date(p.issuedDate).getTime()) / 3600000);
        setTooltip({
          lines: [
            p.isCrane ? '🏗️ Crane / Hoist Permit' : `${p.jobType} Permit`,
            p.address,
            age < 1 ? 'Just filed' : `${age}h ago`,
          ],
          x: e.clientX + 10, y: e.clientY - 10,
        });
      });
      el.addEventListener('mousemove', (e: MouseEvent) => {
        e.stopImmediatePropagation();
        setTooltip(prev => prev ? { ...prev, x: e.clientX + 10, y: e.clientY - 10 } : null);
      });
      el.addEventListener('mouseleave', (e: MouseEvent) => {
        e.stopImmediatePropagation(); setTooltip(null);
      });
      el.addEventListener('pointerdown', (e: PointerEvent) => e.stopImmediatePropagation());

      viewer.addOverlay({
        element: el,
        location: new OpenSeadragon.Point(vpX, vpY),
        placement: OpenSeadragon.Placement.CENTER,
      });
      existing.set(p.id, el);
    }

    // Remove dropped permits
    for (const [id, el] of existing) {
      if (!seen.has(id)) {
        try { viewer.removeOverlay(el); } catch { /* ignore */ }
        existing.delete(id);
      }
    }
  }, []);

  useEffect(() => {
    const poll = async () => {
      try {
        const data = await fetchLivePermits();
        permitDataRef.current = data;
        const cranes = data.filter(p => p.isCrane);
        const permits = data.filter(p => !p.isCrane);
        setCounts(prev => ({ ...prev, permits: permits.length, cranes: cranes.length }));
        if (dziLoaded) placePermits(data, layersRef.current.permits, layersRef.current.cranes);
      } catch { /* silent */ }
    };
    if (dziLoaded) poll();
    const iv = setInterval(poll, 10 * 60 * 1000); // refresh every 10 min
    return () => clearInterval(iv);
  }, [dziLoaded, placePermits]);

  useEffect(() => {
    if (dziLoaded && permitDataRef.current.length > 0) {
      placePermits(permitDataRef.current, layers.permits, layers.cranes);
    }
  }, [dziLoaded, layers.permits, layers.cranes, placePermits]);

  // ── Toggle layer ─────────────────────────────────────────
  const toggleLayer = (key: keyof LayerState) => {
    setLayers(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // ── HUD layer definitions ─────────────────────────────────
  const hudLayers: { key: keyof LayerState; label: string; color: string; countKey?: keyof typeof counts }[] = [
    { key: 'aircraft',   label: 'Aircraft',    color: '#c0d8ff', countKey: 'aircraft' },
    { key: 'fTrain',     label: 'F Train',     color: F_COLOR,   countKey: 'fTrain' },
    { key: 'subway',     label: 'Subway',      color: '#6CBE45', countKey: 'subway' },
    { key: 'complaints', label: '311 / 48h',   color: '#F5A623', countKey: 'complaints' },
    { key: 'permits',    label: 'Permits',     color: '#60b8ff', countKey: 'permits' },
    { key: 'cranes',     label: 'Cranes',      color: '#FFD700', countKey: 'cranes' },
    { key: 'radar',      label: 'Weather',     color: '#60d8a0' },
  ];

  return (
    <div className="live-app">
      <div ref={viewerRef} className="live-viewer" />

      {!dziLoaded && (
        <div className="live-loading">
          <div className="live-loading-spinner" />
          <div className="live-loading-text">Loading live NYC feed…</div>
        </div>
      )}

      {/* HUD */}
      <div className="live-hud">
        <div className="live-hud-title">
          <span className="live-hud-label">NYC</span>
          <span className="live-badge">LIVE</span>
        </div>
        <div className="live-hud-layers">
          {hudLayers.map(({ key, label, color, countKey }) => {
            const on = layers[key];
            const count = countKey ? counts[countKey] : null;
            return (
              <div
                key={key}
                className={`live-layer-row${on ? '' : ' off'}`}
                onClick={() => toggleLayer(key)}
              >
                <div className={`live-layer-dot${on ? '' : ' off'}`} style={{ background: color }} />
                <span className="live-layer-name">{label}</span>
                <span className="live-layer-count">
                  {count !== null ? (count === 0 ? '—' : count) : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Clock */}
      <div className="live-clock">
        <div className="live-clock-time">{nycTime}</div>
        <div className="live-clock-tz">New York</div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div className="live-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.lines.filter(Boolean).map((line, i) => (
            <div
              key={i}
              className={i === 0 ? 'live-tooltip-line1' : i === 1 ? 'live-tooltip-line2' : 'live-tooltip-line3'}
            >
              {line}
            </div>
          ))}
        </div>
      )}

      {/* Back link */}
      <a className="live-back" href="/">← datamap.nyc</a>
    </div>
  );
}
