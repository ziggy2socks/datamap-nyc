/**
 * overlays.ts — McHarg composite overlay engine
 *
 * Overlays are weighted blends of percentile-ranked parcel fields.
 * All inputs are normalised to 0–100 before blending.
 * Composite = weighted average of (inverted?) percentile ranks.
 */

import type { Overlay, OverlayLayer, OverlayLayerId } from './types';

const STORAGE_KEY = 'datamap:overlays';

// ── Persistence ──────────────────────────────────────────────

export function loadOverlays(): Overlay[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveOverlays(overlays: Overlay[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overlays));
}

export function createOverlay(name: string, layers: OverlayLayer[]): Overlay {
  return {
    id: `ov_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    created: new Date().toISOString().slice(0, 10),
    layers,
  };
}

export function addOverlay(overlay: Overlay): Overlay[] {
  const overlays = loadOverlays();
  overlays.push(overlay);
  saveOverlays(overlays);
  return overlays;
}

export function updateOverlay(updated: Overlay): Overlay[] {
  const overlays = loadOverlays().map(o => o.id === updated.id ? updated : o);
  saveOverlays(overlays);
  return overlays;
}

export function deleteOverlay(id: string): Overlay[] {
  const overlays = loadOverlays().filter(o => o.id !== id);
  saveOverlays(overlays);
  return overlays;
}

// ── Scoring ──────────────────────────────────────────────────

/**
 * Get a normalised 0–100 value for a single parcel field.
 * Binary fields (flood) are converted: 0→0, 1→100.
 * Missing/excluded values (null, -1) return null — parcel is excluded from composite.
 */
export function getFieldValue(
  props: Record<string, unknown>,
  fieldId: OverlayLayerId,
): number | null {
  const raw = props[fieldId];
  if (raw === null || raw === undefined) return null;
  const v = Number(raw);
  if (isNaN(v)) return null;
  if (v < 0) return null; // sentinel -1 means excluded

  // Binary: 0 or 1 → 0 or 100
  if (fieldId === 'flood_100yr' || fieldId === 'flood_storm') {
    return v === 1 ? 100 : 0;
  }

  // Percentile ranks are already 0–100
  return Math.max(0, Math.min(100, v));
}

/**
 * Compute composite score for a parcel given an overlay definition.
 * Returns null if no overlay layers have valid data for this parcel.
 */
export function computeComposite(
  props: Record<string, unknown>,
  overlay: Overlay,
): number | null {
  const activeLayers = overlay.layers.filter(l => l.weight > 0);
  if (activeLayers.length === 0) return null;

  // Normalise weights to sum to 1
  const totalWeight = activeLayers.reduce((s, l) => s + l.weight, 0);
  if (totalWeight === 0) return null;

  let weightedSum = 0;
  let weightUsed = 0;

  for (const layer of activeLayers) {
    let val = getFieldValue(props, layer.id);
    if (val === null) continue; // skip missing data — don't penalise

    if (layer.invert) val = 100 - val;

    const w = layer.weight / totalWeight;
    weightedSum += val * w;
    weightUsed += w;
  }

  if (weightUsed === 0) return null;

  // Re-scale to full 0–100 range based on weights actually used
  const composite = weightedSum / weightUsed;
  return Math.round(composite * 10) / 10;
}

/**
 * Get per-layer breakdown for display in detail panel.
 */
export function getLayerBreakdown(
  props: Record<string, unknown>,
  overlay: Overlay,
): Array<{ id: OverlayLayerId; label: string; raw: number | null; contribution: number | null; invert: boolean }> {
  const activeLayers = overlay.layers.filter(l => l.weight > 0);
  const totalWeight = activeLayers.reduce((s, l) => s + l.weight, 0);

  return overlay.layers
    .filter(l => l.weight > 0)
    .map(layer => {
      let val = getFieldValue(props, layer.id);
      const raw = val;
      if (val !== null && layer.invert) val = 100 - val;
      const w = totalWeight > 0 ? layer.weight / totalWeight : 0;
      return {
        id: layer.id,
        label: layer.label,
        raw,
        contribution: val !== null ? Math.round(val * w * 10) / 10 : null,
        invert: layer.invert,
      };
    });
}

// ── Default starter overlays ────────────────────────────────

export const DEFAULT_OVERLAYS: Overlay[] = [
  {
    id: 'default_livability',
    name: 'Urban Livability',
    created: '2026-03-01',
    layers: [
      { id: 'park_score',  label: 'Park Access',        weight: 40, invert: false },
      { id: 'el_ela_pct',  label: 'School Quality (ES)', weight: 35, invert: false },
      { id: 'density_pct', label: 'Residential Density', weight: 15, invert: false },
      { id: 'flood_100yr', label: '100yr Flood Risk',    weight: 10, invert: true  },
    ],
  },
  {
    id: 'default_flood_avoid',
    name: 'Flood Avoidance',
    created: '2026-03-01',
    layers: [
      { id: 'flood_100yr', label: '100yr Flood Risk',  weight: 60, invert: true },
      { id: 'flood_storm', label: 'Stormwater Risk',   weight: 40, invert: true },
    ],
  },
];

export function initOverlays(): Overlay[] {
  const existing = loadOverlays();
  if (existing.length === 0) {
    saveOverlays(DEFAULT_OVERLAYS);
    return DEFAULT_OVERLAYS;
  }
  return existing;
}
