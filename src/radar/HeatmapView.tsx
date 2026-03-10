import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getComplaintColor } from './complaints';

// ── Types ──────────────────────────────────────────────────────────────────

interface HeatCell { lat: number; lng: number; count: number; }
interface HeatFile { year: number; generated: string; res: number; cells: HeatCell[]; }

interface Props {
  activeTypes: Set<string>;     // from sidebar chips — selected types (empty = ALL mode)
  onClearTypes: () => void;
}

// ── Map style ──────────────────────────────────────────────────────────────

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
    { id: 'carto-base', type: 'raster' as const, source: 'carto' },
    { id: 'carto-labels', type: 'raster' as const, source: 'carto_labels', paint: { 'raster-opacity': 0.5 } },
  ],
};

const NYC_CENTER: [number, number] = [-73.97, 40.70];
const NYC_ZOOM = 10.5;

const OVERLAY_API = '/api/311';
const BATCH_SIZE = 50_000;

// ── Helpers ────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function heatmapColor(hex: string): maplibregl.ExpressionSpecification {
  const [r, g, b] = hexToRgb(hex);
  return [
    'interpolate', ['linear'], ['heatmap-density'],
    0,   `rgba(0,0,0,0)`,
    0.1, `rgba(${Math.round(r*0.2)},${Math.round(g*0.2)},${Math.round(b*0.2)},0.4)`,
    0.4, `rgba(${Math.round(r*0.6)},${Math.round(g*0.6)},${Math.round(b*0.6)},0.7)`,
    0.7, `rgba(${r},${g},${b},0.85)`,
    1.0, `rgba(255,255,255,0.95)`,
  ] as unknown as maplibregl.ExpressionSpecification;
}

// All-mode gradient: dark navy → cyan → white
const ALL_HEATMAP_COLOR: maplibregl.ExpressionSpecification = [
  'interpolate', ['linear'], ['heatmap-density'],
  0,   'rgba(0,0,0,0)',
  0.1, 'rgba(0,40,60,0.5)',
  0.3, 'rgba(0,100,130,0.65)',
  0.5, 'rgba(0,170,200,0.75)',
  0.7, 'rgba(0,220,230,0.85)',
  0.9, 'rgba(180,255,255,0.92)',
  1.0, 'rgba(255,255,255,0.97)',
] as unknown as maplibregl.ExpressionSpecification;

// ── Component ──────────────────────────────────────────────────────────────

