import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ParcelProperties, Layer } from './types';
import { LAYERS, LAND_USE_COLORS, LAND_USE_LABELS } from './layers';
import './App.css';

const PMTILES_URL = '/data/parcels.pmtiles';

// Register PMTiles protocol with MapLibre
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

function getParkScoreColor(score: number): string {
  const colors = ['#0a0c14', '#1a4a1a', '#2d7a2d', '#52c452', '#88ff88'];
  const t = Math.min(1, score / 100);
  const idx = t * (colors.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(colors.length - 1, lo + 1);
  const f = idx - lo;
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * f);
  const hexToRgb = (h: string) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const rgbToHex = (r: number, g: number, b: number) =>
    '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  const [r1, g1, b1] = hexToRgb(colors[lo]);
  const [r2, g2, b2] = hexToRgb(colors[hi]);
  return rgbToHex(lerp(r1, r2), lerp(g1, g2), lerp(b1, b2));
}

function buildParkScoreExpression(opacity: number) {
  return [
    'interpolate', ['linear'], ['get', 'park_score'],
    0,  `rgba(10,12,20,${opacity})`,
    10, `rgba(26,74,26,${opacity})`,
    30, `rgba(45,122,45,${opacity})`,
    60, `rgba(82,196,82,${opacity})`,
    100, `rgba(136,255,136,${opacity})`,
  ];
}

function buildHeightExpression(opacity: number) {
  return [
    'interpolate', ['linear'], ['get', 'numfloors'],
    0,  `rgba(10,12,20,${opacity})`,
    5,  `rgba(26,42,74,${opacity})`,
    15, `rgba(34,68,170,${opacity})`,
    30, `rgba(68,136,255,${opacity})`,
    60, `rgba(170,221,255,${opacity})`,
  ];
}

function buildLandUseExpression(opacity: number) {
  const cases: (string | string[])[] = ['match', ['get', 'landuse']];
  Object.entries(LAND_USE_COLORS).forEach(([code, color]) => {
    cases.push(code);
    // Convert hex to rgba
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    cases.push(`rgba(${r},${g},${b},${opacity})`);
  });
  cases.push(`rgba(80,80,80,${opacity})`);
  return cases;
}

