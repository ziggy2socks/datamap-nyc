import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCrashes } from './CrashContext';
import { getCrashColor, formatCrashAddress, formatCrashDate, crashSummary } from './crash-data';
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
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 40,
      });

      // Cluster circles
      map.addLayer({
        id: 'crash-clusters',
        type: 'circle',
        source: 'crashes',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': [
            'step', ['get', 'point_count'],
            'rgba(245,158,11,0.5)',   50,
            'rgba(239,68,68,0.55)',   200,
            'rgba(220,38,38,0.65)',
          ],
          'circle-radius': ['step', ['get', 'point_count'], 14, 50, 22, 200, 30],
          'circle-stroke-width': 1,
          'circle-stroke-color': 'rgba(255,255,255,0.15)',
        },
      });

      // Cluster count labels
      map.addLayer({
        id: 'crash-cluster-count',
        type: 'symbol',
        source: 'crashes',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': '{point_count_abbreviated}',
          'text-font': ['Open Sans Bold'],
          'text-size': 11,
        },
        paint: { 'text-color': '#fff' },
      });

      // Individual dots
      map.addLayer({
        id: 'crash-dots',
        type: 'circle',
        source: 'crashes',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6, 17, 10],
          'circle-color': ['get', 'color'],
          'circle-opacity': ['case', ['get', 'isNone'], 0.4, 0.85],
          'circle-stroke-width': ['case', ['==', ['get', 'severity'], 'fatal'], 1.5, 0.5],
          'circle-stroke-color': ['case', ['==', ['get', 'severity'], 'fatal'], 'rgba(255,255,255,0.5)', 'rgba(0,0,0,0.3)'],
        },
      });

      // Click individual dot
      map.on('click', 'crash-dots', (e) => {
        const feat = e.features?.[0];
        if (!feat) return;
        const crash: Crash = JSON.parse((feat.properties as Record<string, string>)._raw ?? '{}');
        setSelected(crash);
      });

      // Click cluster → zoom in
      map.on('click', 'crash-clusters', (e) => {
        const feat = e.features?.[0];
        if (!feat) return;
        const clusterId = feat.properties?.cluster_id;
        const src = map.getSource('crashes') as maplibregl.GeoJSONSource;
        src.getClusterExpansionZoom(clusterId)
          .then((zoom: number) => {
            map.easeTo({ center: (feat.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
          })
          .catch(() => {});
      });

      map.on('mouseenter', 'crash-dots',     () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'crash-dots',     () => { map.getCanvas().style.cursor = ''; });
      map.on('mouseenter', 'crash-clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'crash-clusters', () => { map.getCanvas().style.cursor = ''; });
    });

    return () => { map.remove(); mapRef.current = null; };
  }, [setSelected]);

  // Update GeoJSON when crashes change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
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
            color:    getCrashColor(c.severity ?? 'none'),
            severity: c.severity ?? 'none',
            isNone:   c.severity === 'none',
            _raw:     JSON.stringify(c),
          },
        })),
    });
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

    const html = `
      <div class="crash-popup">
        <div class="cp-severity cp-severity--${selected.severity}">${(selected.severity ?? 'none').toUpperCase()}</div>
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
