/**
 * BarChart — stacked bar chart for 311 data with two view modes:
 *   'stack' — y-axis = count, stacked by complaint type (consistent global order)
 *   'time'  — y-axis = minute within hour (0–59), each ticket at its actual timestamp
 *
 * Transitions between modes are animated via canvas interpolation.
 */
import { useEffect, useRef } from 'react';
import type { Complaint } from './complaints';
import { getComplaintColor, getStackOrder } from './complaints';

export type ChartMode = 'stack' | 'time';

export interface ChartHit {
  type: string;
  barIdx: number;  // hour index (0-23) for day chart, day index (0-30) for month chart
  count: number;   // count of this type in this bar
  totalInBar: number; // total complaints in this bar across all types
}

interface Props {
  complaints: Complaint[];
  resolution: 'day' | 'month';
  selectedDate: string;
  chartMode: ChartMode;
  onHover?: (hit: ChartHit | null, x: number, y: number) => void;
  onSegmentClick?: (hit: ChartHit) => void;
}

// Rendered region for hit-testing
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

// Easing — cubic out (fast start, eases to stop)
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// A single rendered "block" — one complaint in one bar
interface Block {
  barIdx: number;
  color: string;
  type: string;     // complaint_type string
  count: number;    // number of complaints this block represents (always 1 in day/time mode)
  // Normalised Y position in [0,1] within the chart height (0=bottom,1=top)
  stackY: number;   // y in stack mode
  timeY:  number;   // y in time mode
  height: number;   // normalised height
}

function buildBlocks(
  complaints: Complaint[],
  numBars: number,
  resolution: 'day' | 'month',
): { blocks: Block[]; yMax: number } {
  // ── Global type order — shared pinned order + volume-sorted remainder
  const typeTotals = new Map<string, number>();
  for (const c of complaints) typeTotals.set(c.complaint_type, (typeTotals.get(c.complaint_type) ?? 0) + 1);
  const typeOrder = getStackOrder(typeTotals);

  // ── Bucket by bar
  const barBuckets: { type: string; minute: number; color: string }[][] =
    Array.from({ length: numBars }, () => []);

  for (const c of complaints) {
    const d = new Date(c.created_date);
    const barIdx = resolution === 'day' ? d.getHours() : d.getDate() - 1;
    if (barIdx < 0 || barIdx >= numBars) continue;
    const minute = d.getMinutes();
    barBuckets[barIdx].push({ type: c.complaint_type, minute, color: getComplaintColor(c.complaint_type) });
  }

  // ── Stack mode: compute Y positions from stacked count layout
  const rawMax = Math.max(...barBuckets.map(b => b.length), 1);
  const yMax = niceMax(rawMax);

  const blocks: Block[] = [];

  for (let i = 0; i < numBars; i++) {
    const bucket = barBuckets[i];
    if (bucket.length === 0) continue;
    const BLOCK_H = 1 / yMax; // normalised height per complaint

    // ── Stack mode Y: group by type in global order, stack bottom-up
    const byType = new Map<string, typeof bucket>();
    for (const item of bucket) {
      if (!byType.has(item.type)) byType.set(item.type, []);
      byType.get(item.type)!.push(item);
    }
    const stackItems: { item: (typeof bucket)[0]; stackY: number }[] = [];
    let cursor = 0;
    for (const type of typeOrder) {
      const group = byType.get(type) ?? [];
      for (const item of group) {
        stackItems.push({ item, stackY: cursor * BLOCK_H });
        cursor++;
      }
    }

    // ── Time mode Y: place by minute, resolve collisions upward
    // Sort by minute ASC — items at same minute stack upward from that position
    const timeItems = [...bucket].sort((a, b) => a.minute - b.minute);
    // Raw Y = minute/60 (0=bottom at min 0, top at min 59)
    const rawY = timeItems.map(item => item.minute / 60);
    // Resolve: if items overlap (each occupies BLOCK_H), nudge upward
    const resolvedY = [...rawY];
    for (let j = 1; j < resolvedY.length; j++) {
      const minY = resolvedY[j - 1] + BLOCK_H;
      if (resolvedY[j] < minY) resolvedY[j] = minY;
    }
    // If stack overflows 1.0, compress the top items downward proportionally
    const topY = resolvedY[resolvedY.length - 1] + BLOCK_H;
    if (topY > 1.0) {
      const overflow = topY - 1.0;
      const scale = (1.0 - rawY[0]) / (topY - rawY[0]);
      for (let j = 0; j < resolvedY.length; j++) {
        resolvedY[j] = rawY[0] + (resolvedY[j] - rawY[0]) * scale;
      }
      void overflow; // suppress unused
    }

    // ── Build Block entries (match stackItems order with timeItems by sorting together)
    // Stack order: typeOrder groups. Time order: sorted by minute.
    // For animation we need a stable pairing — pair by index within a type group.
    // Strategy: for each type, pair stack positions with time positions sorted by minute.
    const typeStackMap = new Map<string, number[]>(); // type → array of stackY values
    for (const { item, stackY } of stackItems) {
      if (!typeStackMap.has(item.type)) typeStackMap.set(item.type, []);
      typeStackMap.get(item.type)!.push(stackY);
    }
    const typeTimePosMap = new Map<string, number[]>(); // type → sorted resolvedY values
    for (let j = 0; j < timeItems.length; j++) {
      const t = timeItems[j].type;
      if (!typeTimePosMap.has(t)) typeTimePosMap.set(t, []);
      typeTimePosMap.get(t)!.push(resolvedY[j]);
    }

    // Now emit blocks: for each type in global order, zip stack and time positions
    for (const type of typeOrder) {
      const sYs = typeStackMap.get(type) ?? [];
      const tYs = typeTimePosMap.get(type) ?? [];
      const color = getComplaintColor(type);
      const typeCount = bucket.filter(b => b.type === type).length;
      const n = Math.min(sYs.length, tYs.length);
      for (let k = 0; k < n; k++) {
        blocks.push({
          barIdx: i,
          color,
          type,
          count: typeCount,
          stackY: sYs[k],
          timeY:  tYs[k],
          height: BLOCK_H,
        });
      }
    }


  }

  return { blocks, yMax };
}

