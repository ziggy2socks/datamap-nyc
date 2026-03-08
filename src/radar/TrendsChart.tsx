import { useRef, useEffect, useCallback, useState } from 'react';
import { getComplaintColor } from './complaints';
import type { MonthCount } from './complaints';

interface Props {
  data: MonthCount[];          // current year
  dataB?: MonthCount[];        // comparison year (optional)
  year: number;
  yearB?: number;
  showAll: boolean;            // false = top 8 types only
  topTypes: string[];          // pre-ranked from current year data
  cutoffMonth?: number;        // last month with data (0-based); months after are faded + line drawn
  onHoverMonth?: (month: number | null) => void;
}

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const PAD = { t: 28, r: 20, b: 36, l: 52 };

function buildMonthTotals(data: MonthCount[]): number[] {
  const totals = new Array(12).fill(0);
  for (const r of data) totals[r.month] += r.count;
  return totals;
}

function buildTypeMap(data: MonthCount[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const r of data) {
    if (!map.has(r.complaint_type)) map.set(r.complaint_type, new Array(12).fill(0));
    map.get(r.complaint_type)![r.month] += r.count;
  }
  return map;
}

export function TrendsChart({ data, dataB, year, yearB: _yearB, showAll, topTypes, cutoffMonth, onHoverMonth }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState<{ month: number; x: number; y: number } | null>(null);
  const [hoveredType, setHoveredType] = useState<string | null>(null);

  const draw = useCallback(() => { // cutoffMonth in scope via closure
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
    const typeMap  = buildTypeMap(data);
    const typeTotals = buildMonthTotals(data);
    const typeTotalsB = dataB ? buildMonthTotals(dataB) : null;
    const typemapB = dataB ? buildTypeMap(dataB) : null;

    // Y max — across both years
    const allValues = [
      ...typeTotals,
      ...(typeTotalsB ?? []),
    ];
    const yMax = Math.max(...allValues, 1);

    const xForMonth = (m: number) => PAD.l + (m / 11) * chartW;
    const yForVal   = (v: number) => PAD.t + chartH - (v / yMax) * chartH;

    // ── Grid lines
    const yTicks = 4;
    ctx.strokeStyle = 'rgba(0,200,220,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= yTicks; i++) {
      const y = PAD.t + (i / yTicks) * chartH;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + chartW, y); ctx.stroke();
    }

    // ── Y axis labels
    ctx.fillStyle = 'rgba(0,200,220,0.35)';
    ctx.font = `600 8px var(--font, monospace)`;
    ctx.textAlign = 'right';
    for (let i = 0; i <= yTicks; i++) {
      const val = Math.round((yMax * (yTicks - i)) / yTicks);
      const y   = PAD.t + (i / yTicks) * chartH;
      const label = val >= 10000 ? `${Math.round(val / 1000)}k` : val.toLocaleString();
      ctx.fillText(label, PAD.l - 6, y + 3);
    }

    // ── X axis labels
    ctx.textAlign = 'center';
    for (let m = 0; m < 12; m++) {
      const x = xForMonth(m);
      const isHov = hovered?.month === m;
      ctx.fillStyle = isHov ? 'rgba(0,200,220,0.9)' : 'rgba(0,200,220,0.35)';
      ctx.fillText(MONTHS[m].slice(0, 3), x, H - 8);
      // vertical guide on hover
      if (isHov) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0,200,220,0.2)';
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + chartH); ctx.stroke();
        ctx.restore();
      }
    }

    // ── Draw type lines (dim when a type is hovered)
    const drawLine = (
      vals: number[],
      color: string,
      alpha: number,
      lineWidth: number,
      dashed: boolean,
    ) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';
      if (dashed) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (let m = 0; m < 12; m++) {
        const x = xForMonth(m);
        const y = yForVal(vals[m]);
        m === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    };

    for (const type of visibleTypes) {
      const vals  = typeMap.get(type) ?? new Array(12).fill(0);
      const color = getComplaintColor(type);
      const isHov = hoveredType === type;
      const isDim = hoveredType !== null && !isHov;
      drawLine(vals, color, isDim ? 0.08 : isHov ? 1 : 0.45, isHov ? 2 : 1, false);

      // Comparison year — dashed, more faded
      if (typemapB) {
        const valsB = typemapB.get(type) ?? new Array(12).fill(0);
        drawLine(valsB, color, isDim ? 0.04 : 0.2, 1, true);
      }
    }

    // ── Total line — always on top, bright white
    drawLine(typeTotals, '#ffffff', hoveredType ? 0.3 : 0.85, 2, false);
    if (typeTotalsB) {
      drawLine(typeTotalsB, '#ffffff', 0.25, 1.5, true);
    }

    // ── Cutoff line — vertical dashed line at last available month
    if (cutoffMonth !== undefined && cutoffMonth >= 0 && cutoffMonth < 11) {
      const cx = xForMonth(cutoffMonth);
      // Shade future months
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(cx, PAD.t, xForMonth(11) + 10 - cx, chartH);
      ctx.restore();
      // Dashed vertical line
      ctx.save();
      ctx.strokeStyle = 'rgba(0,200,220,0.5)';
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, PAD.t);
      ctx.lineTo(cx, PAD.t + chartH);
      ctx.stroke();
      // Label
      ctx.fillStyle = 'rgba(0,200,220,0.5)';
      ctx.font = `600 8px var(--font, monospace)`;
      ctx.textAlign = 'left';
      ctx.fillText('DATA ENDS', cx + 4, PAD.t + 10);
      ctx.restore();
    }

    // ── Dots at hovered month
    if (hovered) {
      const m = hovered.month;
      // Total dot
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(xForMonth(m), yForVal(typeTotals[m]), 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Type dots
      for (const type of visibleTypes) {
        const vals = typeMap.get(type) ?? new Array(12).fill(0);
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
  }, [data, dataB, topTypes, showAll, hovered, hoveredType]);

  useEffect(() => { draw(); }, [draw]);

  // Resize observer
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
    const W = canvas.clientWidth;
    const chartW = W - PAD.l - PAD.r;
    const rel = (mx - PAD.l) / chartW;
    if (rel < -0.05 || rel > 1.05) return null;
    return Math.max(0, Math.min(11, Math.round(rel * 11)));
  }, []);

  const hitTestType = useCallback((e: React.MouseEvent<HTMLCanvasElement>): string | null => {
    if (data.length === 0) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect  = canvas.getBoundingClientRect();
    const mx    = e.clientX - rect.left;
    const my    = e.clientY - rect.top;
    const W     = canvas.clientWidth;
    const H     = canvas.clientHeight;
    const chartW = W - PAD.l - PAD.r;
    const chartH = H - PAD.t - PAD.b;
    const typeMap = buildTypeMap(data);
    const typeTotals = buildMonthTotals(data);
    const yMax = Math.max(...typeTotals, 1);
    const visibleTypes = (showAll ? topTypes : topTypes.slice(0, 8));

    let closest: string | null = null;
    let closestDist = 14; // px threshold
    for (const type of visibleTypes) {
      const vals = typeMap.get(type) ?? new Array(12).fill(0);
      for (let m = 0; m < 12; m++) {
        const x = PAD.l + (m / 11) * chartW;
        const y = PAD.t + chartH - (vals[m] / yMax) * chartH;
        const dist = Math.hypot(mx - x, my - y);
        if (dist < closestDist) { closestDist = dist; closest = type; }
      }
    }
    return closest;
  }, [data, topTypes, showAll]);

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const m = hitTestMonth(e);
    const t = hitTestType(e);
    setHovered(m !== null ? { month: m, x: e.clientX, y: e.clientY } : null);
    setHoveredType(t);
    onHoverMonth?.(m);
  };
  const onMouseLeave = () => {
    setHovered(null);
    setHoveredType(null);
    onHoverMonth?.(null);
  };

  // Build tooltip data
  const typeMap    = buildTypeMap(data);
  const typeTotals = buildMonthTotals(data);
  const visibleTypes = showAll ? topTypes : topTypes.slice(0, 8);

  return (
    <div className="trends-wrap">
      <canvas
        ref={canvasRef}
        className="trends-canvas"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      />
      {/* Tooltip */}
      {hovered && (
        <div className="chart-tooltip trends-tooltip" style={{ left: hovered.x + 14, top: hovered.y - 12 }}>
          <div className="chart-tooltip-bar">{MONTHS[hovered.month]} {year}</div>
          {/* Total */}
          <div className="trends-tooltip-row trends-tooltip-total">
            <span className="chart-tooltip-dot" style={{ background: '#fff' }} />
            <span className="trends-tooltip-label">TOTAL</span>
            <span className="trends-tooltip-val">{typeTotals[hovered.month].toLocaleString()}</span>
          </div>
          {/* Top types at this month, sorted desc */}
          {visibleTypes
            .map(t => ({ t, v: typeMap.get(t)?.[hovered.month] ?? 0 }))
            .filter(x => x.v > 0)
            .sort((a, b) => b.v - a.v)
            .slice(0, 6)
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
