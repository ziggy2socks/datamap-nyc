import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './GlobeApp.css';

// ── Binary file format ────────────────────────────────────────────────────────
// [4 bytes: header length uint32 LE][JSON header][raw bytes: weeks × H × W uint8]
// uint8 value: 0-254 = temp remapped to [temp_min, temp_max], 255 = ocean/no-data

interface GlobeHeader {
  year: number;
  width: number;
  height: number;
  weeks: number;
  temp_min: number;
  temp_max: number;
  ocean_sentinel: number;
  dates: string[];
}

interface GlobeData {
  header: GlobeHeader;
  pixels: Uint8Array; // weeks × height × width
}

// ── Color ramp ────────────────────────────────────────────────────────────────
// Maps uint8 0-254 → RGBA. 255 = ocean → transparent black.
// Temp range: -55°C (0) → +50°C (254)

const COLOR_STOPS: { v: number; r: number; g: number; b: number }[] = [
  { v: 0,   r: 10,  g: 20,  b: 80  },  // -55°C deep polar
  { v: 50,  r: 30,  g: 80,  b: 180 },  // -33°C frozen
  { v: 90,  r: 60,  g: 140, b: 220 },  // -18°C cold
  { v: 115, r: 140, g: 210, b: 255 },  // -7°C  near-frost
  { v: 120, r: 200, g: 235, b: 255 },  // -3°C  frost band bright
  { v: 125, r: 220, g: 245, b: 255 },  // 0°C   frost line peak — near white-cyan
  { v: 130, r: 190, g: 235, b: 200 },  // +3°C  just above frost
  { v: 150, r: 160, g: 220, b: 140 },  // +14°C cool green
  { v: 175, r: 240, g: 230, b: 80  },  // +28°C warm yellow
  { v: 210, r: 255, g: 150, b: 30  },  // +43°C hot orange
  { v: 254, r: 220, g: 30,  b: 30  },  // +50°C extreme red
];

// Pre-build 256-entry RGBA lookup table
const LUMA = new Uint8ClampedArray(256 * 4);
for (let i = 0; i < 255; i++) {
  let lo = COLOR_STOPS[0], hi = COLOR_STOPS[1];
  for (let s = 0; s < COLOR_STOPS.length - 1; s++) {
    if (i >= COLOR_STOPS[s].v && i <= COLOR_STOPS[s + 1].v) { lo = COLOR_STOPS[s]; hi = COLOR_STOPS[s + 1]; break; }
  }
  const f = lo.v === hi.v ? 0 : (i - lo.v) / (hi.v - lo.v);
  LUMA[i * 4]     = Math.round(lo.r + (hi.r - lo.r) * f);
  LUMA[i * 4 + 1] = Math.round(lo.g + (hi.g - lo.g) * f);
  LUMA[i * 4 + 2] = Math.round(lo.b + (hi.b - lo.b) * f);
  LUMA[i * 4 + 3] = 255;
}
// 255 = ocean: transparent
LUMA[255 * 4 + 3] = 0;