export function BarChart({ complaints, resolution, selectedDate, chartMode, onHover, onSegmentClick }: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef       = useRef(0);
  const animRef      = useRef<{ from: ChartMode; startTs: number } | null>(null);
  const prevModeRef  = useRef<ChartMode>(chartMode);
  const blocksRef    = useRef<Block[]>([]);
  const yMaxRef      = useRef(1);
  const hitRegionsRef = useRef<HitRegion[]>([]);

  // Recompute blocks when data changes
  useEffect(() => {
    const numBars = resolution === 'day' ? 24 : getDaysInMonth(selectedDate);
    const { blocks, yMax } = buildBlocks(complaints, numBars, resolution);
    blocksRef.current = blocks;
    yMaxRef.current   = yMax;
  }, [complaints, resolution, selectedDate]);

  // Trigger animation when chartMode changes
  useEffect(() => {
    if (chartMode !== prevModeRef.current) {
      animRef.current = { from: prevModeRef.current, startTs: performance.now() };
      prevModeRef.current = chartMode;
    }
  }, [chartMode]);

  useEffect(() => {
    const canvas    = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ANIM_MS = 700;

    function render(ts: number) {
      const W = container!.clientWidth  || 600;
      const H = container!.clientHeight || 400;
      if (canvas!.width !== W || canvas!.height !== H) {
        canvas!.width  = W;
        canvas!.height = H;
      }

      const ctx = canvas!.getContext('2d')!;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#010408';
      ctx.fillRect(0, 0, W, H);

      const numBars = resolution === 'day' ? 24 : getDaysInMonth(selectedDate);
      const chartW  = W - PAD_L - PAD_R;
      const chartH  = H - PAD_T - PAD_B;
      const slotW   = chartW / numBars;
      const barW    = slotW * 0.52;
      const barOff  = (slotW - barW) / 2;
      const yMax    = yMaxRef.current;
      const blocks  = blocksRef.current;

      // Interpolation factor [0,1]
      let tAnim = 1; // default: fully at target (used for axis label crossfade)
      let fromMode = chartMode;
      if (animRef.current) {
        const elapsed = ts - animRef.current.startTs;
        const raw = elapsed / ANIM_MS;
        if (raw >= 1) {
          animRef.current = null;
        } else {
          tAnim    = easeOut(raw);
          fromMode = animRef.current.from;
        }
      }
      // ── Y-axis grid + labels
      ctx.font = LABEL_FONT;
      ctx.textAlign = 'right';

      // Show count axis when in stack mode (or animating away from time — use tAnim for timing)
      if (chartMode === 'stack' || (animRef.current !== null && fromMode === 'time' && tAnim < 1)) {
        // Count axis — 5 ticks
        for (let i = 0; i <= 4; i++) {
          const val = Math.round((yMax / 4) * i);
          const y   = PAD_T + chartH - (val / yMax) * chartH;
          ctx.strokeStyle = i === 0 ? 'rgba(0,200,220,0.25)' : 'rgba(0,200,220,0.18)';
          ctx.lineWidth   = i === 0 ? 1 : 0.75;
          ctx.beginPath(); ctx.moveTo(PAD_L - 4, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
          ctx.fillStyle = 'rgba(0,210,230,0.65)';
          ctx.fillText(val.toLocaleString(), PAD_L - 8, y + 4);
        }
      } else {
        // Time axis — every 15 min (0, 15, 30, 45)
        for (const min of [0, 15, 30, 45, 60]) {
          const y = PAD_T + chartH - (min / 60) * chartH;
          ctx.strokeStyle = min === 0 ? 'rgba(0,200,220,0.25)' : 'rgba(0,200,220,0.18)';
          ctx.lineWidth   = min === 0 ? 1 : 0.75;
          ctx.beginPath(); ctx.moveTo(PAD_L - 4, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
          ctx.fillStyle = 'rgba(0,210,230,0.65)';
          if (min < 60) ctx.fillText(`:${String(min).padStart(2,'0')}`, PAD_L - 8, y + 4);
        }
      }

      // ── Bars: interpolate Y between stack and time positions
      // Stagger: bar 0 leads by 0ms, bar N-1 lags by STAGGER_MS
      const STAGGER_MS = 120;
      const totalMs    = ANIM_MS + STAGGER_MS;
      const newHitRegions: HitRegion[] = [];

      // Pre-compute per-bar totals and per-bar-type counts for hit regions
      const barTotals = new Map<number, number>(); // barIdx → total complaints
      const barTypeCounts = new Map<string, number>(); // `${barIdx}:${type}` → count
      for (const b of blocks) {
        barTotals.set(b.barIdx, (barTotals.get(b.barIdx) ?? 0) + 1);
        const k = `${b.barIdx}:${b.type}`;
        barTypeCounts.set(k, (barTypeCounts.get(k) ?? 0) + 1);
      }

      for (const b of blocks) {
        let interpT: number;

        if (!animRef.current) {
          // No animation in progress — sit at target position
          interpT = chartMode === 'time' ? 1 : 0;
        } else {
          // Animating — apply per-bar stagger
          const barFrac      = b.barIdx / Math.max(numBars - 1, 1);
          const elapsed      = ts - animRef.current.startTs;
          const staggerMs    = barFrac * STAGGER_MS;
          const localElapsed = Math.max(0, elapsed - staggerMs);
          const localT       = easeOut(Math.min(localElapsed / (totalMs - STAGGER_MS), 1));

          // fromMode → chartMode: localT goes 0→1
          // If going stack→time: interpT = localT (0=stack, 1=time)
          // If going time→stack: interpT = 1 - localT (1=time, 0=stack)
          interpT = fromMode === 'stack' ? localT : 1 - localT;
        }

        const normY = b.stackY + (b.timeY - b.stackY) * interpT;
        const normH = b.height;

        const x  = PAD_L + b.barIdx * slotW + barOff;
        const y  = PAD_T + chartH - (normY + normH) * chartH;
        const bh = normH * chartH;

        if (bh < 0.3) continue;

        ctx.globalAlpha = 0.82;
        ctx.fillStyle   = b.color;
        ctx.fillRect(x, y, barW, Math.max(bh, 0.5));

        // Top edge highlight
        ctx.globalAlpha = 0.2;
        ctx.fillStyle   = '#fff';
        ctx.fillRect(x, y, barW, 0.8);

        // Record hit region
        const typeCount = barTypeCounts.get(`${b.barIdx}:${b.type}`) ?? b.count;
        const barTotal  = barTotals.get(b.barIdx) ?? 1;
        newHitRegions.push({ x, y, w: barW, h: Math.max(bh, 2), type: b.type, barIdx: b.barIdx, count: typeCount, totalInBar: barTotal });
      }
      ctx.globalAlpha = 1;
      hitRegionsRef.current = newHitRegions;

      // ── Baseline
      ctx.strokeStyle = 'rgba(0,200,220,0.2)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(PAD_L, PAD_T + chartH);
      ctx.lineTo(W - PAD_R, PAD_T + chartH);
      ctx.stroke();

      // ── X-axis labels
      ctx.font      = LABEL_FONT;
      ctx.fillStyle = 'rgba(0,210,230,0.6)';
      ctx.textAlign = 'center';
      for (let i = 0; i < numBars; i++) {
        const x     = PAD_L + i * slotW + slotW / 2;
        const label = resolution === 'day' ? `${String(i).padStart(2,'0')}` : `${i + 1}`;
        ctx.fillText(label, x, PAD_T + chartH + 16);
      }

      // ── Axis label
      ctx.font      = FONT;
      ctx.fillStyle = 'rgba(0,200,220,0.3)';
      ctx.textAlign = 'center';
      const axLabel = resolution === 'day' ? 'HOUR OF DAY' : 'DAY OF MONTH';
      ctx.fillText(axLabel, PAD_L + chartW / 2, H - 8);

      // Total rendered by view-meta-float overlay — not drawn here

      rafRef.current = requestAnimationFrame(render);
    }

    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complaints, resolution, selectedDate, chartMode]);

  const hitTest = (e: React.MouseEvent<HTMLCanvasElement>): ChartHit | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top)  * scaleY;
    // Search hit regions in reverse (top blocks first)
    const regions = hitRegionsRef.current;
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
        return { type: r.type, barIdx: r.barIdx, count: r.count, totalInBar: r.totalInBar };
      }
    }
    return null;
  };

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      <canvas ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair' }}
        onMouseMove={e => onHover?.(hitTest(e), e.clientX, e.clientY)}
        onMouseLeave={() => onHover?.(null, 0, 0)}
        onClick={e => { const h = hitTest(e); if (h) onSegmentClick?.(h); }}
      />
    </div>
  );
}

function getDaysInMonth(dateStr: string): number {
  const d = new Date(dateStr + 'T12:00:00');
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function niceMax(val: number): number {
  if (val <= 0) return 100;
  const mag  = Math.pow(10, Math.floor(Math.log10(val)));
  const nice = [1, 2, 2.5, 5, 10];
  for (const n of nice) {
    const candidate = Math.ceil(val / (mag * n)) * (mag * n);
    if (candidate >= val) return candidate;
  }
  return Math.ceil(val / mag) * mag;
}
