import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { RadarCanvas } from './RadarCanvas';
import { BarChart } from './BarChart';
import { MonthChart } from './MonthChart';
import { TrendsChart } from './TrendsChart';
import type { ChartMode, ChartHit } from './BarChart';
import { fetchComplaints, fetchComplaintsForDate, fetchMonthAggregate, fetchComplaintsByType, fetchYearAggregate, getComplaintColor, getTopComplaintTypes } from './complaints';
import type { DailyCount, MonthCount } from './complaints';
import type { Complaint } from './complaints';
import './RadarApp.css';

const MAX_FEED = 50;
const DOT_LIFETIME_MS = 10 * 60 * 1000;
// NYC Open Data 311 uploads daily overnight — data is typically 1-2 days behind
const DATA_LAG_DAYS = 3;


function maxDataDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - DATA_LAG_DAYS);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function maxDataYear(): number {
  return new Date(maxDataDate()).getFullYear();
}
function maxDataMonth(year: number): number {
  // Cap at last COMPLETE month — partial current month looks like a dive to zero
  const now = new Date();
  const currentYear  = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-based
  if (year < currentYear) return 11;
  if (year > currentYear) return -1;
  // Current year: last complete month is currentMonth - 1
  // (January of current year = month 0, so if it's March we show Jan+Feb only)
  return Math.max(currentMonth - 1, 0);
}

type ViewMode = 'radar' | 'day' | 'trends';

