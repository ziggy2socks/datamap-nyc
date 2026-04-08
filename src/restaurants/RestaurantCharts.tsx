/**
 * RestaurantCharts — analytics for NYC restaurant inspection data.
 * Charts:
 *   1. Grade distribution (A/B/C/pending) — pie-ish horizontal stacked bar
 *   2. Score histogram — distribution of inspection scores
 *   3. Top cuisines by count
 *   4. Critical violations — most common violation descriptions
 *   5. Top neighborhoods (NTA) by restaurant count
 */
import { useEffect, useRef, useCallback } from 'react';
import { useRestaurants } from './RestaurantContext';


const FONT = "'Courier New', monospace";
const TEXT_BRIGHT = 'rgba(255,255,255,0.88)';
const TEXT_DIM    = 'rgba(255,255,255,0.42)';
const GRID_LINE   = 'rgba(255,255,255,0.06)';
const PANEL_BG    = 'rgba(255,255,255,0.04)';

const GRADE_COLORS: Record<string, string> = {
  A: '#34d399', B: '#f59e0b', C: '#ef4444',
  Z: '#a78bfa', P: '#a78bfa', N: 'rgba(148,163,184,0.4)', '?': 'rgba(148,163,184,0.4)',
};

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

function filterLabel(filters: { grade: string; cuisine: string; boroughs: Set<string> }): string {
  const parts: string[] = [];
  if (filters.grade !== 'all') parts.push(`grade ${filters.grade.toUpperCase()}`);
  if (filters.cuisine) parts.push(filters.cuisine);
  return parts.length ? parts.join(' · ') : 'ALL RESTAURANTS';
}

