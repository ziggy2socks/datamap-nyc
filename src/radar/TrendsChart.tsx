import { useRef, useEffect, useCallback, useState } from 'react';
import { getComplaintColor } from './complaints';
import type { MonthCount } from './complaints';

interface MonthClickRow { type: string; count: number; }

interface Props {
  data: MonthCount[];
  allYearsData?: Map<number, MonthCount[]>;
  year: number;
  showAll: boolean;
  topTypes: string[];
  activeTypes: Set<string>;
  cutoffMonth?: number;
  showTotal: boolean;
  compareYears: boolean;
  showAllYears: boolean;         // ALL mode: continuous multi-year timeline
  onMonthClick?: (month: number, rows: MonthClickRow[]) => void;
  onMonthJump?: (month: number) => void;
}

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const PAD = { t: 36, r: 24, b: 36, l: 52 };

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

interface PeakMarker {
  type: string;
  month: number;
  yearOfPeak: number;
  value: number;
  x: number;
  y: number;
}

export function TrendsChart({
  data, allYearsData, year, showAll, topTypes, activeTypes,
  cutoffMonth, showTotal, compareYears, showAllYears, onMonthClick, onMonthJump
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peakMarkersRef = useRef<PeakMarker[]>([]);
  const [hovered, setHovered] = useState<{ month: number; x: number; y: number } | null>(null);
  const [hoveredType, setHoveredType] = useState<string | null>(null);
  const [hoveredPeak, setHoveredPeak] = useState<PeakMarker | null>(null);

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
    const visibleTypes = topTypes.filter(t => activeTypes.has(t));
    const typeMap    = buildTypeMap(data, effectiveCutoff);
    const typeTotals = buildMonthTotals(data, effectiveCutoff);

    // ── ALL-YEARS CONTINUOUS MODE ──────────────────────────────────────
    if (showAllYears && allYearsData && allYearsData.size > 0) {
      // Build sorted year list, each with its own cutoff
      const sortedYears = [...allYearsData.keys()].sort((a, b) => a - b);
      const yearCutoffs = new Map<number, number>();
      for (const yr of sortedYears) {
        yearCutoffs.set(yr, yr < year ? 11 : (yr === year ? effectiveCutoff : -1));
      }
      // Filter out years with no data
      const activeYears = sortedYears.filter(yr => (yearCutoffs.get(yr) ?? -1) >= 0);
      const totalPoints = activeYears.reduce((s, yr) => s + (yearCutoffs.get(yr)! + 1), 0);

      // Build per-type continuous value arrays
      const buildAllYearsVals = (type: string): number[] => {
        const vals: number[] = [];
        for (const yr of activeYears) {
          const cut = yearCutoffs.get(yr)!;
          const yd = allYearsData.get(yr) ?? [];
          const tm = buildTypeMap(yd, cut);
          const tv = tm.get(type) ?? new Array(12).fill(0);
          for (let m = 0; m <= cut; m++) vals.push(tv[m]);
        }
        return vals;
      };
      const buildAllYearsTotals = (): number[] => {
        const vals: number[] = [];
        for (const yr of activeYears) {
          const cut = yearCutoffs.get(yr)!;
          const yd = allYearsData.get(yr) ?? [];
          const tv = buildMonthTotals(yd, cut);
          for (let m = 0; m <= cut; m++) vals.push(tv[m]);
        }
        return vals;
      };

      const allTotals = buildAllYearsTotals();
      let yMax2 = showTotal ? Math.max(...allTotals, 1) : 1;
      if (!showTotal) {
        for (const type of visibleTypes) {
          const vals = buildAllYearsVals(type);
          yMax2 = Math.max(yMax2, ...vals);
        }
      }

      const xForPt = (i: number) => PAD.l + (i / (totalPoints - 1)) * chartW;
      const yForV  = (v: number) => PAD.t + chartH - (v / yMax2) * chartH;

      // grid
      ctx.strokeStyle = 'rgba(0,200,220,0.08)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = PAD.t + (i / 4) * chartH;
        ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + chartW, y); ctx.stroke();
      }
      // y labels
      ctx.fillStyle = 'rgba(0,200,220,0.35)';
      ctx.font = `600 8px var(--font, monospace)`;
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        const val = Math.round((yMax2 * (4 - i)) / 4);
        const y = PAD.t + (i / 4) * chartH;
        ctx.fillText(val >= 10000 ? `${Math.round(val / 1000)}k` : val.toLocaleString(), PAD.l - 6, y + 3);
      }

      // year boundary ticks + labels
      let ptIdx = 0;
      for (const yr of activeYears) {
        const x = xForPt(ptIdx);
        ctx.save();
        ctx.strokeStyle = 'rgba(0,200,220,0.2)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + chartH); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(0,200,220,0.5)';
        ctx.font = `700 8px var(--font, monospace)`;
        ctx.textAlign = 'center';
        ctx.fillText(String(yr), x, H - 8);
        ctx.restore();
        ptIdx += yearCutoffs.get(yr)! + 1;
      }

      // type lines
      for (const type of visibleTypes) {
        const vals = buildAllYearsVals(type);
        const color = getComplaintColor(type);
        const isHov = hoveredType === type;
        const isDim = hoveredType !== null && !isHov;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = isDim ? 0.06 : isHov ? 1 : 0.4;
        ctx.lineWidth = isHov ? 2 : 1;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (let i = 0; i < vals.length; i++) {
          const x = xForPt(i); const y = yForV(vals[i]);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      }

      // total line
      if (showTotal) {
        ctx.save();
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = hoveredType ? 0.3 : 0.75;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (let i = 0; i < allTotals.length; i++) {
          const x = xForPt(i); const y = yForV(allTotals[i]);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      }

      return; // done with ALL mode
    }
    // ── END ALL-YEARS MODE ─────────────────────────────────────────────

    // yMax: in normal mode without total line, scale to visible type lines only
    let yMax: number;
    if (compareYears) {
      yMax = Math.max(...typeTotals.slice(0, effectiveCutoff + 1), 1);
      if (allYearsData) {
        for (const [yr, yd] of allYearsData) {
          const cut = yr < year ? 11 : effectiveCutoff;
          const t = buildMonthTotals(yd, cut);
          yMax = Math.max(yMax, ...t.slice(0, cut + 1));
        }
      }
    } else if (showTotal) {
      yMax = Math.max(...typeTotals.slice(0, effectiveCutoff + 1), 1);
    } else {
      // scale to the visible type lines, not the (hidden) total
      let typeMax = 1;
      for (const type of visibleTypes) {
        const vals = typeMap.get(type) ?? new Array(12).fill(0);
        typeMax = Math.max(typeMax, ...vals.slice(0, effectiveCutoff + 1));
      }
      yMax = typeMax;
    }

    const xForMonth = (m: number) => PAD.l + (m / 11) * chartW;
    const yForVal   = (v: number) => PAD.t + chartH - (v / yMax) * chartH;

    // grid
    ctx.strokeStyle = 'rgba(0,200,220,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = PAD.t + (i / 4) * chartH;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + chartW, y); ctx.stroke();
    }

    // y labels
    ctx.fillStyle = 'rgba(0,200,220,0.35)';
    ctx.font = `600 8px var(--font, monospace)`;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = Math.round((yMax * (4 - i)) / 4);
      const y   = PAD.t + (i / 4) * chartH;
      ctx.fillText(val >= 10000 ? `${Math.round(val / 1000)}k` : val.toLocaleString(), PAD.l - 6, y + 3);
    }

    // x labels — brighter to hint clickability
    ctx.textAlign = 'center';
    for (let m = 0; m < 12; m++) {
      const x = xForMonth(m);
      const isPast = m > effectiveCutoff;
      const isHov  = hovered?.month === m;
      ctx.fillStyle = isPast
        ? 'rgba(0,200,220,0.12)'
        : isHov ? 'rgba(0,200,220,1)' : 'rgba(0,200,220,0.5)';
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

    // compare years mode
    if (compareYears && allYearsData) {
      const avgTotals = new Array(12).fill(0);
      const avgCount  = new Array(12).fill(0);

      for (const [yr, yd] of allYearsData) {
        if (yr === year) continue;
        // Each year uses its own cutoff: past years full (11), current year uses effectiveCutoff
        const cut = yr < year ? 11 : effectiveCutoff;
        const yt = buildMonthTotals(yd, cut);
        const color = YEAR_COLORS[yr] ?? '#888888';
        drawLine(yt, color, 0.3, 1, false, cut);
        for (let m = 0; m <= cut; m++) {
          avgTotals[m] += yt[m];
          avgCount[m]++;
        }
        // year label at last valid data point
        ctx.save();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.4;
        ctx.font = `600 7px var(--font, monospace)`;
        ctx.textAlign = 'right';
        ctx.fillText(String(yr), xForMonth(cut) - 2, yForVal(yt[cut]) - 3);
        ctx.restore();
      }

      // current year line — stops at effectiveCutoff, never beyond
      const curColor = YEAR_COLORS[year] ?? '#ffffff';
      drawLine(typeTotals, curColor, 0.9, 2, false, effectiveCutoff);
      ctx.save();
      ctx.fillStyle = curColor;
      ctx.globalAlpha = 0.9;
      ctx.font = `700 7px var(--font, monospace)`;
      ctx.textAlign = 'right';
      ctx.fillText(String(year), xForMonth(effectiveCutoff) - 2, yForVal(typeTotals[effectiveCutoff]) - 3);
      ctx.restore();

      // avg line
      const avgVals = avgTotals.map((t, m) => avgCount[m] > 0 ? t / avgCount[m] : 0);
      drawLine(avgVals, '#ffffff', 0.4, 1.5, true, 11);
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.4;
      ctx.font = `600 7px var(--font, monospace)`;
      ctx.textAlign = 'right';
      ctx.fillText('AVG', xForMonth(11) - 2, yForVal(avgVals[11]) - 5);
      ctx.restore();
    } else {
      // normal trends mode — type lines
      for (const type of visibleTypes) {
        const vals  = typeMap.get(type) ?? new Array(12).fill(0);
        const color = getComplaintColor(type);
        const isHov = hoveredType === type;
        const isDim = hoveredType !== null && !isHov;
        drawLine(vals, color, isDim ? 0.08 : isHov ? 1 : 0.45, isHov ? 2 : 1, false, effectiveCutoff);
      }

      // total line (optional)
      if (showTotal) {
        drawLine(typeTotals, '#ffffff', hoveredType ? 0.3 : 0.75, 1.5, false, effectiveCutoff);
      }

      // peak markers — one per type, highest month across all years
      const newMarkers: PeakMarker[] = [];
      if (allYearsData && allYearsData.size > 0) {
        for (const type of visibleTypes) {
          let peakVal = -Infinity;
          let peakMonth = 0;
          let peakYear = year;

          // check all years
          for (const [yr, yd] of allYearsData) {
            const cut = yr === year ? effectiveCutoff : 11;
            const tmap = buildTypeMap(yd, cut);
            const vals = tmap.get(type) ?? new Array(12).fill(0);
            for (let m = 0; m <= cut; m++) {
              if (vals[m] > peakVal) {
                peakVal = vals[m];
                peakMonth = m;
                peakYear = yr;
              }
            }
          }

          if (peakVal <= 0) continue;

          // get position using the correct year's data
          // only draw if peak is on current year's line (month within cutoff)
          // We draw peak relative to current year typeMap position if same month exists
          const currentVals = typeMap.get(type) ?? new Array(12).fill(0);
          const drawMonth = peakYear === year ? peakMonth : -1;
          if (drawMonth < 0 || drawMonth > effectiveCutoff) continue;

          const x = xForMonth(drawMonth);
          const y = yForVal(currentVals[drawMonth]);
          newMarkers.push({ type, month: peakMonth, yearOfPeak: peakYear, value: peakVal, x, y });
        }

        // Draw markers
        for (const marker of newMarkers) {
          const isHov = hoveredPeak?.type === marker.type;
          const color = getComplaintColor(marker.type);
          ctx.save();
          ctx.strokeStyle = color;
          ctx.fillStyle = '#020810';
          ctx.lineWidth = isHov ? 2 : 1.5;
          ctx.globalAlpha = isHov ? 1 : 0.75;
          ctx.beginPath();
          ctx.arc(marker.x, marker.y, isHov ? 5 : 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          // small tick above
          ctx.strokeStyle = color;
          ctx.globalAlpha = isHov ? 0.8 : 0.4;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(marker.x, marker.y - (isHov ? 6 : 4));
          ctx.lineTo(marker.x, marker.y - (isHov ? 12 : 7));
          ctx.stroke();
          ctx.restore();
        }
        peakMarkersRef.current = newMarkers;
      } else {
        peakMarkersRef.current = [];
      }
    }

    // cutoff marker
    if (effectiveCutoff < 11) {
      const cx = xForMonth(effectiveCutoff);
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      const nextX = xForMonth(effectiveCutoff + 0.5);
      ctx.fillRect(nextX, PAD.t, xForMonth(11) + 24 - nextX, chartH);
      ctx.strokeStyle = 'rgba(0,200,220,0.4)';
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, PAD.t); ctx.lineTo(cx, PAD.t + chartH); ctx.stroke();
      ctx.fillStyle = 'rgba(0,200,220,0.4)';
      ctx.font = `600 7px var(--font, monospace)`;
      ctx.textAlign = 'left';
      ctx.setLineDash([]);
      ctx.fillText('DATA ENDS', cx + 4, PAD.t + 10);
      ctx.restore();
    }

    // hover dots
    if (hovered && hovered.month <= effectiveCutoff) {
      const m = hovered.month;
      if (!compareYears) {
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
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = compareYears ? (YEAR_COLORS[year] ?? '#ffffff') : '#ffffff';
      ctx.beginPath();
      ctx.arc(xForMonth(m), yForVal(typeTotals[m]), 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }, [data, allYearsData, topTypes, showAll, activeTypes, hovered, hoveredType, hoveredPeak, effectiveCutoff, year, showTotal, compareYears]);

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

  // Hit-test the x-axis label row (bottom strip) for month-jump clicks
  const hitTestMonthLabel = useCallback((e: React.MouseEvent<HTMLCanvasElement>): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const H = canvas.clientHeight;
    if (my < H - PAD.b || my > H) return null;  // only in label strip
    const chartW = canvas.clientWidth - PAD.l - PAD.r;
    const rel = (mx - PAD.l) / chartW;
    if (rel < -0.05 || rel > 1.05) return null;
    const m = Math.max(0, Math.min(11, Math.round(rel * 11)));
    return m <= effectiveCutoff ? m : null;
  }, [effectiveCutoff]);

  const hitTestType = useCallback((e: React.MouseEvent<HTMLCanvasElement>): string | null => {
    if (compareYears || data.length === 0) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect    = canvas.getBoundingClientRect();
    const mx      = e.clientX - rect.left;
    const my      = e.clientY - rect.top;
    const W       = canvas.clientWidth;
    const H       = canvas.clientHeight;
    const chartW  = W - PAD.l - PAD.r;
    const chartH  = H - PAD.t - PAD.b;
    const typeMap2 = buildTypeMap(data, effectiveCutoff);
    const totals2  = buildMonthTotals(data, effectiveCutoff);
    const yMax2    = Math.max(...totals2, 1);
    const visible  = topTypes.filter(t => activeTypes.has(t));
    let closest: string | null = null;
    let closestDist = 14;
    for (const type of visible) {
      const vals = typeMap2.get(type) ?? new Array(12).fill(0);
      for (let m = 0; m <= effectiveCutoff; m++) {
        const x = PAD.l + (m / 11) * chartW;
        const y = PAD.t + chartH - (vals[m] / yMax2) * chartH;
        const dist = Math.hypot(mx - x, my - y);
        if (dist < closestDist) { closestDist = dist; closest = type; }
      }
    }
    return closest;
  }, [data, topTypes, showAll, activeTypes, effectiveCutoff, compareYears]);

  const hitTestPeak = useCallback((e: React.MouseEvent<HTMLCanvasElement>): PeakMarker | null => {
    if (compareYears) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let closest: PeakMarker | null = null;
    let closestDist = 12;
    for (const marker of peakMarkersRef.current) {
      const distCss = Math.hypot(mx - marker.x, my - marker.y);
      if (distCss < closestDist) { closestDist = distCss; closest = marker; }
    }
    return closest;
  }, [compareYears]);

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const peak = hitTestPeak(e);
    setHoveredPeak(peak);
    const m = hitTestMonth(e);
    const t = hitTestType(e);
    setHovered(m !== null ? { month: m, x: e.clientX, y: e.clientY } : null);
    setHoveredType(t);
  };
  const onMouseLeave = () => { setHovered(null); setHoveredType(null); setHoveredPeak(null); };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Click on month label strip → jump to month chart
    const labelM = hitTestMonthLabel(e);
    if (labelM !== null && onMonthJump) {
      onMonthJump(labelM);
      return;
    }
    // Click on chart area → breakdown feed
    const m = hitTestMonth(e);
    if (m === null || !onMonthClick) return;
    const typeMap2 = buildTypeMap(data, effectiveCutoff);
    const visible  = topTypes.filter(t => activeTypes.has(t));
    const rows = visible
      .map(t => ({ type: t, count: typeMap2.get(t)?.[m] ?? 0 }))
      .filter(r => r.count > 0)
      .sort((a, b) => b.count - a.count);
    onMonthClick(m, rows);
  };

  const typeMap    = buildTypeMap(data, effectiveCutoff);
  const typeTotals = buildMonthTotals(data, effectiveCutoff);

  return (
    <div className="trends-wrap">
      <canvas
        ref={canvasRef}
        className="trends-canvas"
        style={{ cursor: hovered || hoveredPeak ? 'pointer' : 'default' }}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
      />
      {/* Hover tooltip — minimal: just type + count, or peak info */}
      {hoveredPeak && (
        <div className="chart-tooltip trends-tooltip" style={{ left: hoveredPeak.x + 14, top: hoveredPeak.y - 28 }}>
          <div className="chart-tooltip-bar">5Y PEAK · {MONTHS[hoveredPeak.month]} {hoveredPeak.yearOfPeak}</div>
          <div className="trends-tooltip-row">
            <span className="chart-tooltip-dot" style={{ background: getComplaintColor(hoveredPeak.type) }} />
            <span className="trends-tooltip-label">{hoveredPeak.type}</span>
            <span className="trends-tooltip-val">{hoveredPeak.value.toLocaleString()}</span>
          </div>
        </div>
      )}
      {hovered && !hoveredPeak && (
        <div className="chart-tooltip trends-tooltip" style={{ left: hovered.x + 14, top: hovered.y - 12 }}>
          <div className="chart-tooltip-bar">{MONTHS[hovered.month]} {year} · click for breakdown</div>
          {hoveredType ? (
            <div className="trends-tooltip-row">
              <span className="chart-tooltip-dot" style={{ background: getComplaintColor(hoveredType) }} />
              <span className="trends-tooltip-label">{hoveredType}</span>
              <span className="trends-tooltip-val">{(typeMap.get(hoveredType)?.[hovered.month] ?? 0).toLocaleString()}</span>
            </div>
          ) : (
            <div className="trends-tooltip-row trends-tooltip-total">
              <span className="chart-tooltip-dot" style={{ background: compareYears ? (YEAR_COLORS[year] ?? '#fff') : '#fff' }} />
              <span className="trends-tooltip-label">{compareYears ? String(year) : 'TOTAL'}</span>
              <span className="trends-tooltip-val">{typeTotals[hovered.month].toLocaleString()}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
