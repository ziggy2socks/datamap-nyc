/**
 * OverlayPanel.tsx — McHarg composite overlay builder UI
 *
 * Renders:
 *  - List of saved overlays with apply/edit/delete
 *  - Overlay builder (inline, replaces list when editing)
 */

import { useState } from 'react';
import type { Overlay, OverlayLayer, OverlayLayerId } from './types';
import { OVERLAY_FIELDS } from './types';
import { createOverlay, updateOverlay, deleteOverlay } from './overlays';

interface OverlayPanelProps {
  overlays: Overlay[];
  activeOverlayId: string | null;
  onOverlaysChange: (overlays: Overlay[]) => void;
  onApply: (overlay: Overlay | null) => void;
}

// ── Overlay Builder ──────────────────────────────────────────

interface BuilderProps {
  initial?: Overlay;
  onSave: (overlay: Overlay) => void;
  onCancel: () => void;
}

function OverlayBuilder({ initial, onSave, onCancel }: BuilderProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [layers, setLayers] = useState<OverlayLayer[]>(
    initial?.layers ?? []
  );
  const [nameError, setNameError] = useState('');

  const allFieldIds = Object.keys(OVERLAY_FIELDS) as OverlayLayerId[];
  const activeIds = new Set(layers.map(l => l.id));

  const totalWeight = layers.reduce((s, l) => s + l.weight, 0);

  const toggleField = (id: OverlayLayerId) => {
    if (activeIds.has(id)) {
      setLayers(prev => prev.filter(l => l.id !== id));
    } else {
      const info = OVERLAY_FIELDS[id];
      const remaining = Math.max(0, 100 - totalWeight);
      setLayers(prev => [...prev, {
        id,
        label: info.label,
        weight: Math.max(10, Math.min(remaining, 25)),
        invert: info.defaultInvert,
      }]);
    }
  };

  const setWeight = (id: OverlayLayerId, w: number) => {
    setLayers(prev => prev.map(l => l.id === id ? { ...l, weight: w } : l));
  };

  const toggleInvert = (id: OverlayLayerId) => {
    setLayers(prev => prev.map(l => l.id === id ? { ...l, invert: !l.invert } : l));
  };

  const handleSave = () => {
    if (!name.trim()) { setNameError('Name required'); return; }
    if (layers.length === 0) { setNameError('Select at least one layer'); return; }
    const overlay = initial
      ? { ...initial, name: name.trim(), layers }
      : createOverlay(name.trim(), layers);
    onSave(overlay);
  };

  const weightOk = totalWeight > 0;

  return (
    <div className="overlay-builder">
      <div className="overlay-builder-header">
        <div className="overlay-builder-title">{initial ? 'Edit Overlay' : 'New Overlay'}</div>
        <button className="detail-close" onClick={onCancel}>✕</button>
      </div>

      <div className="overlay-name-row">
        <input
          className="overlay-name-input"
          placeholder="Overlay name…"
          value={name}
          onChange={e => { setName(e.target.value); setNameError(''); }}
          maxLength={40}
        />
        {nameError && <div className="overlay-name-error">{nameError}</div>}
      </div>

      <div className="overlay-fields-label">Select layers</div>

      <div className="overlay-fields-list">
        {allFieldIds.map(id => {
          const info = OVERLAY_FIELDS[id];
          const layer = layers.find(l => l.id === id);
          const active = !!layer;

          return (
            <div key={id} className={`overlay-field-row ${active ? 'active' : ''}`}>
              <div className="overlay-field-header">
                <button
                  className={`overlay-field-check ${active ? 'checked' : ''}`}
                  onClick={() => toggleField(id)}
                >
                  {active ? '✓' : ''}
                </button>
                <span className="overlay-field-label" onClick={() => toggleField(id)}>
                  {info.label}
                </span>
                {active && (
                  <button
                    className={`overlay-invert-btn ${layer!.invert ? 'on' : ''}`}
                    onClick={() => toggleInvert(id)}
                    title={layer!.invert ? 'Inverted (higher = worse)' : 'Normal (higher = better)'}
                  >
                    {layer!.invert ? '↓ inv' : '↑'}
                  </button>
                )}
              </div>

              {active && (
                <div className="overlay-field-weight">
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={layer!.weight}
                    onChange={e => setWeight(id, parseInt(e.target.value))}
                    className="opacity-slider"
                  />
                  <span className="overlay-weight-value">{layer!.weight}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Weight summary */}
      {layers.length > 0 && (
        <div className="overlay-weight-summary">
          <div className="overlay-weight-bar">
            {layers.map(l => {
              const pct = totalWeight > 0 ? (l.weight / totalWeight) * 100 : 0;
              return (
                <div
                  key={l.id}
                  className="overlay-weight-segment"
                  style={{ width: `${pct}%`, background: FIELD_COLORS[l.id] }}
                  title={`${l.label}: ${Math.round(pct)}%`}
                />
              );
            })}
          </div>
          <div className="overlay-weight-labels">
            {layers.map(l => {
              const pct = totalWeight > 0 ? Math.round((l.weight / totalWeight) * 100) : 0;
              return (
                <span key={l.id} className="overlay-weight-label-item">
                  <span className="overlay-weight-dot" style={{ background: FIELD_COLORS[l.id] }} />
                  {l.label} {pct}%{l.invert ? ' ↓' : ''}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="overlay-builder-actions">
        <button className="overlay-btn-cancel" onClick={onCancel}>Cancel</button>
        <button
          className={`overlay-btn-save ${weightOk && name.trim() && layers.length > 0 ? '' : 'disabled'}`}
          onClick={handleSave}
        >
          {initial ? 'Save Changes' : 'Create Overlay'}
        </button>
      </div>
    </div>
  );
}

// ── Field accent colors for weight bar ───────────────────────

const FIELD_COLORS: Record<OverlayLayerId, string> = {
  park_score:  '#4A8A4A',
  el_ela_pct:  '#7AB87A',
  floors_pct:  '#4A7AAA',
  year_pct:    '#A08040',
  density_pct: '#B06080',
  flood_100yr: '#4A7AB0',
  flood_storm: '#7A4AB0',
};

// ── Overlay list item ─────────────────────────────────────────

interface OverlayItemProps {
  overlay: Overlay;
  isActive: boolean;
  onApply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function OverlayItem({ overlay, isActive, onApply, onEdit, onDelete }: OverlayItemProps) {
  const [expanded, setExpanded] = useState(false);
  const totalWeight = overlay.layers.reduce((s, l) => s + l.weight, 0);

  return (
    <div className={`overlay-item ${isActive ? 'active' : ''}`}>
      <div className="overlay-item-header" onClick={() => setExpanded(v => !v)}>
        <div className="overlay-item-left">
          <span className="overlay-item-chevron">{expanded ? '▾' : '▸'}</span>
          <span className="overlay-item-name">{overlay.name}</span>
        </div>
        <button
          className={`layer-toggle${isActive ? ' on' : ''}`}
          onClick={e => { e.stopPropagation(); onApply(); }}
          title={isActive ? 'Deactivate overlay' : 'Apply overlay to map'}
          aria-label={`Toggle ${overlay.name}`}
        >
          <span className="layer-toggle-dot" />
        </button>
      </div>

      {/* Mini weight bar */}
      <div className="overlay-mini-bar">
        {overlay.layers.filter(l => l.weight > 0).map(l => {
          const pct = totalWeight > 0 ? (l.weight / totalWeight) * 100 : 0;
          return (
            <div
              key={l.id}
              className="overlay-weight-segment"
              style={{ width: `${pct}%`, background: FIELD_COLORS[l.id] }}
              title={`${l.label}: ${Math.round(pct)}%${l.invert ? ' (inverted)' : ''}`}
            />
          );
        })}
      </div>

      {expanded && (
        <div className="overlay-item-layers">
          {overlay.layers.filter(l => l.weight > 0).map(l => {
            const pct = totalWeight > 0 ? Math.round((l.weight / totalWeight) * 100) : 0;
            return (
              <div key={l.id} className="overlay-item-layer">
                <span className="overlay-item-dot" style={{ background: FIELD_COLORS[l.id] }} />
                <span className="overlay-item-layer-name">{l.label}</span>
                <span className="overlay-item-layer-pct">{pct}%{l.invert ? ' ↓' : ''}</span>
              </div>
            );
          })}
          <div className="overlay-item-actions">
            <button className="overlay-action-btn" onClick={onEdit}>Edit</button>
            <button className="overlay-action-btn danger" onClick={onDelete}>Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────

export function OverlayPanel({ overlays, activeOverlayId, onOverlaysChange, onApply }: OverlayPanelProps) {
  const [editing, setEditing] = useState<Overlay | null | 'new'>(null);

  const handleSave = (overlay: Overlay) => {
    let updated: Overlay[];
    if (editing === 'new') {
      updated = [...overlays, overlay];
    } else {
      updated = updateOverlay(overlay);
    }
    onOverlaysChange(updated);
    setEditing(null);
  };

  const handleDelete = (id: string) => {
    const updated = deleteOverlay(id);
    if (activeOverlayId === id) onApply(null);
    onOverlaysChange(updated);
  };

  const handleApply = (overlay: Overlay) => {
    if (activeOverlayId === overlay.id) {
      onApply(null); // toggle off
    } else {
      onApply(overlay);
    }
  };

  if (editing !== null) {
    return (
      <OverlayBuilder
        initial={editing === 'new' ? undefined : editing}
        onSave={handleSave}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="overlay-panel">
      <div className="overlay-panel-intro">
        <p>Combine layers into a weighted composite — the McHarg method. Each layer contributes proportionally to a 0–100 suitability score for every parcel.</p>
      </div>

      <div className="overlay-list">
        {overlays.length === 0 ? (
          <div className="overlay-empty">No overlays yet. Create your first below.</div>
        ) : (
          overlays.map(o => (
            <OverlayItem
              key={o.id}
              overlay={o}
              isActive={activeOverlayId === o.id}
              onApply={() => handleApply(o)}
              onEdit={() => setEditing(o)}
              onDelete={() => handleDelete(o.id)}
            />
          ))
        )}
      </div>

      <button className="overlay-new-btn" onClick={() => setEditing('new')}>
        + New Overlay
      </button>
    </div>
  );
}
