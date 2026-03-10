/**
 * MonthChart — stacked bar chart for monthly aggregated 311 data.
 * 28-31 bars (one per day), stacked by complaint type.
 * Click a segment to filter feed; click a day label to jump to that day's chart.
 */
import { useEffect, useRef, useCallback } from 'react';
import type { DailyCount } from './complaints';
import { getComplaintColor, getStackOrder } from './complaints';
import type { ChartHit } from './BarChart';

interface Props {
  data: DailyCount[];
  selectedDate: string;
  onHover?: (hit: ChartHit | null, x: number, y: number) => void;
  onSegmentClick?: (hit: ChartHit) => void;
  onDayClick?: (date: string) => void;
}

interface HitRegion {
  x: number; y: number; w: number; h: number;
  type: string; barIdx: number; count: number; totalInBar: number;
}

const FONT       = "700 11px 'Courier New', monospace";
const LABEL_FONT = "600 10px 'Courier New', monospace";
const PAD_L = 58;
const PAD_R = 28;
const PAD_T = 32;
const PAD_B = 56;

export function MonthChart({ data, selectedDate, onHover, onSegmentClick, onDayClick }: Props) {
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const containerRef   = useRef<HTMLDivElement>(null);
  const hitRegionsRef  = useRef<HitRegion[]>([]);

  const d = new Date(selectedDate + 'T12:00:00');
  const numBars = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

  const typeTotals = new Map<string, number>();
  for (const row of data) typeTotals.set(row.complaint_type, (typeTotals.get(row.complaint_type) ?? 0) + row.count);
  const typeOrder = getStackOrder(typeTotals);

  const buckets: Map<string, number>[] = Array.from({ length: numBars }, () => new Map());
  for (const row of data) {
    const day = parseInt(row.day.split('-')[2], 10) - 1;
    if (day < 0 || day >= numBars) continue;
    buckets[day].set(row.complaint_type, (buckets[day].get(row.complaint_type) ?? 0) + row.count);
  }

  const totals = buckets.map(b => [...b.values()].reduce((a, v) => a + v, 0));
  const rawMax = Math.max(...totals, 1);
  const yMax   = niceMax(rawMax);

  useEffect(() => {
    const canvas    = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const W = container.clientWidth  || 600;
    const H = container.clientHeight || 400;
    canvas.width  = W;
    canvas.height = H;

    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#010408';
    ctx.fillRect(0, 0, W, H);

    const chartW = W - PAD_L - PAD_R;
    const chartH = H - PAD_T - PAD_B;
    const slotW  = chartW / numBars;
    const barW   = slotW * 0.60;
    const barOff = (slotW - barW) / 2;

    ctx.font      = LABEL_FONT;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = Math.round((yMax / 4) * i);
      const y   = PAD_T + chartH - (val / yMax) * chartH;
      ctx.strokeStyle = i === 0 ? 'rgba(0,200,220,0.25)' : 'rgba(0,200,220,0.18)';
      ctx.lineWidth   = i === 0 ? 1 : 0.75;
      ctx.beginPath(); ctx.moveTo(PAD_L - 4, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
      ctx.fillStyle = 'rgba(0,210,230,0.65)';
      ctx.fillText(val.toLocaleString(), PAD_L - 8, y + 4);
    }

    const newHits: HitRegion[] = [];
    for (let i = 0; i < numBars; i++) {
      const bucket = buckets[i];
      if (totals[i] === 0) continue;
      const x = PAD_L + i * slotW + barOff;
      let stackY = PAD_T + chartH;
      for (const type of typeOrder) {
        const count = bucket.get(type) ?? 0;
        if (count === 0) continue;
        const bh = (count / yMax) * chartH;
        stackY -= bh;
        ctx.globalAlpha = 0.82;
        ctx.fillStyle   = getComplaintColor(type);
        ctx.fillRect(x, stackY, barW, Math.max(bh, 1));
        ctx.globalAlpha = 0.2;
        ctx.fillStyle   = '#fff';
        ctx.fillRect(x, stackY, barW, 0.8);
        newHits.push({ x, y: stackY, w: barW, h: Math.max(bh, 2), type, barIdx: i, count, totalInBar: totals[i] });
      }
      ctx.globalAlpha = 1;
    }
    hitRegionsRef.current = newHits;

    ctx.strokeStyle = 'rgba(0,200,220,0.2)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T + chartH);
    ctx.lineTo(W - PAD_R, PAD_T + chartH);
    ctx.stroke();

    // X-axis day labels — highlighted to hint clickability
    ctx.font      = LABEL_FONT;
    ctx.textAlign = 'center';
    for (let i = 0; i < numBars; i++) {
      const x = PAD_L + i * slotW + slotW / 2;
      ctx.fillStyle = onDayClick ? 'rgba(0,210,230,0.85)' : 'rgba(0,210,230,0.6)';
      ctx.fillText(`${i + 1}`, x, PAD_T + chartH + 16);
    }

    ctx.font      = FONT;
    ctx.fillStyle = 'rgba(0,200,220,0.3)';
    ctx.textAlign = 'center';
    ctx.fillText(
      onDayClick ? 'DAY OF MONTH  ·  click day to open  ·  click bar to filter feed' : 'DAY OF MONTH  ·  click segment to filter feed',
      PAD_L + chartW / 2, H - 8
    );
  }, [data, selectedDate]);

  const hitTest = useCallback((e: React.MouseEvent<HTMLCanvasElement>): ChartHit | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top)  * scaleY;
    const regions = hitRegionsRef.current;
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h)
        return { type: r.type, barIdx: r.barIdx, count: r.count, totalInBar: r.totalInBar };
    }
    return null;
  }, []);

  // Hit-test the day label area (below baseline)
  const hitTestDayLabel = useCallback((e: React.MouseEvent<HTMLCanvasElement>): number | null => {
    if (!onDayClick) return null;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return null;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top)  * scaleY;
    const W = container.clientWidth || 600;
    const H = container.clientHeight || 400;
    const chartW = W - PAD_L - PAD_R;
    const chartH = H - PAD_T - PAD_B;
    const labelY = PAD_T + chartH + 8;
    if (my < labelY || my > labelY + 20) return null;
    const slotW = chartW / numBars;
    const barIdx = Math.floor((mx - PAD_L) / slotW);
    if (barIdx < 0 || barIdx >= numBars) return null;
    return barIdx;
  }, [onDayClick, numBars]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const dayIdx = hitTestDayLabel(e);
    if (dayIdx !== null && onDayClick) {
      const date = new Date(selectedDate + 'T12:00:00');
      const target = new Date(date.getFullYear(), date.getMonth(), dayIdx + 1);
      const iso = target.toISOString().split('T')[0];
      onDayClick(iso);
      return;
    }
    const h = hitTest(e);
    if (h) onSegmentClick?.(h);
  }, [hitTestDayLabel, hitTest, onDayClick, onSegmentClick, selectedDate]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const dayIdx = hitTestDayLabel(e);
    if (dayIdx !== null) {
      if (canvasRef.current) canvasRef.current.style.cursor = 'pointer';
      onHover?.(null, 0, 0);
      return;
    }
    if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair';
    onHover?.(hitTest(e), e.clientX, e.clientY);
  }, [hitTestDayLabel, hitTest, onHover]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      <canvas ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => onHover?.(null, 0, 0)}
        onClick={handleClick}
      />
    </div>
  );
}

function niceMax(val: number): number {
  if (val <= 0) return 100;
  const mag  = Math.pow(10, Math.floor(Math.log10(val)));
  const nice = [1, 2, 2.5, 5, 10];
  for (const n of nice) {
    const c = Math.ceil(val / (mag * n)) * (mag * n);
    if (c >= val) return c;
  }
  return Math.ceil(val / mag) * mag;
}
