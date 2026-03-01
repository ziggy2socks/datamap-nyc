import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ParcelProperties, Layer } from './types';
import { LAYERS, LAND_USE_COLORS, LAND_USE_LABELS } from './layers';
import './App.css';

const PMTILES_URL = '/data/parcels.pmtiles';

// Register PMTiles protocol
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

// Park score → green color (light mode palette)
function getParkScoreColor(score: number): string {
  // F0EDE6 (0) → A8CCA8 (30) → 4A8A4A (70) → 2D6E2D (100)
  const stops = [
    { t: 0,   rgb: [240, 237, 230] },
    { t: 30,  rgb: [168, 204, 168] },
    { t: 70,  rgb: [74,  138, 74]  },
    { t: 100, rgb: [45,  110, 45]  },
  ];
  const s = Math.max(0, Math.min(100, score));
  let lo = stops[0], hi = stops[1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (s >= stops[i].t && s <= stops[i + 1].t) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const f = lo.t === hi.t ? 0 : (s - lo.t) / (hi.t - lo.t);
  const r = Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * f);
  const g = Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * f);
  const b = Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * f);
  return `rgb(${r},${g},${b})`;
}

function buildParkScoreExpression(opacity: number) {
  return [
    'interpolate', ['linear'], ['get', 'park_score'],
    0,   `rgba(240,237,230,${opacity})`,
    20,  `rgba(190,220,190,${opacity})`,
    50,  `rgba(120,180,120,${opacity})`,
    80,  `rgba(74,138,74,${opacity})`,
    100, `rgba(45,110,45,${opacity})`,
  ];
}

function buildHeightExpression(opacity: number) {
  return [
    'interpolate', ['linear'], ['get', 'numfloors'],
    0,  `rgba(240,237,230,${opacity})`,
    5,  `rgba(190,210,230,${opacity})`,
    15, `rgba(130,170,210,${opacity})`,
    30, `rgba(74,122,170,${opacity})`,
    60, `rgba(26,74,122,${opacity})`,
  ];
}

function buildLandUseExpression(opacity: number) {
  const cases: unknown[] = ['match', ['get', 'landuse']];
  Object.entries(LAND_USE_COLORS).forEach(([code, color]) => {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    cases.push(code);
    cases.push(`rgba(${r},${g},${b},${opacity})`);
  });
  cases.push(`rgba(200,198,195,${opacity})`);
  return cases;
}

const LIGHT_MAP_STYLE: maplibregl.StyleSpecification = {
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
    { id: 'background', type: 'background', paint: { 'background-color': '#F2EFE9' } },
    {
      id: 'water', type: 'fill', source: 'protomaps', 'source-layer': 'water',
      paint: { 'fill-color': '#D4E4EE' },
    },
    {
      id: 'natural', type: 'fill', source: 'protomaps', 'source-layer': 'natural',
      paint: { 'fill-color': '#E2EDD8' },
    },
    {
      id: 'roads_minor', type: 'line', source: 'protomaps', 'source-layer': 'roads',
      paint: { 'line-color': '#DDD9D2', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 15, 1.5] as maplibregl.DataDrivenPropertyValueSpecification<number> },
    },
    {
      id: 'roads_major', type: 'line', source: 'protomaps', 'source-layer': 'roads',
      paint: { 'line-color': '#C8C3BA', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 15, 3] as maplibregl.DataDrivenPropertyValueSpecification<number> },
    },
    {
      id: 'labels', type: 'symbol', source: 'protomaps', 'source-layer': 'places',
      layout: {
        'text-field': ['get', 'name'] as maplibregl.DataDrivenPropertyValueSpecification<string>,
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 13] as maplibregl.DataDrivenPropertyValueSpecification<number>,
      },
      paint: { 'text-color': '#8A8580', 'text-halo-color': '#F2EFE9', 'text-halo-width': 1.5 },
    },
  ],
};

