import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ParcelProperties, SchoolZoneProperties, Layer, LayerInfo, Overlay } from './types';
import { LAYER_GROUPS, LAYERS, LAND_USE_COLORS, LAND_USE_LABELS } from './layers';
import { OverlayPanel } from './OverlayPanel';
import { initOverlays, computeComposite, getLayerBreakdown } from './overlays';
import './App.css';

type ZoneType = 'elementary' | 'middle' | 'high';

// In dev: served locally. In production: set VITE_PMTILES_URL to external CDN URL.
const PMTILES_URL = import.meta.env.VITE_PMTILES_URL ?? '/data/parcels.pmtiles';

// Register PMTiles protocol
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

// ── Overlay breakdown colors (matching OverlayPanel.tsx FIELD_COLORS) ────────
const BREAKDOWN_COLORS = {
  park_score:  '#4A8A4A',
  el_ela_pct:  '#7AB87A',
  floors_pct:  '#4A7AAA',
  year_pct:    '#A08040',
  density_pct: '#B06080',
  flood_100yr: '#4A7AB0',
  flood_storm: '#7A4AB0',
};

// ── Shared info panel ────────────────────────────────────────

function LayerInfoPanel({ info }: { info: LayerInfo }) {
  return (
    <div className="detail-methodology">
      <p>{info.what}</p>
      {info.how && <p>{info.how}</p>}
      {info.formula && (
        <p className="detail-methodology-formula">{info.formula}</p>
      )}
      {info.caveats && (
        <p className="detail-methodology-caveat"><strong>Note:</strong> {info.caveats}</p>
      )}
      <p className="detail-methodology-src">{info.source}</p>
    </div>
  );
}

// ── Color helpers ─────────────────────────────────────────────

function getParkScoreColor(score: number): string {
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
  return `rgb(${Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * f)},${Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * f)},${Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * f)})`;
}

