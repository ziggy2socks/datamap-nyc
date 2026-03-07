import { useEffect, useRef, useMemo } from 'react';
import type { Complaint } from './complaints';
import { getComplaintColor } from './complaints';
import { makeProjection } from './coordinates';

interface Props {
  complaints: Complaint[];
  replayTime: number;
  dotLifetime: number;
  onPing: (complaint: Complaint) => void;
  onBatchLoad: (complaints: Complaint[]) => void;
  hoveredKey: string | null;
}

const SIZE = 600;
const R = SIZE / 2 - 2;
const CX = SIZE / 2;
const CY = SIZE / 2;
const SWEEP_SPEED = (2 * Math.PI) / 7000; // 7s per rotation
const TRAIL_ARC = Math.PI * 1.2; // ~216° trailing glow

interface DotInfo {
  key: string;
  complaint: Complaint;
  x: number;
  y: number;
  angle: number;
  color: string;
  createdMs: number;
}

const project = makeProjection(SIZE);

// Borough paths
let boroughPaths: Path2D[] = [];
fetch('/boroughs.geojson')
  .then(r => r.json())
  .then((geo: any) => {
    for (const f of geo.features) {
      const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
      for (const poly of polys) {
        const p = new Path2D();
        for (const ring of poly) {
          ring.forEach(([lon, lat]: number[], i: number) => {
            const { x, y } = project(lat, lon);
            i === 0 ? p.moveTo(x, y) : p.lineTo(x, y);
          });
          p.closePath();
        }
        boroughPaths.push(p);
      }
    }
  })
  .catch(console.error);

// Offscreen canvas for smooth sweep trail
const trailCanvas = document.createElement('canvas');
trailCanvas.width = SIZE;
trailCanvas.height = SIZE;

function renderTrail(sweep: number) {
  const tctx = trailCanvas.getContext('2d')!;
  tctx.clearRect(0, 0, SIZE, SIZE);
  const slices = 60;
  const sliceArc = TRAIL_ARC / slices;
  for (let s = 0; s < slices; s++) {
    const frac = s / slices;
    const alpha = Math.pow(1 - frac, 3) * 0.12;
    if (alpha < 0.002) continue;
    tctx.beginPath();
    tctx.moveTo(CX, CY);
    tctx.arc(CX, CY, R, sweep - sliceArc * (s + 1), sweep - sliceArc * s);
    tctx.closePath();
    tctx.fillStyle = `rgba(0,220,255,${alpha})`;
    tctx.fill();
  }
}

