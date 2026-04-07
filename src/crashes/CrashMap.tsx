import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCrashes } from './CrashContext';
import { formatCrashAddress, formatCrashDate, crashSummary } from './crash-data';
import type { Crash } from './types';

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
    { id: 'carto-base',   type: 'raster' as const, source: 'carto',        paint: { 'raster-opacity': 1 } },
    { id: 'carto-labels', type: 'raster' as const, source: 'carto_labels', paint: { 'raster-opacity': 0.6 } },
  ],
};

// Mode colors — dot fill
const MODE_COLORS: Record<string, string> = {
  pedestrian: '#f87171',  // red
  cyclist:    '#34d399',  // green
  motorist:   '#60a5fa',  // blue
  multi:      '#c084fc',  // purple
};


function getModeColor(mode: string | undefined): string {
  return MODE_COLORS[mode ?? 'motorist'] ?? '#60a5fa';
}

export default function CrashMap() {
  const { crashes, selected, setSelected } = useCrashes();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);
  const popupRef     = useRef<maplibregl.Popup | null>(null);

  // Init map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [-73.98, 40.73],
      zoom: 11,
      maxBounds: [[-74.6, 40.2], [-73.1, 41.2]],
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('crashes', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // No-injury dots (bottom layer — drawn first, least prominent)
      map.addLayer({
        id: 'crash-dots-none',
        type: 'circle',
        source: 'crashes',
        filter: ['==', ['get', 'severity'], 'none'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 17, 7],
          'circle-color': ['get', 'modeColor'],
          'circle-opacity': 0.35,
          'circle-stroke-width': 0,
        },
      });

      // Injury dots (middle layer)
      map.addLayer({
        id: 'crash-dots-injury',
        type: 'circle',
        source: 'crashes',
        filter: ['==', ['get', 'severity'], 'injury'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 5, 17, 9],
          'circle-color': ['get', 'modeColor'],
          'circle-opacity': 0.8,
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 1.5],
          'circle-stroke-color': '#f59e0b',
          'circle-stroke-opacity': 0.85,
        },
      });

      // Fatal dots (top layer — most prominent)
      map.addLayer({
        id: 'crash-dots-fatal',
        type: 'circle',
        source: 'crashes',
        filter: ['==', ['get', 'severity'], 'fatal'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7, 17, 11],
          'circle-color': ['get', 'modeColor'],
          'circle-opacity': 1,
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 2.5],
          'circle-stroke-color': '#ef4444',
          'circle-stroke-opacity': 1,
        },
      });

      const CLICK_LAYERS = ['crash-dots-fatal', 'crash-dots-injury', 'crash-dots-none'];

      CLICK_LAYERS.forEach(layer => {
        map.on('click', layer, (e) => {
          const feat = e.features?.[0];
          if (!feat) return;
          const crash: Crash = JSON.parse((feat.properties as Record<string, string>)._raw ?? '{}');
          setSelected(crash);
        });
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      });
    });

    return () => { map.remove(); mapRef.current = null; };
  }, [setSelected]);

  // Update GeoJSON when crashes change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const update = () => {
      const src = map.getSource('crashes') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData({
        type: 'FeatureCollection',
        features: crashes
          .filter(c => c.latitude && c.longitude)
          .map(c => ({
            type: 'Feature' as const,
            geometry: {
              type: 'Point' as const,
              coordinates: [parseFloat(c.longitude!), parseFloat(c.latitude!)],
            },
            properties: {
              modeColor: getModeColor(c.mode),
              severity:  c.severity ?? 'none',
              _raw:      JSON.stringify(c),
            },
          })),
      });
    };
    if (map.isStyleLoaded()) update();
    else map.once('load', update);
  }, [crashes]);

  // Popup for selected crash
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (popupRef.current) { popupRef.current.remove(); popupRef.current = null; }
    if (!selected?.latitude || !selected?.longitude) return;

    const factor = [selected.contributing_factor_vehicle_1, selected.contributing_factor_vehicle_2]
      .filter(f => f && f !== 'Unspecified' && f !== '1')
      .join(', ');

    const modeLabel = (selected.mode ?? 'motorist').charAt(0).toUpperCase() + (selected.mode ?? 'motorist').slice(1);
    const modeColor = getModeColor(selected.mode);

    const html = `
      <div class="crash-popup">
        <div class="cp-badges">
          <span class="cp-severity cp-severity--${selected.severity}">${(selected.severity ?? 'none').toUpperCase()}</span>
          <span class="cp-mode" style="color:${modeColor}">${modeLabel}</span>
        </div>
        <div class="cp-address">${formatCrashAddress(selected)}</div>
        <div class="cp-meta">${selected.borough ?? ''} · ${formatCrashDate(selected)} · ${selected.crash_time ?? ''}</div>
        <div class="cp-summary">${crashSummary(selected)}</div>
        ${factor ? `<div class="cp-factor">${factor}</div>` : ''}
      </div>
    `;

    popupRef.current = new maplibregl.Popup({ closeButton: true, maxWidth: '260px', className: 'crash-popup-wrap' })
      .setLngLat([parseFloat(selected.longitude), parseFloat(selected.latitude)])
      .setHTML(html)
      .addTo(map);
  }, [selected]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
  );
}
