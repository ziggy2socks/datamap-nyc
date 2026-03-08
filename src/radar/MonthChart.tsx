/**
 * MonthChart — stacked bar chart for monthly aggregated 311 data.
 * 28-31 bars (one per day), stacked by complaint type.
 * Click a bar to drill into that day.
 */
import { useEffect, useRef, useCallback } from 'react';
import type { DailyCount } from './complaints';
import { getComplaintColor } from './complaints';

interface Props {
  data: DailyCount[];
  selectedDate: string; // YYYY-MM-DD (any day in the month)
  onDrillDay: (dateStr: string) => void;
}

const FONT       = "700 11px 'Courier New', monospace";
const LABEL_FONT = "600 10px 'Courier New', monospace";
const PAD_L = 58;
const PAD_R = 28;
const PAD_T = 32;
const PAD_B = 56;

export function MonthChart({ data, selectedDate, onDrillDay }: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Pre-compute for render
  const d = new Date(selectedDate + 'T12:00:00');
  const numBars = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

  // Global type order (most frequent on bottom)
  const typeTotals = new Map<string, number>();
  for (const row of data) typeTotals.set(row.complaint_type, (typeTotals.get(row.complaint_type) ?? 0) + row.count);
  const typeOrder = [...typeTotals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);

  // Bucket by day-of-month (1-indexed → 0-indexed bar)
  const buckets: Map<string, number>[] = Array.from({ length: numBars }, () => new Map());
  for (const row of data) {
    const day = parseInt(row.day.split('-')[2], 10) - 1;
    if (day < 0 || day >= numBars) continue;
    buckets[day].set(row.complaint_type, (buckets[day].get(row.complaint_type) ?? 0) + row.count);
  }
  const totals = buckets.map(b => [...b.values()].reduce((a, v) => a + v, 0));
  const rawMax = Math.max(...totals, 1);
  const yMax   = niceMax(rawMax);

  // Draw
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

    // Y-axis grid
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

    // Bars
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
        ctx.fillRect(x, stackY, barW, bh);
        ctx.globalAlpha = 0.2;
        ctx.fillStyle   = '#fff';
        ctx.fillRect(x, stackY, barW, 0.8);
      }
      ctx.globalAlpha = 1;
    }

    // Baseline
    ctx.strokeStyle = 'rgba(0,200,220,0.2)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T + chartH);
    ctx.lineTo(W - PAD_R, PAD_T + chartH);
    ctx.stroke();

    // X-axis labels (every day)
    ctx.font      = LABEL_FONT;
    ctx.fillStyle = 'rgba(0,210,230,0.6)';
    ctx.textAlign = 'center';
    for (let i = 0; i < numBars; i++) {
      const x = PAD_L + i * slotW + slotW / 2;
      ctx.fillText(`${i + 1}`, x, PAD_T + chartH + 16);
    }

    // Axis label + hint
    ctx.font      = FONT;
    ctx.fillStyle = 'rgba(0,200,220,0.3)';
    ctx.textAlign = 'center';
    ctx.fillText('DAY OF MONTH  ·  click to drill into day', PAD_L + chartW / 2, H - 8);

    // Total
    const total = totals.reduce((a, v) => a + v, 0);
    ctx.fillStyle = 'rgba(0,220,240,0.55)';
    ctx.textAlign = 'right';
    ctx.fillText(`${total.toLocaleString()} REPORTS`, W - PAD_R, PAD_T - 10);

  }, [data, selectedDate]);

  // Click → drill to that day
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const cx     = (e.clientX - rect.left) * scaleX;
    const chartW = canvas.width - PAD_L - PAD_R;
    const slotW  = chartW / numBars;
    const barIdx = Math.floor((cx - PAD_L) / slotW);
    if (barIdx < 0 || barIdx >= numBars) return;

    const d2     = new Date(selectedDate + 'T12:00:00');
    const clicked = new Date(d2.getFullYear(), d2.getMonth(), barIdx + 1);
    const iso    = clicked.toISOString().split('T')[0];
    onDrillDay(iso);
  }, [selectedDate, numBars, onDrillDay]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      <canvas ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', cursor: 'pointer' }}
        onClick={handleClick} />
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
