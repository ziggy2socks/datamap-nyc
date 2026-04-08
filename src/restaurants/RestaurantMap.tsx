import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useRestaurants } from './RestaurantContext';
import { getGradeColor, getGradeLabel, formatInspectionDate } from './restaurant-data';
import type { Restaurant } from './types';

const MAP_STYLE = {
  version: 8 as const,
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {
    carto: {
      type: 'raster' as const,
      tiles: ['https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png'],
      tileSize: 256, attribution: '© OpenStreetMap © CartoDB',
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

export default function RestaurantMap() {
  const { restaurants, selected, setSelected } = useRestaurants();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);
  const popupRef     = useRef<maplibregl.Popup | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [-73.98, 40.73],
      zoom: 12,
      maxBounds: [[-74.6, 40.2], [-73.1, 41.2]],
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('restaurants', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Grade C — bottom layer
      map.addLayer({
        id: 'rest-C',
        type: 'circle',
        source: 'restaurants',
        filter: ['==', ['get', 'grade'], 'C'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6, 17, 10],
          'circle-color': '#ef4444',
          'circle-opacity': 0.85,
          'circle-stroke-width': 1,
          'circle-stroke-color': 'rgba(0,0,0,0.4)',
        },
      });

      // Grade B
      map.addLayer({
        id: 'rest-B',
        type: 'circle',
        source: 'restaurants',
        filter: ['==', ['get', 'grade'], 'B'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 5, 17, 9],
          'circle-color': '#f59e0b',
          'circle-opacity': 0.8,
          'circle-stroke-width': 0.5,
          'circle-stroke-color': 'rgba(0,0,0,0.3)',
        },
      });

      // Pending / no grade (gray)
      map.addLayer({
        id: 'rest-other',
        type: 'circle',
        source: 'restaurants',
        filter: ['!', ['in', ['get', 'grade'], ['literal', ['A', 'B', 'C']]]],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 17, 7],
          'circle-color': 'rgba(148,163,184,0.5)',
          'circle-opacity': 0.5,
          'circle-stroke-width': 0,
        },
      });

      // Grade A — top layer, smallest dots (most are A, don't drown the map)
      map.addLayer({
        id: 'rest-A',
        type: 'circle',
        source: 'restaurants',
        filter: ['==', ['get', 'grade'], 'A'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 17, 7],
          'circle-color': '#34d399',
          'circle-opacity': 0.55,
          'circle-stroke-width': 0,
        },
      });

      const LAYERS = ['rest-C', 'rest-B', 'rest-other', 'rest-A'];
      LAYERS.forEach(layer => {
        map.on('click', layer, (e) => {
          const feat = e.features?.[0];
          if (!feat) return;
          const r: Restaurant = JSON.parse((feat.properties as Record<string, string>)._raw ?? '{}');
          setSelected(r);
        });
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      });
    });

    return () => { map.remove(); mapRef.current = null; };
  }, [setSelected]);

  // Update source data
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const update = () => {
      const src = map.getSource('restaurants') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData({
        type: 'FeatureCollection',
        features: restaurants.map(r => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [r.longitude, r.latitude] },
          properties: { grade: r.grade, _raw: JSON.stringify(r) },
        })),
      });
    };
    if (map.isStyleLoaded()) update();
    else map.once('load', update);
  }, [restaurants]);

  // Popup for selected
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (popupRef.current) { popupRef.current.remove(); popupRef.current = null; }
    if (!selected) return;

    const gradeColor = getGradeColor(selected.grade);
    const criticals = selected.violations.filter(v => v.critical);
    const violationHtml = criticals.slice(0, 3).map(v =>
      `<div class="rp-violation">⚠ ${v.description.slice(0, 80)}${v.description.length > 80 ? '…' : ''}</div>`
    ).join('');

    const html = `
      <div class="rest-popup">
        <div class="rp-header">
          <span class="rp-grade" style="color:${gradeColor};border-color:${gradeColor}">${selected.grade}</span>
          <div class="rp-name">${selected.name}</div>
        </div>
        <div class="rp-meta">${selected.cuisine} · ${selected.boro}</div>
        <div class="rp-address">${selected.address}, ${selected.zipcode}</div>
        <div class="rp-score">Score: ${selected.score} · ${getGradeLabel(selected.grade)}</div>
        <div class="rp-date">Inspected ${formatInspectionDate(selected.inspectionDate)}</div>
        ${criticals.length > 0 ? `<div class="rp-violations-label">Critical violations (${criticals.length}):</div>${violationHtml}` : '<div class="rp-clean">No critical violations</div>'}
      </div>
    `;

    popupRef.current = new maplibregl.Popup({ closeButton: true, maxWidth: '280px', className: 'rest-popup-wrap' })
      .setLngLat([selected.longitude, selected.latitude])
      .setHTML(html)
      .addTo(map);
  }, [selected]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