export default function App() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<maplibregl.Map | null>(null);
  const [layers, setLayers] = useState<Layer[]>(LAYERS);
  const [selectedParcel, setSelectedParcel] = useState<ParcelProperties | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<unknown[]>([]);
  const [mapLoaded, setMapLoaded] = useState(false);

  // Init map
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: LIGHT_MAP_STYLE,
      center: [-73.9857, 40.7484],
      zoom: 12,
    });

    map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

    map.on('load', () => {
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
          'fill-color': buildParkScoreExpression(0.65) as maplibregl.DataDrivenPropertyValueSpecification<string>,
          'fill-outline-color': 'rgba(0,0,0,0.08)',
        },
      });

      // Building height layer (default OFF)
      map.addLayer({
        id: 'parcels-height',
        type: 'fill',
        source: 'parcels',
        'source-layer': 'parcels',
        paint: {
          'fill-color': buildHeightExpression(0.65) as maplibregl.DataDrivenPropertyValueSpecification<string>,
          'fill-outline-color': 'rgba(0,0,0,0.08)',
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
          'fill-color': buildLandUseExpression(0.65) as maplibregl.DataDrivenPropertyValueSpecification<string>,
          'fill-outline-color': 'rgba(0,0,0,0.08)',
        },
        layout: { visibility: 'none' },
      });

      // Parcel hover highlight
      map.addLayer({
        id: 'parcels-hover',
        type: 'fill',
        source: 'parcels',
        'source-layer': 'parcels',
        paint: {
          'fill-color': 'rgba(26,24,20,0.12)',
          'fill-outline-color': 'rgba(26,24,20,0.4)',
        },
        filter: ['==', ['get', 'bbl'], ''],
      });

      // Click handler
      const handleClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (e.features?.[0]) setSelectedParcel(e.features[0].properties as ParcelProperties);
      };

      map.on('click', 'parcels-park-score', handleClick);
      map.on('click', 'parcels-height', handleClick);
      map.on('click', 'parcels-landuse', handleClick);

      // Hover effects
      let hoveredBBL = '';
      const setHover = (bbl: string) => {
        hoveredBBL = bbl;
        map.setFilter('parcels-hover', ['==', ['get', 'bbl'], bbl]);
      };

      ['parcels-park-score', 'parcels-height', 'parcels-landuse'].forEach(layerId => {
        map.on('mousemove', layerId, (e) => {
          const bbl = e.features?.[0]?.properties?.bbl ?? '';
          if (bbl !== hoveredBBL) setHover(bbl);
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', layerId, () => {
          setHover('');
          map.getCanvas().style.cursor = '';
        });
      });

      setMapLoaded(true);
    });

    mapInstance.current = map;
    return () => { map.remove(); mapInstance.current = null; };
  }, []);

  // Sync layer visibility/opacity
  useEffect(() => {
    if (!mapLoaded || !mapInstance.current) return;
    const map = mapInstance.current;

    const layerMap: Record<string, string> = {
      park_score: 'parcels-park-score',
      numfloors:  'parcels-height',
      landuse:    'parcels-landuse',
    };

    layers.forEach(layer => {
      const mapLayerId = layerMap[layer.id];
      if (!mapLayerId) return;
      map.setLayoutProperty(mapLayerId, 'visibility', layer.enabled ? 'visible' : 'none');
      if (layer.id === 'park_score') {
        map.setPaintProperty(mapLayerId, 'fill-color', buildParkScoreExpression(layer.opacity) as maplibregl.DataDrivenPropertyValueSpecification<string>);
      } else if (layer.id === 'numfloors') {
        map.setPaintProperty(mapLayerId, 'fill-color', buildHeightExpression(layer.opacity) as maplibregl.DataDrivenPropertyValueSpecification<string>);
      } else if (layer.id === 'landuse') {
        map.setPaintProperty(mapLayerId, 'fill-color', buildLandUseExpression(layer.opacity) as maplibregl.DataDrivenPropertyValueSpecification<string>);
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

  const flyToResult = (feature: { geometry: { coordinates: [number, number] }; properties?: { label?: string; name?: string } }) => {
    const [lng, lat] = feature.geometry.coordinates;
    mapInstance.current?.flyTo({ center: [lng, lat], zoom: 16, duration: 1000 });
    setSearchResults([]);
    setSearchQuery(feature.properties?.label ?? '');
  };

  const scoreColor = selectedParcel ? getParkScoreColor(selectedParcel.park_score ?? 0) : '#4A8A4A';

  return (
    <div className="app">
      {/* Left sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title">DATAMAP<span className="sidebar-dot">·</span>NYC</div>
          <div className="sidebar-sub">Parcel intelligence</div>
        </div>

        {/* Search */}
        <div className="search-wrap">
          <input
            className="search-input"
            placeholder="Search address…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchResults.length > 0 && (
            <div className="search-results">
              {(searchResults as { properties?: { label?: string; name?: string }; geometry: { coordinates: [number, number] } }[]).map((f, i) => (
                <div key={i} className="search-result" onClick={() => flyToResult(f)}>
                  {f.properties?.label ?? f.properties?.name ?? 'Unknown'}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Layers */}
        <div className="layers-section">
          <div className="section-label">Layers</div>
          {layers.map(layer => (
            <div key={layer.id} className="layer-row">
              <div className="layer-header" onClick={() => toggleLayer(layer.id)}>
                <span
                  className="layer-swatch"
                  style={{ background: layer.accentColor, opacity: layer.enabled ? 1 : 0.3 }}
                />
                <span className="layer-name">{layer.label}</span>
                <button
                  className={`layer-toggle ${layer.enabled ? 'on' : ''}`}
                  onClick={e => { e.stopPropagation(); toggleLayer(layer.id); }}
                  aria-label={`Toggle ${layer.label}`}
                >
                  <span className="layer-toggle-dot" />
                </button>
              </div>

              {layer.enabled && (
                <>
                  <div className="layer-desc">{layer.description}</div>
                  <div className="layer-opacity-row">
                    <span className="layer-opacity-label">Opacity</span>
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
                      {Object.entries(layer.categories).slice(0, 7).map(([code, label]) => (
                        <div key={code} className="category-row">
                          <span className="category-dot" style={{ background: LAND_USE_COLORS[code] ?? '#ccc' }} />
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

      {/* Map */}
      <div ref={mapRef} className="map" />

      {/* Detail panel */}
      <div className={`detail-panel ${selectedParcel ? '' : 'hidden'}`}>
        {selectedParcel && (
          <>
            <div className="detail-header">
              <div className="detail-address">{selectedParcel.address}</div>
              <button className="detail-close" onClick={() => setSelectedParcel(null)}>✕</button>
            </div>

            <div className="detail-borough">
              {selectedParcel.borough} · {selectedParcel.zonedist1}
            </div>

            <div className="detail-score-section">
              <div className="detail-score-label">Park Access Score</div>
              <div className="detail-score-value" style={{ color: scoreColor }}>
                {selectedParcel.park_score ?? 0}
                <span style={{ fontSize: 14, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>/100</span>
              </div>
              <div className="detail-score-bar">
                <div className="detail-score-fill" style={{
                  width: `${selectedParcel.park_score ?? 0}%`,
                  background: scoreColor,
                }} />
              </div>
            </div>

            <div className="detail-grid">
              <div className="detail-field">
                <div className="detail-field-label">Land Use</div>
                <div className="detail-field-value">{LAND_USE_LABELS[selectedParcel.landuse] ?? (selectedParcel.landuse || '—')}</div>
              </div>
              <div className="detail-field">
                <div className="detail-field-label">Floors</div>
                <div className="detail-field-value">{selectedParcel.numfloors || '—'}</div>
              </div>
              <div className="detail-field">
                <div className="detail-field-label">Year Built</div>
                <div className="detail-field-value">{selectedParcel.yearbuilt || '—'}</div>
              </div>
              <div className="detail-field">
                <div className="detail-field-label">Lot Area</div>
                <div className="detail-field-value">
                  {selectedParcel.lotarea ? `${Number(selectedParcel.lotarea).toLocaleString()} sf` : '—'}
                </div>
              </div>
              <div className="detail-field">
                <div className="detail-field-label">Res. Units</div>
                <div className="detail-field-value">{selectedParcel.unitsres || '—'}</div>
              </div>
              <div className="detail-field">
                <div className="detail-field-label">BBL</div>
                <div className="detail-field-value detail-muted">{selectedParcel.bbl || '—'}</div>
              </div>
            </div>

            <div className="detail-links">
              {selectedParcel.bbl && (
                <a
                  className="detail-link"
                  href={`https://zola.planning.nyc.gov/l/lot/${selectedParcel.bbl.slice(0,1)}/${selectedParcel.bbl.slice(1,6)}/${selectedParcel.bbl.slice(6)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ZoLa ↗
                </a>
              )}
              {selectedParcel.bbl && (
                <a
                  className="detail-link"
                  href={`https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?boro=${selectedParcel.bbl.slice(0,1)}&block=${selectedParcel.bbl.slice(1,6)}&lot=${selectedParcel.bbl.slice(6)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  DOB ↗
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