function getHeightColor(floors: number): string {
  const stops = [
    { t: 0,  rgb: [240, 237, 230] },
    { t: 5,  rgb: [190, 210, 230] },
    { t: 15, rgb: [130, 170, 210] },
    { t: 30, rgb: [74,  122, 170] },
    { t: 60, rgb: [26,  74,  122] },
  ];
  const s = Math.max(0, Math.min(60, floors));
  let lo = stops[0], hi = stops[1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (s >= stops[i].t && s <= stops[i + 1].t) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const f = lo.t === hi.t ? 0 : (s - lo.t) / (hi.t - lo.t);
  return `rgb(${Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * f)},${Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * f)},${Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * f)})`;
}

function getYearBuiltColor(year: number): string {
  if (!year) return 'rgb(240,237,230)';
  const stops = [
    { t: 1850, rgb: [96,  64,  16]  },
    { t: 1900, rgb: [160, 128, 64]  },
    { t: 1940, rgb: [192, 168, 96]  },
    { t: 1970, rgb: [208, 196, 140] },
    { t: 2000, rgb: [220, 210, 180] },
    { t: 2020, rgb: [240, 237, 230] },
  ];
  const s = Math.max(1850, Math.min(2020, year));
  let lo = stops[0], hi = stops[1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (s >= stops[i].t && s <= stops[i + 1].t) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const f = lo.t === hi.t ? 0 : (s - lo.t) / (hi.t - lo.t);
  return `rgb(${Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * f)},${Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * f)},${Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * f)})`;
}

// ── MapLibre expressions ──────────────────────────────────────

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
  ['/', ['*', ['to-number', ['get', 'unitsres']], 1000], ['+', ['to-number', ['get', 'lotarea']], 1]],
  0,    'rgb(240,237,230)',
  0.5,  'rgb(224,196,208)',
  2,    'rgb(192,128,160)',
  5,    'rgb(160,80,112)',
  10,   'rgb(106,24,64)',
];

const YEARBUILT_COLOR = [
  'interpolate', ['linear'], ['get', 'yearbuilt'],
  0,    'rgb(240,237,230)',
  1850, 'rgb(96,64,16)',
  1900, 'rgb(160,128,64)',
  1940, 'rgb(192,168,96)',
  1970, 'rgb(208,196,140)',
  2000, 'rgb(220,210,180)',
  2020, 'rgb(240,237,230)',
];

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

// ── Layer methodology panels ──────────────────────────────────

interface LayerDetailProps {
  layer: Layer;
  parcel: ParcelProperties;
}

function ParkScoreDetail({ parcel, layer }: { parcel: ParcelProperties; layer: Layer }) {
  const [showInfo, setShowInfo] = useState(false);
  const score = parcel.park_score ?? 0;
  const isExcluded = score < 0;
  const color = isExcluded ? 'var(--text-tertiary)' : getParkScoreColor(score);

  return (
    <div className="layer-detail-section">
      <div className="layer-detail-header">
        <div className="layer-detail-swatch" style={{ background: '#4A8A4A' }} />
        <span className="layer-detail-name">Park Access</span>
        <button className="detail-info-btn" onClick={() => setShowInfo(v => !v)}>
          {showInfo ? '✕' : 'ⓘ'}
        </button>
      </div>

      {showInfo ? (
        <>
          <LayerInfoPanel info={layer.info} />
          {parcel.park_gravity != null && (
            <p className="detail-methodology-raw" style={{ fontSize: 9, color: 'var(--text-secondary)', marginTop: 6 }}>
              Raw gravity value: <span className="detail-mono">{parcel.park_gravity.toFixed(4)}</span> ac/m²
            </p>
          )}
        </>
      ) : isExcluded ? (
        <div className="layer-detail-excluded">Open space parcel — not ranked</div>
      ) : (
        <div className="layer-detail-score">
          <div className="layer-detail-score-value" style={{ color }}>
            {score}<span className="layer-detail-score-denom">/100</span>
          </div>
          <div className="layer-detail-bar">
            <div className="layer-detail-bar-fill" style={{ width: `${score}%`, background: color }} />
          </div>
          <div className="layer-detail-interp">Better access than {Math.round(score)}% of NYC parcels</div>
        </div>
      )}
    </div>
  );
}

function HeightDetail({ parcel, layer }: { parcel: ParcelProperties; layer: Layer }) {
  const [showInfo, setShowInfo] = useState(false);
  const floors = Number(parcel.numfloors) || 0;
  const color = getHeightColor(floors);
  const era = floors === 0 ? 'Unknown' : floors <= 3 ? 'Low-rise' : floors <= 12 ? 'Mid-rise' : floors <= 30 ? 'High-rise' : 'Supertall';

  return (
    <div className="layer-detail-section">
      <div className="layer-detail-header">
        <div className="layer-detail-swatch" style={{ background: '#4A7AAA' }} />
        <span className="layer-detail-name">Building Height</span>
        <button className="detail-info-btn" onClick={() => setShowInfo(v => !v)}>
          {showInfo ? '✕' : 'ⓘ'}
        </button>
      </div>
      {showInfo ? (
        <LayerInfoPanel info={layer.info} />
      ) : !floors ? (
        <div className="layer-detail-excluded">No height data</div>
      ) : (
        <div className="layer-detail-score">
          <div className="layer-detail-score-value" style={{ color }}>
            {floors}<span className="layer-detail-score-denom"> fl</span>
          </div>
          <div className="layer-detail-bar">
            <div className="layer-detail-bar-fill" style={{ width: `${Math.min(100, (floors / 60) * 100)}%`, background: color }} />
          </div>
          <div className="layer-detail-interp">{era}</div>
        </div>
      )}
    </div>
  );
}

function DensityDetail({ parcel, layer }: { parcel: ParcelProperties; layer: Layer }) {
  const [showInfo, setShowInfo] = useState(false);
  const units = Number(parcel.unitsres) || 0;
  const lotArea = Number(parcel.lotarea) || 1;
  const density = (units * 1000) / lotArea;

  const densityLabel =
    density === 0 ? 'No residential units' :
    density < 0.5 ? 'Very low' :
    density < 2   ? 'Low–medium' :
    density < 5   ? 'Medium–high' :
    density < 10  ? 'High' : 'Very high';

  const color = density === 0 ? 'var(--text-tertiary)'
    : density < 0.5  ? 'rgb(224,196,208)'
    : density < 2    ? 'rgb(192,128,160)'
    : density < 5    ? 'rgb(160,80,112)'
    : 'rgb(106,24,64)';

  return (
    <div className="layer-detail-section">
      <div className="layer-detail-header">
        <div className="layer-detail-swatch" style={{ background: '#B06080' }} />
        <span className="layer-detail-name">Residential Density</span>
        <button className="detail-info-btn" onClick={() => setShowInfo(v => !v)}>
          {showInfo ? '✕' : 'ⓘ'}
        </button>
      </div>
      {showInfo ? (
        <LayerInfoPanel info={layer.info} />
      ) : (
        <div className="layer-detail-score">
          <div className="layer-detail-score-value" style={{ color: density > 0 ? color : 'var(--text-tertiary)' }}>
            {density > 0 ? density.toFixed(2) : '—'}
            {density > 0 && <span className="layer-detail-score-denom"> u/ksf</span>}
          </div>
          {density > 0 && (
            <div className="layer-detail-bar">
              <div className="layer-detail-bar-fill" style={{ width: `${Math.min(100, (density / 10) * 100)}%`, background: color }} />
            </div>
          )}
          <div className="layer-detail-interp">{densityLabel}</div>
        </div>
      )}
    </div>
  );
}

function YearBuiltDetail({ parcel, layer }: { parcel: ParcelProperties; layer: Layer }) {
  const [showInfo, setShowInfo] = useState(false);
  const year = Number(parcel.yearbuilt) || 0;
  const color = getYearBuiltColor(year);

  const era = !year ? 'Unknown' :
    year < 1900 ? 'Pre-1900 · Tenement era' :
    year < 1940 ? '1900–1940 · Pre-war boom' :
    year < 1970 ? '1940–1970 · Postwar expansion' :
    year < 2000 ? '1970–2000 · Urban renewal era' :
    year < 2010 ? '2000–2010 · Boom years' :
    'Contemporary';

  return (
    <div className="layer-detail-section">
      <div className="layer-detail-header">
        <div className="layer-detail-swatch" style={{ background: '#A08040' }} />
        <span className="layer-detail-name">Year Built</span>
        <button className="detail-info-btn" onClick={() => setShowInfo(v => !v)}>
          {showInfo ? '✕' : 'ⓘ'}
        </button>
      </div>
      {showInfo ? (
        <LayerInfoPanel info={layer.info} />
      ) : !year ? (
        <div className="layer-detail-excluded">No year data</div>
      ) : (
        <div className="layer-detail-score">
          <div className="layer-detail-score-value" style={{ color }}>{year}</div>
          <div className="layer-detail-interp">{era}</div>
        </div>
      )}
    </div>
  );
}

function FloodDetail({ parcel, layer }: LayerDetailProps) {
  const [showInfo, setShowInfo] = useState(false);
  const is100yr = layer.id === 'flood_100yr';
  const value = is100yr ? parcel.flood_100yr : parcel.flood_storm;
  const inZone = value === 1;
  const accentColor = is100yr ? '#4A7AB0' : '#7A4AB0';

  return (
    <div className="layer-detail-section">
      <div className="layer-detail-header">
        <div className="layer-detail-swatch" style={{ background: accentColor }} />
        <span className="layer-detail-name">{layer.label}</span>
        <button className="detail-info-btn" onClick={() => setShowInfo(v => !v)}>
          {showInfo ? '✕' : 'ⓘ'}
        </button>
      </div>
      {showInfo ? (
        <LayerInfoPanel info={layer.info} />
      ) : (
        <div className={`layer-detail-badge ${inZone ? 'in-zone' : 'not-in-zone'}`}
          style={{ borderColor: inZone ? accentColor : 'var(--border)', color: inZone ? accentColor : 'var(--text-secondary)' }}>
          {inZone ? `⚠ In ${is100yr ? 'floodplain' : 'stormwater zone'}` : `Not in zone`}
        </div>
      )}
    </div>
  );
}

function LandUseDetail({ parcel, layer }: { parcel: ParcelProperties; layer: Layer }) {
  const [showInfo, setShowInfo] = useState(false);
  const code = parcel.landuse || '';
  const label = LAND_USE_LABELS[code] ?? (code || 'Unknown');
  const color = LAND_USE_COLORS[code] ?? '#ccc';

  return (
    <div className="layer-detail-section">
      <div className="layer-detail-header">
        <div className="layer-detail-swatch" style={{ background: '#9B8EC4' }} />
        <span className="layer-detail-name">Land Use</span>
        <button className="detail-info-btn" onClick={() => setShowInfo(v => !v)}>
          {showInfo ? '✕' : 'ⓘ'}
        </button>
      </div>
      {showInfo ? (
        <LayerInfoPanel info={layer.info} />
      ) : (
        <div className="layer-detail-category">
          <div className="layer-detail-category-dot" style={{ background: color }} />
          <span className="layer-detail-category-label">{label}</span>
          {code && <span className="layer-detail-category-code">{code}</span>}
        </div>
      )}
    </div>
  );
}

function LayerDetail({ layer, parcel }: LayerDetailProps) {
  switch (layer.id) {
    case 'park_score':  return <ParkScoreDetail parcel={parcel} layer={layer} />;
    case 'numfloors':   return <HeightDetail parcel={parcel} layer={layer} />;
    case 'density':     return <DensityDetail parcel={parcel} layer={layer} />;
    case 'yearbuilt':   return <YearBuiltDetail parcel={parcel} layer={layer} />;
    case 'flood_100yr': return <FloodDetail layer={layer} parcel={parcel} />;
    case 'flood_storm': return <FloodDetail layer={layer} parcel={parcel} />;
    case 'landuse':     return <LandUseDetail parcel={parcel} layer={layer} />;
    default:            return null;
  }
}

// ── School zone detail ────────────────────────────────────────

const ZONE_TYPE_LABELS: Record<ZoneType, string> = {
  elementary: 'Elementary School',
  middle: 'Middle School',
  high: 'High School',
};

const ZONE_TYPE_COLORS: Record<ZoneType, string> = {
  elementary: '#4A8A4A',
  middle: '#7A4AB0',
  high: '#4A7AAA',
};

function SchoolZoneDetail({ zone }: { zone: SchoolZoneProperties }) {
  const [showInfo, setShowInfo] = useState(false);
  const zoneType = (zone.zone_type || 'elementary') as ZoneType;
  const color = ZONE_TYPE_COLORS[zoneType] ?? '#4A8A4A';
  const typeLabel = ZONE_TYPE_LABELS[zoneType] ?? 'School';

  const formatScore = (score: number | null) =>
    score != null ? score.toFixed(1) : '—';

  const formatAttendance = (att: number | null) =>
    att != null ? `${Math.round(att * 100)}%` : '—';

  const elaColor = zone.ela_percentile != null
    ? `rgb(${Math.round(45 + (200 * (1 - zone.ela_percentile / 100)))}, ${Math.round(122 + (118 * zone.ela_percentile / 100))}, ${Math.round(45 + (45 * (1 - zone.ela_percentile / 100)))})`
    : 'var(--text-tertiary)';

  return (
    <div className="layer-detail-section school-zone-detail">
      <div className="layer-detail-header">
        <div className="layer-detail-swatch" style={{ background: color }} />
        <span className="layer-detail-name">School Zone</span>
        <button className="detail-info-btn" onClick={() => setShowInfo(v => !v)}>
          {showInfo ? '✕' : 'ⓘ'}
        </button>
      </div>

      {showInfo ? (
        <LayerInfoPanel info={LAYERS.find(l => l.id === 'school_zones')!.info} />
      ) : (
        <>
          <div className="school-zone-name">{zone.school_name || zone.dbn}</div>
          <div className="school-zone-badge" style={{ borderColor: color, color }}>
            {typeLabel.toUpperCase()}
          </div>

          {zone.ela_score != null && (
            <div className="layer-detail-score" style={{ marginTop: 10 }}>
              <div className="layer-detail-score-label">ELA Proficiency</div>
              <div className="layer-detail-score-value" style={{ color: elaColor, fontSize: 22 }}>
                {formatScore(zone.ela_score)}<span className="layer-detail-score-denom"> / 4.0</span>
              </div>
              {zone.ela_percentile != null && (
                <>
                  <div className="layer-detail-bar">
                    <div className="layer-detail-bar-fill" style={{ width: `${zone.ela_percentile}%`, background: elaColor }} />
                  </div>
                  <div className="layer-detail-interp">Better than {Math.round(zone.ela_percentile)}% of NYC schools</div>
                </>
              )}
            </div>
          )}

          {zone.math_score != null && (
            <div style={{ marginTop: 8 }}>
              <div className="layer-detail-score-label">Math Proficiency</div>
              <div className="layer-detail-score-value" style={{ color: 'var(--text)', fontSize: 18, fontFamily: 'var(--font-mono)' }}>
                {formatScore(zone.math_score)}<span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}> / 4.0</span>
              </div>
            </div>
          )}

          {zone.attendance != null && (
            <div style={{ marginTop: 6 }}>
              <div className="layer-detail-score-label">Attendance</div>
              <div className="layer-detail-score-value" style={{ color: 'var(--text)', fontSize: 16, fontFamily: 'var(--font-mono)' }}>
                {formatAttendance(zone.attendance)}
              </div>
            </div>
          )}

          {!zone.ela_score && !zone.math_score && (
            <div className="layer-detail-excluded">No quality data available for this school</div>
          )}

          <div className="school-zone-links" style={{ marginTop: 10 }}>
            {zone.dbn && (
              <a
                className="detail-link"
                href={`https://www.schools.nyc.gov/schools/${zone.dbn}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                School Profile ↗
              </a>
            )}
          </div>
          {zone.dbn && (
            <div className="detail-bbl" style={{ marginTop: 6 }}>
              DBN <span className="detail-mono">{zone.dbn}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────

export default function App() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<maplibregl.Map | null>(null);
  const [layers, setLayers] = useState<Layer[]>(LAYERS);
  const [expandedInfo, setExpandedInfo] = useState<string | null>(null);
  const [selectedParcel, setSelectedParcel] = useState<ParcelProperties | null>(null);
  const [selectedSchoolZone, setSelectedSchoolZone] = useState<SchoolZoneProperties | null>(null);
  const [activeZoneType, setActiveZoneType] = useState<ZoneType>('elementary');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<unknown[]>([]);
  const [mapLoaded, setMapLoaded] = useState(false);

  // Overlay (McHarg composite) state
  const [sidebarTab, setSidebarTab] = useState<'layers' | 'overlays'>('layers');
  const [overlays, setOverlays] = useState<Overlay[]>(() => initOverlays());
  const [activeOverlay, setActiveOverlay] = useState<Overlay | null>(null);

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
      // ── Hatch pattern for no-data school zones ──────────────
      // Draw a tiny diagonal hatch tile on canvas and register as map image
      const SZ = 12;
      const canvas = document.createElement('canvas');
      canvas.width = SZ; canvas.height = SZ;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, SZ, SZ);
      ctx.strokeStyle = 'rgba(160,155,148,0.55)';
      ctx.lineWidth = 1;
      // Two diagonal lines across the tile (NW→SE)
      ctx.beginPath();
      ctx.moveTo(0, SZ / 2); ctx.lineTo(SZ / 2, 0);
      ctx.moveTo(SZ / 2, SZ); ctx.lineTo(SZ, SZ / 2);
      ctx.stroke();
      const imgData = ctx.getImageData(0, 0, SZ, SZ);
      map.addImage('hatch-nodata', { width: SZ, height: SZ, data: imgData.data as unknown as Uint8Array });

      // School zone GeoJSON sources (added before parcels so parcels render on top)
      const ZONE_TYPES: ZoneType[] = ['elementary', 'middle', 'high'];
      ZONE_TYPES.forEach(zt => {
        map.addSource(`school-zones-${zt}`, {
          type: 'geojson',
          data: `/data/school_zones_${zt}.geojson`,
        });

        // No-data hatch layer (zones where ela_percentile is null)
        map.addLayer({
          id: `school-zones-${zt}-nodata`,
          type: 'fill',
          source: `school-zones-${zt}`,
          filter: ['!', ['to-boolean', ['get', 'ela_percentile']]],
          paint: {
            'fill-pattern': 'hatch-nodata',
            'fill-opacity': 0,
          },
          layout: { visibility: 'none' },
        });

        // Scored fill layer (zones with ela_percentile data)
        map.addLayer({
          id: `school-zones-${zt}-fill`,
          type: 'fill',
          source: `school-zones-${zt}`,
          filter: ['to-boolean', ['get', 'ela_percentile']],
          paint: {
            'fill-color': [
              'interpolate', ['linear'], ['get', 'ela_percentile'],
              0,   'rgb(245,240,232)',
              25,  'rgb(200,221,184)',
              50,  'rgb(140,185,140)',
              75,  'rgb(80,150,80)',
              100, 'rgb(45,122,45)',
            ],
            'fill-opacity': 0,
          },
          layout: { visibility: 'none' },
        });

        // Outline layer (all zones)
        map.addLayer({
          id: `school-zones-${zt}-outline`,
          type: 'line',
          source: `school-zones-${zt}`,
          paint: {
            'line-color': 'rgb(120,120,115)',
            'line-width': 0.75,
            'line-opacity': 0,
          },
          layout: { visibility: 'none' },
        });
      });

      // Full URL for external CDN, relative URL for local dev
      const pmtilesFullUrl = PMTILES_URL.startsWith('http')
        ? PMTILES_URL
        : `${window.location.origin}${PMTILES_URL}`;
      map.addSource('parcels', {
        type: 'vector',
        url: `pmtiles://${pmtilesFullUrl}`,
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

      addParcelLayer('parcels-park-score',  PARK_SCORE_COLOR,         true);
      addParcelLayer('parcels-flood-100yr', FLOOD_100YR_COLOR,        false);
      addParcelLayer('parcels-flood-storm', FLOOD_STORM_COLOR,        false);
      addParcelLayer('parcels-height',      HEIGHT_COLOR,             false);
      addParcelLayer('parcels-density',     DENSITY_COLOR,            false);
      addParcelLayer('parcels-yearbuilt',   YEARBUILT_COLOR,          false);
      addParcelLayer('parcels-landuse',     buildLandUseExpression(), false);

      // Composite overlay layer (initially hidden, updated when overlay is applied)
      map.addLayer({
        id: 'parcels-overlay',
        type: 'circle',
        source: 'parcels',
        'source-layer': 'parcels',
        paint: {
          'circle-color': 'rgba(0,0,0,0)',
          'circle-radius': circleRadius,
          'circle-opacity': 0,
        },
        layout: { visibility: 'none' },
      });

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
        if (e.features?.[0]) {
          setSelectedParcel(e.features[0].properties as ParcelProperties);
          // Keep school zone visible alongside parcel — don't clear it
        }
      };

      const PARCEL_LAYER_IDS = ['parcels-park-score','parcels-flood-100yr','parcels-flood-storm','parcels-height','parcels-density','parcels-yearbuilt','parcels-landuse','parcels-overlay'];
      PARCEL_LAYER_IDS.forEach(id => map.on('click', id, handleClick));

      // School zone click handlers
      ZONE_TYPES.forEach(zt => {
        const zoneClickHandler = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          if (e.features?.[0]) {
            setSelectedSchoolZone(e.features[0].properties as SchoolZoneProperties);
          }
        };
        map.on('click', `school-zones-${zt}-fill`,   zoneClickHandler);
        map.on('click', `school-zones-${zt}-nodata`, zoneClickHandler);

        [`school-zones-${zt}-fill`, `school-zones-${zt}-nodata`].forEach(lid => {
          map.on('mousemove', lid, () => { map.getCanvas().style.cursor = 'pointer'; });
          map.on('mouseleave', lid, () => { map.getCanvas().style.cursor = ''; });
        });
      });

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

  // Sync active overlay to map — overlay is a static color expression
  // Note: true per-parcel composites require client-side scoring on tile data,
  // which MapLibre doesn't natively support. We use a fixed expression approach:
  // when an overlay is active, we hide all other layers and show the overlay layer
  // colored by park_score as a proxy (full composite computed on click in detail panel).
  // TODO: when MapLibre supports custom expressions, switch to full composite coloring.
  useEffect(() => {
    if (!mapLoaded || !mapInstance.current) return;
    const map = mapInstance.current;
    const isActive = activeOverlay !== null;

    // Show/hide the overlay layer
    map.setLayoutProperty('parcels-overlay', 'visibility', isActive ? 'visible' : 'none');

    if (isActive) {
      // Color the overlay layer using park_score as a warm amber suitability ramp
      // (full composite coloring is computed at click time for the detail panel)
      // We use park_score as the primary driver since it's always present;
      // this is a visual approximation — the true score is shown in the detail panel.
      map.setPaintProperty('parcels-overlay', 'circle-color', [
        'case',
        ['<', ['get', 'park_score'], 0], 'rgba(0,0,0,0)',
        [
          'interpolate', ['linear'], ['get', 'park_score'],
          0,   'rgb(245,240,230)',
          20,  'rgb(235,215,180)',
          40,  'rgb(220,185,120)',
          60,  'rgb(195,145,60)',
          80,  'rgb(160,100,20)',
          100, 'rgb(120,60,10)',
        ],
      ]);
      map.setPaintProperty('parcels-overlay', 'circle-opacity', 0.8);
    }
  }, [activeOverlay, mapLoaded]);

  // Sync school zone layers when toggle or sub-type changes
  useEffect(() => {
    if (!mapLoaded || !mapInstance.current) return;
    const map = mapInstance.current;
    const schoolLayer = layers.find(l => l.id === 'school_zones');
    const enabled = schoolLayer?.enabled ?? false;
    const opacity = schoolLayer?.opacity ?? 0.65;

    const ZONE_TYPES: ZoneType[] = ['elementary', 'middle', 'high'];
    ZONE_TYPES.forEach(zt => {
      const visible = enabled && zt === activeZoneType;
      const vis = visible ? 'visible' : 'none';
      map.setLayoutProperty(`school-zones-${zt}-fill`,   'visibility', vis);
      map.setLayoutProperty(`school-zones-${zt}-nodata`, 'visibility', vis);
      map.setLayoutProperty(`school-zones-${zt}-outline`,'visibility', vis);
      map.setPaintProperty(`school-zones-${zt}-fill`,    'fill-opacity', visible ? opacity * 0.8 : 0);
      map.setPaintProperty(`school-zones-${zt}-nodata`,  'fill-opacity', visible ? opacity * 0.6 : 0);
      map.setPaintProperty(`school-zones-${zt}-outline`, 'line-opacity', visible ? 0.5 : 0);
    });
  }, [layers, mapLoaded, activeZoneType]);

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
    setLayers(prev => {
      const target = prev.find(l => l.id === id);
      // If turning a layer ON, deactivate any active overlay
      if (target && !target.enabled) {
        setActiveOverlay(null);
      }
      return prev.map(l => l.id === id ? { ...l, enabled: !l.enabled } : l);
    });
  };

  const setOpacity = (id: string, opacity: number) => {
    setLayers(prev => prev.map(l => l.id === id ? { ...l, opacity } : l));
  };

  // Address search
  const search = useCallback(async (q: string) => {
    if (q.length < 3) { setSearchResults([]); return; }
    try {
      // NYC Planning Labs geosearch — CORS-open, no key needed
      const url = `https://geosearch.planninglabs.nyc/v2/autocomplete?text=${encodeURIComponent(q)}&size=5`;
      const res = await fetch(url);
      const data = await res.json();
      setSearchResults(data.features ?? []);
    } catch { setSearchResults([]); }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => search(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery, search]);

  // Query parcel features at a given lng/lat
  const queryParcelAt = useCallback((lng: number, lat: number) => {
    const map = mapInstance.current;
    if (!map) return;
    // project to pixel space
    const pt = map.project([lng, lat]);
    // query all parcel layers in a small radius
    const features = map.queryRenderedFeatures(
      [
        [pt.x - 20, pt.y - 20],
        [pt.x + 20, pt.y + 20],
      ],
      {
        layers: ['parcels-park-score', 'parcels-height', 'parcels-density', 'parcels-yearbuilt', 'parcels-landuse'],
      }
    );
    if (features.length > 0) {
      setSelectedParcel(features[0].properties as ParcelProperties);
    }
  }, []);

  const flyToResult = useCallback((feature: { geometry: { coordinates: [number, number] }; properties?: { label?: string; name?: string } }) => {
    const [lng, lat] = feature.geometry.coordinates;
    const map = mapInstance.current;
    if (!map) return;
    map.flyTo({ center: [lng, lat], zoom: 17, duration: 1000 });
    setSearchResults([]);
    setSearchQuery(feature.properties?.label ?? '');
    // Query after fly animation settles
    map.once('moveend', () => {
      queryParcelAt(lng, lat);
    });
  }, [queryParcelAt]);

  // Active layers — ordered by LAYERS array (top-level order)
  const activeLayers = layers.filter(l => l.enabled);

  return (
    <div className="app">
      {/* Left sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title">DATAMAP<span className="sidebar-dot">·</span>NYC</div>
          <div className="sidebar-sub">Parcel intelligence</div>
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab ${sidebarTab === 'layers' ? 'active' : ''}`}
              onClick={() => setSidebarTab('layers')}
            >Layers</button>
            <button
              className={`sidebar-tab ${sidebarTab === 'overlays' ? 'active' : ''}`}
              onClick={() => setSidebarTab('overlays')}
            >
              Overlays
              {activeOverlay && <span className="sidebar-tab-dot" />}
            </button>
          </div>
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

        {/* Overlay panel */}
        {sidebarTab === 'overlays' && (
          <OverlayPanel
            overlays={overlays}
            activeOverlayId={activeOverlay?.id ?? null}
            onOverlaysChange={setOverlays}
            onApply={(overlay) => {
              setActiveOverlay(overlay);
              // Turning on an overlay — disable all raw layers so the map is clean
              if (overlay !== null) {
                setLayers(prev => prev.map(l => ({ ...l, enabled: false })));
              }
            }}
          />
        )}

        {/* Layers — grouped */}
        <div className="layers-section" style={{ display: sidebarTab === 'layers' ? 'flex' : 'none', flexDirection: 'column' }}>
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
                      <div className="layer-info-panel">
                        <LayerInfoPanel info={layer.info} />
                      </div>
                    )}

                    {layer.enabled && (
                      <div className="layer-controls">
                        {/* School zone sub-toggle */}
                        {layer.id === 'school_zones' && (
                          <div className="zone-type-pills">
                            {(['elementary', 'middle', 'high'] as ZoneType[]).map(zt => (
                              <button
                                key={zt}
                                className={`zone-pill${activeZoneType === zt ? ' active' : ''}`}
                                onClick={() => setActiveZoneType(zt)}
                              >
                                {zt === 'elementary' ? 'ES' : zt === 'middle' ? 'MS' : 'HS'}
                              </button>
                            ))}
                            <span className="zone-pill-label">
                              {activeZoneType === 'elementary' ? 'Elementary' : activeZoneType === 'middle' ? 'Middle' : 'High School'}
                            </span>
                          </div>
                        )}

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

      {/* Detail panel — shows when parcel or school zone selected */}
      <div className={`detail-panel ${(selectedParcel || selectedSchoolZone) ? '' : 'hidden'}`}>
        {/* Header — address if parcel, generic if zone-only */}
        <div className="detail-header">
          <div>
            {selectedParcel ? (
              <>
                <div className="detail-address">{selectedParcel.address || '—'}</div>
                <div className="detail-borough">{selectedParcel.borough}{selectedParcel.zonedist1 ? ` · ${selectedParcel.zonedist1}` : ''}</div>
              </>
            ) : selectedSchoolZone ? (
              <>
                <div className="detail-address">{selectedSchoolZone.school_name || selectedSchoolZone.dbn}</div>
                <div className="detail-borough">{ZONE_TYPE_LABELS[selectedSchoolZone.zone_type as ZoneType] ?? 'School Zone'}</div>
              </>
            ) : null}
          </div>
          <button className="detail-close" onClick={() => { setSelectedParcel(null); setSelectedSchoolZone(null); }}>✕</button>
        </div>

        {/* Scrollable body */}
        <div className="detail-body">

          {/* Parcel layer scores */}
          {selectedParcel && (
            <>
              {/* Active overlay composite score */}
              {activeOverlay && (() => {
                const props = selectedParcel as unknown as Record<string, unknown>;
                const composite = computeComposite(props, activeOverlay);
                const breakdown = getLayerBreakdown(props, activeOverlay);
                const compositeColor = composite != null
                  ? `rgb(${Math.round(120 + (125 * (1 - composite / 100)))},${Math.round(60 + (100 * composite / 100))},${Math.round(10 + (20 * (1 - composite / 100)))})`
                  : 'var(--text-tertiary)';

                return (
                  <div className="detail-layers-section">
                    <div className="detail-section-title">Overlay · {activeOverlay.name}</div>
                    <div className="layer-detail-section overlay-composite-section">
                      {composite != null ? (
                        <>
                          <div className="overlay-composite-score" style={{ color: compositeColor }}>
                            {composite}
                            <span className="layer-detail-score-denom">/100</span>
                          </div>
                          <div className="layer-detail-bar">
                            <div className="layer-detail-bar-fill" style={{ width: `${composite}%`, background: compositeColor }} />
                          </div>
                          <div className="layer-detail-interp">
                            Composite suitability score
                          </div>
                          <div className="overlay-breakdown">
                            {breakdown.map(b => (
                              <div key={b.id} className="overlay-breakdown-row">
                                <span className="overlay-breakdown-dot" style={{ background: BREAKDOWN_COLORS[b.id as keyof typeof BREAKDOWN_COLORS] ?? '#ccc' }} />
                                <span className="overlay-breakdown-label">{b.label}</span>
                                <span className="overlay-breakdown-val">
                                  {b.raw != null ? `${Math.round(b.raw)}` : '—'}
                                  {b.invert ? ' ↓' : ''}
                                </span>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : (
                        <div className="layer-detail-excluded">No data for this parcel in current overlay</div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Per-layer scores (hidden when overlay active to keep panel clean) */}
              {!activeOverlay && (activeLayers.filter(l => l.id !== 'school_zones').length > 0 ? (
                <div className="detail-layers-section">
                  <div className="detail-section-title">Active Layers</div>
                  {activeLayers.filter(l => l.id !== 'school_zones').map(layer => (
                    <LayerDetail key={layer.id} layer={layer} parcel={selectedParcel} />
                  ))}
                </div>
              ) : (
                <div className="detail-no-layers">
                  Enable layers in the sidebar to see scores for this parcel.
                </div>
              ))}

              {/* Base facts */}
              <div className="detail-facts-section">
                <div className="detail-section-title">Parcel Facts</div>
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
                    <div className="detail-field-label">Zoning</div>
                    <div className="detail-field-value">{selectedParcel.zonedist1 || '—'}</div>
                  </div>
                </div>
              </div>

              {/* Links */}
              <div className="detail-links-section">
                {selectedParcel.bbl && (
                  <div className="detail-bbl">
                    BBL <span className="detail-mono">{selectedParcel.bbl}</span>
                  </div>
                )}
                <div className="detail-links">
                  {selectedParcel.bbl && (
                    <a className="detail-link"
                      href={`https://zola.planning.nyc.gov/l/lot/${selectedParcel.bbl.slice(0,1)}/${selectedParcel.bbl.slice(1,6)}/${selectedParcel.bbl.slice(6)}`}
                      target="_blank" rel="noopener noreferrer">ZoLa ↗</a>
                  )}
                  {selectedParcel.bbl && (
                    <a className="detail-link"
                      href={`https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?boro=${selectedParcel.bbl.slice(0,1)}&block=${selectedParcel.bbl.slice(1,6)}&lot=${selectedParcel.bbl.slice(6)}`}
                      target="_blank" rel="noopener noreferrer">DOB ↗</a>
                  )}
                  {selectedParcel.bbl && (
                    <a className="detail-link"
                      href={`https://whoownswhat.justfix.org/en/address/${selectedParcel.bbl}`}
                      target="_blank" rel="noopener noreferrer">WOW ↗</a>
                  )}
                </div>
              </div>
            </>
          )}

          {/* School zone section — shown when zone layer is active and a zone was clicked */}
          {selectedSchoolZone && (
            <div className="detail-layers-section">
              {selectedParcel && <div className="detail-section-title">School Zone</div>}
              <SchoolZoneDetail zone={selectedSchoolZone} />
              {selectedSchoolZone && (
                <div style={{ padding: '6px 16px 10px', borderTop: '1px solid var(--border)' }}>
                  <button
                    className="detail-link"
                    onClick={() => setSelectedSchoolZone(null)}
                    style={{ cursor: 'pointer', background: 'none', border: '1px solid var(--border)', padding: '4px 8px', fontSize: 9, color: 'var(--text-secondary)', letterSpacing: '0.05em' }}
                  >Clear zone</button>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
