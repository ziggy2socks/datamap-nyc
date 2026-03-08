import { useRef, useEffect, useCallback, useState } from 'react';
import { getComplaintColor } from './complaints';
import type { MonthCount } from './complaints';

interface MonthClickRow { type: string; count: number; }

interface Props {
  data: MonthCount[];
  allYearsData?: Map<number, MonthCount[]>; // year → data, for YoY overlay
  year: number;
  showAll: boolean;
  topTypes: string[];
  cutoffMonth?: number;   // last valid month (0-based); lines stop here
  onMonthClick?: (month: number, rows: MonthClickRow[]) => void;
}

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const PAD = { t: 28, r: 20, b: 36, l: 52 };

// Year colors for YoY overlay — muted, distinct
const YEAR_COLORS: Record<number, string> = {
  2020: '#ff6b6b',
  2021: '#ffa94d',
  2022: '#a9e34b',
  2023: '#74c0fc',
  2024: '#cc5de8',
  2025: '#63e6be',
  2026: '#ffffff',
};

function buildMonthTotals(data: MonthCount[], maxMonth = 11): number[] {
  const totals = new Array(12).fill(0);
  for (const r of data) {
    if (r.month <= maxMonth) totals[r.month] += r.count;
  }
  return totals;
}

function buildTypeMap(data: MonthCount[], maxMonth = 11): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const r of data) {
    if (r.month > maxMonth) continue;
    if (!map.has(r.complaint_type)) map.set(r.complaint_type, new Array(12).fill(0));
    map.get(r.complaint_type)![r.month] += r.count;
  }
  return map;
}