export default function App() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<maplibregl.Map | null>(null);
  const [layers, setLayers] = useState<Layer[]>(LAYERS);
  const [selectedParcel, setSelectedParcel] = useState<ParcelProperties | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [mapLoaded, setMapLoaded] = useState(false);

  // Init map
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: {
        version: 8,
        glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
        sources: {
          protomaps: {
            type: 'vector',
            url: 'pmtiles:https://build.protomaps.com/20240828.pmtiles',
            attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
          },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#0a0c14' } },
          { id: 'water', type: 'fill', source: 'protomaps', 'source-layer': 'water', paint: { 'fill-color': '#0d1824' } },
          { id: 'roads', type: 'line', source: 'protomaps', 'source-layer': 'roads', paint: { 'line-color': '#1a2233', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 15, 2] } },
          { id: 'labels', type: 'symbol', source: 'protomaps', 'source-layer': 'places', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 13] }, paint: { 'text-color': '#556688', 'text-halo-color': '#0a0c14', 'text-halo-width': 1 } },
        ],
      },
      center: [-73.9857, 40.7484],
      zoom: 12,
    });

    map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

    map.on('load', () => {
      // Add parcel PMTiles source
      map.addSource('parcels', {
        type: 'vector',
        url: `pmtiles://${window.location.origin}${PMTILES_URL}`,
      });

      // Park score layer (default ON)
      map.addLayer({
        id: 'parcels-park-score',
        type: 'fill',
        source: 'parcels',
        'source-layer': 'parcels',
        paint: {
          'fill-color': buildParkScoreExpression(0.75) as any,
          'fill-outline-color': 'rgba(255,255,255,0.03)',
        },
      });

      // Building height layer (default OFF)
      map.addLayer({
        id: 'parcels-height',
        type: 'fill',
        source: 'parcels',
        'source-layer': 'parcels',
        paint: {
          'fill-color': buildHeightExpression(0.75) as any,
          'fill-outline-color': 'rgba(255,255,255,0.03)',
        },
        layout: { visibility: 'none' },
      });

      // Land use layer (default OFF)
      map.addLayer({
        id: 'parcels-landuse',
        type: 'fill',
        source: 'parcels',
        'source-layer': 'parcels',
        paint: {
          'fill-color': buildLandUseExpression(0.75) as any,
          'fill-outline-color': 'rgba(255,255,255,0.03)',
        },
        layout: { visibility: 'none' },
      });

      // Click handler
      map.on('click', 'parcels-park-score', (e) => {
        if (e.features?.[0]) {
          setSelectedParcel(e.features[0].properties as ParcelProperties);
        }
      });
      map.on('click', 'parcels-height', (e) => {
        if (e.features?.[0]) setSelectedParcel(e.features[0].properties as ParcelProperties);
      });
      map.on('click', 'parcels-landuse', (e) => {
        if (e.features?.[0]) setSelectedParcel(e.features[0].properties as ParcelProperties);
      });

      map.on('mouseenter', 'parcels-park-score', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'parcels-park-score', () => { map.getCanvas().style.cursor = ''; });

      setMapLoaded(true);
    });

    mapInstance.current = map;
    return () => { map.remove(); mapInstance.current = null; };
  }, []);

  // Sync layer visibility/opacity to map
  useEffect(() => {
    if (!mapLoaded || !mapInstance.current) return;
    const map = mapInstance.current;

    const layerMap: Record<string, string> = {
      park_score: 'parcels-park-score',
      numfloors: 'parcels-height',
      landuse: 'parcels-landuse',
    };

    layers.forEach(layer => {
      const mapLayerId = layerMap[layer.id];
      if (!mapLayerId) return;
      map.setLayoutProperty(mapLayerId, 'visibility', layer.enabled ? 'visible' : 'none');
      if (layer.id === 'park_score') {
        map.setPaintProperty(mapLayerId, 'fill-color', buildParkScoreExpression(layer.opacity) as any);
      } else if (layer.id === 'numfloors') {
        map.setPaintProperty(mapLayerId, 'fill-color', buildHeightExpression(layer.opacity) as any);
      } else if (layer.id === 'landuse') {
        map.setPaintProperty(mapLayerId, 'fill-color', buildLandUseExpression(layer.opacity) as any);
      }
    });
  }, [layers, mapLoaded]);

  const toggleLayer = (id: string) => {
    setLayers(prev => prev.map(l => l.id === id ? { ...l, enabled: !l.enabled } : l));
  };

  const setOpacity = (id: string, opacity: number) => {
    setLayers(prev => prev.map(l => l.id === id ? { ...l, opacity } : l));
  };

  // Address search
  const search = useCallback(async (q: string) => {
    if (q.length < 3) { setSearchResults([]); return; }
    try {
      const res = await fetch(`/api/geocode?text=${encodeURIComponent(q)}&size=5`);
      const data = await res.json();
      setSearchResults(data.features ?? []);
    } catch { setSearchResults([]); }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => search(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery, search]);

  const flyToResult = (feature: any) => {
    const [lng, lat] = feature.geometry.coordinates;
    mapInstance.current?.flyTo({ center: [lng, lat], zoom: 16, duration: 1000 });
    setSearchResults([]);
    setSearchQuery(feature.properties.label ?? '');
  };

  const parkScoreColor = selectedParcel ? getParkScoreColor(selectedParcel.park_score ?? 0) : '#00ff88';

  return (
    <div className="app">
      <div ref={mapRef} className="map" />

      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title">DATAMAP<span className="sidebar-dot">·</span>NYC</div>
          <div className="sidebar-sub">Parcel intelligence</div>
        </div>

        {/* Address search */}
        <div className="search-wrap">
          <input
            className="search-input"
            placeholder="Search address…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((f, i) => (
                <div key={i} className="search-result" onClick={() => flyToResult(f)}>
                  {f.properties?.label ?? f.properties?.name ?? 'Unknown'}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Layer controls */}
        <div className="layers-section">
          <div className="section-label">LAYERS</div>
          {layers.map(layer => (
            <div key={layer.id} className="layer-row">
              <div className="layer-header">
                <button
                  className={`layer-toggle ${layer.enabled ? 'on' : ''}`}
                  onClick={() => toggleLayer(layer.id)}
                >
                  <span className="layer-toggle-dot" />
                </button>
                <span className="layer-name">{layer.label}</span>
              </div>
              {layer.enabled && (
                <>
                  <div className="layer-desc">{layer.description}</div>
                  <div className="layer-opacity-row">
                    <span className="layer-opacity-label">OPACITY</span>
                    <input
                      type="range" min={0.1} max={1} step={0.05}
                      value={layer.opacity}
                      onChange={e => setOpacity(layer.id, parseFloat(e.target.value))}
                      className="opacity-slider"
                    />
                  </div>
                  {layer.type === 'continuous' && (
                    <div className="layer-legend">
                      <span className="legend-label">Low</span>
                      <div className="legend-bar" style={{
                        background: `linear-gradient(to right, ${layer.colorScale.join(', ')})`,
                      }} />
                      <span className="legend-label">High</span>
                    </div>
                  )}
                  {layer.type === 'categorical' && layer.categories && (
                    <div className="layer-categories">
                      {Object.entries(layer.categories).slice(0, 6).map(([code, label]) => (
                        <div key={code} className="category-row">
                          <span className="category-dot" style={{ background: LAND_USE_COLORS[code] ?? '#666' }} />
                          <span className="category-label">{label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>

        <div className="sidebar-footer">datamap.nyc · NYC Open Data</div>
      </div>

      {/* Parcel detail panel */}
      {selectedParcel && (
        <div className="detail-panel">
          <div className="detail-header">
            <div className="detail-address">{selectedParcel.address}</div>
            <button className="detail-close" onClick={() => setSelectedParcel(null)}>✕</button>
          </div>
          <div className="detail-borough">{selectedParcel.borough} · {selectedParcel.zonedist1}</div>

          <div className="detail-divider" />

          <div className="detail-score-row">
            <div className="detail-score-label">PARK ACCESS SCORE</div>
            <div className="detail-score-bar">
              <div className="detail-score-fill" style={{
                width: `${selectedParcel.park_score ?? 0}%`,
                background: parkScoreColor,
              }} />
            </div>
            <div className="detail-score-value" style={{ color: parkScoreColor }}>
              {selectedParcel.park_score ?? 0}/100
            </div>
          </div>

          <div className="detail-divider" />

          <div className="detail-grid">
            <div className="detail-field">
              <div className="detail-field-label">LAND USE</div>
              <div className="detail-field-value">{LAND_USE_LABELS[selectedParcel.landuse] ?? (selectedParcel.landuse || '—')}</div>
            </div>
            <div className="detail-field">
              <div className="detail-field-label">FLOORS</div>
              <div className="detail-field-value">{selectedParcel.numfloors || '—'}</div>
            </div>
            <div className="detail-field">
              <div className="detail-field-label">YEAR BUILT</div>
              <div className="detail-field-value">{selectedParcel.yearbuilt || '—'}</div>
            </div>
            <div className="detail-field">
              <div className="detail-field-label">LOT AREA</div>
              <div className="detail-field-value">{selectedParcel.lotarea ? `${Number(selectedParcel.lotarea).toLocaleString()} sf` : '—'}</div>
            </div>
            <div className="detail-field">
              <div className="detail-field-label">UNITS</div>
              <div className="detail-field-value">{selectedParcel.unitsres || '—'}</div>
            </div>
            <div className="detail-field">
              <div className="detail-field-label">BBL</div>
              <div className="detail-field-value detail-muted">{selectedParcel.bbl || '—'}</div>
            </div>
          </div>

          <div className="detail-divider" />
          <div className="detail-links">
            {selectedParcel.bbl && (
              <a className="detail-link" href={`https://zola.planning.nyc.gov/l/lot/${selectedParcel.bbl.slice(0,1)}/${selectedParcel.bbl.slice(1,6)}/${selectedParcel.bbl.slice(6)}`} target="_blank" rel="noopener noreferrer">🗺 ZoLa</a>
            )}
            {selectedParcel.bbl && (
              <a className="detail-link" href={`https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?boro=${selectedParcel.bbl.slice(0,1)}&block=${selectedParcel.bbl.slice(1,6)}&lot=${selectedParcel.bbl.slice(6)}`} target="_blank" rel="noopener noreferrer">🏛 DOB</a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
