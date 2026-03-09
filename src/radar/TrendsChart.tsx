import { useRef, useEffect, useCallback, useState } from 'react';
import type { MonthCount } from './complaints';

interface MonthClickRow { type: string; count: number; }

interface Props {
  data: MonthCount[];
  allYearsData?: Map<number, MonthCount[]>;
  year: number;
  cutoffMonth?: number;
  onMonthClick?: (month: number, rows: MonthClickRow[]) => void;
}

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const PAD = { t: 28, r: 20, b: 36, l: 52 };

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

function buildMonthBreakdown(data: MonthCount[], month: number): MonthClickRow[] {
  return data
    .filter(r => r.month === month)
    .map(r => ({ type: r.complaint_type, count: r.count }))
    .sort((a, b) => b.count - a.count);
}

interface MonthFlag {
  month: number;
  label: string;
  sublabel?: string;
}

export function TrendsChart({ data, allYearsData, year, cutoffMonth, onMonthClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState<{ month: number; x: number; y: number } | null>(null);

  const effectiveCutoff = cutoffMonth !== undefined ? cutoffMonth : 11;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const chartW = W - PAD.l - PAD.r;
    const chartH = H - PAD.t - PAD.b;
    const currentTotals = buildMonthTotals(data, effectiveCutoff);

    const comparisonYears = allYearsData
      ? [...allYearsData.entries()].sort((a, b) => a[0] - b[0])
      : [[year, data] as [number, MonthCount[]]];

    let yMax = Math.max(...currentTotals.slice(0, effectiveCutoff + 1), 1);
    const yearTotals = new Map<number, number[]>();
    for (const [yr, yd] of comparisonYears) {
      const cut = yr === year ? effectiveCutoff : 11;
      const totals = buildMonthTotals(yd, cut);
      yearTotals.set(yr, totals);
      yMax = Math.max(yMax, ...totals.slice(0, cut + 1));
    }

    const xForMonth = (m: number) => PAD.l + (m / 11) * chartW;
    const yForVal = (v: number) => PAD.t + chartH - (v / yMax) * chartH;

    // grid
    ctx.strokeStyle = 'rgba(0,200,220,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = PAD.t + (i / 4) * chartH;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(PAD.l + chartW, y);
      ctx.stroke();
    }

    // y labels
    ctx.fillStyle = 'rgba(0,200,220,0.35)';
    ctx.font = `600 8px var(--font, monospace)`;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = Math.round((yMax * (4 - i)) / 4);
      const y = PAD.t + (i / 4) * chartH;
      ctx.fillText(val >= 10000 ? `${Math.round(val / 1000)}k` : val.toLocaleString(), PAD.l - 6, y + 3);
    }

    // x labels
    ctx.textAlign = 'center';
    for (let m = 0; m < 12; m++) {
      const x = xForMonth(m);
      const isPast = m > effectiveCutoff;
      const isHov = hovered?.month === m;
      ctx.fillStyle = isPast
        ? 'rgba(0,200,220,0.12)'
        : isHov ? 'rgba(0,200,220,0.9)' : 'rgba(0,200,220,0.35)';
      ctx.fillText(MONTHS[m], x, H - 8);
      if (isHov && !isPast) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0,200,220,0.2)';
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, PAD.t);
        ctx.lineTo(x, PAD.t + chartH);
        ctx.stroke();
        ctx.restore();
      }
    }

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

    // comparison year lines
    const avgTotals = new Array(12).fill(0);
    const avgCount = new Array(12).fill(0);

    for (const [yr, totals] of yearTotals.entries()) {
      const cut = yr === year ? effectiveCutoff : 11;
      const isSelected = yr === year;
      const color = YEAR_COLORS[yr] ?? '#888888';
      drawLine(totals, color, isSelected ? 0.95 : 0.35, isSelected ? 2.2 : 1.2, false, cut);

      if (yr !== year || cut === 11) {
        for (let m = 0; m <= cut; m++) {
          avgTotals[m] += totals[m];
          avgCount[m]++;
        }
      }

      const labelMonth = cut;
      if (labelMonth >= 0) {
        ctx.save();
        ctx.fillStyle = color;
        ctx.globalAlpha = isSelected ? 0.9 : 0.45;
        ctx.font = `600 7px var(--font, monospace)`;
        ctx.textAlign = 'right';
        ctx.fillText(String(yr), xForMonth(labelMonth) - 2, yForVal(totals[labelMonth]) - 3);
        ctx.restore();
      }
    }

    const avgVals = avgTotals.map((t, m) => avgCount[m] > 0 ? t / avgCount[m] : 0);
    drawLine(avgVals, '#ffffff', 0.45, 1.5, true, 11);

    // average label
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.45;
    ctx.font = `600 7px var(--font, monospace)`;
    ctx.textAlign = 'right';
    ctx.fillText('AVG', xForMonth(11) - 2, yForVal(avgVals[11]) - 3);
    ctx.restore();

    // cutoff marker for incomplete selected year
    if (effectiveCutoff < 11) {
      const cx = xForMonth(effectiveCutoff);
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      const nextX = xForMonth(effectiveCutoff + 0.5);
      ctx.fillRect(nextX, PAD.t, xForMonth(11) + 20 - nextX, chartH);
      ctx.strokeStyle = 'rgba(0,200,220,0.4)';
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, PAD.t);
      ctx.lineTo(cx, PAD.t + chartH);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,200,220,0.4)';
      ctx.font = `600 7px var(--font, monospace)`;
      ctx.textAlign = 'left';
      ctx.setLineDash([]);
      ctx.fillText(`DATA THROUGH ${MONTHS[effectiveCutoff]}`, cx + 4, PAD.t + 10);
      ctx.restore();
    }

    // flags on selected year
    const flags: MonthFlag[] = [];
    let ytdPeakMonth = 0;
    let ytdPeakVal = -Infinity;
    for (let m = 0; m <= effectiveCutoff; m++) {
      const v = currentTotals[m];
      if (v > ytdPeakVal) {
        ytdPeakVal = v;
        ytdPeakMonth = m;
      }

      const historical = comparisonYears
        .filter(([yr]) => yr !== year)
        .map(([yr]) => yearTotals.get(yr)![m])
        .filter(v2 => v2 > 0);
      if (historical.length === 0) continue;

      const maxHist = Math.max(...historical);
      const minHist = Math.min(...historical);
      const avgHist = historical.reduce((s, n) => s + n, 0) / historical.length;
      const deltaPct = avgHist > 0 ? ((v - avgHist) / avgHist) * 100 : 0;

      if (v > maxHist) flags.push({ month: m, label: '5Y HIGH' });
      else if (v < minHist) flags.push({ month: m, label: '5Y LOW' });
      else if (Math.abs(deltaPct) >= 10) flags.push({ month: m, label: deltaPct > 0 ? 'VS AVG +' : 'VS AVG -', sublabel: `${Math.round(Math.abs(deltaPct))}%` });
    }
    flags.push({ month: ytdPeakMonth, label: 'YTD PEAK' });

    const usedFlagMonths = new Set<number>();
    let flip = false;
    for (const flag of flags) {
      if (usedFlagMonths.has(flag.month)) continue;
      usedFlagMonths.add(flag.month);
      const x = xForMonth(flag.month);
      const y = yForVal(currentTotals[flag.month]);
      const offsetY = flip ? -26 : 18;
      flip = !flip;

      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - offsetY);
      ctx.stroke();

      const textY = y - offsetY - 4;
      ctx.font = `700 7px var(--font, monospace)`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(flag.label, x, textY);
      if (flag.sublabel) {
        ctx.font = `600 7px var(--font, monospace)`;
        ctx.fillStyle = 'rgba(0,200,220,0.7)';
        ctx.fillText(flag.sublabel, x, textY + 9);
      }
      ctx.restore();
    }

    // hover dot on selected year
    if (hovered && hovered.month <= effectiveCutoff) {
      const m = hovered.month;
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(xForMonth(m), yForVal(currentTotals[m]), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }, [data, allYearsData, cutoffMonth, effectiveCutoff, hovered, year]);

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
    return m <= effectiveCutoff ? m : null;
  }, [effectiveCutoff]);

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const m = hitTestMonth(e);
    setHovered(m !== null ? { month: m, x: e.clientX, y: e.clientY } : null);
  };

  const onMouseLeave = () => setHovered(null);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const m = hitTestMonth(e);
    if (m === null || !onMonthClick) return;
    onMonthClick(m, buildMonthBreakdown(data, m));
  };

  const currentTotals = buildMonthTotals(data, effectiveCutoff);
  const comparisonYears = allYearsData
    ? [...allYearsData.entries()].sort((a, b) => a[0] - b[0]).map(([yr]) => yr)
    : [year];

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
      {hovered && (
        <div className="chart-tooltip trends-tooltip" style={{ left: hovered.x + 14, top: hovered.y - 12 }}>
          <div className="chart-tooltip-bar">{MONTHS[hovered.month]} {year} · click to load feed</div>
          <div className="trends-tooltip-row trends-tooltip-total">
            <span className="chart-tooltip-dot" style={{ background: YEAR_COLORS[year] ?? '#fff' }} />
            <span className="trends-tooltip-label">{year}</span>
            <span className="trends-tooltip-val">{currentTotals[hovered.month].toLocaleString()}</span>
          </div>
          {comparisonYears.filter(yr => yr !== year).map(yr => {
            const totals = buildMonthTotals(allYearsData?.get(yr) ?? [], 11);
            return (
              <div key={yr} className="trends-tooltip-row">
                <span className="chart-tooltip-dot" style={{ background: YEAR_COLORS[yr] ?? '#888' }} />
                <span className="trends-tooltip-label">{yr}</span>
                <span className="trends-tooltip-val">{totals[hovered.month].toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
