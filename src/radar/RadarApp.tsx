import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { RadarCanvas } from './RadarCanvas';
import { fetchComplaints, fetchComplaintsForDate, getComplaintColor, getTopComplaintTypes } from './complaints';
import type { Complaint } from './complaints';
import './RadarApp.css';

const MAX_FEED = 50;
const DOT_LIFETIME_MS = 10 * 60 * 1000;

export default function App() {
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
    hour12: false, timeZone: 'America/New_York'
  });

  return (
    <div className="app">
      {/* ── Mobile top bar ── */}
      <div className="mobile-bar">
        <div className="mobile-title">NYC 311 RADAR</div>
        <div className="mobile-time">{dataDate} {timeStr} ET</div>
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
          <div className="replay-info">
            <div className="replay-date-row">
              <button className="date-nav" onClick={() => switchDate(-1)}>◀</button>
              <span className="replay-date">{dataDate}</span>
              <button className="date-nav" onClick={() => switchDate(1)}>▶</button>
            </div>
            <div className="replay-time">{timeStr} ET</div>
            <div className="replay-delay">24H DELAY</div>
          </div>
          <div className="meta">
            {loading ? 'LOADING…' : `${filteredComplaints.length.toLocaleString()} SIGNALS`}
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

      {/* ── Radar ── */}
      <div className="radar-wrap">
        <RadarCanvas
          complaints={filteredComplaints}
          replayTime={replayTime}
          dotLifetime={DOT_LIFETIME_MS}
          onPing={handlePing}
          onBatchLoad={handleBatchLoad}
          hoveredKey={hoveredKey || expandedKey}
        />
      </div>

      {/* ── Right feed (desktop) / persistent mini-feed (mobile) ── */}
      <div className="feed-panel">
        <div className="feed-header">TICKET FEED</div>
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
