import { useState, useCallback, useRef } from 'react';
import { FixedSizeList as VList } from 'react-window';
import { useCrashes } from './CrashContext';
import { getCrashColor, formatCrashAddress, formatCrashDate, crashSummary, ALL_BOROUGHS } from './crash-data';
import { MIN_DATE } from './CrashContext';
import type { Crash, SeverityFilter, ModeFilter } from './types';

const BOROUGH_SHORT: Record<string, string> = {
  MANHATTAN: 'MN', BROOKLYN: 'BK', QUEENS: 'QN', BRONX: 'BX', 'STATEN ISLAND': 'SI',
};

function DateInput({ value, onChange, placeholder, min }: {
  value: string; onChange: (v: string) => void; placeholder: string; min?: string;
}) {
  const [draft, setDraft] = useState(value);
  const prev = useRef(value);
  if (value !== prev.current) { prev.current = value; if (draft !== value) setDraft(value); }
  const isValid = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v).getTime());
  const commit = () => {
    if (isValid(draft)) {
      const clamped = min && draft < min ? min : draft;
      onChange(clamped);
      if (clamped !== draft) setDraft(clamped);
    } else setDraft(value);
  };
  return (
    <input type="text" className="cs-date-input" value={draft} placeholder={placeholder} maxLength={10}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); }} />
  );
}