export function HeatmapView({ activeTypes, onClearTypes }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState('');
  const [year, setYear] = useState(() => {
    const now = new Date().getFullYear();
    return now > 2025 ? 2025 : now - 1; // default to last complete year
  });

  // Selected types from sidebar — 0 = ALL, 1 = single, 2-4 = small multiples
  const selectedTypes = [...activeTypes];
  const isAll = selectedTypes.length === 0;
  const isSingle = selectedTypes.length === 1;
  const isMulti = selectedTypes.length >= 2 && selectedTypes.length <= 4;

  // ── Map init ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: NYC_CENTER,
      zoom: NYC_ZOOM,
      attributionControl: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // ── Load heatmap data ─────────────────────────────────────────────────────

  const loadAllMode = useCallback(async (yr: number) => {
    const map = mapRef.current;
    if (!map) return;
    setLoading(true);
    setLoadMsg(`Loading ${yr} heatmap…`);

    try {
      const res = await fetch(`/data/311_heatmap_${yr}.json`, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: HeatFile = await res.json();

      const geojson: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: data.cells.map(c => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
          properties: { count: c.count },
        })),
      };

      if (map.getSource('heatmap-src')) {
        (map.getSource('heatmap-src') as maplibregl.GeoJSONSource).setData(geojson);
      } else {
        map.addSource('heatmap-src', { type: 'geojson', data: geojson });
        map.addLayer({
          id: 'heatmap-layer',
          type: 'heatmap',
          source: 'heatmap-src',
          paint: {
            'heatmap-weight': ['interpolate', ['linear'], ['get', 'count'], 0, 0, 500, 1],
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, 3],
            'heatmap-color': ALL_HEATMAP_COLOR,
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 12, 18, 15, 30],
            'heatmap-opacity': 0.85,
          },
        }, 'carto-labels');
      }
      setLoadMsg('');
    } catch (e) {
      setLoadMsg(`Failed to load — ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTypeMode = useCallback(async (yr: number, type: string) => {
    const map = mapRef.current;
    if (!map) return;
    setLoading(true);
    setLoadMsg(`Fetching ${type}…`);

    try {
      // Fetch raw lat/lng for this type from Socrata via proxy
      const start = `${yr}-01-01T00:00:00`;
      const end   = `${yr + 1}-01-01T00:00:00`;
      const GRID  = 0.0005;

      const snap = (v: number) => Math.round(Math.round(v / GRID) * GRID * 1e6) / 1e6;
      const grid = new Map<string, number>();

      let offset = 0;
      while (true) {
        const params = new URLSearchParams({
          '$select': 'latitude,longitude',
          '$where': `complaint_type='${type}' AND created_date>='${start}' AND created_date<'${end}' AND latitude IS NOT NULL AND longitude IS NOT NULL`,
          '$limit': String(BATCH_SIZE),
          '$offset': String(offset),
        });
        const res = await fetch(`${OVERLAY_API}?${params}`);
        if (!res.ok) throw new Error(`API ${res.status}`);
        const rows: Array<{ latitude: string; longitude: string }> = await res.json();
        if (!rows.length) break;

        for (const r of rows) {
          const lat = parseFloat(r.latitude);
          const lng = parseFloat(r.longitude);
          if (!isFinite(lat) || !isFinite(lng)) continue;
          if (lat < 40.4 || lat > 40.95 || lng < -74.3 || lng > -73.65) continue;
          const key = `${snap(lat)},${snap(lng)}`;
          grid.set(key, (grid.get(key) ?? 0) + 1);
        }

        offset += BATCH_SIZE;
        setLoadMsg(`Fetching ${type}… ${offset.toLocaleString()} rows`);
        if (rows.length < BATCH_SIZE) break;
      }

      const color = getComplaintColor(type);
      const geojson: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: [...grid.entries()].map(([key, count]) => {
          const [lat, lng] = key.split(',').map(Number);
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lng, lat] },
            properties: { count },
          };
        }),
      };

      const sourceId = `heatmap-src-${type}`;
      const layerId  = `heatmap-layer-${type}`;

      if (map.getSource(sourceId)) {
        (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(geojson);
      } else {
        map.addSource(sourceId, { type: 'geojson', data: geojson });
        map.addLayer({
          id: layerId,
          type: 'heatmap',
          source: sourceId,
          paint: {
            'heatmap-weight': ['interpolate', ['linear'], ['get', 'count'], 0, 0, 200, 1],
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 4],
            'heatmap-color': heatmapColor(color.startsWith('#') ? color : '#00c8dc'),
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 8, 8, 12, 20, 15, 35],
            'heatmap-opacity': 0.9,
          },
        }, 'carto-labels');
      }

      setLoadMsg('');
    } catch (e) {
      setLoadMsg(`Failed — ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Remove a type's layer when it's deselected
  const removeTypeLayer = useCallback((type: string) => {
    const map = mapRef.current;
    if (!map) return;
    const layerId  = `heatmap-layer-${type}`;
    const sourceId = `heatmap-src-${type}`;
    if (map.getLayer(layerId))  map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }, []);

  // ── React to year / type changes ──────────────────────────────────────────

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onLoad = () => {
      if (isAll) loadAllMode(year);
    };
    if (map.isStyleLoaded()) onLoad();
    else map.once('load', onLoad);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload when year changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (isAll) {
      loadAllMode(year);
    } else {
      // Reload all active type layers for new year
      for (const type of selectedTypes) loadTypeMode(year, type);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  // React to ALL mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (isAll) {
      // Hide all type layers
      for (const layer of (map.getStyle()?.layers ?? [])) {
        if (layer.id.startsWith('heatmap-layer-')) map.setLayoutProperty(layer.id, 'visibility', 'none');
      }
      // Show/load ALL layer
      if (map.getLayer('heatmap-layer')) {
        map.setLayoutProperty('heatmap-layer', 'visibility', 'visible');
      } else {
        loadAllMode(year);
      }
    } else {
      // Hide ALL layer
      if (map.getLayer('heatmap-layer')) map.setLayoutProperty('heatmap-layer', 'visibility', 'none');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAll]);

  // React to type selection changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || isAll) return;

    // Find layers that are no longer selected and remove them
    for (const layer of (map.getStyle()?.layers ?? [])) {
      if (!layer.id.startsWith('heatmap-layer-')) continue;
      const type = layer.id.replace('heatmap-layer-', '');
      if (!activeTypes.has(type)) removeTypeLayer(type);
    }

    // Load newly selected types
    for (const type of selectedTypes) {
      if (!map.getLayer(`heatmap-layer-${type}`)) loadTypeMode(year, type);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTypes]);

  // ── Render ────────────────────────────────────────────────────────────────

  const maxYear = new Date().getFullYear() - 1; // last complete year

  return (
    <div className="heatmap-view">
      {/* Map panels — single or small multiples */}
      {isMulti ? (
        <div className={`heatmap-panels heatmap-panels--${selectedTypes.length}`}>
          {selectedTypes.map(type => (
            <div key={type} className="heatmap-panel">
              <div className="heatmap-panel-label" style={{ color: getComplaintColor(type) }}>
                {type}
              </div>
              {/* Each panel shares the same map container in single-map mode;
                  for small multiples we'd need N map instances — handled via CSS layout
                  The primary map is always rendered; extra panels are overlaid */}
            </div>
          ))}
        </div>
      ) : null}

      <div
        ref={mapContainerRef}
        className={`heatmap-map${isMulti ? ' heatmap-map--multi' : ''}`}
      />

      {/* Loading overlay */}
      {loading && (
        <div className="heatmap-loading">
          <span className="heatmap-loading-dot" />
          {loadMsg || 'Loading…'}
        </div>
      )}

      {/* Type label when single type active */}
      {isSingle && (
        <div className="heatmap-type-badge" style={{ borderColor: getComplaintColor(selectedTypes[0]) }}>
          <span className="heatmap-type-badge-dot" style={{ background: getComplaintColor(selectedTypes[0]) }} />
          {selectedTypes[0]}
          <button className="heatmap-type-badge-x" onClick={onClearTypes}>✕</button>
        </div>
      )}

      {/* Controls bar */}
      <div className="heatmap-controls">
        <div className="vc-col vc-col--left">
          <button
            className={`vc-toggle-btn${isAll ? ' active' : ''}`}
            onClick={onClearTypes}
          >ALL</button>
        </div>
        <div className="vc-col vc-col--center">
          <button
            className="vc-nav-btn"
            disabled={year <= 2020}
            style={{ opacity: year <= 2020 ? 0.25 : undefined }}
            onClick={() => setYear(y => Math.max(2020, y - 1))}
          >◀</button>
          <span className="vc-date">{year}</span>
          <button
            className="vc-nav-btn"
            disabled={year >= maxYear}
            style={{ opacity: year >= maxYear ? 0.25 : undefined }}
            onClick={() => setYear(y => Math.min(maxYear, y + 1))}
          >▶</button>
        </div>
        <div className="vc-col vc-col--right" />
      </div>

      {/* Sidebar type list — injected via RadarApp's existing sidebar */}
      {/* (RadarApp handles sidebar rendering; this component just receives the props) */}
    </div>
  );
}