// ── Draw one frame to ImageData ───────────────────────────────────────────────
function drawFrame(pixels: Uint8Array, frameIdx: number, w: number, h: number, imgData: ImageData) {
  const offset = frameIdx * w * h;
  const out = imgData.data;
  for (let i = 0; i < w * h; i++) {
    const v = pixels[offset + i];
    const src = v * 4;
    const dst = i * 4;
    out[dst]     = LUMA[src];
    out[dst + 1] = LUMA[src + 1];
    out[dst + 2] = LUMA[src + 2];
    out[dst + 3] = LUMA[src + 3];
  }
}

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Component ─────────────────────────────────────────────────────────────────
export default function GlobeApp() {
  const mountRef    = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef    = useRef<THREE.Scene | null>(null);
  const cameraRef   = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const textureRef  = useRef<THREE.CanvasTexture | null>(null);
  const canvasRef   = useRef<HTMLCanvasElement | null>(null);
  const imgDataRef  = useRef<ImageData | null>(null);
  const rafRef      = useRef<number>(0);
  const frameIdxRef = useRef(0);
  const playingRef  = useRef(false);

  const [globeData, setGlobeData]   = useState<GlobeData | null>(null);
  const [loading, setLoading]       = useState(true);
  const [loadProgress, setProgress] = useState(0);
  const [error, setError]           = useState<string | null>(null);
  const [frameIdx, setFrameIdx]     = useState(0);
  const [playing, setPlaying]       = useState(false);
  const [sceneReady, setSceneReady] = useState(false);

  // ── Load binary data ───────────────────────────────────────────────────────
  useEffect(() => {
    const url = '/data/soil_globe_texture_2024.bin';
    fetch(url)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const total = Number(r.headers.get('content-length') ?? 0);
        const reader = r.body!.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total > 0) setProgress(Math.round(received / total * 100));
        }
        // Concatenate
        const full = new Uint8Array(received);
        let pos = 0;
        for (const c of chunks) { full.set(c, pos); pos += c.length; }
        return full.buffer;
      })
      .then(buf => {
        const view = new DataView(buf);
        const headerLen = view.getUint32(0, true);
        const headerJson = new TextDecoder().decode(new Uint8Array(buf, 4, headerLen));
        const header: GlobeHeader = JSON.parse(headerJson);
        const pixels = new Uint8Array(buf, 4 + headerLen);
        setGlobeData({ header, pixels });
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  // ── Init Three.js ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mountRef.current) return;
    const W = mountRef.current.clientWidth;
    const H = mountRef.current.clientHeight;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000408, 1);
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 1000);
    camera.position.set(0, 0, 2.8);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1.4;
    controls.maxDistance = 5;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controlsRef.current = controls;

    // Dark ocean sphere underneath
    scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(0.999, 64, 64),
      new THREE.MeshBasicMaterial({ color: 0x020c1a })
    ));

    // Atmosphere glow
    scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(1.06, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x0a2a5a, transparent: true, opacity: 0.18, side: THREE.BackSide })
    ));

    // Data texture sphere — texture applied after data loads
    const texCanvas = document.createElement('canvas');
    texCanvas.width  = 720;
    texCanvas.height = 360;
    canvasRef.current = texCanvas;

    const texture = new THREE.CanvasTexture(texCanvas);
    texture.needsUpdate = true;
    textureRef.current = texture;

    const dataSphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.001, 128, 64),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true })
    );
    // Flip: Three.js sphere UV wraps differently from equirectangular convention
    dataSphere.rotation.y = Math.PI;
    scene.add(dataSphere);

    const handleResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth, h = mountRef.current.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', handleResize);

    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
    setSceneReady(true);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', handleResize);
      controls.dispose();
      texture.dispose();
      renderer.dispose();
      if (mountRef.current && renderer.domElement.parentNode === mountRef.current) {
        mountRef.current.removeChild(renderer.domElement);
      }
      sceneRef.current = null;
      rendererRef.current = null;
      setSceneReady(false);
    };
  }, []);

  // ── Update texture when frame changes ─────────────────────────────────────
  useEffect(() => {
    if (!globeData || !sceneReady) return;
    const { header, pixels } = globeData;
    const { width: w, height: h } = header;

    const texCanvas = canvasRef.current!;
    const ctx = texCanvas.getContext('2d')!;

    // Lazily create ImageData
    if (!imgDataRef.current) {
      imgDataRef.current = ctx.createImageData(w, h);
    }

    drawFrame(pixels, frameIdx, w, h, imgDataRef.current);
    ctx.putImageData(imgDataRef.current, 0, 0);

    if (textureRef.current) {
      textureRef.current.needsUpdate = true;
    }
  }, [globeData, frameIdx, sceneReady]);

  // ── Playback ───────────────────────────────────────────────────────────────
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { frameIdxRef.current = frameIdx; }, [frameIdx]);

  useEffect(() => {
    if (!playing || !globeData) return;
    const iv = setInterval(() => {
      const next = (frameIdxRef.current + 1) % globeData.header.weeks;
      frameIdxRef.current = next;
      setFrameIdx(next);
    }, 200);
    return () => clearInterval(iv);
  }, [playing, globeData]);

  // Stop auto-rotate on drag
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const stop = () => { if (controlsRef.current) controlsRef.current.autoRotate = false; };
    el.addEventListener('pointerdown', stop);
    return () => el.removeEventListener('pointerdown', stop);
  }, []);

  // ── Date label ─────────────────────────────────────────────────────────────
  const dateLabel = (() => {
    if (!globeData?.header.dates[frameIdx]) return '';
    const d = new Date(globeData.header.dates[frameIdx] + 'T00:00:00Z');
    return `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  })();

  const weeks = globeData?.header.weeks ?? 53;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="globe-shell">
      <div ref={mountRef} className="globe-canvas" />

      {loading && (
        <div className="globe-overlay">
          <div className="globe-loading">
            <div className="globe-spinner" />
            <div>Loading soil temperature data…</div>
            <div className="globe-progress-bar">
              <div className="globe-progress-fill" style={{ width: `${loadProgress}%` }} />
            </div>
            <div className="globe-loading-sub">{loadProgress}% · 720×360 · 53 weeks · 2024</div>
          </div>
        </div>
      )}
      {error && (
        <div className="globe-overlay">
          <div className="globe-error">
            <div>⚠ Data not ready</div>
            <div className="globe-error-sub">Run <code>python3 scripts/process-era5-texture.py --year 2024</code></div>
            <div className="globe-error-detail">{error}</div>
          </div>
        </div>
      )}

      {!loading && !error && globeData && (
        <>
          <div className="globe-hud-title">
            <div className="globe-eyebrow">Global soil temperature · ERA5</div>
            <div className="globe-title">Frost Globe</div>
          </div>
          <div className="globe-hud-date">
            <div className="globe-date-label">{dateLabel}</div>
            <div className="globe-week-label">Week {frameIdx + 1} of {weeks}</div>
          </div>
          <div className="globe-controls">
            <button className="globe-play-btn" onClick={() => setPlaying(p => !p)}>{playing ? '⏸' : '▶'}</button>
            <input type="range" min={0} max={weeks - 1} value={frameIdx}
              onChange={e => { setPlaying(false); setFrameIdx(Number(e.target.value)); }}
              className="globe-scrubber" />
          </div>
          <div className="globe-legend">
            <div className="globe-legend-bar" />
            <div className="globe-legend-labels"><span>−55°C</span><span>0°C</span><span>+50°C</span></div>
          </div>
          <div className="globe-tip">Drag to rotate · scroll to zoom</div>
        </>
      )}
    </div>
  );
}
