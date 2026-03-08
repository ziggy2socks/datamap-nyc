import { useEffect, useRef } from 'react';
import type { Complaint } from './complaints';
import { getComplaintColor } from './complaints';

interface Props {
  complaints: Complaint[];
  mode: 'day' | 'month';
  selectedDate: string; // YYYY-MM-DD
  onBarClick?: (label: string) => void;
}

const FONT = "700 9px 'Courier New', monospace";
const LABEL_FONT = "600 8px 'Courier New', monospace";
const PAD_L = 52;  // left axis
const PAD_R = 16;
const PAD_T = 24;
const PAD_B = 48;  // bottom labels

export function BarChart({ complaints, mode, selectedDate }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const W = container.clientWidth || 600;
    const H = container.clientHeight || 400;
    canvas.width = W;
    canvas.height = H;

    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#010408';
    ctx.fillRect(0, 0, W, H);

    const numBars = mode === 'day' ? 24 : getDaysInMonth(selectedDate);
    const chartW = W - PAD_L - PAD_R;
    const chartH = H - PAD_T - PAD_B;

    // Bucket complaints by bar index
    const buckets: Map<string, number>[] = Array.from({ length: numBars }, () => new Map());

    for (const c of complaints) {
      const d = new Date(c.created_date);
      const idx = mode === 'day' ? d.getHours() : d.getDate() - 1;
      if (idx < 0 || idx >= numBars) continue;
      const color = getComplaintColor(c.complaint_type);
      buckets[idx].set(color, (buckets[idx].get(color) ?? 0) + 1);
    }

    // Totals per bar
    const totals = buckets.map(b => [...b.values()].reduce((a, v) => a + v, 0));
    const maxTotal = Math.max(...totals, 1);

    // Round up to a nice number for y-axis
    const yMax = niceMax(maxTotal);
    const yTicks = 4;

    const barW = (chartW / numBars) * 0.72;
    const gap  = (chartW / numBars) * 0.28;

    // Draw y-axis grid lines + labels
    ctx.strokeStyle = 'rgba(0,200,220,0.12)';
    ctx.lineWidth = 0.5;
    ctx.font = LABEL_FONT;
    ctx.fillStyle = 'rgba(0,200,220,0.5)';
    ctx.textAlign = 'right';

    for (let i = 0; i <= yTicks; i++) {
      const val = Math.round((yMax / yTicks) * i);
      const y = PAD_T + chartH - (val / yMax) * chartH;
      ctx.beginPath();
      ctx.moveTo(PAD_L - 4, y);
      ctx.lineTo(W - PAD_R, y);
      ctx.stroke();
      ctx.fillText(val.toLocaleString(), PAD_L - 7, y + 3);
    }

    // Draw bars (stacked by complaint type color)
    for (let i = 0; i < numBars; i++) {
      const x = PAD_L + (i / numBars) * chartW + gap / 2;
      const bucket = buckets[i];
      if (bucket.size === 0) continue;

      // Sort colors by count desc so largest segment is at bottom
      const sorted = [...bucket.entries()].sort((a, b) => b[1] - a[1]);
      let stackY = PAD_T + chartH;

      for (const [color, count] of sorted) {
        const barH = (count / yMax) * chartH;
        stackY -= barH;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x, stackY, barW, barH);
        // Top highlight
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, stackY, barW, 1);
      }
      ctx.globalAlpha = 1;
    }

    // X-axis labels
    ctx.font = LABEL_FONT;
    ctx.fillStyle = 'rgba(0,200,220,0.55)';
    ctx.textAlign = 'center';

    const labelEvery = mode === 'day' ? 3 : (numBars <= 28 ? 7 : 5);
    for (let i = 0; i < numBars; i++) {
      if (i % labelEvery !== 0) continue;
      const x = PAD_L + (i / numBars) * chartW + (chartW / numBars) / 2;
      const label = mode === 'day' ? `${String(i).padStart(2, '0')}h` : `${i + 1}`;
      ctx.fillText(label, x, H - PAD_B + 14);
    }

    // X-axis baseline
    ctx.strokeStyle = 'rgba(0,200,220,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T + chartH);
    ctx.lineTo(W - PAD_R, PAD_T + chartH);
    ctx.stroke();

    // Axis label
    ctx.font = FONT;
    ctx.fillStyle = 'rgba(0,200,220,0.35)';
    ctx.textAlign = 'center';
    const axisLabel = mode === 'day' ? 'HOUR OF DAY' : 'DAY OF MONTH';
    ctx.fillText(axisLabel, PAD_L + chartW / 2, H - 6);

    // Total count top-right
    const total = totals.reduce((a, v) => a + v, 0);
    ctx.font = FONT;
    ctx.fillStyle = 'rgba(0,220,240,0.6)';
    ctx.textAlign = 'right';
    ctx.fillText(`${total.toLocaleString()} REPORTS`, W - PAD_R, PAD_T - 6);

  }, [complaints, mode, selectedDate]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  );
}

function getDaysInMonth(dateStr: string): number {
  const d = new Date(dateStr + 'T12:00:00');
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function niceMax(val: number): number {
  if (val <= 0) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(val)));
  const nice = [1, 2, 2.5, 5, 10];
  for (const n of nice) {
    const candidate = Math.ceil(val / (mag * n)) * (mag * n);
    if (candidate >= val) return candidate;
  }
  return Math.ceil(val / mag) * mag;
}
