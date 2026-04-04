/**
 * PermitCharts — full-viewport analytics view for NYC DOB permit data.
 *
 * Four canvas-based charts:
 *   1. Monthly volume trend (2021→present) — stacked area by type
 *   2. Type breakdown — horizontal bar chart for current filter window
 *   3. Top neighborhoods (NTA) — most active in current filter window
 *   4. Estimated cost by type — total declared $ per permit type
 *   5. Top owners/applicants — most active in current filter window
 *
 * Trend data is fetched independently (full 2021→present) via Socrata
 * aggregation query. Filter charts draw from allPermits in context.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { usePermits } from './PermitContext';
import { ALL_BOROUGHS, WORK_TYPE_LABELS, WORK_TYPE_COLORS } from './permit-data';

// ── colour helpers ──────────────────────────────────────────────────────────

const ACCENT2 = '#34d399';
const ACCENT3 = '#f59e0b';
const TEXT_BRIGHT = 'rgba(255,255,255,0.88)';
const TEXT_DIM    = 'rgba(255,255,255,0.42)';
const GRID_LINE   = 'rgba(255,255,255,0.06)';
const PANEL_BG    = 'rgba(255,255,255,0.04)';
const FONT        = "'Courier New', monospace";

// ── Socrata monthly trend query ─────────────────────────────────────────────
interface MonthBucket { month: string; work_type: string; cnt: number; }

async function fetchMonthlyTrend(): Promise<MonthBucket[]> {
  const url =
    '/api/permits?' +
    '$select=date_trunc_ym(issued_date) as month,work_type,count(*) as cnt' +
    "&$where=issued_date>='2021-01-01'" +
    '&$group=month,work_type' +
    '&$order=month ASC' +
    '&$limit=50000';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return [];
  const rows: any[] = await res.json();
  return rows
    .filter(r => r.month && r.work_type && r.cnt)
    .map(r => ({ month: r.month.slice(0, 7), work_type: r.work_type, cnt: parseInt(r.cnt, 10) }));
}

// ── canvas drawing helpers ──────────────────────────────────────────────────
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (w < 0 || h < 0) return;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// Map work_type strings to our job type codes
const WORK_TYPE_TO_CODE: Record<string, string> = {
  'General Construction': 'GC',
  'Plumbing': 'PL',
  'Mechanical Systems': 'ME',
  'Sidewalk Shed': 'SHD',
  'Structural': 'STR',
  'Construction Fence': 'FNC',
  'Sprinklers': 'SPR',
  'Solar': 'SOL',
  'Supported Scaffold': 'SCF',
  'Foundation': 'FND',
  'Suspended Scaffold': 'STP',
  'Protection and Mechanical Methods': 'OTH',
  'Earth Work': 'EW',
  'Sign': 'SG',
  'Standpipe': 'STP',
  'Support of Excavation': 'EW',
  'Boiler Equipment': 'BLR',
  'Curb Cut': 'CC',
  'Full Demolition': 'DM',
  'Antenna': 'ANT',
  'New Building': 'NB',
  'Demolition': 'DM',
};

function wtCode(wt: string): string {
  return WORK_TYPE_TO_CODE[wt] ?? 'OTH';
}

// ── component ──────────────────────────────────────────────────────────────
export default function PermitCharts() {
  const { allPermits, filters } = usePermits();

  const trendRef  = useRef<HTMLCanvasElement>(null);
  const typeRef   = useRef<HTMLCanvasElement>(null);
  const ntaRef    = useRef<HTMLCanvasElement>(null);
  const costRef   = useRef<HTMLCanvasElement>(null);
  const ownersRef = useRef<HTMLCanvasElement>(null);

  const [trendData,    setTrendData]    = useState<MonthBucket[]>([]);
  const [trendLoading, setTrendLoading] = useState(true);
  const [trendMode,    setTrendMode]    = useState<'total' | 'stacked'>('stacked');

  // Fetch trend on mount
  useEffect(() => {
    setTrendLoading(true);
    fetchMonthlyTrend().then(d => { setTrendData(d); setTrendLoading(false); });
  }, []);

  // ── Chart 1: Monthly trend ────────────────────────────────────────────────
  const drawTrend = useCallback(() => {
    const canvas = trendRef.current;
    if (!canvas || trendLoading) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = PANEL_BG;
    roundRect(ctx, 0, 0, W, H, 8); ctx.fill();

    // Title
    ctx.fillStyle = TEXT_BRIGHT;
    ctx.font = `700 11px ${FONT}`;
    ctx.fillText('MONTHLY PERMIT VOLUME', 16, 20);
    ctx.fillStyle = TEXT_DIM;
    ctx.font = `400 10px ${FONT}`;
    ctx.fillText('2021 → PRESENT', W - 110, 20);

    const PAD_L = 52, PAD_R = 16, PAD_T = 36, PAD_B = 36;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;

    // Group by month
    const months = [...new Set(trendData.map(d => d.month))].sort();
    if (!months.length) return;

    // Top types by total volume
    const typeVol: Record<string, number> = {};
    trendData.forEach(d => { typeVol[d.work_type] = (typeVol[d.work_type] ?? 0) + d.cnt; });
    const topTypes = Object.entries(typeVol).sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0]);

    // Monthly totals per type
    const byMonthType: Record<string, Record<string, number>> = {};
    trendData.forEach(d => {
      if (!byMonthType[d.month]) byMonthType[d.month] = {};
      byMonthType[d.month][d.work_type] = (byMonthType[d.month][d.work_type] ?? 0) + d.cnt;
    });

    const monthTotals = months.map(m => Object.values(byMonthType[m] ?? {}).reduce((a, b) => a + b, 0));
    const maxVal = Math.max(...monthTotals);

    // Grid lines
    const gridCount = 4;
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    for (let i = 0; i <= gridCount; i++) {
      const y = PAD_T + cH - (i / gridCount) * cH;
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + cW, y); ctx.stroke();
      if (i > 0) {
        ctx.fillStyle = TEXT_DIM;
        ctx.font = `400 9px ${FONT}`;
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.round(maxVal * i / gridCount / 1000)}k`, PAD_L - 4, y + 3);
      }
    }

    const barW = Math.max(1, cW / months.length - 1);

    if (trendMode === 'total') {
      // Simple area fill
      ctx.beginPath();
      months.forEach((_m, i) => {
        const x = PAD_L + i * (cW / months.length) + barW / 2;
        const y = PAD_T + cH - (monthTotals[i] / maxVal) * cH;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      // Close area
      const lastX = PAD_L + (months.length - 1) * (cW / months.length) + barW / 2;
      ctx.lineTo(lastX, PAD_T + cH);
      ctx.lineTo(PAD_L + barW / 2, PAD_T + cH);
      ctx.closePath();
      ctx.fillStyle = 'rgba(96,165,250,0.25)';
      ctx.fill();
      // Line
      ctx.beginPath();
      months.forEach((_m, i) => {
        const x = PAD_L + i * (cW / months.length) + barW / 2;
        const y = PAD_T + cH - (monthTotals[i] / maxVal) * cH;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      // Stacked bars
      months.forEach((m, i) => {
        const x = PAD_L + i * (cW / months.length);
        let yBase = PAD_T + cH;
        topTypes.forEach(wt => {
          const cnt = byMonthType[m]?.[wt] ?? 0;
          if (!cnt) return;
          const h = (cnt / maxVal) * cH;
          yBase -= h;
          const code = wtCode(wt);
          ctx.fillStyle = WORK_TYPE_COLORS[code] ?? '#888';
          ctx.globalAlpha = 0.8;
          ctx.fillRect(x, yBase, Math.max(barW - 0.5, 1), h);
          ctx.globalAlpha = 1;
        });
      });
    }

    // X-axis labels — year markers
    ctx.fillStyle = TEXT_DIM;
    ctx.font = `400 9px ${FONT}`;
    ctx.textAlign = 'center';
    let lastYear = '';
    months.forEach((m, i) => {
      const yr = m.slice(0, 4);
      if (yr !== lastYear) {
        lastYear = yr;
        const x = PAD_L + i * (cW / months.length);
        ctx.beginPath(); ctx.moveTo(x, PAD_T + cH); ctx.lineTo(x, PAD_T + cH + 4);
        ctx.strokeStyle = TEXT_DIM; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillText(yr, x + 12, PAD_T + cH + 14);
      }
    });
    ctx.textAlign = 'left';
  }, [trendData, trendLoading, trendMode]);

  // ── Chart 2: Type breakdown ──────────────────────────────────────────────
  const drawTypes = useCallback(() => {
    const canvas = typeRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = PANEL_BG;
    roundRect(ctx, 0, 0, W, H, 8); ctx.fill();

    ctx.fillStyle = TEXT_BRIGHT;
    ctx.font = `700 11px ${FONT}`;
    ctx.fillText('PERMITS BY TYPE', 16, 20);
    ctx.fillStyle = TEXT_DIM;
    ctx.font = `400 10px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(`${allPermits.length.toLocaleString()} TOTAL`, W - 16, 20);
    ctx.textAlign = 'left';

    // Count by job type from allPermits
    const counts: Record<string, number> = {};
    allPermits.forEach(p => {
      const t = p.job_type ?? 'OTH';
      counts[t] = (counts[t] ?? 0) + 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!sorted.length) return;

    const PAD_L = 108, PAD_R = 50, PAD_T = 32, PAD_B = 12;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const rowH = cH / sorted.length;
    const maxCnt = sorted[0][1];

    sorted.forEach(([type, cnt], i) => {
      const y = PAD_T + i * rowH;
      const barH = Math.max(rowH * 0.55, 4);
      const barY = y + (rowH - barH) / 2;
      const barW = (cnt / maxCnt) * cW;

      // Bar
      ctx.fillStyle = WORK_TYPE_COLORS[type] ?? '#888';
      ctx.globalAlpha = 0.75;
      roundRect(ctx, PAD_L, barY, barW, barH, 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Label
      const labelText = WORK_TYPE_LABELS[type] ?? type;
      ctx.fillStyle = TEXT_DIM;
      ctx.font = `400 9px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(labelText, PAD_L - 6, y + rowH / 2 + 3);

      // Count
      ctx.fillStyle = TEXT_BRIGHT;
      ctx.font = `700 9px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(cnt.toLocaleString(), PAD_L + barW + 6, y + rowH / 2 + 3);
    });
    ctx.textAlign = 'left';
  }, [allPermits]);

  // ── Chart 3: Top neighborhoods (NTA) ───────────────────────────────────
  const drawNTA = useCallback(() => {
    const canvas = ntaRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = PANEL_BG;
    roundRect(ctx, 0, 0, W, H, 8); ctx.fill();

    ctx.fillStyle = TEXT_BRIGHT;
    ctx.font = `700 11px ${FONT}`;
    ctx.fillText('TOP NEIGHBORHOODS', 16, 20);
    ctx.fillStyle = TEXT_DIM;
    ctx.font = `400 10px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText('BY PERMIT COUNT', W - 16, 20);
    ctx.textAlign = 'left';

    const counts: Record<string, number> = {};
    allPermits.forEach(p => {
      const n = p.nta?.trim();
      if (n) counts[n] = (counts[n] ?? 0) + 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!sorted.length) {
      ctx.fillStyle = TEXT_DIM;
      ctx.font = `400 10px ${FONT}`;
      ctx.fillText('NO NEIGHBORHOOD DATA IN CURRENT FILTER', 16, H / 2);
      return;
    }

    const PAD_L = 118, PAD_R = 50, PAD_T = 32, PAD_B = 12;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const rowH = cH / sorted.length;
    const maxCnt = sorted[0][1];

    sorted.forEach(([nta, cnt], i) => {
      const y = PAD_T + i * rowH;
      const barH = Math.max(rowH * 0.55, 4);
      const barY = y + (rowH - barH) / 2;
      const barW = (cnt / maxCnt) * cW;

      ctx.fillStyle = ACCENT2;
      ctx.globalAlpha = 0.65;
      roundRect(ctx, PAD_L, barY, barW, barH, 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = TEXT_DIM;
      ctx.font = `400 9px ${FONT}`;
      ctx.textAlign = 'right';
      const label = nta.length > 16 ? nta.slice(0, 15) + '…' : nta;
      ctx.fillText(label, PAD_L - 6, y + rowH / 2 + 3);

      ctx.fillStyle = TEXT_BRIGHT;
      ctx.font = `700 9px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(cnt.toLocaleString(), PAD_L + barW + 6, y + rowH / 2 + 3);
    });
    ctx.textAlign = 'left';
  }, [allPermits]);

  // ── Chart 4: Estimated cost by type ──────────────────────────────────────
  const drawCost = useCallback(() => {
    const canvas = costRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = PANEL_BG;
    roundRect(ctx, 0, 0, W, H, 8); ctx.fill();

    ctx.fillStyle = TEXT_BRIGHT;
    ctx.font = `700 11px ${FONT}`;
    ctx.fillText('DECLARED COST BY TYPE', 16, 20);
    ctx.fillStyle = TEXT_DIM;
    ctx.font = `400 10px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText('ESTIMATED $', W - 16, 20);
    ctx.textAlign = 'left';

    // Aggregate cost per type — estimated_job_costs is a text field
    const costs: Record<string, number> = {};
    allPermits.forEach(p => {
      const t = p.job_type ?? 'OTH';
      const v = parseFloat((p.estimated_job_costs ?? '').replace(/[$,]/g, ''));
      if (!isNaN(v) && v > 0) costs[t] = (costs[t] ?? 0) + v;
    });
    const sorted = Object.entries(costs).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!sorted.length) {
      ctx.fillStyle = TEXT_DIM;
      ctx.font = `400 10px ${FONT}`;
      ctx.fillText('NO COST DATA IN CURRENT FILTER', 16, H / 2);
      return;
    }

    const PAD_L = 88, PAD_R = 72, PAD_T = 32, PAD_B = 12;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const rowH = cH / sorted.length;
    const maxCost = sorted[0][1];

    // Format cost compactly
    const fmtCost = (v: number) => {
      if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
      if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
      if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
      return `$${v.toFixed(0)}`;
    };

    sorted.forEach(([type, cost], i) => {
      const y = PAD_T + i * rowH;
      const barH = Math.max(rowH * 0.55, 4);
      const barY = y + (rowH - barH) / 2;
      const barW = (cost / maxCost) * cW;

      ctx.fillStyle = WORK_TYPE_COLORS[type] ?? '#888';
      ctx.globalAlpha = 0.75;
      roundRect(ctx, PAD_L, barY, barW, barH, 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = TEXT_DIM;
      ctx.font = `400 9px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(WORK_TYPE_LABELS[type] ?? type, PAD_L - 6, y + rowH / 2 + 3);

      ctx.fillStyle = TEXT_BRIGHT;
      ctx.font = `700 9px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(fmtCost(cost), PAD_L + barW + 6, y + rowH / 2 + 3);
    });
    ctx.textAlign = 'left';
  }, [allPermits]);

  // ── Chart 5: Top owners / applicants ─────────────────────────────────────
  const drawOwners = useCallback(() => {
    const canvas = ownersRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = PANEL_BG;
    roundRect(ctx, 0, 0, W, H, 8); ctx.fill();

    ctx.fillStyle = TEXT_BRIGHT;
    ctx.font = `700 11px ${FONT}`;
    ctx.fillText('TOP OWNERS / APPLICANTS', 16, 20);
    ctx.fillStyle = TEXT_DIM;
    ctx.font = `400 10px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText('PERMIT COUNT', W - 16, 20);
    ctx.textAlign = 'left';

    // Prefer business name; fall back to personal name; skip blanks/unknowns
    const SKIP = new Set(['', 'UNKNOWN', 'N/A', 'NA', 'NONE', 'NOT APPLICABLE', 'NOT AVAILABLE', 'NO BUSINESS NAME']);
    const counts: Record<string, number> = {};
    allPermits.forEach(p => {
      const raw = (
        p.owner_business_name ||
        p.applicant_business_name ||
        (p.owner_name ? p.owner_name.trim() : '') ||
        [p.applicant_first_name, p.applicant_last_name].filter(Boolean).join(' ')
      ).trim().toUpperCase();
      if (!raw || SKIP.has(raw)) return;
      counts[raw] = (counts[raw] ?? 0) + 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!sorted.length) {
      ctx.fillStyle = TEXT_DIM;
      ctx.font = `400 10px ${FONT}`;
      ctx.fillText('NO OWNER DATA IN CURRENT FILTER', 16, H / 2);
      return;
    }

    const PAD_L = 130, PAD_R = 50, PAD_T = 32, PAD_B = 12;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const rowH = cH / sorted.length;
    const maxCnt = sorted[0][1];

    sorted.forEach(([owner, cnt], i) => {
      const y = PAD_T + i * rowH;
      const barH = Math.max(rowH * 0.55, 4);
      const barY = y + (rowH - barH) / 2;
      const barW = (cnt / maxCnt) * cW;

      ctx.fillStyle = ACCENT3;
      ctx.globalAlpha = 0.65;
      roundRect(ctx, PAD_L, barY, barW, barH, 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = TEXT_DIM;
      ctx.font = `400 9px ${FONT}`;
      ctx.textAlign = 'right';
      const label = owner.length > 18 ? owner.slice(0, 17) + '…' : owner;
      ctx.fillText(label, PAD_L - 6, y + rowH / 2 + 3);

      ctx.fillStyle = TEXT_BRIGHT;
      ctx.font = `700 9px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(cnt.toLocaleString(), PAD_L + barW + 6, y + rowH / 2 + 3);
    });
    ctx.textAlign = 'left';
  }, [allPermits]);

  // Redraw all on data/size change
  useEffect(() => { drawTrend(); }, [drawTrend]);
  useEffect(() => { drawTypes(); drawNTA(); drawCost(); drawOwners(); }, [drawTypes, drawNTA, drawCost, drawOwners]);

  // ResizeObserver for redraws
  useEffect(() => {
    const canvases = [trendRef, typeRef, ntaRef, costRef, ownersRef];
    const ro = new ResizeObserver(() => {
      drawTrend(); drawTypes(); drawNTA(); drawCost(); drawOwners();
    });
    canvases.forEach(r => { if (r.current?.parentElement) ro.observe(r.current.parentElement); });
    return () => ro.disconnect();
  }, [drawTrend, drawTypes, drawNTA, drawCost, drawOwners]);

  return (
    <div className="permit-charts">

      {/* Header row */}
      <div className="pc-header">
        <div className="pc-title">
          NYC PERMIT ANALYTICS
          <span className="pc-subtitle">
            {filters.dateFrom} → {filters.dateTo}
            {filters.boroughs.size < ALL_BOROUGHS.length && ` · ${[...filters.boroughs].join(', ')}`}
          </span>
        </div>
        <div className="pc-trend-toggle">
          <button
            className={`pc-toggle-btn${trendMode === 'total' ? ' active' : ''}`}
            onClick={() => setTrendMode('total')}
          >TOTAL</button>
          <button
            className={`pc-toggle-btn${trendMode === 'stacked' ? ' active' : ''}`}
            onClick={() => setTrendMode('stacked')}
          >BY TYPE</button>
        </div>
      </div>

      {/* Charts grid */}
      <div className="pc-grid">

        {/* Trend — full width */}
        <div className="pc-panel pc-trend">
          {trendLoading
            ? <div className="pc-loading">LOADING TREND DATA…</div>
            : <canvas ref={trendRef} style={{ width: '100%', height: '100%', display: 'block' }} />
          }
        </div>

        {/* Three equal panels */}
        <div className="pc-panel pc-type">
          <canvas ref={typeRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        <div className="pc-panel pc-nta">
          <canvas ref={ntaRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        <div className="pc-panel pc-cost">
          <canvas ref={costRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        <div className="pc-panel pc-owners" style={{ gridColumn: '1 / -1' }}>
          <canvas ref={ownersRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>

      </div>
    </div>
  );
}
