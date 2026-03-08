import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { RadarCanvas } from './RadarCanvas';
import { BarChart } from './BarChart';
import { MonthChart } from './MonthChart';
import type { ChartMode, ChartHit } from './BarChart';
import { fetchComplaints, fetchComplaintsForDate, fetchMonthAggregate, fetchComplaintsByType, getComplaintColor, getTopComplaintTypes } from './complaints';
import type { DailyCount } from './complaints';
import type { Complaint } from './complaints';
import './RadarApp.css';

const MAX_FEED = 50;
const DOT_LIFETIME_MS = 10 * 60 * 1000;

type ViewMode = 'radar' | 'day';

export default function App() {
  const [viewMode,        setViewMode]        = useState<ViewMode>('radar');
  const [chartResolution, setChartResolution] = useState<'day' | 'month'>('day');
  const [chartMode,       setChartMode]       = useState<ChartMode>('stack');
  const [tooltip, setTooltip] = useState<{ type: string; count: number; totalInBar: number; barIdx: number; x: number; y: number } | null>(null);
  const [monthData, setMonthData] = useState<DailyCount[]>([]);
  const [monthLoading,    setMonthLoading]    = useState(false);
  const [complaints, setComplaints] = useState<Complaint[]>([]);

  const [topTypes, setTopTypes] = useState<string[]>([]);
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [feed, setFeed] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);
  const [replayTime, setReplayTime] = useState<number>(0);
  const [dataDate, setDataDate] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState('');
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'none' | 'feed' | 'filters'>('none');

  const replayRef = useRef(0);
  const lastTickRef = useRef(0);
  const needsBatchRef = useRef(false);

  function initializeData(data: Complaint[], dateStr: string) {
    const types = getTopComplaintTypes(data, 20);
    setComplaints(data);
    setTopTypes(types);
    setActiveTypes(new Set(types));
    setFeed([]);
    setExpandedKey(null);

    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const d = new Date(dateStr + 'T12:00:00');
    setDataDate(`${months[d.getMonth()]} ${d.getDate()}`);
    setSelectedDate(dateStr);

    const nycNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const nycMidnight = new Date(nycNow.getFullYear(), nycNow.getMonth(), nycNow.getDate()).getTime();
    const nycTimeOfDay = nycNow.getTime() - nycMidnight;
    const dataStart = new Date(dateStr + 'T00:00:00').getTime();
    const startReplay = dataStart + nycTimeOfDay;
    setReplayTime(startReplay);
    replayRef.current = startReplay;
    needsBatchRef.current = true; // signal RadarCanvas to batch load
  }

  // Initial load
  useEffect(() => {
    async function load() {
      try {
        const { data, date } = await fetchComplaints();
        if (data.length === 0) {
          setError('No 311 data available');
          setLoading(false);
          return;
        }
        initializeData(data, date);
      } catch (e) {
        setError('Failed to load 311 data');
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Switch date
  const switchDate = async (offset: number) => {
    if (!selectedDate) return;
    const current = new Date(selectedDate + 'T12:00:00');
    current.setDate(current.getDate() + offset);
    const newDate = current.toISOString().split('T')[0];
    setLoading(true);
    setError(null);
    try {
      const data = await fetchComplaintsForDate(newDate);
      if (data.length === 0) {
        setError(`No data for ${newDate}`);
      } else {
        initializeData(data, newDate);
      }
    } catch (e) {
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleViewChange = (mode: ViewMode) => {
    setViewMode(mode);
    // Default to month view when switching to chart
    if (mode === 'day') {
      setChartResolution('month');
      if (monthData.length === 0 && selectedDate) loadMonth(selectedDate);
    }
  };

  // Fetch aggregated month data (fast — ~600 rows via $group)
  const loadMonth = useCallback(async (date: string) => {
    setMonthLoading(true);
    try {
      const agg = await fetchMonthAggregate(date);
      setMonthData(agg);
    } catch { /* ignore */ }
    finally { setMonthLoading(false); }
  }, []);

  const handleChartResolution = (res: 'day' | 'month') => {
    setChartResolution(res);
    if (res === 'month' && monthData.length === 0 && selectedDate) {
      loadMonth(selectedDate);
    }
  };

  // Navigate by month (for month chart)
  const switchMonth = async (offset: number) => {
    if (!selectedDate) return;
    const d = new Date(selectedDate + 'T12:00:00');
    d.setMonth(d.getMonth() + offset);
    const newDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    setMonthData([]);
    setSelectedDate(newDate);
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    setDataDate(`${months[d.getMonth()]} ${d.getFullYear()}`);
    loadMonth(newDate);
  };

  // Chart segment click → fetch type-filtered complaints → populate feed
  const handleSegmentClick = useCallback(async (hit: ChartHit) => {
    if (!selectedDate) return;
    // Determine date range based on resolution
    let dateFrom = selectedDate;
    let dateTo   = selectedDate;
    if (chartResolution === 'month') {
      const d  = new Date(selectedDate + 'T12:00:00');
      dateFrom = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      dateTo   = nextMonth.toISOString().split('T')[0];
    } else {
      const next = new Date(new Date(selectedDate + 'T00:00:00').getTime() + 86400000);
      dateTo = next.toISOString().split('T')[0];
    }
    const results = await fetchComplaintsByType(hit.type, dateFrom, dateTo);
    setFeed(results.slice(0, MAX_FEED));
  }, [selectedDate, chartResolution]);

  // Replay clock — always 1× real time
  useEffect(() => {
    let raf: number;
    let lastDisplayUpdate = 0;
    function tick(ts: number) {
      if (lastTickRef.current) {
        const dt = Math.min(ts - lastTickRef.current, 50);
        replayRef.current += dt;
      }
      lastTickRef.current = ts;
      if (ts - lastDisplayUpdate > 500) {
        lastDisplayUpdate = ts;
        setReplayTime(replayRef.current);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const filteredComplaints = useMemo(() =>
    complaints.filter(c => activeTypes.has(c.complaint_type)),
    [complaints, activeTypes]
  );

  const handleBatchLoad = useCallback((batch: Complaint[]) => {
    setFeed(batch.slice(0, MAX_FEED));
  }, []);

  const handlePing = useCallback((complaint: Complaint) => {
    setFeed(prev => {
      if (prev.length > 0 && prev[0].unique_key === complaint.unique_key) return prev;
      return [complaint, ...prev].slice(0, MAX_FEED);
    });
  }, []);

  const toggleType = (type: string) => {
    setActiveTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  };

  const toggleAll = () => {
    if (activeTypes.size === topTypes.length) setActiveTypes(new Set());
    else setActiveTypes(new Set(topTypes));
  };

  const replayDate = new Date(replayTime);
  const timeStr = replayDate.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'America/New_York',
  });

  return (
    <div className="app">
      {/* ── Mobile top bar ── */}
      <div className="mobile-bar">
        <div className="mobile-title">NYC 311 RADAR</div>
        <button
          className={`mobile-btn ${mobilePanel === 'filters' ? 'mobile-btn--active' : ''}`}
          onClick={() => setMobilePanel(mobilePanel === 'filters' ? 'none' : 'filters')}
        >☰</button>
      </div>

      {/* ── Left sidebar (desktop) / overlay (mobile) ── */}
      <div className={`sidebar ${mobilePanel === 'filters' ? 'sidebar--mobile-open' : ''}`}>
        <div className="sidebar-header">
          <div className="title">NYC 311 RADAR</div>
          <div className="subtitle">COMPLAINT SCANNER</div>

          {/* View toggle — only thing that stays in sidebar */}
          <div className="view-toggle">
            <button className={`view-btn${viewMode === 'radar' ? ' active' : ''}`}
              onClick={() => handleViewChange('radar')} title="Radar view">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <circle cx="9" cy="9" r="7.5" stroke="currentColor" strokeWidth="0.8" opacity="0.5"/>
                <circle cx="9" cy="9" r="5"   stroke="currentColor" strokeWidth="0.8" opacity="0.5"/>
                <circle cx="9" cy="9" r="2.5" stroke="currentColor" strokeWidth="0.8" opacity="0.5"/>
                <line x1="9" y1="9" x2="9" y2="1.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                <circle cx="9" cy="9" r="1" fill="currentColor"/>
              </svg>
            </button>
            <button className={`view-btn${viewMode !== 'radar' ? ' active' : ''}`}
              onClick={() => handleViewChange('day')} title="Chart view">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                {[3,5,4,7,6,8,5,9,7,6,8,6].map((h, i) => (
                  <rect key={i} x={1 + i * 1.35} y={16 - h} width="1" height={h} fill="currentColor" opacity="0.85" rx="0.3"/>
                ))}
                <line x1="1" y1="16" x2="17" y2="16" stroke="currentColor" strokeWidth="0.7" opacity="0.5"/>
              </svg>
            </button>
          </div>
        </div>

        <div className="filter-section">
          <div className="filter-header">
            <span className="filter-label">COMPLAINT TYPE</span>
            <button className="filter-all" onClick={toggleAll}>
              {activeTypes.size === topTypes.length ? 'NONE' : 'ALL'}
            </button>
          </div>
          <div className="filter-list">
            {topTypes.map(type => (
              <button
                key={type}
                className={`filter-chip ${activeTypes.has(type) ? 'active' : ''}`}
                onClick={() => toggleType(type)}
                style={{ '--chip-color': getComplaintColor(type) } as React.CSSProperties}
              >
                <span className="chip-dot" style={{ background: getComplaintColor(type) }} />
                <span className="chip-label">{type}</span>
              </button>
            ))}
          </div>
        </div>

        {error && <div className="error">{error}</div>}
      </div>

      {/* Mobile backdrop */}
      {mobilePanel !== 'none' && (
        <div className="mobile-backdrop" onClick={() => setMobilePanel('none')} />
      )}

      {/* ── Main view (radar or chart) ── */}
      <div className="radar-wrap">

        {/* RADAR VIEW */}
        {viewMode === 'radar' && (
          <div className="view-column">
            {/* Floating meta — top right of canvas area */}
            <div className="view-meta-float">
              {loading ? 'LOADING…' : `${filteredComplaints.length.toLocaleString()} SIGNALS`}
            </div>
            <div className="view-column-spacer">
              <RadarCanvas
                complaints={filteredComplaints}
                replayTime={replayTime}
                dotLifetime={DOT_LIFETIME_MS}
                onPing={handlePing}
                onBatchLoad={handleBatchLoad}
                hoveredKey={hoveredKey || expandedKey}
              />
            </div>
            {/* Controls bar — live time + date nav */}
            <div className="view-controls view-controls--radar">
              <span className="vc-time">{timeStr}</span>
              <button className="vc-nav-btn" onClick={() => switchDate(-1)}>◀</button>
              <span className="vc-date">{dataDate}</span>
              <button className="vc-nav-btn" onClick={() => switchDate(1)}>▶</button>
            </div>
          </div>
        )}

        {/* CHART VIEW */}
        {viewMode !== 'radar' && (
          <div className="view-column">
            {/* Floating meta — top right, same position as radar */}
            <div className="view-meta-float">
              {loading ? 'LOADING…'
                : chartResolution === 'month'
                ? `${monthData.reduce((s, r) => s + r.count, 0).toLocaleString()} REPORTS`
                : `${filteredComplaints.length.toLocaleString()} REPORTS`}
            </div>
            <div className="chart-wrap">
              {monthLoading && <div className="chart-loading">LOADING MONTH…</div>}
              {!monthLoading && chartResolution === 'month' && (
                <MonthChart
                  data={monthData}
                  selectedDate={selectedDate}
                  onHover={(hit, x, y) => setTooltip(hit ? { type: hit.type, count: hit.count, totalInBar: hit.totalInBar, barIdx: hit.barIdx, x, y } : null)}
                  onSegmentClick={handleSegmentClick}
                />
              )}
              {chartResolution === 'day' && (
                <BarChart
                  complaints={filteredComplaints}
                  resolution="day"
                  selectedDate={selectedDate}
                  chartMode={chartMode}
                  onHover={(hit, x, y) => setTooltip(hit ? { type: hit.type, count: hit.count, totalInBar: hit.totalInBar, barIdx: hit.barIdx, x, y } : null)}
                  onSegmentClick={handleSegmentClick}
                />
              )}
              {/* Tooltip */}
              {tooltip && (() => {
                let barLabel = '';
                if (chartResolution === 'day') {
                  const h = tooltip.barIdx;
                  const h12 = h % 12 === 0 ? 12 : h % 12;
                  const h12next = (h + 1) % 12 === 0 ? 12 : (h + 1) % 12;
                  barLabel = `${h12}${h < 12 ? 'AM' : 'PM'}–${h12next}${(h + 1) < 12 ? 'AM' : 'PM'}`;
                } else {
                  const d2 = new Date(selectedDate + 'T12:00:00');
                  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                  barLabel = `${months[d2.getMonth()]} ${tooltip.barIdx + 1}`;
                }
                const typeColor = getComplaintColor(tooltip.type);
                return (
                  <div className="chart-tooltip" style={{ left: tooltip.x + 12, top: tooltip.y - 8, borderColor: typeColor }}>
                    <div className="chart-tooltip-bar">{barLabel}</div>
                    <div className="chart-tooltip-type">
                      <span className="chart-tooltip-dot" style={{ background: typeColor }} />
                      {tooltip.type}
                    </div>
                    <div className="chart-tooltip-count">{tooltip.count.toLocaleString()} <span className="chart-tooltip-of">/ {tooltip.totalInBar.toLocaleString()}</span></div>
                  </div>
                );
              })()}
            </div>

            {/* Controls bar — 3-column grid */}
            {(() => {
              const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
              const d = new Date(selectedDate + 'T12:00:00');
              const chartDateLabel = chartResolution === 'day'
                ? `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2,'0')}`
                : `${MONTHS[d.getMonth()]} '${String(d.getFullYear()).slice(2)}`;
              return (
                <div className="view-controls">
                  {/* Col 1: MONTH | DAY toggle — left */}
                  <div className="vc-col vc-col--left">
                    <button className={`vc-toggle-btn${chartResolution === 'month' ? ' active' : ''}`}
                      onClick={() => handleChartResolution('month')}>MONTH</button>
                    <button className={`vc-toggle-btn${chartResolution === 'day' ? ' active' : ''}`}
                      onClick={() => handleChartResolution('day')}>DAY</button>
                  </div>
                  {/* Col 2: STACK | TIME icons (day only) — left */}
                  <div className="vc-col vc-col--left">
                    {chartResolution === 'day' && (
                      <>
                        {/* Stack icon — 4 horizontal bars of varying width */}
                        <button className={`vc-icon-btn${chartMode === 'stack' ? ' active' : ''}`}
                          onClick={() => setChartMode('stack')} title="Stack by type">
                          <svg width="16" height="14" viewBox="0 0 16 14" fill="none">
                            <rect x="0" y="0"  width="16" height="2.5" rx="0.5" fill="currentColor"/>
                            <rect x="0" y="4"  width="12" height="2.5" rx="0.5" fill="currentColor"/>
                            <rect x="0" y="8"  width="9"  height="2.5" rx="0.5" fill="currentColor"/>
                            <rect x="0" y="12" width="5"  height="2.5" rx="0.5" fill="currentColor"/>
                          </svg>
                        </button>
                        {/* Clock icon */}
                        <button className={`vc-icon-btn${chartMode === 'time' ? ' active' : ''}`}
                          onClick={() => setChartMode('time')} title="Position by time">
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2"/>
                            <line x1="8" y1="8" x2="8"   y2="3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                            <line x1="8" y1="8" x2="11.5" y2="10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                            <circle cx="8" cy="8" r="1" fill="currentColor"/>
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                  {/* Col 3: nav + date — center */}
                  <div className="vc-col vc-col--center">
                    <button className="vc-nav-btn"
                      onClick={() => chartResolution === 'month' ? switchMonth(-1) : switchDate(-1)}>◀</button>
                    <span className="vc-date">{chartDateLabel}</span>
                    <button className="vc-nav-btn"
                      onClick={() => chartResolution === 'month' ? switchMonth(1) : switchDate(1)}>▶</button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* ── Right feed (desktop) / persistent mini-feed (mobile) ── */}
      <div className="feed-panel">
        <div className="feed-header">SERVICE REQUEST FEED</div>
        <div className="feed-list">
          {feed.length === 0 && (
            <div className="feed-empty">Waiting for signals…</div>
          )}
          {feed.map((c) => {
            const isExpanded = expandedKey === c.unique_key;
            return (
              <div
                key={c.unique_key}
                className={`feed-item ${isExpanded ? 'feed-item--expanded' : ''}`}
                style={{ '--item-color': getComplaintColor(c.complaint_type) } as React.CSSProperties}
                onMouseEnter={() => setHoveredKey(c.unique_key)}
                onMouseLeave={() => setHoveredKey(null)}
                onClick={() => setExpandedKey(isExpanded ? null : c.unique_key)}
              >
                <span className="feed-dot" style={{ background: getComplaintColor(c.complaint_type) }} />
                <div className="feed-content">
                  <div className="feed-type">{c.complaint_type}</div>
                  {c.descriptor && <div className="feed-desc">{c.descriptor}</div>}
                  <div className="feed-meta">
                    {c.borough} · {new Date(c.created_date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}
                  </div>
                  {isExpanded && (
                    <div className="feed-detail">
                      {c.agency_name && <div className="feed-detail-row"><span className="fd-label">AGENCY</span> {c.agency_name}</div>}
                      {(c.incident_address || c.intersection_street_1) && (
                        <div className="feed-detail-row"><span className="fd-label">ADDR</span> {c.incident_address || c.intersection_street_1}</div>
                      )}
                      {c.incident_zip && <div className="feed-detail-row"><span className="fd-label">ZIP</span> {c.incident_zip}</div>}
                      {c.status && <div className="feed-detail-row"><span className="fd-label">STATUS</span> {c.status}</div>}
                      {c.community_board && <div className="feed-detail-row"><span className="fd-label">CB</span> {c.community_board}</div>}
                      <div className="feed-detail-row fd-id"><span className="fd-label">ID</span> {c.unique_key}</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
}