export function TrendsChart({ data, allYearsData, year, showAll, topTypes, cutoffMonth, onMonthClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState<{ month: number; x: number; y: number } | null>(null);
  const [hoveredType, setHoveredType] = useState<string | null>(null);

  // Effective cutoff: if current year use cutoffMonth, otherwise full year (11)
  const effectiveCutoff = cutoffMonth !== undefined ? cutoffMonth : 11;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const chartW = W - PAD.l - PAD.r;
    const chartH = H - PAD.t - PAD.b;
    const visibleTypes = showAll ? topTypes : topTypes.slice(0, 8);
    const typeMap    = buildTypeMap(data, effectiveCutoff);
    const typeTotals = buildMonthTotals(data, effectiveCutoff);

    // Y max — use current year data + all years if YoY
    let yMax = Math.max(...typeTotals.slice(0, effectiveCutoff + 1), 1);
    if (allYearsData) {
      for (const [yr, yd] of allYearsData) {
        const cut = yr === year ? effectiveCutoff : 11;
        const t = buildMonthTotals(yd, cut);
        yMax = Math.max(yMax, ...t);
      }
    }

    const xForMonth = (m: number) => PAD.l + (m / 11) * chartW;
    const yForVal   = (v: number) => PAD.t + chartH - (v / yMax) * chartH;

    // ── Grid
    ctx.strokeStyle = 'rgba(0,200,220,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = PAD.t + (i / 4) * chartH;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + chartW, y); ctx.stroke();
    }

    // ── Y axis labels
    ctx.fillStyle = 'rgba(0,200,220,0.35)';
    ctx.font = `600 8px var(--font, monospace)`;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = Math.round((yMax * (4 - i)) / 4);
      const y   = PAD.t + (i / 4) * chartH;
      ctx.fillText(val >= 10000 ? `${Math.round(val / 1000)}k` : val.toLocaleString(), PAD.l - 6, y + 3);
    }

    // ── X axis labels
    ctx.textAlign = 'center';
    for (let m = 0; m < 12; m++) {
      const x = xForMonth(m);
      const isPast = m > effectiveCutoff;
      const isHov  = hovered?.month === m;
      ctx.fillStyle = isPast
        ? 'rgba(0,200,220,0.12)'
        : isHov ? 'rgba(0,200,220,0.9)' : 'rgba(0,200,220,0.35)';
      ctx.fillText(MONTHS[m].slice(0, 3), x, H - 8);
      if (isHov && !isPast) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0,200,220,0.2)';
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + chartH); ctx.stroke();
        ctx.restore();
      }
    }

    // ── Helper: draw a line stopping at maxM
    const drawLine = (vals: number[], color: string, alpha: number, lineWidth: number, dashed: boolean, maxM: number) => {
      if (maxM < 0) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';
      if (dashed) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (let m = 0; m <= maxM; m++) {
        const x = xForMonth(m);
        const y = yForVal(vals[m]);
        m === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    };

    // ── YoY overlay — all other years as dim colored lines
    if (allYearsData) {
      // Collect totals per month per year for 5yr avg
      const avgTotals = new Array(12).fill(0);
      const avgCount  = new Array(12).fill(0);

      for (const [yr, yd] of allYearsData) {
        if (yr === year) continue;
        const cut = 11; // past years always have full data
        const yt = buildMonthTotals(yd, cut);
        const color = YEAR_COLORS[yr] ?? '#888888';
        drawLine(yt, color, 0.25, 1, false, cut);
        for (let m = 0; m <= cut; m++) {
          avgTotals[m] += yt[m];
          avgCount[m]++;
        }
        // Year label at last point
        ctx.save();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.35;
        ctx.font = `600 7px var(--font, monospace)`;
        ctx.textAlign = 'right';
        ctx.fillText(String(yr), xForMonth(11) - 2, yForVal(yt[11]) - 3);
        ctx.restore();
      }

      // 5-year rolling average line — bright white, medium weight
      const avgVals = avgTotals.map((t, m) => avgCount[m] > 0 ? t / avgCount[m] : 0);
      drawLine(avgVals, '#ffffff', 0.4, 1.5, true, 11);
    }

    // ── Current year type lines
    for (const type of visibleTypes) {
      const vals  = typeMap.get(type) ?? new Array(12).fill(0);
      const color = getComplaintColor(type);
      const isHov = hoveredType === type;
      const isDim = hoveredType !== null && !isHov;
      drawLine(vals, color, isDim ? 0.08 : isHov ? 1 : 0.45, isHov ? 2 : 1, false, effectiveCutoff);
    }

    // ── Current year total line — bright white, on top
    drawLine(typeTotals, '#ffffff', hoveredType ? 0.3 : 0.85, 2, false, effectiveCutoff);

    // ── Cutoff marker
    if (effectiveCutoff < 11) {
      const cx = xForMonth(effectiveCutoff);
      // Shade future area
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      const nextX = xForMonth(effectiveCutoff + 0.5);
      ctx.fillRect(nextX, PAD.t, xForMonth(11) + 20 - nextX, chartH);
      // Dashed cutoff line
      ctx.strokeStyle = 'rgba(0,200,220,0.4)';
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, PAD.t); ctx.lineTo(cx, PAD.t + chartH); ctx.stroke();
      // Label
      ctx.fillStyle = 'rgba(0,200,220,0.4)';
      ctx.font = `600 7px var(--font, monospace)`;
      ctx.textAlign = 'left';
      ctx.setLineDash([]);
      ctx.fillText('DATA ENDS', cx + 4, PAD.t + 10);
      ctx.restore();
    }

    // ── Hover dots on current year
    if (hovered && hovered.month <= effectiveCutoff) {
      const m = hovered.month;
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(xForMonth(m), yForVal(typeTotals[m]), 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      for (const type of visibleTypes) {
        const vals  = typeMap.get(type) ?? new Array(12).fill(0);
        const isHov = hoveredType === type;
        ctx.save();
        ctx.globalAlpha = isHov ? 1 : hoveredType ? 0.15 : 0.6;
        ctx.fillStyle = getComplaintColor(type);
        ctx.beginPath();
        ctx.arc(xForMonth(m), yForVal(vals[m]), isHov ? 4 : 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }, [data, allYearsData, topTypes, showAll, hovered, hoveredType, effectiveCutoff, year]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  const hitTestMonth = useCallback((e: React.MouseEvent<HTMLCanvasElement>): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const chartW = canvas.clientWidth - PAD.l - PAD.r;
    const rel = (mx - PAD.l) / chartW;
    if (rel < -0.05 || rel > 1.05) return null;
    const m = Math.max(0, Math.min(11, Math.round(rel * 11)));
    return m <= effectiveCutoff ? m : null; // don't hover future months
  }, [effectiveCutoff]);

  const hitTestType = useCallback((e: React.MouseEvent<HTMLCanvasElement>): string | null => {
    if (data.length === 0) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect    = canvas.getBoundingClientRect();
    const mx      = e.clientX - rect.left;
    const my      = e.clientY - rect.top;
    const W       = canvas.clientWidth;
    const H       = canvas.clientHeight;
    const chartW  = W - PAD.l - PAD.r;
    const chartH  = H - PAD.t - PAD.b;
    const typeMap = buildTypeMap(data, effectiveCutoff);
    const totals  = buildMonthTotals(data, effectiveCutoff);
    const yMax    = Math.max(...totals, 1);
    const visible = showAll ? topTypes : topTypes.slice(0, 8);
    let closest: string | null = null;
    let closestDist = 14;
    for (const type of visible) {
      const vals = typeMap.get(type) ?? new Array(12).fill(0);
      for (let m = 0; m <= effectiveCutoff; m++) {
        const x = PAD.l + (m / 11) * chartW;
        const y = PAD.t + chartH - (vals[m] / yMax) * chartH;
        const dist = Math.hypot(mx - x, my - y);
        if (dist < closestDist) { closestDist = dist; closest = type; }
      }
    }
    return closest;
  }, [data, topTypes, showAll, effectiveCutoff]);

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const m = hitTestMonth(e);
    const t = hitTestType(e);
    setHovered(m !== null ? { month: m, x: e.clientX, y: e.clientY } : null);
    setHoveredType(t);
  };
  const onMouseLeave = () => { setHovered(null); setHoveredType(null); };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const m = hitTestMonth(e);
    if (m === null || !onMonthClick) return;
    const typeMap = buildTypeMap(data, effectiveCutoff);
    const visible = showAll ? topTypes : topTypes.slice(0, 8);
    const rows = visible
      .map(t => ({ type: t, count: typeMap.get(t)?.[m] ?? 0 }))
      .filter(r => r.count > 0)
      .sort((a, b) => b.count - a.count);
    onMonthClick(m, rows);
  };

  const typeMap    = buildTypeMap(data, effectiveCutoff);
  const typeTotals = buildMonthTotals(data, effectiveCutoff);
  const visibleTypes = showAll ? topTypes : topTypes.slice(0, 8);

  return (
    <div className="trends-wrap">
      <canvas
        ref={canvasRef}
        className="trends-canvas"
        style={{ cursor: hovered ? 'pointer' : 'default' }}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
      />
      {/* Hover tooltip — inline, minimal */}
      {hovered && (
        <div className="chart-tooltip trends-tooltip" style={{ left: hovered.x + 14, top: hovered.y - 12 }}>
          <div className="chart-tooltip-bar">{MONTHS[hovered.month]} {year} · click to load feed</div>
          <div className="trends-tooltip-row trends-tooltip-total">
            <span className="chart-tooltip-dot" style={{ background: '#fff' }} />
            <span className="trends-tooltip-label">TOTAL</span>
            <span className="trends-tooltip-val">{typeTotals[hovered.month].toLocaleString()}</span>
          </div>
          {visibleTypes
            .map(t => ({ t, v: typeMap.get(t)?.[hovered.month] ?? 0 }))
            .filter(x => x.v > 0)
            .sort((a, b) => b.v - a.v)
            .slice(0, 5)
            .map(({ t, v }) => (
              <div key={t} className={`trends-tooltip-row${hoveredType === t ? ' trends-tooltip-row--hov' : ''}`}>
                <span className="chart-tooltip-dot" style={{ background: getComplaintColor(t) }} />
                <span className="trends-tooltip-label">{t}</span>
                <span className="trends-tooltip-val">{v.toLocaleString()}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
