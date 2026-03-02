import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ParcelProperties, Layer } from './types';
import { LAYER_GROUPS, LAYERS, LAND_USE_COLORS, LAND_USE_LABELS } from './layers';
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

// Color expressions — use circle-opacity for overall opacity, pure RGB colors here
// park_score = -1 means "park parcel, excluded from ranking" — render transparent
const PARK_SCORE_COLOR = [
  'case',
  ['<', ['get', 'park_score'], 0], 'rgba(0,0,0,0)',
  [
    'interpolate', ['linear'], ['get', 'park_score'],
    0,   'rgb(240,237,230)',
    20,  'rgb(190,220,190)',
    50,  'rgb(120,180,120)',
    80,  'rgb(74,138,74)',
    100, 'rgb(45,110,45)',
  ],
];

const HEIGHT_COLOR = [
  'interpolate', ['linear'], ['get', 'numfloors'],
  0,  'rgb(240,237,230)',
  5,  'rgb(190,210,230)',
  15, 'rgb(130,170,210)',
  30, 'rgb(74,122,170)',
  60, 'rgb(26,74,122)',
];

const DENSITY_COLOR = [
  'interpolate', ['linear'],
  // density = unitsres / lotarea * 1000 — derived in pipeline
  // alternatively compute on the fly: ['/', ['*', ['get','unitsres'], 1000], ['+', ['get','lotarea'], 1]]
  ['/', ['*', ['to-number', ['get', 'unitsres']], 1000], ['+', ['to-number', ['get', 'lotarea']], 1]],
  0,    'rgb(240,237,230)',
  0.5,  'rgb(224,196,208)',
  2,    'rgb(192,128,160)',
  5,    'rgb(160,80,112)',
  10,   'rgb(106,24,64)',
];

const YEARBUILT_COLOR = [
  'interpolate', ['linear'], ['get', 'yearbuilt'],
  0,    'rgb(240,237,230)',   // unknown / 0
  1850, 'rgb(96,64,16)',      // very old
  1900, 'rgb(160,128,64)',
  1940, 'rgb(192,168,96)',
  1970, 'rgb(208,196,140)',
  2000, 'rgb(220,210,180)',
  2020, 'rgb(240,237,230)',   // brand new = neutral
];

// Binary flood layers — 0=no risk (transparent), 1=in zone (color)
const FLOOD_100YR_COLOR = [
  'case',
  ['==', ['get', 'flood_100yr'], 1], 'rgb(74,122,176)',
  'rgba(0,0,0,0)',
];

const FLOOD_STORM_COLOR = [
  'case',
  ['==', ['get', 'flood_storm'], 1], 'rgb(122,74,176)',
  'rgba(0,0,0,0)',
];

function buildLandUseExpression() {
  const cases: unknown[] = ['match', ['get', 'landuse']];
  Object.entries(LAND_USE_COLORS).forEach(([code, color]) => {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    cases.push(code);
    cases.push(`rgb(${r},${g},${b})`);
  });
  cases.push('rgb(200,198,195)');
  return cases;
}

