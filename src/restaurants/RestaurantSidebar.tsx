import { useState, useCallback } from 'react';
import { FixedSizeList as VList } from 'react-window';
import { useRestaurants } from './RestaurantContext';
import { getGradeColor, formatInspectionDate, ALL_BOROUGHS } from './restaurant-data';
import type { Restaurant, GradeFilter } from './types';

const BOROUGH_SHORT: Record<string, string> = {
  MANHATTAN: 'MN', BROOKLYN: 'BK', QUEENS: 'QN', BRONX: 'BX', 'STATEN ISLAND': 'SI',
};

export default function RestaurantSidebar({
  mobileOpen, onMobileClose,
}: { mobileOpen?: boolean; onMobileClose?: () => void }) {
  const {
    view, setView,
    restaurants, loading, error,
    filters, setGrade, toggleBorough, setCuisine,
    selected, setSelected,
  } = useRestaurants();

  const [listHeight, setListHeight] = useState(400);
  const listContainerRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const measure = () => setListHeight(el.clientHeight || 400);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
  }, []);

  const GRADE_OPTS: { value: GradeFilter; label: string }[] = [
    { value: 'all',  label: 'All' },
    { value: 'A',    label: 'A' },
    { value: 'B',    label: 'B' },
    { value: 'C',    label: 'C' },
    { value: 'warn', label: 'B+C' },
  ];

  const handleSelect = (r: Restaurant) => { setSelected(r); onMobileClose?.(); };

  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const r = restaurants[index];
    const isSelected = selected?.camis === r.camis;
    const color = getGradeColor(r.grade);
    return (
      <div
        style={style}
        className={`rs-row${isSelected ? ' rs-row--selected' : ''}`}
        onClick={() => handleSelect(r)}
      >
        <span className="rs-row-grade" style={{ color, borderColor: color }}>{r.grade}</span>
        <div className="rs-row-body">
          <div className="rs-row-name">{r.name}</div>
          <div className="rs-row-meta">
            {r.cuisine} · {BOROUGH_SHORT[r.boro] ?? r.boro} · {formatInspectionDate(r.inspectionDate)}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`rs-sidebar${mobileOpen ? ' rs-sidebar--open' : ''}`}>
      <div className="rs-header">
        <div className="rs-header-row">
          <span className="rs-title">NYC RESTAURANTS</span>
        </div>
        <div className="rs-view-toggle-row">
          <button className={`rs-view-btn${view === 'map' ? ' active' : ''}`} onClick={() => setView('map')}>MAP</button>
          <button className={`rs-view-btn${view === 'charts' ? ' active' : ''}`} onClick={() => setView('charts')}>
            <svg width="13" height="12" viewBox="0 0 13 12" fill="none" style={{ verticalAlign: 'middle', marginRight: 4 }}>
              <rect x="0" y="6" width="3" height="6" fill="currentColor" opacity="0.8"/>
              <rect x="4" y="3" width="3" height="9" fill="currentColor" opacity="0.8"/>
              <rect x="8" y="0" width="3" height="12" fill="currentColor" opacity="0.8"/>
            </svg>
            CHARTS
          </button>
        </div>
        <div className="rs-count-row">
          {loading
            ? <span className="rs-loading"><span className="rs-spinner" />LOADING…</span>
            : error
              ? <span className="rs-error">⚠ {error}</span>
              : <span className="rs-count">{restaurants.length.toLocaleString()} restaurants</span>
          }
        </div>
      </div>

      <div className="rs-body">
        {/* Grade filter */}
        <div className="rs-section">
          <div className="rs-section-label">GRADE</div>
          <div className="rs-pill-row">
            {GRADE_OPTS.map(o => (
              <button key={o.value}
                className={`rs-pill${filters.grade === o.value ? ' active' : ''}`}
                style={filters.grade === o.value && o.value !== 'all' && o.value !== 'warn'
                  ? { borderColor: getGradeColor(o.value), color: getGradeColor(o.value), background: getGradeColor(o.value) + '22' }
                  : {}}
                onClick={() => setGrade(o.value)}
              >{o.label}</button>
            ))}
          </div>
        </div>

        {/* Borough */}
        <div className="rs-section">
          <div className="rs-section-label">BOROUGH</div>
          <div className="rs-pill-row rs-pill-row--wrap">
            {ALL_BOROUGHS.map(b => (
              <button key={b}
                className={`rs-pill${filters.boroughs.has(b) ? ' active' : ''}`}
                onClick={() => toggleBorough(b)}
              >{BOROUGH_SHORT[b] ?? b}</button>
            ))}
          </div>
        </div>

        {/* Cuisine search */}
        <div className="rs-section">
          <div className="rs-section-label">CUISINE</div>
          <input
            type="text"
            className="rs-search-input"
            placeholder="e.g. Japanese, Pizza…"
            value={filters.cuisine}
            onChange={e => setCuisine(e.target.value)}
          />
          {filters.cuisine && (
            <button className="rs-clear-btn" onClick={() => setCuisine('')}>✕ clear</button>
          )}
        </div>

        {/* Legend */}
        <div className="rs-section">
          <div className="rs-section-label">GRADE</div>
          <div className="rs-legend">
            {([['A', '#34d399', '0–13 pts'], ['B', '#f59e0b', '14–27 pts'], ['C', '#ef4444', '28+ pts'], ['?', 'rgba(148,163,184,0.5)', 'Pending']] as const).map(([grade, color, hint]) => (
              <div key={grade} className="rs-legend-row">
                <span className="rs-legend-grade" style={{ color, borderColor: color }}>{grade}</span>
                <span>{getGradeColor(grade) && grade !== '?' ? grade === 'A' ? 'Grade A' : grade === 'B' ? 'Grade B' : 'Grade C' : 'Pending'}</span>
                <span className="rs-legend-hint">{hint}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Results list */}
        <div className="rs-section rs-section--list">
          <div className="rs-section-label">{restaurants.length.toLocaleString()} RESULTS</div>
          <div ref={listContainerRef} className="rs-list-container">
            {restaurants.length > 0 && (
              <VList height={listHeight} itemCount={restaurants.length} itemSize={52} width="100%">
                {Row}
              </VList>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