export function RadarCanvas({ complaints, replayTime, dotLifetime, onPing, onBatchLoad, hoveredKey }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const angleRef = useRef(-Math.PI / 2);
  const lastTsRef = useRef(0);
  const dotsRef = useRef<DotInfo[]>([]);
  const pingedRef = useRef<Set<string>>(new Set());
  // Track when each dot got its first beam pass (key → animation frame timestamp)
  const highlightRef = useRef<Map<string, number>>(new Map());
  const replayRef = useRef(replayTime);
  const lifetimeRef = useRef(dotLifetime);
  const onPingRef = useRef(onPing);
  const onBatchLoadRef = useRef(onBatchLoad);
  const initialLoadDoneRef = useRef(false);
  const hoveredKeyRef = useRef(hoveredKey);

  replayRef.current = replayTime;
  lifetimeRef.current = dotLifetime;
  onPingRef.current = onPing;
  onBatchLoadRef.current = onBatchLoad;
  hoveredKeyRef.current = hoveredKey;

  // Pre-compute dot positions + angles
  useMemo(() => {
    const result: DotInfo[] = [];
    for (const c of complaints) {
      const lat = parseFloat(c.latitude ?? '');
      const lon = parseFloat(c.longitude ?? '');
      if (isNaN(lat) || isNaN(lon)) continue;
      const { x, y } = project(lat, lon);
      const dx = x - CX;
      const dy = y - CY;
      if (dx * dx + dy * dy > R * R) continue;
      const angle = (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI);
      result.push({
        key: c.unique_key, complaint: c,
        x, y, angle,
        color: getComplaintColor(c.complaint_type),
        createdMs: new Date(c.created_date).getTime(),
      });
    }
    result.sort((a, b) => a.createdMs - b.createdMs);
    dotsRef.current = result;
    pingedRef.current.clear();
    highlightRef.current.clear();
    initialLoadDoneRef.current = false; // reset for batch load on date switch
  }, [complaints]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    function draw(ts: number) {
      const dt = lastTsRef.current ? Math.min(ts - lastTsRef.current, 50) : 16;
      lastTsRef.current = ts;
      angleRef.current = (angleRef.current + SWEEP_SPEED * dt) % (2 * Math.PI);
      const sweep = angleRef.current;
      const now = replayRef.current;
      const lifetime = lifetimeRef.current;
      const dots = dotsRef.current;
      const windowStart = now - lifetime;

      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.clip();

      // Background
      ctx.fillStyle = '#010408';
      ctx.fillRect(0, 0, SIZE, SIZE);

      // Grid rings — more visible
      ctx.strokeStyle = 'rgba(0,200,220,0.18)';
      ctx.lineWidth = 1;
      for (let r = R / 4; r <= R; r += R / 4) {
        ctx.beginPath();
        ctx.arc(CX, CY, r, 0, 2 * Math.PI);
        ctx.stroke();
      }

      // Thin orthogonal grid inside the radar circle
      const gridSpacing = R / 6; // ~6 cells across each axis
      ctx.strokeStyle = 'rgba(0,200,220,0.06)';
      ctx.lineWidth = 0.5;
      for (let gx = CX - R; gx <= CX + R; gx += gridSpacing) {
        // clip each line to circle
        const halfH = Math.sqrt(Math.max(0, R * R - (gx - CX) ** 2));
        if (halfH < 1) continue;
        ctx.beginPath();
        ctx.moveTo(gx, CY - halfH);
        ctx.lineTo(gx, CY + halfH);
        ctx.stroke();
      }
      for (let gy = CY - R; gy <= CY + R; gy += gridSpacing) {
        const halfW = Math.sqrt(Math.max(0, R * R - (gy - CY) ** 2));
        if (halfW < 1) continue;
        ctx.beginPath();
        ctx.moveTo(CX - halfW, gy);
        ctx.lineTo(CX + halfW, gy);
        ctx.stroke();
      }

      // Crosshairs (cardinal axes — slightly brighter than grid)
      ctx.strokeStyle = 'rgba(0,200,220,0.10)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(CX - R, CY); ctx.lineTo(CX + R, CY);
      ctx.moveTo(CX, CY - R); ctx.lineTo(CX, CY + R);
      ctx.stroke();
      ctx.setLineDash([]);

      // Borough outlines
      ctx.strokeStyle = 'rgba(0,200,220,0.15)';
      ctx.lineWidth = 0.7;
      for (const p of boroughPaths) ctx.stroke(p);
      ctx.fillStyle = 'rgba(0,160,190,0.03)';
      for (const p of boroughPaths) ctx.fill(p);

      // Sweep trail (smooth gradient)
      renderTrail(sweep);
      ctx.drawImage(trailCanvas, 0, 0);

      // Sweep leading edge
      ctx.save();
      ctx.strokeStyle = 'rgba(0,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#0ff';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(CX + Math.cos(sweep) * R, CY + Math.sin(sweep) * R);
      ctx.stroke();
      ctx.restore();

      // ── Dots ────────────────────────────────────
      const HIGHLIGHT_DURATION = 1500; // 1.5s highlight animation

      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        if (d.createdMs > now) continue;
        if (d.createdMs < windowStart) continue;

        // Beam proximity
        const behind = (sweep - d.angle + 2 * Math.PI) % (2 * Math.PI);
        const beamOn = behind < 0.12;

        // First beam pass: highlight now, feed ping after 1s delay
        if (beamOn && !highlightRef.current.has(d.key)) {
          highlightRef.current.set(d.key, ts);
          if (initialLoadDoneRef.current) {
            const complaint = d.complaint;
            setTimeout(() => onPingRef.current(complaint), 300);
          }
        }

        // Beam flicker for all dots
        const flicker = beamOn ? (1 - behind / 0.12) * 0.4 : 0;

        // Check if this dot is in its highlight phase
        const highlightStart = highlightRef.current.get(d.key);
        const highlightAge = highlightStart != null ? ts - highlightStart : -1;
        const isHighlighting = highlightAge >= 0 && highlightAge < HIGHLIGHT_DURATION;

        if (isHighlighting) {
          // Highlight: 1.5x size, full brightness, expanding ring
          const t = highlightAge / HIGHLIGHT_DURATION; // 0→1
          const ringAlpha = 1 - t;
          const ringRadius = 6 + t * 14;

          // Bright dot
          ctx.save();
          ctx.globalAlpha = 0.9 - t * 0.4; // 0.9 → 0.5
          ctx.fillStyle = d.color;
          ctx.shadowColor = d.color;
          ctx.shadowBlur = 12 * (1 - t);
          ctx.beginPath();
          ctx.arc(d.x, d.y, 3, 0, 2 * Math.PI); // 1.5x of base 2px
          ctx.fill();
          ctx.restore();

          // Expanding ring
          ctx.save();
          ctx.globalAlpha = ringAlpha * 0.6;
          ctx.strokeStyle = d.color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(d.x, d.y, ringRadius, 0, 2 * Math.PI);
          ctx.stroke();
          ctx.restore();
        } else {
          // Normal dot: 50% + beam flicker
          ctx.save();
          ctx.globalAlpha = 0.5 + flicker;
          ctx.fillStyle = d.color;
          if (flicker > 0.1) {
            ctx.shadowColor = d.color;
            ctx.shadowBlur = 6 * flicker;
          }
          ctx.beginPath();
          ctx.arc(d.x, d.y, 2, 0, 2 * Math.PI);
          ctx.fill();
          ctx.restore();
        }
      }

      // After first frame, batch-load all currently visible dots into feed immediately
      if (!initialLoadDoneRef.current) {
        // Check if we have any visible dots
        let hasVisible = false;
        for (let i = 0; i < dots.length; i++) {
          if (dots[i].createdMs <= now && dots[i].createdMs >= windowStart) { hasVisible = true; break; }
        }
        if (hasVisible) {
          initialLoadDoneRef.current = true;
          // Mark all currently visible dots as already highlighted (no animation for pre-existing)
          for (let i = 0; i < dots.length; i++) {
            const d = dots[i];
            if (d.createdMs > now || d.createdMs < windowStart) continue;
            highlightRef.current.set(d.key, ts - 9999); // expired highlight = already settled
          }
          // Batch the feed
          const batch: Complaint[] = [];
          for (let i = dots.length - 1; i >= 0; i--) {
            const d = dots[i];
            if (d.createdMs > now || d.createdMs < windowStart) continue;
            batch.push(d.complaint);
            if (batch.length >= 50) break;
          }
          onBatchLoadRef.current(batch);
        }
      }

      // ── Hovered/selected dot — thin corner brackets ──
      const hKey = hoveredKeyRef.current;
      if (hKey) {
        for (let i = 0; i < dots.length; i++) {
          const d = dots[i];
          if (d.key !== hKey) continue;
          if (d.createdMs > now || d.createdMs < windowStart) break;

          const s = 5;  // bracket arm length
          const g = 6;  // half-size of the square around dot

          ctx.save();
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth = 0.75;

          // Corner brackets forming a square: ┌ ┐ └ ┘
          ctx.beginPath();
          // Top-left ┌
          ctx.moveTo(d.x - g, d.y - g + s);
          ctx.lineTo(d.x - g, d.y - g);
          ctx.lineTo(d.x - g + s, d.y - g);
          // Top-right ┐
          ctx.moveTo(d.x + g - s, d.y - g);
          ctx.lineTo(d.x + g, d.y - g);
          ctx.lineTo(d.x + g, d.y - g + s);
          // Bottom-left └
          ctx.moveTo(d.x - g, d.y + g - s);
          ctx.lineTo(d.x - g, d.y + g);
          ctx.lineTo(d.x - g + s, d.y + g);
          // Bottom-right ┘
          ctx.moveTo(d.x + g - s, d.y + g);
          ctx.lineTo(d.x + g, d.y + g);
          ctx.lineTo(d.x + g, d.y + g - s);
          ctx.stroke();

          ctx.restore();
          break;
        }
      }

      // Center dot
      ctx.save();
      ctx.fillStyle = '#00ccff';
      ctx.shadowColor = '#00ccff';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(CX, CY, 2, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();

      ctx.restore(); // end clip

      // Outer ring
      ctx.strokeStyle = 'rgba(0,200,220,0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.stroke();

      // Perimeter tick marks — 360 ticks (1° each), tied to sweep rotation timing
      // Major tick every 10° (longer), minor every 1° (short)
      // Ticks are outside the clipped area so they sit on the rim
      const TICK_INNER_MINOR = R + 2;
      const TICK_OUTER_MINOR = R + 5;
      const TICK_INNER_MAJOR = R + 2;
      const TICK_OUTER_MAJOR = R + 9;
      ctx.lineWidth = 0.75;
      for (let deg = 0; deg < 360; deg++) {
        const rad = (deg - 90) * (Math.PI / 180); // 0° at top
        const isMajor = deg % 10 === 0;
        const inner = isMajor ? TICK_INNER_MAJOR : TICK_INNER_MINOR;
        const outer = isMajor ? TICK_OUTER_MAJOR : TICK_OUTER_MINOR;
        const cosR = Math.cos(rad);
        const sinR = Math.sin(rad);
        ctx.strokeStyle = isMajor ? 'rgba(0,220,240,0.55)' : 'rgba(0,200,220,0.25)';
        ctx.beginPath();
        ctx.moveTo(CX + cosR * inner, CY + sinR * inner);
        ctx.lineTo(CX + cosR * outer, CY + sinR * outer);
        ctx.stroke();
      }

      // Edge vignette
      ctx.save();
      const vig = ctx.createRadialGradient(CX, CY, R * 0.55, CX, CY, R);
      vig.addColorStop(0, 'rgba(1,4,8,0)');
      vig.addColorStop(0.65, 'rgba(1,4,8,0)');
      vig.addColorStop(1, 'rgba(1,4,8,0.7)');
      ctx.fillStyle = vig;
      ctx.beginPath();
      ctx.arc(CX, CY, R + 1, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      className="radar-canvas"
    />
  );
}