function buildMapStyle(): maplibregl.StyleSpecification {
  // Simple raster fallback using Carto light tiles — always works, no key needed
  return {
    version: 8,
    sources: {
      'carto-light': {
        type: 'raster',
        tiles: ['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'],
        tileSize: 256,
        attribution: '© <a href="https://carto.com">Carto</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: [
      { id: 'carto-light', type: 'raster', source: 'carto-light' },
    ],
  };
}

export default function App() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<maplibregl.Map | null>(null);
  const [layers, setLayers] = useState<Layer[]>(LAYERS);
  const [expandedInfo, setExpandedInfo] = useState<string | null>(null); // layer id with open info
  const [selectedParcel, setSelectedParcel] = useState<ParcelProperties | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<unknown[]>([]);
  const [mapLoaded, setMapLoaded] = useState(false);

  // Init map
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: buildMapStyle(),
      center: [-73.9857, 40.7484],
      zoom: 12,
    });

    map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

    map.on('load', () => {
      map.addSource('parcels', {
        type: 'vector',
        url: `pmtiles://${window.location.origin}${PMTILES_URL}`,
      });

      const circleRadius = [
        'interpolate', ['linear'], ['zoom'],
        10, 1.5, 13, 3, 15, 6, 17, 12,
      ] as maplibregl.DataDrivenPropertyValueSpecification<number>;

      const addParcelLayer = (id: string, color: unknown, visible: boolean) => {
        map.addLayer({
          id,
          type: 'circle',
          source: 'parcels',
          'source-layer': 'parcels',
          paint: {
            'circle-color': color as maplibregl.DataDrivenPropertyValueSpecification<string>,
            'circle-radius': circleRadius,
            'circle-stroke-width': 0,
            'circle-opacity': 0.75,
          },
          layout: { visibility: visible ? 'visible' : 'none' },
        });
      };

      addParcelLayer('parcels-park-score',  PARK_SCORE_COLOR,      true);
      addParcelLayer('parcels-flood-100yr', FLOOD_100YR_COLOR,     false);
      addParcelLayer('parcels-flood-storm', FLOOD_STORM_COLOR,     false);
      addParcelLayer('parcels-height',      HEIGHT_COLOR,          false);
      addParcelLayer('parcels-density',     DENSITY_COLOR,         false);
      addParcelLayer('parcels-yearbuilt',   YEARBUILT_COLOR,       false);
      addParcelLayer('parcels-landuse',     buildLandUseExpression(), false);

      // Hover ring
      map.addLayer({
        id: 'parcels-hover',
        type: 'circle',
        source: 'parcels',
        'source-layer': 'parcels',
        paint: {
          'circle-color': 'rgba(26,24,20,0)',
          'circle-radius': circleRadius,
          'circle-stroke-width': 2,
          'circle-stroke-color': 'rgba(26,24,20,0.6)',
        },
        filter: ['==', ['get', 'bbl'], ''],
      });

      const handleClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (e.features?.[0]) setSelectedParcel(e.features[0].properties as ParcelProperties);
      };

      const PARCEL_LAYER_IDS = ['parcels-park-score','parcels-flood-100yr','parcels-flood-storm','parcels-height','parcels-density','parcels-yearbuilt','parcels-landuse'];
      PARCEL_LAYER_IDS.forEach(id => map.on('click', id, handleClick));

      // Hover effects
      let hoveredBBL = '';
      const setHover = (bbl: string) => {
        hoveredBBL = bbl;
        map.setFilter('parcels-hover', ['==', ['get', 'bbl'], bbl]);
      };

      PARCEL_LAYER_IDS.forEach(layerId => {
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
      park_score:  'parcels-park-score',
      flood_100yr: 'parcels-flood-100yr',
      flood_storm: 'parcels-flood-storm',
      numfloors:   'parcels-height',
      density:     'parcels-density',
      yearbuilt:   'parcels-yearbuilt',
      landuse:     'parcels-landuse',
    };

    const colorMap: Record<string, unknown> = {
      park_score:  PARK_SCORE_COLOR,
      flood_100yr: FLOOD_100YR_COLOR,
      flood_storm: FLOOD_STORM_COLOR,
      numfloors:   HEIGHT_COLOR,
      density:     DENSITY_COLOR,
      yearbuilt:   YEARBUILT_COLOR,
      landuse:     buildLandUseExpression(),
    };

    layers.forEach(layer => {
      const mapLayerId = layerMap[layer.id];
      if (!mapLayerId) return;
      map.setLayoutProperty(mapLayerId, 'visibility', layer.enabled ? 'visible' : 'none');
      map.setPaintProperty(mapLayerId, 'circle-color', colorMap[layer.id] as maplibregl.DataDrivenPropertyValueSpecification<string>);
      map.setPaintProperty(mapLayerId, 'circle-opacity', layer.opacity);
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
  const [showMethodology, setShowMethodology] = useState(false);

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

        {/* Layers — grouped */}
        <div className="layers-section">
          {LAYER_GROUPS.map(group => (
            <div key={group.id} className="layer-group">
              <div className="layer-group-label">{group.label}</div>
              {group.layers.map(groupLayer => {
                const layer = layers.find(l => l.id === groupLayer.id) ?? groupLayer;
                const infoOpen = expandedInfo === layer.id;
                return (
                  <div key={layer.id} className="layer-row">
                    <div className="layer-header">
                      <span
                        className="layer-swatch"
                        style={{ background: layer.accentColor, opacity: layer.enabled ? 1 : 0.35 }}
                        onClick={() => toggleLayer(layer.id)}
                      />
                      <span
                        className="layer-name"
                        style={{ opacity: layer.enabled ? 1 : 0.6 }}
                        onClick={() => toggleLayer(layer.id)}
                      >{layer.label}</span>
                      <button
                        className={`layer-info-btn${infoOpen ? ' active' : ''}`}
                        onClick={() => setExpandedInfo(infoOpen ? null : layer.id)}
                        title="About this layer"
                      >ⓘ</button>
                      <button
                        className={`layer-toggle${layer.enabled ? ' on' : ''}`}
                        onClick={() => toggleLayer(layer.id)}
                        aria-label={`Toggle ${layer.label}`}
                      ><span className="layer-toggle-dot" /></button>
                    </div>

                    {infoOpen && (
                      <div className="layer-info-panel">{layer.description}</div>
                    )}

                    {layer.enabled && (
                      <div className="layer-controls">
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
                            <div className="legend-bar" style={{ background: `linear-gradient(to right, ${layer.colorScale.join(', ')})` }} />
                            <span className="legend-label">High</span>
                          </div>
                        )}
                        {layer.type === 'binary' && (
                          <div className="layer-legend">
                            <span className="category-dot" style={{ background: layer.accentColor, borderRadius: '2px', width: '10px', height: '10px', display: 'inline-block', marginRight: 6 }} />
                            <span className="legend-label" style={{ color: 'var(--text-secondary)' }}>In flood zone</span>
                          </div>
                        )}
                        {layer.type === 'categorical' && layer.categories && (
                          <div className="layer-categories">
                            {Object.entries(layer.categories).map(([code, lbl]) => (
                              <div key={code} className="category-row">
                                <span className="category-dot" style={{ background: LAND_USE_COLORS[code] ?? '#ccc' }} />
                                <span className="category-label">{lbl}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
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
              <div className="detail-score-label-row">
                <span className="detail-score-label">Park Access</span>
                <button
                  className="detail-info-btn"
                  onClick={() => setShowMethodology(v => !v)}
                  title="How this score is calculated"
                >
                  {showMethodology ? '✕' : 'ⓘ'}
                </button>
              </div>

              {showMethodology ? (
                <div className="detail-methodology">
                  <p><strong>Gravity model</strong> — measures cumulative access to all open spaces within 1 mile.</p>
                  <p className="detail-methodology-formula">score = Σ acres<sub>i</sub> / (dist<sub>i</sub> + 50)²</p>
                  <p>Distance is measured to the <em>nearest edge</em> of each park polygon — not its centroid. A parcel touching Central Park's edge gets the same distance (≈0) as one inside it.</p>
                  <p>The final score is a <strong>percentile rank</strong> across all 857k NYC parcels. A score of 35 means this parcel has better park access than 35% of NYC parcels — and worse access than 64%.</p>
                  <p className="detail-methodology-raw">Raw gravity value: <span className="detail-mono">{selectedParcel.park_gravity?.toFixed(4) ?? '—'}</span> acres/m²</p>
                  <p className="detail-methodology-src">Source: NYC Parks Open Space (2024) · NYC MapPLUTO 24v2</p>
                </div>
              ) : (selectedParcel.park_score ?? 0) < 0 ? (
                <div className="detail-score-interp" style={{fontStyle:'normal', color:'var(--text-secondary)'}}>
                  Open space parcel — not ranked
                </div>
              ) : (
                <>
                  <div className="detail-score-value" style={{ color: scoreColor }}>
                    {selectedParcel.park_score}
                    <span className="detail-score-denom">/100</span>
                  </div>
                  <div className="detail-score-bar">
                    <div className="detail-score-fill" style={{
                      width: `${selectedParcel.park_score}%`,
                      background: scoreColor,
                    }} />
                  </div>
                  <div className="detail-score-interp">
                    Better access than {Math.round(selectedParcel.park_score)}% of NYC parcels
                  </div>
                </>
              )}
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
              {'flood_100yr' in selectedParcel && (
                <div className="detail-field">
                  <div className="detail-field-label">100yr Flood</div>
                  <div className="detail-field-value" style={{ color: selectedParcel.flood_100yr ? '#4A7AB0' : 'var(--text-secondary)' }}>
                    {selectedParcel.flood_100yr ? '⚠ In zone' : 'Not in zone'}
                  </div>
                </div>
              )}
              {'flood_storm' in selectedParcel && (
                <div className="detail-field">
                  <div className="detail-field-label">Stormwater</div>
                  <div className="detail-field-value" style={{ color: selectedParcel.flood_storm ? '#7A4AB0' : 'var(--text-secondary)' }}>
                    {selectedParcel.flood_storm ? '⚠ At risk' : 'Not at risk'}
                  </div>
                </div>
              )}
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
