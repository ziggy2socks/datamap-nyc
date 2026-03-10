import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getComplaintColor } from './complaints';

// ── Types ──────────────────────────────────────────────────────────────────

interface HeatCell { lat: number; lng: number; count: number; }
interface HeatFile { year: number; generated: string; res: number; cells: HeatCell[]; }
type TimeMode = '5y' | '1y' | 'month';

interface Props {
  activeTypes: Set<string>;
  trendsTypes: string[];
  onClearTypes: () => void;
  onSelectAll: () => void;
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAP_STYLE = {
  version: 8 as const,
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {
    carto: {
      type: 'raster' as const,
      tiles: ['https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap © CartoDB',
    },
    carto_labels: {
      type: 'raster' as const,
      tiles: ['https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png'],
      tileSize: 256,
    },
  },
  layers: [
    { id: 'carto-base',   type: 'raster' as const, source: 'carto' },
    { id: 'carto-labels', type: 'raster' as const, source: 'carto_labels', paint: { 'raster-opacity': 0.5 } },
  ],
};

const NYC_CENTER: [number, number] = [-73.97, 40.70];
const NYC_ZOOM = 10.5;
const PROXY = '/api/311';
const BATCH = 50_000;
const GRID  = 0.0005;
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const MAX_YEAR = 2025; // last complete year with static files

// ── Color helpers ──────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const c = hex.replace('#','');
  return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)];
}

function typeHeatColor(hex: string): maplibregl.ExpressionSpecification {
  const safeHex = hex.startsWith('#') ? hex : '#00c8dc';
  const [r,g,b] = hexToRgb(safeHex);
  return [
    'interpolate',['linear'],['heatmap-density'],
    0,   'rgba(0,0,0,0)',
    0.1, `rgba(${Math.round(r*.15)},${Math.round(g*.15)},${Math.round(b*.15)},0.4)`,
    0.4, `rgba(${Math.round(r*.5)},${Math.round(g*.5)},${Math.round(b*.5)},0.7)`,
    0.75,`rgba(${r},${g},${b},0.88)`,
    1.0, 'rgba(255,255,255,0.97)',
  ] as unknown as maplibregl.ExpressionSpecification;
}

// All-mode: stays saturated cyan at high zoom, only tips to white at extreme hotspots
// Raise the weight cap per zoom level so the density range spreads wider
const ALL_COLOR: maplibregl.ExpressionSpecification = [
  'interpolate',['linear'],['heatmap-density'],
  0,    'rgba(0,0,0,0)',
  0.05, 'rgba(0,20,45,0.55)',
  0.2,  'rgba(0,75,110,0.72)',
  0.4,  'rgba(0,140,170,0.82)',
  0.6,  'rgba(0,198,220,0.9)',
  0.8,  'rgba(0,228,240,0.94)',
  0.95, 'rgba(140,248,255,0.97)',
  1.0,  'rgba(255,255,255,0.99)',
] as unknown as maplibregl.ExpressionSpecification;

// ── Weight calibration — use p95 so gradient fills the real data range ────

function p95counts(grid: Map<string,number>): number {
  const vals = [...grid.values()].sort((a,b) => a-b);
  if (!vals.length) return 1;
  return Math.max(1, vals[Math.floor(vals.length * 0.95)]);
}

function p95fromCells(cells: HeatCell[]): number {
  const vals = cells.map(c => c.count).sort((a,b) => a-b);
  if (!vals.length) return 1;
  return Math.max(1, vals[Math.floor(vals.length * 0.95)]);
}

// ── Snap coordinate to grid ────────────────────────────────────────────────

function snap(v: number) {
  return Math.round(Math.round(v / GRID) * GRID * 1e6) / 1e6;
}

// ── Build GeoJSON from bucketed grid ──────────────────────────────────────

function gridToGeoJSON(grid: Map<string,number>): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [...grid.entries()].map(([key, count]) => {
      const [lat, lng] = key.split(',').map(Number);
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { count } };
    }),
  };
}

// ── Fetch + bucket raw points from Socrata ────────────────────────────────