export default function CrashSidebar({
  mobileOpen, onMobileClose,
}: { mobileOpen?: boolean; onMobileClose?: () => void }) {
  const {
    view, setView,
    crashes, loading, error,
    filters, setDateFrom, setDateTo, setSeverity, setMode, toggleBorough,
    selected, setSelected,
  } = useCrashes();

  const [listHeight, setListHeight] = useState(400);
  const listContainerRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const measure = () => setListHeight(el.clientHeight || 400);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
  }, []);

  const todayStr = new Date().toISOString().split('T')[0];
  const quickDates = [
    { label: '7d', days: 7 }, { label: '30d', days: 30 },
    { label: '90d', days: 90 }, { label: '1y', days: 365 },
  ];

  const SEVERITY_OPTS: { value: SeverityFilter; label: string }[] = [
    { value: 'all',    label: 'All' },
    { value: 'fatal',  label: 'Fatal' },
    { value: 'injury', label: 'Injury' },
  ];
  const MODE_OPTS: { value: ModeFilter; label: string }[] = [
    { value: 'all',        label: 'All' },
    { value: 'pedestrian', label: 'Pedestrian' },
    { value: 'cyclist',    label: 'Cyclist' },
    { value: 'motorist',   label: 'Motorist' },
  ];

  const handleSelect = (c: Crash) => { setSelected(c); onMobileClose?.(); };

  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const c = crashes[index];
    const isSelected = selected?.collision_id === c.collision_id;
    const color = getCrashColor(c.severity ?? 'none');
    return (
      <div
        style={style}
        className={`cs-row${isSelected ? ' cs-row--selected' : ''}`}
        onClick={() => handleSelect(c)}
      >
        <span className="cs-row-dot" style={{ background: color }} />
        <div className="cs-row-body">
          <div className="cs-row-address">{formatCrashAddress(c)}</div>
          <div className="cs-row-meta">
            {c.borough ? BOROUGH_SHORT[c.borough.toUpperCase()] ?? c.borough : ''}
            {' · '}{formatCrashDate(c)}
            {c.severity !== 'none' && <span className="cs-row-sev"> · {crashSummary(c)}</span>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`cs-sidebar${mobileOpen ? ' cs-sidebar--open' : ''}`}>
      {/* Header */}
      <div className="cs-header">
        <div className="cs-header-row">
          <span className="cs-title">NYC CRASH MAP</span>
        </div>
        <div className="cs-view-toggle-row">
          <button className={`cs-view-btn${view === 'map' ? ' active' : ''}`} onClick={() => setView('map')}>MAP</button>
          <button className={`cs-view-btn${view === 'charts' ? ' active' : ''}`} onClick={() => setView('charts')}>
            <svg width="13" height="12" viewBox="0 0 13 12" fill="none" style={{ verticalAlign: 'middle', marginRight: 4 }}>
              <rect x="0" y="6" width="3" height="6" fill="currentColor" opacity="0.8"/>
              <rect x="4" y="3" width="3" height="9" fill="currentColor" opacity="0.8"/>
              <rect x="8" y="0" width="3" height="12" fill="currentColor" opacity="0.8"/>
            </svg>
            CHARTS
          </button>
        </div>
        <div className="cs-count-row">
          {loading ? (
            <span className="cs-loading"><span className="cs-spinner" />LOADING…</span>
          ) : error ? (
            <span className="cs-error">⚠ {error}</span>
          ) : (
            <span className="cs-count">{crashes.length.toLocaleString()} collisions</span>
          )}
        </div>
      </div>

      <div className="cs-body">
        {/* Date range */}
        <div className="cs-section">
          <div className="cs-section-label-row">
            <span className="cs-section-label">DATE RANGE</span>
            <button className="cs-reset-btn" onClick={() => {
              const d = new Date(); d.setDate(d.getDate() - 30);
              setDateFrom(d.toISOString().split('T')[0]); setDateTo(todayStr);
            }}>↺ 30d</button>
          </div>
          <div className="cs-date-row">
            <DateInput value={filters.dateFrom} onChange={setDateFrom} placeholder="YYYY-MM-DD" min={MIN_DATE} />
            <span className="cs-date-sep">→</span>
            <DateInput value={filters.dateTo} onChange={setDateTo} placeholder="YYYY-MM-DD" />
          </div>
          <div className="cs-date-floor-hint">data from {MIN_DATE}</div>
          <div className="cs-quick-dates">
            {quickDates.map(({ label, days }) => (
              <button key={label} className="cs-quick-btn" onClick={() => {
                const d = new Date(); d.setDate(d.getDate() - days);
                setDateFrom(d.toISOString().split('T')[0]); setDateTo(todayStr);
              }}>{label}</button>
            ))}
          </div>
        </div>

        {/* Severity */}
        <div className="cs-section">
          <div className="cs-section-label">SEVERITY</div>
          <div className="cs-pill-row">
            {SEVERITY_OPTS.map(o => (
              <button key={o.value}
                className={`cs-pill${filters.severity === o.value ? ' active' : ''}`}
                onClick={() => setSeverity(o.value)}
              >{o.label}</button>
            ))}
          </div>
        </div>

        {/* Mode */}
        <div className="cs-section">
          <div className="cs-section-label">MODE</div>
          <div className="cs-pill-row">
            {MODE_OPTS.map(o => (
              <button key={o.value}
                className={`cs-pill${filters.mode === o.value ? ' active' : ''}`}
                onClick={() => setMode(o.value)}
              >{o.label}</button>
            ))}
          </div>
        </div>

        {/* Boroughs */}
        <div className="cs-section">
          <div className="cs-section-label">BOROUGH</div>
          <div className="cs-pill-row cs-pill-row--wrap">
            {ALL_BOROUGHS.map(b => (
              <button key={b}
                className={`cs-pill${filters.boroughs.has(b) ? ' active' : ''}`}
                onClick={() => toggleBorough(b)}
              >{BOROUGH_SHORT[b] ?? b}</button>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div className="cs-section">
          <div className="cs-section-label">LEGEND</div>
          <div className="cs-legend">
            {([['fatal', '#ef4444', 'Fatal'], ['injury', '#f59e0b', 'Injury'], ['none', 'rgba(148,163,184,0.4)', 'No injury']] as const).map(([, color, label]) => (
              <div key={label} className="cs-legend-row">
                <span className="cs-legend-dot" style={{ background: color }} />
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Results list */}
        <div className="cs-section cs-section--list">
          <div className="cs-section-label">{crashes.length.toLocaleString()} RESULTS</div>
          <div ref={listContainerRef} className="cs-list-container">
            {crashes.length > 0 && (
              <VList height={listHeight} itemCount={crashes.length} itemSize={54} width="100%">
                {Row}
              </VList>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
