/**
 * CrashCharts — analytics view for Vision Zero collision data.
 *
 * Charts:
 *   1. Monthly trend (2013→present) — total + fatal/injury breakdown
 *   2. By severity — fatal / injury / no injury breakdown
 *   3. Top contributing factors
 *   4. Mode breakdown (pedestrian / cyclist / motorist)
 *   5. Top intersections (by crash count)
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useCrashes } from './CrashContext';


const FONT = "'Courier New', monospace";
const TEXT_BRIGHT = 'rgba(255,255,255,0.88)';
const TEXT_DIM    = 'rgba(255,255,255,0.42)';
const GRID_LINE   = 'rgba(255,255,255,0.06)';
const PANEL_BG    = 'rgba(255,255,255,0.04)';

const SEV_COLORS = {
  fatal:  '#ef4444',
  injury: '#f59e0b',
  none:   'rgba(148,163,184,0.4)',
};
const MODE_COLORS = {
  pedestrian: '#f87171',
  cyclist:    '#34d399',
  motorist:   '#60a5fa',
  multi:      '#c084fc',
};

// Monthly trend query
interface MonthSev { month: string; total: number; fatal: number; injury: number; none: number; }

async function fetchMonthlyTrend(): Promise<MonthSev[]> {
  // Build manually — URLSearchParams encodes '$' -> '%24' which breaks Socrata
  const qs = [
    `$select=date_trunc_ym(crash_date)%20as%20month,sum(number_of_persons_killed)%20as%20killed,sum(number_of_persons_injured)%20as%20injured,count(*)%20as%20total`,
    `$where=crash_date%20>=%20'2013-07-01T00:00:00.000'%20AND%20latitude%20IS%20NOT%20NULL`,
    `$group=month`,
    `$order=month%20ASC`,
    `$limit=2000`,
  ].join('&');
  const res = await fetch(`/api/crashes?${qs}`, { cache: 'no-store' });
  if (!res.ok) return [];
  const rows: any[] = await res.json();
  return rows
    .filter(r => r.month)
    .map(r => {
      const total   = parseInt(r.total   ?? '0');
      const killed  = parseInt(r.killed  ?? '0');
      const injured = parseInt(r.injured ?? '0');
      const none    = Math.max(0, total - killed - injured);
      return { month: r.month.slice(0, 7), total, fatal: killed, injury: injured, none };
    });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (w <= 0 || h <= 0) return;
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

function initCanvas(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return { ctx, W, H };
}

export default function CrashCharts() {
  const { crashes, filters } = useCrashes();

  const trendRef     = useRef<HTMLCanvasElement>(null);
  const severityRef  = useRef<HTMLCanvasElement>(null);
  const factorsRef   = useRef<HTMLCanvasElement>(null);
  const modeRef      = useRef<HTMLCanvasElement>(null);
  const intersectRef = useRef<HTMLCanvasElement>(null);

  const [trendData,    setTrendData]    = useState<MonthSev[]>([]);
  const [trendLoading, setTrendLoading] = useState(true);

  useEffect(() => {
    setTrendLoading(true);
    fetchMonthlyTrend().then(d => { setTrendData(d); setTrendLoading(false); });
  }, []);

  // ── Chart 1: Monthly trend + fatality line ──────────────────────────────
  const drawTrend = useCallback(() => {
    const canvas = trendRef.current;
    if (!canvas || trendLoading) return;
    const { ctx, W, H } = initCanvas(canvas);

    ctx.fillStyle = PANEL_BG; roundRect(ctx, 0, 0, W, H, 8); ctx.fill();
    ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 11px ${FONT}`;
    ctx.fillText('MONTHLY COLLISIONS', 16, 20);
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`;
    ctx.textAlign = 'right'; ctx.fillText('FULL HISTORY 2013→PRESENT', W - 16, 20); ctx.textAlign = 'left';

    const PAD_L = 52, PAD_R = 44, PAD_T = 36, PAD_B = 36;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const months = trendData.map(d => d.month);
    if (!months.length) return;

    const totals = trendData.map(d => d.total);
    const maxVal = Math.max(...totals, 1);
    const fatals = trendData.map(d => d.fatal);
    const maxFatal = Math.max(...fatals, 1);
    const gridCount = 4;

    // Left grid + axis
    ctx.strokeStyle = GRID_LINE; ctx.lineWidth = 1;
    for (let i = 0; i <= gridCount; i++) {
      const y = PAD_T + cH - (i / gridCount) * cH;
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + cW, y); ctx.stroke();
      if (i > 0) {
        ctx.fillStyle = TEXT_DIM; ctx.font = `400 9px ${FONT}`; ctx.textAlign = 'right';
        ctx.fillText(`${Math.round(maxVal * i / gridCount / 1000)}k`, PAD_L - 4, y + 3);
      }
    }

    // Right axis labels for fatalities
    ctx.fillStyle = 'rgba(239,68,68,0.5)'; ctx.font = `400 8px ${FONT}`; ctx.textAlign = 'left';
    for (let i = 1; i <= 2; i++) {
      const y = PAD_T + cH - (i / 2) * cH;
      ctx.fillText(`${Math.round(maxFatal * i / 2)}`, W - PAD_R + 4, y + 3);
    }
    ctx.textAlign = 'left';

    const barW = Math.max(1, cW / months.length - 0.5);

    // Stacked bars
    trendData.forEach((d, i) => {
      const x = PAD_L + i * (cW / months.length);
      let yBase = PAD_T + cH;

      const hNone = (d.none / maxVal) * cH;
      yBase -= hNone;
      ctx.fillStyle = SEV_COLORS.none;
      ctx.fillRect(x, yBase, Math.max(barW, 1), hNone);

      const hInj = (d.injury / maxVal) * cH;
      yBase -= hInj;
      ctx.fillStyle = SEV_COLORS.injury;
      ctx.globalAlpha = 0.65;
      ctx.fillRect(x, yBase, Math.max(barW, 1), hInj);
      ctx.globalAlpha = 1;

      const hFatal = (d.fatal / maxVal) * cH;
      yBase -= hFatal;
      ctx.fillStyle = SEV_COLORS.fatal;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, yBase, Math.max(barW, 1), hFatal);
      ctx.globalAlpha = 1;
    });

    // Fatality line (right Y-axis scale)
    ctx.beginPath();
    trendData.forEach((d, i) => {
      const x = PAD_L + i * (cW / months.length) + barW / 2;
      const y = PAD_T + cH - (d.fatal / maxFatal) * cH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.85;
    ctx.stroke(); ctx.globalAlpha = 1;

    // X labels — year markers
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 9px ${FONT}`; ctx.textAlign = 'center';
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

    // Legend
    const legend = [['fatal', 'Fatal'], ['injury', 'Injury'], ['none', 'No injury']] as const;
    let lx = W - PAD_R - 6;
    legend.forEach(([key, label]) => {
      ctx.font = `400 9px ${FONT}`; ctx.textAlign = 'right';
      ctx.fillStyle = TEXT_DIM; ctx.fillText(label, lx, H - 10);
      lx -= ctx.measureText(label).width + 18;
      ctx.fillStyle = SEV_COLORS[key]; ctx.globalAlpha = 0.8;
      ctx.fillRect(lx, H - 19, 10, 8); ctx.globalAlpha = 1;
      lx -= 16;
    });
    // Red line legend item
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 9px ${FONT}`; ctx.textAlign = 'right';
    ctx.fillText('— fatalities (right axis)', W - 8, H - 10);
    ctx.textAlign = 'left';
  }, [trendData, trendLoading]);

  // ── Chart 2: Severity breakdown ───────────────────────────────────────────
  const drawSeverity = useCallback(() => {
    const canvas = severityRef.current;
    if (!canvas) return;
    const { ctx, W, H } = initCanvas(canvas);
    ctx.fillStyle = PANEL_BG; roundRect(ctx, 0, 0, W, H, 8); ctx.fill();
    ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 11px ${FONT}`;
    ctx.fillText('BY SEVERITY', 16, 20);
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText('CURRENT FILTER', W - 16, 20);
    ctx.textAlign = 'left';

    const counts = { fatal: 0, injury: 0, none: 0 };
    crashes.forEach(c => { counts[c.severity ?? 'none']++; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = crashes.length || 1;

    const PAD_L = 72, PAD_R = 60, PAD_T = 36, PAD_B = 12;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const rowH = cH / 3;

    sorted.forEach(([sev, cnt], i) => {
      const y = PAD_T + i * rowH;
      const barH = Math.max(rowH * 0.55, 6);
      const barY = y + (rowH - barH) / 2;
      const barW = (cnt / total) * cW;
      const label = sev.charAt(0).toUpperCase() + sev.slice(1);

      ctx.fillStyle = SEV_COLORS[sev as keyof typeof SEV_COLORS];
      ctx.globalAlpha = sev === 'none' ? 0.4 : 0.8;
      roundRect(ctx, PAD_L, barY, barW, barH, 2); ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = TEXT_DIM; ctx.font = `400 9px ${FONT}`;
      ctx.textAlign = 'right'; ctx.fillText(label, PAD_L - 6, y + rowH / 2 + 3);

      ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 9px ${FONT}`;
      ctx.textAlign = 'left';
      const pct = Math.round(cnt / total * 100);
      ctx.fillText(`${cnt.toLocaleString()}  ${pct}%`, PAD_L + barW + 6, y + rowH / 2 + 3);
    });
    ctx.textAlign = 'left';
  }, [crashes]);

  // ── Chart 3: Contributing factors ────────────────────────────────────────
  const drawFactors = useCallback(() => {
    const canvas = factorsRef.current;
    if (!canvas) return;
    const { ctx, W, H } = initCanvas(canvas);
    ctx.fillStyle = PANEL_BG; roundRect(ctx, 0, 0, W, H, 8); ctx.fill();
    ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 11px ${FONT}`;
    ctx.fillText('TOP FACTORS', 16, 20);
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`; ctx.textAlign = 'right';
    ctx.fillText('CURRENT FILTER', W - 16, 20); ctx.textAlign = 'left';

    const SKIP = new Set(['Unspecified', '1', '', undefined]);
    const counts: Record<string, number> = {};
    crashes.forEach(c => {
      [c.contributing_factor_vehicle_1, c.contributing_factor_vehicle_2].forEach(f => {
        if (f && !SKIP.has(f)) counts[f] = (counts[f] ?? 0) + 1;
      });
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return;

    const PAD_L = 130, PAD_R = 50, PAD_T = 32, PAD_B = 12;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const rowH = cH / sorted.length;
    const maxCnt = sorted[0][1];

    sorted.forEach(([factor, cnt], i) => {
      const y = PAD_T + i * rowH;
      const barH = Math.max(rowH * 0.55, 4);
      const barY = y + (rowH - barH) / 2;
      const barW = (cnt / maxCnt) * cW;

      ctx.fillStyle = '#94a3b8';
      ctx.globalAlpha = 0.6;
      roundRect(ctx, PAD_L, barY, barW, barH, 2); ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = TEXT_DIM; ctx.font = `400 9px ${FONT}`; ctx.textAlign = 'right';
      const label = factor.length > 18 ? factor.slice(0, 17) + '…' : factor;
      ctx.fillText(label, PAD_L - 6, y + rowH / 2 + 3);

      ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 9px ${FONT}`; ctx.textAlign = 'left';
      ctx.fillText(cnt.toLocaleString(), PAD_L + barW + 6, y + rowH / 2 + 3);
    });
    ctx.textAlign = 'left';
  }, [crashes]);

  // ── Chart 4: Mode breakdown ───────────────────────────────────────────────
  const drawMode = useCallback(() => {
    const canvas = modeRef.current;
    if (!canvas) return;
    const { ctx, W, H } = initCanvas(canvas);
    ctx.fillStyle = PANEL_BG; roundRect(ctx, 0, 0, W, H, 8); ctx.fill();
    ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 11px ${FONT}`;
    ctx.fillText('BY MODE', 16, 20);
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`; ctx.textAlign = 'right';
    ctx.fillText('CURRENT FILTER', W - 16, 20); ctx.textAlign = 'left';

    const counts: Record<string, number> = {};
    crashes.forEach(c => { const m = c.mode ?? 'motorist'; counts[m] = (counts[m] ?? 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = crashes.length || 1;

    const PAD_L = 80, PAD_R = 60, PAD_T = 36, PAD_B = 12;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const rowH = cH / Math.max(sorted.length, 1);

    sorted.forEach(([m, cnt], i) => {
      const y = PAD_T + i * rowH;
      const barH = Math.max(rowH * 0.55, 6);
      const barY = y + (rowH - barH) / 2;
      const barW = (cnt / total) * cW;
      const label = m.charAt(0).toUpperCase() + m.slice(1);

      ctx.fillStyle = MODE_COLORS[m as keyof typeof MODE_COLORS] ?? '#888';
      ctx.globalAlpha = 0.75;
      roundRect(ctx, PAD_L, barY, barW, barH, 2); ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = TEXT_DIM; ctx.font = `400 9px ${FONT}`;
      ctx.textAlign = 'right'; ctx.fillText(label, PAD_L - 6, y + rowH / 2 + 3);

      ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 9px ${FONT}`;
      ctx.textAlign = 'left';
      const pct = Math.round(cnt / total * 100);
      ctx.fillText(`${cnt.toLocaleString()}  ${pct}%`, PAD_L + barW + 6, y + rowH / 2 + 3);
    });
    ctx.textAlign = 'left';
  }, [crashes]);

  // ── Chart 5: Top intersections ────────────────────────────────────────────
  const drawIntersections = useCallback(() => {
    const canvas = intersectRef.current;
    if (!canvas) return;
    const { ctx, W, H } = initCanvas(canvas);
    ctx.fillStyle = PANEL_BG; roundRect(ctx, 0, 0, W, H, 8); ctx.fill();
    ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 11px ${FONT}`;
    ctx.fillText('TOP INTERSECTIONS', 16, 20);
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`; ctx.textAlign = 'right';
    ctx.fillText('CURRENT FILTER', W - 16, 20); ctx.textAlign = 'left';
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`;
    ctx.textAlign = 'right'; ctx.fillText('BY CRASH COUNT', W - 16, 20); ctx.textAlign = 'left';

    const counts: Record<string, { cnt: number; killed: number; injured: number }> = {};
    crashes.forEach(c => {
      const st1 = c.on_street_name?.trim().toUpperCase();
      const st2 = c.cross_street_name?.trim().toUpperCase();
      if (!st1 || !st2) return;
      // Normalize order so A&B === B&A
      const key = [st1, st2].sort().join(' & ');
      if (!counts[key]) counts[key] = { cnt: 0, killed: 0, injured: 0 };
      counts[key].cnt++;
      counts[key].killed  += parseInt(c.number_of_persons_killed  || '0');
      counts[key].injured += parseInt(c.number_of_persons_injured || '0');
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1].cnt - a[1].cnt).slice(0, 10);
    if (!sorted.length) {
      ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`;
      ctx.fillText('INSUFFICIENT INTERSECTION DATA', 16, H / 2);
      return;
    }

    const PAD_L = 160, PAD_R = 50, PAD_T = 32, PAD_B = 12;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const rowH = cH / sorted.length;
    const maxCnt = sorted[0][1].cnt;

    sorted.forEach(([intersection, data], i) => {
      const y = PAD_T + i * rowH;
      const barH = Math.max(rowH * 0.55, 4);
      const barY = y + (rowH - barH) / 2;
      const barW = (data.cnt / maxCnt) * cW;

      // Color by severity at this intersection
      const color = data.killed > 0 ? SEV_COLORS.fatal : data.injured > 0 ? SEV_COLORS.injury : '#888';
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.7;
      roundRect(ctx, PAD_L, barY, barW, barH, 2); ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = TEXT_DIM; ctx.font = `400 9px ${FONT}`;
      ctx.textAlign = 'right';
      const label = intersection.length > 22 ? intersection.slice(0, 21) + '…' : intersection;
      ctx.fillText(label, PAD_L - 6, y + rowH / 2 + 3);

      ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 9px ${FONT}`;
      ctx.textAlign = 'left';
      const suffix = data.killed > 0 ? ` ⚠${data.killed}💀` : data.injured > 0 ? ` ${data.injured}inj` : '';
      ctx.fillText(`${data.cnt}${suffix}`, PAD_L + barW + 6, y + rowH / 2 + 3);
    });
    ctx.textAlign = 'left';
  }, [crashes]);

  useEffect(() => { drawTrend(); }, [drawTrend]);
  useEffect(() => {
    drawSeverity(); drawFactors(); drawMode(); drawIntersections();
  }, [drawSeverity, drawFactors, drawMode, drawIntersections]);

  useEffect(() => {
    const refs = [trendRef, severityRef, factorsRef, modeRef, intersectRef];
    const ro = new ResizeObserver(() => {
      drawTrend(); drawSeverity(); drawFactors(); drawMode(); drawIntersections();
    });
    refs.forEach(r => { if (r.current?.parentElement) ro.observe(r.current.parentElement); });
    return () => ro.disconnect();
  }, [drawTrend, drawSeverity, drawFactors, drawMode, drawIntersections]);

  return (
    <div className="crash-charts">
      <div className="cc-header">
        <div className="cc-title">
          NYC COLLISION ANALYTICS
          <span className="cc-subtitle">
            {filters.dateFrom} → {filters.dateTo}
            {filters.severity !== 'all' && ` · ${filters.severity} only`}
          </span>
        </div>
      </div>
      <div className="cc-grid">
        <div className="cc-panel cc-trend">
          {trendLoading
            ? <div className="cc-loading">LOADING TREND DATA…</div>
            : <canvas ref={trendRef} style={{ width: '100%', height: '100%', display: 'block' }} />}
        </div>
        <div className="cc-panel cc-severity">
          <canvas ref={severityRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        <div className="cc-panel cc-mode">
          <canvas ref={modeRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        <div className="cc-panel cc-factors">
          <canvas ref={factorsRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        <div className="cc-panel cc-intersections">
          <canvas ref={intersectRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
      </div>
    </div>
  );
}