async function fetchAndBucket(
  where: string,
  onProgress: (msg: string) => void
): Promise<Map<string,number>> {
  const grid = new Map<string,number>();
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      '$select': 'latitude,longitude',
      '$where': `${where} AND latitude IS NOT NULL AND longitude IS NOT NULL`,
      '$limit': String(BATCH),
      '$offset': String(offset),
    });
    const res = await fetch(`${PROXY}?${params}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const rows: Array<{latitude:string; longitude:string}> = await res.json();
    if (!rows.length) break;
    for (const r of rows) {
      const lat = parseFloat(r.latitude);
      const lng = parseFloat(r.longitude);
      if (!isFinite(lat)||!isFinite(lng)) continue;
      if (lat<40.4||lat>40.95||lng<-74.3||lng>-73.65) continue;
      const key = `${snap(lat)},${snap(lng)}`;
      grid.set(key, (grid.get(key)??0) + 1);
    }
    offset += BATCH;
    onProgress(`${offset.toLocaleString()} pts…`);
    if (rows.length < BATCH) break;
  }
  return grid;
}

// ── Component ──────────────────────────────────────────────────────────────

export function HeatmapView({ activeTypes, trendsTypes: _trendsTypes, onClearTypes: _onClearTypes, onSelectAll: _onSelectAll }: Props) {
  const mapRef    = useRef<maplibregl.Map | null>(null);
  const mapDivRef = useRef<HTMLDivElement>(null);

  const [loading,   setLoading]   = useState(false);
  const [loadMsg,   setLoadMsg]   = useState('');
  const [timeMode,  setTimeMode]  = useState<TimeMode>('1y');
  const [year,      setYear]      = useState(MAX_YEAR);
  const [month,     setMonth]     = useState(0); // 0-based
  const [hoverInfo, setHoverInfo] = useState<{count:number; types:string[]} | null>(null);

  const selectedTypes = [...activeTypes];

  // ── Layer management helpers ───────────────────────────────────────────

  const removeLayer = useCallback((id: string) => {
    const map = mapRef.current; if (!map) return;
    if (map.getLayer(id))  map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }, []);

  const clearAllLayers = useCallback(() => {
    const map = mapRef.current; if (!map) return;
    for (const layer of (map.getStyle()?.layers ?? [])) {
      if (layer.id.startsWith('heat-')) removeLayer(layer.id);
    }
  }, [removeLayer]);

  const addHeatLayer = useCallback((
    id: string,
    geojson: GeoJSON.FeatureCollection,
    color: maplibregl.ExpressionSpecification,
    weightMax: number
  ) => {
    const map = mapRef.current; if (!map) return;
    if (map.getSource(id)) {
      (map.getSource(id) as maplibregl.GeoJSONSource).setData(geojson);
    } else {
      map.addSource(id, { type: 'geojson', data: geojson });
      map.addLayer({
        id,
        type: 'heatmap',
        source: id,
        paint: {
          // weight: log-scale so lower counts still register
          'heatmap-weight': ['interpolate',['linear'],['get','count'], 0, 0, weightMax, 1],
          // intensity stays lower at zoom-out so mid-density cells stay cyan not white
          'heatmap-intensity': ['interpolate',['linear'],['zoom'], 7, 0.3, 10, 0.7, 14, 3],
          'heatmap-color':     color,
          // radius grows with zoom for detail; at zoom-out keep small so cells don't bleed together
          'heatmap-radius':    ['interpolate',['linear'],['zoom'], 7, 4, 10, 8, 13, 18, 15, 30],
          'heatmap-opacity':   0.9,
        },
      }, 'carto-labels');
    }
  }, []);

  // ── Load data ─────────────────────────────────────────────────────────

  const load = useCallback(async (
    tm: TimeMode, yr: number, mo: number, types: string[]
  ) => {
    const map = mapRef.current; if (!map || !map.isStyleLoaded()) return;
    setLoading(true);

    // types.length === 0 means ALL mode — always load aggregate for all time modes

    try {
      if (types.length === 0) {
        // ALL mode — use pre-generated static file (1y only; 5y = sum over years)
        if (tm === '5y') {
          // Sum 2020–2025 grids
          setLoadMsg('Loading 5Y aggregate…');
          const merged = new Map<string,number>();
          for (let y = 2020; y <= MAX_YEAR; y++) {
            const r = await fetch(`/data/311_heatmap_${y}.json`, { cache: 'force-cache' });
            const d: HeatFile = await r.json();
            for (const c of d.cells) {
              const key = `${c.lat},${c.lng}`;
              merged.set(key, (merged.get(key)??0) + c.count);
            }
          }
          clearAllLayers();
          addHeatLayer('heat-all', gridToGeoJSON(merged), ALL_COLOR, p95counts(merged));
        } else if (tm === '1y') {
          setLoadMsg(`Loading ${yr}…`);
          const r = await fetch(`/data/311_heatmap_${yr}.json`, { cache: 'force-cache' });
          const d: HeatFile = await r.json();
          const geojson: GeoJSON.FeatureCollection = {
            type: 'FeatureCollection',
            features: d.cells.map(c => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
              properties: { count: c.count },
            })),
          };
          const wmax = p95fromCells(d.cells);
          clearAllLayers();
          addHeatLayer('heat-all', geojson, ALL_COLOR, wmax);
        } else {
          // month — live fetch all types for that month
          const start = `${yr}-${String(mo+1).padStart(2,'0')}-01T00:00:00`;
          const nextM = mo === 11 ? `${yr+1}-01-01T00:00:00` : `${yr}-${String(mo+2).padStart(2,'0')}-01T00:00:00`;
          setLoadMsg(`Loading ${MONTHS[mo]} ${yr}…`);
          const grid = await fetchAndBucket(
            `created_date>='${start}' AND created_date<'${nextM}'`,
            msg => setLoadMsg(`${MONTHS[mo]} ${yr} — ${msg}`)
          );
          clearAllLayers();
          addHeatLayer('heat-all', gridToGeoJSON(grid), ALL_COLOR, p95counts(grid));
        }
      } else {
        // Type mode — always clear and reload so time changes are respected
        clearAllLayers();
        for (const type of types) {
          let where: string;
          if (tm === '5y') {
            where = `complaint_type='${type.replace(/'/g,"\\'")}' AND created_date>='2020-01-01T00:00:00' AND created_date<'2026-01-01T00:00:00'`;
          } else if (tm === '1y') {
            where = `complaint_type='${type.replace(/'/g,"\\'")}' AND created_date>='${yr}-01-01T00:00:00' AND created_date<'${yr+1}-01-01T00:00:00'`;
          } else {
            const start = `${yr}-${String(mo+1).padStart(2,'0')}-01T00:00:00`;
            const nextM = mo === 11 ? `${yr+1}-01-01T00:00:00` : `${yr}-${String(mo+2).padStart(2,'0')}-01T00:00:00`;
            where = `complaint_type='${type.replace(/'/g,"\\'")}' AND created_date>='${start}' AND created_date<'${nextM}'`;
          }
          setLoadMsg(`${type}…`);
          const grid = await fetchAndBucket(where, msg => setLoadMsg(`${type} — ${msg}`));
          const color = typeHeatColor(getComplaintColor(type));
          addHeatLayer(`heat-type-${type}`, gridToGeoJSON(grid), color, p95counts(grid));
        }
        // Hide ALL layer if present
        if (map.getLayer('heat-all')) removeLayer('heat-all');
      }
    } catch(e) {
      setLoadMsg(`Error: ${e}`);
    } finally {
      setLoading(false); setLoadMsg('');
    }
  }, [clearAllLayers, addHeatLayer, removeLayer]);

  // ── Map init ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapDivRef.current,
      style: MAP_STYLE,
      center: NYC_CENTER,
      zoom: NYC_ZOOM,
      attributionControl: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    map.on('load', () => {
      load('1y', MAX_YEAR, 0, []);

      // Hover — update corner HUD, no floating popup
      map.on('mousemove', (e) => {
        const layers = (map.getStyle()?.layers??[])
          .filter(l => l.id.startsWith('heat-'))
          .map(l => l.id);
        if (!layers.length) { setHoverInfo(null); return; }

        const features = map.queryRenderedFeatures(e.point, { layers });
        if (features.length) {
          const count = features[0]?.properties?.count as number | undefined;
          const layerId = features[0]?.layer?.id ?? '';
          const typeName = layerId.startsWith('heat-type-')
            ? layerId.replace('heat-type-', '')
            : null;
          setHoverInfo({ count: count ?? 0, types: typeName ? [typeName] : [] });
        } else {
          setHoverInfo(null);
        }
      });
      map.on('mouseleave', () => setHoverInfo(null));
    });

    return () => { map.remove(); mapRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-load when controls change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    // Clear all existing layers then reload
    clearAllLayers();
    load(timeMode, year, month, selectedTypes);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeMode, year, month, activeTypes]);

  // ── Derived state ──────────────────────────────────────────────────────

  const maxYear = MAX_YEAR;
  const maxMonth = month; // display label

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="heatmap-view">
      <div ref={mapDivRef} className="heatmap-map" />

      {/* Loading overlay */}
      {loading && (
        <div className="heatmap-loading-overlay">
          <div className="heatmap-loading-box">
            <div className="heatmap-loading-spinner" />
            <div className="heatmap-loading-msg">{loadMsg || 'Loading…'}</div>
            <div className="heatmap-loading-sub">Large datasets may take a moment</div>
          </div>
        </div>
      )}

      {/* No floating badges — sidebar chips show selection clearly */}

      {/* Controls bar */}
      <div className="heatmap-controls view-controls">
        {/* Time mode */}
        <div className="vc-col vc-col--left">
          <button className={`vc-toggle-btn${timeMode==='5y'?' active':''}`} onClick={() => setTimeMode('5y')}>ALL</button>
          <button className={`vc-toggle-btn${timeMode==='1y'?' active':''}`} onClick={() => setTimeMode('1y')}>1Y</button>
          <button className={`vc-toggle-btn${timeMode==='month'?' active':''}`} onClick={() => setTimeMode('month')}>MONTH</button>
        </div>

        {/* Date nav */}
        <div className="vc-col vc-col--center">
          {timeMode === '5y' ? (
            <span className="vc-date" style={{ opacity: 0.5 }}>2020–2025</span>
          ) : timeMode === '1y' ? (<>
            <button className="vc-nav-btn" disabled={year<=2020} style={{ opacity: year<=2020?.25:undefined }}
              onClick={() => setYear(y => Math.max(2020, y-1))}>◀</button>
            <span className="vc-date">{year}</span>
            <button className="vc-nav-btn" disabled={year>=maxYear} style={{ opacity: year>=maxYear?.25:undefined }}
              onClick={() => setYear(y => Math.min(maxYear, y+1))}>▶</button>
          </>) : (<>
            <button className="vc-nav-btn"
              disabled={year<=2020 && month<=0}
              style={{ opacity: (year<=2020&&month<=0)?.25:undefined }}
              onClick={() => {
                if (month === 0) { setYear(y => y-1); setMonth(11); }
                else setMonth(m => m-1);
              }}>◀</button>
            <span className="vc-date">{MONTHS[maxMonth]} '{String(year).slice(2)}</span>
            <button className="vc-nav-btn"
              disabled={year>=maxYear && month>=11}
              style={{ opacity: (year>=maxYear&&month>=11)?.25:undefined }}
              onClick={() => {
                if (month === 11) { setYear(y => Math.min(maxYear, y+1)); setMonth(0); }
                else setMonth(m => Math.min(11, m+1));
              }}>▶</button>
          </>)}
        </div>

        <div className="vc-col vc-col--right" />
      </div>

      {/* Corner hover HUD — bottom-left, away from nav controls */}
      {hoverInfo && (
        <div className="heatmap-hover-hud">
          <span className="heatmap-hover-count">{hoverInfo.count.toLocaleString()}</span>
          <span className="heatmap-hover-label">
            {hoverInfo.types.length > 0
              ? <span style={{ color: getComplaintColor(hoverInfo.types[0]) }}>{hoverInfo.types[0]}</span>
              : 'reports / cell'
            }
          </span>
        </div>
      )}
    </div>
  );
}