export default function App() {
  const [viewMode,        setViewMode]        = useState<ViewMode>('radar');
  const [chartResolution, setChartResolution] = useState<'day' | 'month'>('day');
  const [chartMode,       setChartMode]       = useState<ChartMode>('stack');
  const [tooltip, setTooltip] = useState<{ type: string; count: number; totalInBar: number; barIdx: number; x: number; y: number } | null>(null);
  const [monthData, setMonthData] = useState<DailyCount[]>([]);
  const [monthLoading,    setMonthLoading]    = useState(false);

  // Trends state
  const [trendsYear,         setTrendsYear]         = useState(() => new Date().getFullYear());
  const [trendsData,         setTrendsData]         = useState<MonthCount[]>([]);
  const [trendsAllData,      setTrendsAllData]      = useState<Map<number, MonthCount[]>>(new Map());
  const [trendsLoading,      setTrendsLoading]      = useState(false);
  const [trendsTypes,        setTrendsTypes]        = useState<string[]>([]);
  const [trendsActiveTypes,  setTrendsActiveTypes]  = useState<Set<string>>(new Set());
  const [trendsShowTotal,    setTrendsShowTotal]    = useState(false);
  const [trendsMode,         setTrendsMode]         = useState<'1y' | 'overlay' | 'continuous'>('1y');
  const [trendsTypesExpanded, setTrendsTypesExpanded] = useState(false);
  const TRENDS_TOP_N = 20;
  const [complaints, setComplaints] = useState<Complaint[]>([]);

  const [topTypes, setTopTypes] = useState<string[]>([]);
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [feed, setFeed] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);
  const [replayTime, setReplayTime] = useState<number>(0);
  const [dataDate, setDataDate] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState('');
  const [latestDataDate, setLatestDataDate] = useState(''); // true ceiling from API
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [selectedDotKey, setSelectedDotKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'none' | 'feed' | 'filters'>('none');

  const replayRef = useRef(0);
  const feedListRef = useRef<HTMLDivElement>(null);
  const lastTickRef = useRef(0);
  const needsBatchRef = useRef(false);

  function initializeData(data: Complaint[], dateStr: string) {
    const types = getTopComplaintTypes(data, 20);
    setComplaints(data);
    setTopTypes(types);
    setActiveTypes(new Set(types));
    setFeed([]);
    setExpandedKey(null);
    setSelectedDotKey(null);

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
        setLatestDataDate(date); // true ceiling — never navigate past this
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
    const ceiling = latestDataDate || maxDataDate();
    if (newDate > ceiling) return; // don't go into unavailable future
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

  const loadTrends = useCallback(async (yr: number, withAllYears = false) => {
    setTrendsLoading(true);
    try {
      const currentYear = new Date().getFullYear();
      const allYears = Array.from({ length: currentYear - 2019 }, (_, i) => 2020 + i);
      const yearsToFetch = withAllYears
        ? allYears.filter(y => y !== yr)
        : [];
      const [d, ...rest] = await Promise.all([
        fetchYearAggregate(yr),
        ...yearsToFetch.map(y => fetchYearAggregate(y)),
      ]);
      setTrendsData(d);
      if (withAllYears) {
        const m = new Map<number, MonthCount[]>();
        m.set(yr, d);
        yearsToFetch.forEach((y, i) => m.set(y, rest[i]));
        setTrendsAllData(m);
      }
      const totals = new Map<string, number>();
      for (const r of d) totals.set(r.complaint_type, (totals.get(r.complaint_type) ?? 0) + r.count);
      const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
      setTrendsTypes(sorted);
      setTrendsActiveTypes(prev => {
        // Keep existing toggles if already set, otherwise enable all
        if (prev.size === 0) return new Set(sorted);
        // Add any new types that appeared
        const next = new Set(prev);
        sorted.forEach(t => { if (!next.has(t)) next.add(t); });
        return next;
      });

    } catch { /* ignore */ }
    finally { setTrendsLoading(false); }
  }, []);

  const handleViewChange = (mode: ViewMode) => {
    setViewMode(mode);
    // Default to day view when switching to chart — matches the radar day you were on
    if (mode === 'day') {
      setChartResolution('day');
    }
    if (mode === 'trends' && trendsData.length === 0) {
      loadTrends(trendsYear, true);
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
    // Block forward navigation past available data
    const maxDate = new Date(maxDataDate() + 'T12:00:00');
    if (d.getFullYear() > maxDate.getFullYear() ||
       (d.getFullYear() === maxDate.getFullYear() && d.getMonth() > maxDate.getMonth())) return;
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

  // Scroll expanded feed item into view
  useEffect(() => {
    if (!expandedKey || !feedListRef.current) return;
    const el = feedListRef.current.querySelector(`[data-key="${expandedKey}"]`);
    if (!el) return;
    const isMobile = window.innerWidth < 768;
    if (isMobile) {
      // Mobile: snap to top of feed
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else {
      // Desktop: scroll just enough to make it visible, centered if possible
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [expandedKey]);

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
            <button className={`view-btn${viewMode === 'day' ? ' active' : ''}`}
              onClick={() => handleViewChange('day')} title="Chart view">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                {[3,5,4,7,6,8,5,9,7,6,8,6].map((h, i) => (
                  <rect key={i} x={1 + i * 1.35} y={16 - h} width="1" height={h} fill="currentColor" opacity="0.85" rx="0.3"/>
                ))}
                <line x1="1" y1="16" x2="17" y2="16" stroke="currentColor" strokeWidth="0.7" opacity="0.5"/>
              </svg>
            </button>
            <button className={`view-btn${viewMode === 'trends' ? ' active' : ''}`}
              onClick={() => handleViewChange('trends')} title="Trends view">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <polyline points="1,14 5,9 8,11 12,5 17,4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                <line x1="1" y1="16" x2="17" y2="16" stroke="currentColor" strokeWidth="0.7" opacity="0.5"/>
              </svg>
            </button>
          </div>
        </div>

        <div className="filter-section">
          <div className="filter-header">
            <span className="filter-label">COMPLAINT TYPE</span>
            {viewMode === 'trends' ? (
              <button className="filter-all" onClick={() => {
                if (trendsActiveTypes.size === trendsTypes.length) setTrendsActiveTypes(new Set());
                else setTrendsActiveTypes(new Set(trendsTypes));
              }}>
                {trendsActiveTypes.size === trendsTypes.length ? 'NONE' : 'ALL'}
              </button>
            ) : (
              <button className="filter-all" onClick={toggleAll}>
                {activeTypes.size === topTypes.length ? 'NONE' : 'ALL'}
              </button>
            )}
          </div>
          <div className="filter-list">
            {(() => {
              const allList = viewMode === 'trends' ? trendsTypes : topTypes;
              const visibleList = viewMode === 'trends' && !trendsTypesExpanded
                ? allList.slice(0, TRENDS_TOP_N)
                : allList;
              return (<>
                {visibleList.map(type => {
                  const isActive = viewMode === 'trends' ? trendsActiveTypes.has(type) : activeTypes.has(type);
                  const toggle = () => {
                    if (viewMode === 'trends') {
                      setTrendsActiveTypes(prev => {
                        const next = new Set(prev);
                        if (next.has(type)) next.delete(type); else next.add(type);
                        return next;
                      });
                    } else {
                      toggleType(type);
                    }
                  };
                  return (
                    <button
                      key={type}
                      className={`filter-chip ${isActive ? 'active' : ''}`}
                      onClick={toggle}
                      style={{ '--chip-color': getComplaintColor(type) } as React.CSSProperties}
                    >
                      <span className="chip-dot" style={{ background: getComplaintColor(type) }} />
                      <span className="chip-label">{type}</span>
                    </button>
                  );
                })}
                {viewMode === 'trends' && allList.length > TRENDS_TOP_N && (
                  <button
                    className="filter-chip filter-chip--more"
                    onClick={() => setTrendsTypesExpanded(v => !v)}
                    style={{ '--chip-color': 'rgba(0,180,200,0.4)' } as React.CSSProperties}
                  >
                    <span className="chip-label" style={{ color: 'rgba(0,200,220,0.5)', textAlign: 'center' }}>
                      {trendsTypesExpanded ? '▲ SHOW LESS' : `▼ +${allList.length - TRENDS_TOP_N} MORE`}
                    </span>
                  </button>
                )}
              </>);
            })()}
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
                hoveredKey={hoveredKey || selectedDotKey || expandedKey}
                onDotClick={(c) => {
                  setSelectedDotKey(c.unique_key);
                  // Add to top of feed if not already there
                  setFeed(prev => {
                    const exists = prev.some(p => p.unique_key === c.unique_key);
                    return exists ? prev : [c, ...prev].slice(0, MAX_FEED);
                  });
                  // Desktop: expand the item; mobile: just scroll to it
                  if (window.innerWidth >= 768) {
                    setExpandedKey(c.unique_key);
                  } else {
                    setExpandedKey(null);
                    // Keep selected brackets on tapped dot, but mobile still just scrolls feed
                    setTimeout(() => {
                      const el = feedListRef.current?.querySelector(`[data-key="${c.unique_key}"]`);
                      el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                    }, 50);
                  }
                }}
              />
            </div>
            {/* Controls bar — time left, date nav right */}
            <div className="view-controls">
              <div className="vc-col vc-col--left">
                <span className="vc-time vc-time--bright">{timeStr}</span>
              </div>
              <div className="vc-col vc-col--left" />
              <div className="vc-col vc-col--center">
                <button className="vc-nav-btn" onClick={() => switchDate(-1)}>◀</button>
                <span className="vc-date">{dataDate}</span>
                <button className="vc-nav-btn"
                  onClick={() => switchDate(1)}
                  disabled={selectedDate >= (latestDataDate || maxDataDate())}
                  style={{ opacity: selectedDate >= (latestDataDate || maxDataDate()) ? 0.25 : undefined }}>▶</button>
              </div>
            </div>
          </div>
        )}

        {/* CHART VIEW */}
        {viewMode === 'day' && (
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
                  onDayClick={async (date) => {
                    setLoading(true);
                    setError(null);
                    try {
                      const data2 = await fetchComplaintsForDate(date);
                      if (data2.length > 0) initializeData(data2, date);
                    } catch { /* ignore */ }
                    finally {
                      setLoading(false);
                      setChartResolution('day');
                    }
                  }}
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
                      onClick={() => chartResolution === 'month' ? switchMonth(1) : switchDate(1)}
                      disabled={(() => {
                        const max = new Date(maxDataDate() + 'T12:00:00');
                        const cur = new Date(selectedDate + 'T12:00:00');
                        if (chartResolution === 'day') return selectedDate >= (latestDataDate || maxDataDate());
                        return cur.getFullYear() > max.getFullYear() ||
                          (cur.getFullYear() === max.getFullYear() && cur.getMonth() >= max.getMonth());
                      })()}
                      style={{ opacity: (() => {
                        const max = new Date(maxDataDate() + 'T12:00:00');
                        const cur = new Date(selectedDate + 'T12:00:00');
                        const atMax = chartResolution === 'day'
                          ? selectedDate >= (latestDataDate || maxDataDate())
                          : cur.getFullYear() > max.getFullYear() ||
                            (cur.getFullYear() === max.getFullYear() && cur.getMonth() >= max.getMonth());
                        return atMax ? 0.25 : undefined;
                      })() }}>▶</button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* TRENDS VIEW */}
        {viewMode === 'trends' && (
          <div className="view-column">
            <div className="view-meta-float">
              {trendsLoading ? 'LOADING…'
                : `${trendsData.reduce((s, r) => s + r.count, 0).toLocaleString()} REPORTS`}
            </div>
            <div className="chart-wrap">
              {trendsLoading
                ? <div className="chart-loading">LOADING {trendsYear}…</div>
                : <TrendsChart
                    data={trendsData}
                    allYearsData={trendsAllData.size > 0 ? trendsAllData : undefined}
                    year={trendsYear}

                    topTypes={trendsTypes}
                    activeTypes={trendsActiveTypes}
                    cutoffMonth={maxDataMonth(trendsYear)}
                    showAllYears={trendsMode === 'continuous'}
                    compareYears={trendsMode === 'overlay'}
                    showTotal={trendsShowTotal}
                    onMonthJump={async (month) => {
                      const targetDate = `${trendsYear}-${String(month + 1).padStart(2, '0')}-01`;
                      setSelectedDate(targetDate);
                      const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
                      setDataDate(`${months[month]} '${String(trendsYear).slice(2)}`);
                      setViewMode('day');
                      setChartResolution('month');
                      setMonthData([]);
                      setMonthLoading(true);
                      try { const agg = await fetchMonthAggregate(targetDate); setMonthData(agg); }
                      catch { /* ignore */ }
                      finally { setMonthLoading(false); }
                    }}
                    onMonthClick={(month, rows) => {
                      const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
                      const synth = rows.map((r, i) => ({
                        unique_key: `trends-${trendsYear}-${month}-${i}`,
                        complaint_type: r.type,
                        borough: `${MONTHS[month]} ${trendsYear}`,
                        created_date: `${trendsYear}-${String(month+1).padStart(2,'0')}-01T00:00:00.000`,
                        descriptor: `${r.count}`,
                        status: '',
                        agency_name: '',
                        incident_address: '',
                        incident_zip: '',
                        intersection_street_1: '',
                        community_board: '',
                        latitude: '',
                        longitude: '',
                      }));
                      setFeed(synth as any);
                    }}
                  />
              }
              {trendsYear === maxDataYear() && !trendsLoading && (
                <div className="trends-lag-notice">
                  ⚠ data through {maxDataDate()}
                </div>
              )}
            </div>
            {/* Controls bar */}
            <div className="view-controls">
              {/* Tier 1: 1Y | ALL */}
              <div className="vc-col vc-col--left">
                <button
                  className={`vc-toggle-btn${trendsMode === '1y' ? ' active' : ''}`}
                  onClick={() => setTrendsMode('1y')}
                >1Y</button>
                <button
                  className={`vc-toggle-btn${trendsMode !== '1y' ? ' active' : ''}`}
                  onClick={() => {
                    if (trendsMode === '1y') {
                      setTrendsMode('overlay');
                      if (trendsAllData.size === 0) loadTrends(trendsYear, true);
                    }
                  }}
                >ALL</button>
              </div>
              {/* Tier 2: sub-toggles */}
              <div className="vc-col vc-col--left">
                {trendsMode === '1y' && (
                  <button
                    className={`vc-toggle-btn${trendsShowTotal ? ' active' : ''}`}
                    onClick={() => setTrendsShowTotal(v => !v)}
                  >TOTAL</button>
                )}
                {trendsMode !== '1y' && (<>
                  <button
                    className={`vc-toggle-btn${trendsMode === 'overlay' ? ' active' : ''}`}
                    onClick={() => setTrendsMode('overlay')}
                  >OVERLAY</button>
                  <button
                    className={`vc-toggle-btn${trendsMode === 'continuous' ? ' active' : ''}`}
                    onClick={() => setTrendsMode('continuous')}
                  >CONTINUOUS</button>
                </>)}
              </div>
              <div className="vc-col vc-col--center">
                {trendsMode === '1y' ? (<>
                  <button className="vc-nav-btn" onClick={() => {
                    const yr = trendsYear - 1;
                    if (yr < 2020) return;
                    setTrendsYear(yr);
                    setTrendsData([]);
                    loadTrends(yr, true);
                  }}>◀</button>
                  <span className="vc-date">{trendsYear}</span>
                  <button className="vc-nav-btn"
                    disabled={trendsYear >= maxDataYear()}
                    style={{ opacity: trendsYear >= maxDataYear() ? 0.25 : undefined }}
                    onClick={() => {
                      const yr = trendsYear + 1;
                      if (yr > maxDataYear()) return;
                      setTrendsYear(yr);
                      setTrendsData([]);
                      loadTrends(yr, true);
                    }}>▶</button>
                </>) : (
                  <span className="vc-date" style={{ opacity: 0.4 }}>2020–2025</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Right feed (desktop) / persistent mini-feed (mobile) ── */}
      <div className="feed-panel">
        <div className="feed-header">
          {feed.length > 0 && feed[0].unique_key.startsWith('trends-')
            ? `${feed[0].borough} BREAKDOWN`
            : 'SERVICE REQUEST FEED'}
        </div>
        <div className="feed-list" ref={feedListRef}>
          {feed.length === 0 && (
            <div className="feed-empty">Waiting for signals…</div>
          )}

          {/* ── Trends breakdown — clean type + count rows ── */}
          {feed.length > 0 && feed[0].unique_key.startsWith('trends-') && (() => {
            const total = (feed as any[]).reduce((s: number, c: any) => s + parseInt(c.descriptor), 0);
            return (feed as any[]).map((c: any) => {
              const count = parseInt(c.descriptor);
              const pct   = total > 0 ? Math.round((count / total) * 100) : 0;
              const color = getComplaintColor(c.complaint_type);
              return (
                <div key={c.unique_key} className="feed-item feed-item--trend"
                  style={{ '--item-color': color } as React.CSSProperties}>
                  <span className="feed-dot" style={{ background: color }} />
                  <div className="feed-content">
                    <div className="feed-type">{c.complaint_type}</div>
                    <div className="trend-bar-row">
                      <div className="trend-bar" style={{ width: `${pct}%`, background: color }} />
                      <span className="trend-count">{count.toLocaleString()}</span>
                      <span className="trend-pct">{pct}%</span>
                    </div>
                  </div>
                </div>
              );
            });
          })()}

          {/* ── Radar/chart feed — normal complaint rows ── */}
          {(feed.length === 0 || !feed[0].unique_key.startsWith('trends-')) && feed.map((c) => {
            const isExpanded = expandedKey === c.unique_key;
            return (
              <div
                key={c.unique_key}
                data-key={c.unique_key}
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