export default function RestaurantCharts() {
  const { restaurants, filters } = useRestaurants();

  const gradeRef    = useRef<HTMLCanvasElement>(null);
  const scoreRef    = useRef<HTMLCanvasElement>(null);
  const cuisineRef  = useRef<HTMLCanvasElement>(null);
  const violRef     = useRef<HTMLCanvasElement>(null);
  const ntaRef      = useRef<HTMLCanvasElement>(null);

  // ── Chart 1: Grade distribution ──────────────────────────────────────────
  const drawGrades = useCallback(() => {
    const canvas = gradeRef.current;
    if (!canvas) return;
    const { ctx, W, H } = initCanvas(canvas);
    ctx.fillStyle = PANEL_BG; roundRect(ctx, 0, 0, W, H, 8); ctx.fill();
    ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 11px ${FONT}`;
    ctx.fillText('GRADE DISTRIBUTION', 16, 20);
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`; ctx.textAlign = 'right';
    ctx.fillText(`${restaurants.length.toLocaleString()} RESTAURANTS`, W - 16, 20);
    ctx.textAlign = 'left';

    const counts: Record<string, number> = { A: 0, B: 0, C: 0, pending: 0 };
    restaurants.forEach(r => {
      if (r.grade === 'A') counts.A++;
      else if (r.grade === 'B') counts.B++;
      else if (r.grade === 'C') counts.C++;
      else counts.pending++;
    });
    const total = restaurants.length || 1;

    // Horizontal stacked bar
    const PAD = 24, barH = 28, barY = H / 2 - barH / 2;
    const barW = W - PAD * 2;
    let x = PAD;
    const segments = [
      ['A', counts.A, '#34d399'],
      ['B', counts.B, '#f59e0b'],
      ['C', counts.C, '#ef4444'],
      ['?', counts.pending, 'rgba(148,163,184,0.4)'],
    ] as const;

    segments.forEach(([grade, cnt, color]) => {
      const w = (cnt / total) * barW;
      if (w < 1) return;
      ctx.fillStyle = color;
      ctx.globalAlpha = grade === '?' ? 0.4 : 0.85;
      ctx.fillRect(x, barY, w, barH);
      ctx.globalAlpha = 1;
      // Label inside bar if wide enough
      if (w > 32) {
        ctx.fillStyle = grade === '?' ? TEXT_DIM : 'rgba(0,0,0,0.7)';
        ctx.font = `700 10px ${FONT}`; ctx.textAlign = 'center';
        ctx.fillText(`${grade} ${Math.round(cnt / total * 100)}%`, x + w / 2, barY + barH / 2 + 4);
      }
      x += w;
    });

    // Count labels below bar
    x = PAD;
    ctx.font = `400 9px ${FONT}`;
    segments.forEach(([_grade, cnt, color]) => {
      const w = (cnt / total) * barW;
      if (w < 1) return;
      if (w > 20) {
        ctx.fillStyle = color === 'rgba(148,163,184,0.4)' ? TEXT_DIM : color as string;
        ctx.textAlign = 'center';
        ctx.fillText(cnt.toLocaleString(), x + w / 2, barY + barH + 14);
      }
      x += w;
    });
    ctx.textAlign = 'left';
  }, [restaurants]);

  // ── Chart 2: Score histogram ──────────────────────────────────────────────
  const drawScores = useCallback(() => {
    const canvas = scoreRef.current;
    if (!canvas) return;
    const { ctx, W, H } = initCanvas(canvas);
    ctx.fillStyle = PANEL_BG; roundRect(ctx, 0, 0, W, H, 8); ctx.fill();
    ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 11px ${FONT}`;
    ctx.fillText('SCORE DISTRIBUTION', 16, 20);
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`; ctx.textAlign = 'right';
    ctx.fillText('LOWER = BETTER', W - 16, 20); ctx.textAlign = 'left';

    // Bucket by score ranges 0–7(A), 8–13(A-), 14–27(B), 28+(C)
    const MAX_SCORE = 60;
    const BUCKETS = 24; // 0-2, 3-5, ..., 57-60
    const bucketSize = Math.ceil(MAX_SCORE / BUCKETS);
    const counts = new Array(BUCKETS).fill(0);
    restaurants.forEach(r => {
      const s = Math.min(r.score, MAX_SCORE - 1);
      const b = Math.floor(s / bucketSize);
      if (b >= 0 && b < BUCKETS) counts[b]++;
    });
    const maxCnt = Math.max(...counts, 1);

    const PAD_L = 36, PAD_R = 16, PAD_T = 32, PAD_B = 28;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const bW = cW / BUCKETS;

    // Grade zone shading
    const gradeZones = [
      { label: 'A', from: 0, to: 13, color: 'rgba(52,211,153,0.07)' },
      { label: 'B', from: 14, to: 27, color: 'rgba(245,158,11,0.07)' },
      { label: 'C', from: 28, to: MAX_SCORE, color: 'rgba(239,68,68,0.07)' },
    ];
    gradeZones.forEach(({ label, from, to, color }) => {
      const x1 = PAD_L + (from / MAX_SCORE) * cW;
      const x2 = PAD_L + (Math.min(to + 1, MAX_SCORE) / MAX_SCORE) * cW;
      ctx.fillStyle = color; ctx.fillRect(x1, PAD_T, x2 - x1, cH);
      ctx.fillStyle = GRADE_COLORS[label] ? GRADE_COLORS[label] + '60' : TEXT_DIM;
      ctx.font = `700 8px ${FONT}`; ctx.textAlign = 'center';
      ctx.fillText(label, (x1 + x2) / 2, PAD_T + 10);
    });

    // Grid
    ctx.strokeStyle = GRID_LINE; ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = PAD_T + cH - (i / 3) * cH;
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + cW, y); ctx.stroke();
      ctx.fillStyle = TEXT_DIM; ctx.font = `400 8px ${FONT}`; ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(maxCnt * i / 3)}`, PAD_L - 3, y + 3);
    }

    // Bars
    counts.forEach((cnt, i) => {
      const x = PAD_L + i * bW;
      const h = (cnt / maxCnt) * cH;
      const score = i * bucketSize;
      const color = score <= 13 ? '#34d399' : score <= 27 ? '#f59e0b' : '#ef4444';
      ctx.fillStyle = color; ctx.globalAlpha = 0.7;
      ctx.fillRect(x + 0.5, PAD_T + cH - h, Math.max(bW - 1, 1), h);
      ctx.globalAlpha = 1;
    });

    // X labels
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 8px ${FONT}`; ctx.textAlign = 'center';
    [0, 14, 28, 42, 56].forEach(score => {
      const x = PAD_L + (score / MAX_SCORE) * cW;
      ctx.fillText(String(score), x, PAD_T + cH + 14);
    });
    ctx.textAlign = 'left';
  }, [restaurants]);

  // ── Chart 3: Top cuisines ─────────────────────────────────────────────────
  const drawCuisines = useCallback(() => {
    const canvas = cuisineRef.current;
    if (!canvas) return;
    const { ctx, W, H } = initCanvas(canvas);
    ctx.fillStyle = PANEL_BG; roundRect(ctx, 0, 0, W, H, 8); ctx.fill();
    ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 11px ${FONT}`;
    ctx.fillText('TOP CUISINES', 16, 20);
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`; ctx.textAlign = 'right';
    ctx.fillText('CURRENT FILTER', W - 16, 20); ctx.textAlign = 'left';

    const counts: Record<string, number> = {};
    restaurants.forEach(r => { if (r.cuisine) counts[r.cuisine] = (counts[r.cuisine] ?? 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!sorted.length) return;

    const PAD_L = 108, PAD_R = 50, PAD_T = 32, PAD_B = 12;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const rowH = cH / sorted.length;
    const maxCnt = sorted[0][1];

    sorted.forEach(([cuisine, cnt], i) => {
      const y = PAD_T + i * rowH;
      const barH = Math.max(rowH * 0.55, 4);
      const barY = y + (rowH - barH) / 2;
      const barW = (cnt / maxCnt) * cW;

      ctx.fillStyle = '#60a5fa'; ctx.globalAlpha = 0.65;
      roundRect(ctx, PAD_L, barY, barW, barH, 2); ctx.fill(); ctx.globalAlpha = 1;

      ctx.fillStyle = TEXT_DIM; ctx.font = `400 9px ${FONT}`; ctx.textAlign = 'right';
      const label = cuisine.length > 14 ? cuisine.slice(0, 13) + '…' : cuisine;
      ctx.fillText(label, PAD_L - 6, y + rowH / 2 + 3);

      ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 9px ${FONT}`; ctx.textAlign = 'left';
      ctx.fillText(cnt.toLocaleString(), PAD_L + barW + 6, y + rowH / 2 + 3);
    });
    ctx.textAlign = 'left';
  }, [restaurants]);

  // ── Chart 4: Critical violations ─────────────────────────────────────────
  const drawViolations = useCallback(() => {
    const canvas = violRef.current;
    if (!canvas) return;
    const { ctx, W, H } = initCanvas(canvas);
    ctx.fillStyle = PANEL_BG; roundRect(ctx, 0, 0, W, H, 8); ctx.fill();
    ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 11px ${FONT}`;
    ctx.fillText('TOP CRITICAL VIOLATIONS', 16, 20);
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`; ctx.textAlign = 'right';
    ctx.fillText('CURRENT FILTER', W - 16, 20); ctx.textAlign = 'left';

    const counts: Record<string, number> = {};
    restaurants.forEach(r => {
      r.violations.filter(v => v.critical).forEach(v => {
        // Shorten code-based key to avoid duplicate counting
        const key = v.code;
        counts[key] = (counts[key] ?? 0) + 1;
      });
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) {
      ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`;
      ctx.fillText('NO CRITICAL VIOLATION DATA', 16, H / 2);
      return;
    }

    // Get a description for each code from loaded data
    const codeDesc: Record<string, string> = {};
    restaurants.forEach(r => {
      r.violations.forEach(v => { if (!codeDesc[v.code]) codeDesc[v.code] = v.description; });
    });

    const PAD_L = 30, PAD_R = 50, PAD_T = 32, PAD_B = 12;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const rowH = cH / sorted.length;
    const maxCnt = sorted[0][1];

    sorted.forEach(([code, cnt], i) => {
      const y = PAD_T + i * rowH;
      const barH = Math.max(rowH * 0.55, 4);
      const barY = y + (rowH - barH) / 2;
      const barW = (cnt / maxCnt) * cW;

      ctx.fillStyle = '#ef4444'; ctx.globalAlpha = 0.6;
      roundRect(ctx, PAD_L, barY, barW, barH, 2); ctx.fill(); ctx.globalAlpha = 1;

      // Violation code + short description
      const desc = codeDesc[code] ?? code;
      const shortDesc = desc.length > 28 ? desc.slice(0, 27) + '…' : desc;
      ctx.fillStyle = TEXT_DIM; ctx.font = `400 8px ${FONT}`; ctx.textAlign = 'left';
      ctx.fillText(`${code} — ${shortDesc}`, PAD_L + 4, y + rowH / 2 - 2);

      ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 9px ${FONT}`; ctx.textAlign = 'right';
      ctx.fillText(cnt.toLocaleString(), PAD_L + barW - 4, y + rowH / 2 + 8);
    });
    ctx.textAlign = 'left';
  }, [restaurants]);

  // ── Chart 5: Top neighborhoods ────────────────────────────────────────────
  const drawNTA = useCallback(() => {
    const canvas = ntaRef.current;
    if (!canvas) return;
    const { ctx, W, H } = initCanvas(canvas);
    ctx.fillStyle = PANEL_BG; roundRect(ctx, 0, 0, W, H, 8); ctx.fill();
    ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 11px ${FONT}`;
    ctx.fillText('TOP NEIGHBORHOODS', 16, 20);
    ctx.fillStyle = TEXT_DIM; ctx.font = `400 10px ${FONT}`; ctx.textAlign = 'right';
    ctx.fillText('CURRENT FILTER', W - 16, 20); ctx.textAlign = 'left';

    const counts: Record<string, number> = {};
    restaurants.forEach(r => { if (r.nta) counts[r.nta] = (counts[r.nta] ?? 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!sorted.length) return;

    const PAD_L = 118, PAD_R = 50, PAD_T = 32, PAD_B = 12;
    const cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    const rowH = cH / sorted.length;
    const maxCnt = sorted[0][1];

    sorted.forEach(([nta, cnt], i) => {
      const y = PAD_T + i * rowH;
      const barH = Math.max(rowH * 0.55, 4);
      const barY = y + (rowH - barH) / 2;
      const barW = (cnt / maxCnt) * cW;

      ctx.fillStyle = '#34d399'; ctx.globalAlpha = 0.6;
      roundRect(ctx, PAD_L, barY, barW, barH, 2); ctx.fill(); ctx.globalAlpha = 1;

      ctx.fillStyle = TEXT_DIM; ctx.font = `400 9px ${FONT}`; ctx.textAlign = 'right';
      const label = nta.length > 16 ? nta.slice(0, 15) + '…' : nta;
      ctx.fillText(label, PAD_L - 6, y + rowH / 2 + 3);

      ctx.fillStyle = TEXT_BRIGHT; ctx.font = `700 9px ${FONT}`; ctx.textAlign = 'left';
      ctx.fillText(cnt.toLocaleString(), PAD_L + barW + 6, y + rowH / 2 + 3);
    });
    ctx.textAlign = 'left';
  }, [restaurants]);

  useEffect(() => { drawGrades(); drawScores(); drawCuisines(); drawViolations(); drawNTA(); },
    [drawGrades, drawScores, drawCuisines, drawViolations, drawNTA]);

  useEffect(() => {
    const refs = [gradeRef, scoreRef, cuisineRef, violRef, ntaRef];
    const ro = new ResizeObserver(() => {
      drawGrades(); drawScores(); drawCuisines(); drawViolations(); drawNTA();
    });
    refs.forEach(r => { if (r.current?.parentElement) ro.observe(r.current.parentElement); });
    return () => ro.disconnect();
  }, [drawGrades, drawScores, drawCuisines, drawViolations, drawNTA]);

  return (
    <div className="rest-charts">
      <div className="rc-header">
        <div className="rc-title">
          NYC RESTAURANT INSPECTIONS
          <span className="rc-subtitle">{filterLabel(filters)} · {restaurants.length.toLocaleString()} shown</span>
        </div>
      </div>
      <div className="rc-grid">
        <div className="rc-panel rc-grade">
          <canvas ref={gradeRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        <div className="rc-panel rc-score">
          <canvas ref={scoreRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        <div className="rc-panel rc-cuisine">
          <canvas ref={cuisineRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        <div className="rc-panel rc-violations">
          <canvas ref={violRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        <div className="rc-panel rc-nta">
          <canvas ref={ntaRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
      </div>
    </div>
  );
}
