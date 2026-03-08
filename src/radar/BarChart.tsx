import { useEffect, useRef } from 'react';
import type { Complaint } from './complaints';
import { getComplaintColor } from './complaints';

interface Props {
  complaints: Complaint[];
  mode: 'day' | 'month';
  selectedDate: string; // YYYY-MM-DD
}

const FONT = "700 11px 'Courier New', monospace";
const LABEL_FONT = "600 10px 'Courier New', monospace";
const PAD_L = 58;
const PAD_R = 28;
const PAD_T = 32;
const PAD_B = 56;

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

    // ── Step 1: compute global type order (by total volume across all bars)
    // This gives consistent stacking — same color always in same vertical lane
    const typeTotals = new Map<string, number>();
    for (const c of complaints) {
      const t = c.complaint_type;
      typeTotals.set(t, (typeTotals.get(t) ?? 0) + 1);
    }
    // Ordered: most frequent first (bottom of stack)
    const typeOrder = [...typeTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(e => e[0]);

    // ── Step 2: bucket by bar index, keyed by type name
    const buckets: Map<string, number>[] = Array.from({ length: numBars }, () => new Map());
    for (const c of complaints) {
      const d = new Date(c.created_date);
      const idx = mode === 'day' ? d.getHours() : d.getDate() - 1;
      if (idx < 0 || idx >= numBars) continue;
      buckets[idx].set(c.complaint_type, (buckets[idx].get(c.complaint_type) ?? 0) + 1);
    }

    const totals = buckets.map(b => [...b.values()].reduce((a, v) => a + v, 0));
    const maxTotal = Math.max(...totals, 1);
    const yMax = niceMax(maxTotal);
    const yTicks = 4;

    // Bar geometry — narrower bars with more breathing room
    const slotW = chartW / numBars;
    const barW = slotW * 0.52;
    const barOffset = (slotW - barW) / 2;

    // ── Y-axis grid + labels
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'right';
    for (let i = 0; i <= yTicks; i++) {
      const val = Math.round((yMax / yTicks) * i);
      const y = PAD_T + chartH - (val / yMax) * chartH;
      ctx.strokeStyle = i === 0 ? 'rgba(0,200,220,0.25)' : 'rgba(0,200,220,0.18)';
      ctx.lineWidth = i === 0 ? 1 : 0.75;
      ctx.beginPath();
      ctx.moveTo(PAD_L - 4, y);
      ctx.lineTo(W - PAD_R, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,210,230,0.65)';
      ctx.fillText(val.toLocaleString(), PAD_L - 8, y + 4);
    }

    // ── Draw bars (consistent type order — bottom to top = highest to lowest volume globally)
    for (let i = 0; i < numBars; i++) {
      const x = PAD_L + i * slotW + barOffset;
      const bucket = buckets[i];
      if ([...bucket.values()].reduce((a, v) => a + v, 0) === 0) continue;

      let stackY = PAD_T + chartH; // start from baseline, go up

      // Draw in global type order (most frequent type at bottom)
      for (const type of typeOrder) {
        const count = bucket.get(type) ?? 0;
        if (count === 0) continue;
        const barH = (count / yMax) * chartH;
        stackY -= barH;
        const color = getComplaintColor(type);

        ctx.globalAlpha = 0.82;
        ctx.fillStyle = color;
        ctx.fillRect(x, stackY, barW, barH);

        // Subtle top edge highlight
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = '#fff';
        ctx.fillRect(x, stackY, barW, 0.8);
      }
      ctx.globalAlpha = 1;
    }

    // ── X-axis baseline
    ctx.strokeStyle = 'rgba(0,200,220,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T + chartH);
    ctx.lineTo(W - PAD_R, PAD_T + chartH);
    ctx.stroke();

    // ── X-axis labels — every bar
    ctx.font = LABEL_FONT;
    ctx.fillStyle = 'rgba(0,210,230,0.6)';
    ctx.textAlign = 'center';
    for (let i = 0; i < numBars; i++) {
      const x = PAD_L + i * slotW + slotW / 2;
      const label = mode === 'day' ? `${String(i).padStart(2, '0')}` : `${i + 1}`;
      ctx.fillText(label, x, PAD_T + chartH + 16);
    }

    // ── Axis label
    ctx.font = FONT;
    ctx.fillStyle = 'rgba(0,200,220,0.3)';
    ctx.textAlign = 'center';
    ctx.fillText(mode === 'day' ? 'HOUR OF DAY' : 'DAY OF MONTH', PAD_L + chartW / 2, H - 8);

    // ── Total count + legend note top-right
    const total = totals.reduce((a, v) => a + v, 0);
    ctx.font = FONT;
    ctx.fillStyle = 'rgba(0,220,240,0.55)';
    ctx.textAlign = 'right';
    ctx.fillText(`${total.toLocaleString()} REPORTS`, W - PAD_R, PAD_T - 10);

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
