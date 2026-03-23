/**
 * Vercel serverless function: /api/forecast
 *
 * Returns a pre-baked soil temperature forecast tile in the same binary
 * format as the ERA5 historical .bin files. The frontend LIVE/TODAY button
 * fetches this endpoint instead of calling Open-Meteo directly.
 *
 * Caching: Vercel CDN caches the response for 23h (stale-while-revalidate 1h).
 * First request of the day does the work; all subsequent requests are instant.
 *
 * Format (same as soil_globe_texture_YYYY.bin):
 *   [4 bytes LE uint32] header length
 *   [N bytes UTF-8 JSON] header object
 *   [720*360 bytes] uint8 pixel array (255 = ocean sentinel)
 */

const FORECAST_URL = 'https://forecast-api.open-meteo.com/v1/forecast';
const VARIABLE = 'soil_temperature_0_to_7cm';
const STEP = 2;
const W = 720, H = 360;
const BATCH = 200;
const DELAY_MS = 400;
const OCEAN = 255;
const TEMP_MIN = -55.0;
const TEMP_MAX = 50.0;

function tempToU8(t) {
  return Math.max(0, Math.min(254, Math.round((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN) * 254)));
}

function buildGrid() {
  const lats = [], lons = [];
  for (let lat = -88; lat <= 88; lat += STEP)
    for (let lon = -178; lon <= 178; lon += STEP) {
      lats.push(lat); lons.push(lon);
    }
  return { lats, lons };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchBatch(latsB, lonsB, today) {
  const url = `${FORECAST_URL}?latitude=${latsB.join(',')}&longitude=${lonsB.join(',')}&hourly=${VARIABLE}&start_date=${today}&end_date=${today}&timezone=UTC&forecast_days=1`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (r.status === 429) {
        await sleep(30000 * (attempt + 1));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const locs = Array.isArray(data) ? data : [data];
      return locs.map(loc => {
        const vals = (loc.hourly?.[VARIABLE] ?? []).filter(v => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      });
    } catch (e) {
      if (attempt < 3) await sleep(5000);
    }
  }
  return new Array(latsB.length).fill(null);
}

function interpolate(pointData) {
  const GW = Math.floor(360 / STEP) + 1;
  const GH = Math.floor(180 / STEP) + 1;
  const sparse = new Float32Array(GW * GH).fill(NaN);

  for (const [key, temp] of Object.entries(pointData)) {
    const [lat, lon] = key.split(',').map(Number);
    const gx = Math.round((lon + 178) / STEP);
    const gy = Math.round((88 - lat) / STEP);
    if (gx >= 0 && gx < GW && gy >= 0 && gy < GH)
      sparse[gy * GW + gx] = temp;
  }

  const pixels = new Uint8Array(H * W).fill(OCEAN);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const lon = tx * 0.5 - 179.75;
      const lat = 89.75 - ty * 0.5;
      const gxf = (lon + 178) / STEP;
      const gyf = (88 - lat) / STEP;
      const gx0 = Math.floor(gxf), gy0 = Math.floor(gyf);
      const gx1 = Math.min(gx0 + 1, GW - 1), gy1 = Math.min(gy0 + 1, GH - 1);
      const fx = gxf - gx0, fy = gyf - gy0;
      const corners = [
        [sparse[gy0 * GW + gx0], (1 - fx) * (1 - fy)],
        [sparse[gy0 * GW + gx1], fx * (1 - fy)],
        [sparse[gy1 * GW + gx0], (1 - fx) * fy],
        [sparse[gy1 * GW + gx1], fx * fy],
      ].filter(([v]) => !isNaN(v));
      if (!corners.length) continue;
      const tw = corners.reduce((s, [, w]) => s + w, 0);
      if (tw === 0) continue;
      pixels[ty * W + tx] = tempToU8(corners.reduce((s, [v, w]) => s + v * w, 0) / tw);
    }
  }
  return pixels;
}

export default async function handler(req, res) {
  const today = new Date().toISOString().slice(0, 10);

  try {
    const { lats, lons } = buildGrid();
    const total = lats.length;
    const pointData = {};

    for (let i = 0; i < total; i += BATCH) {
      const lb = lats.slice(i, i + BATCH);
      const lo = lons.slice(i, i + BATCH);
      const temps = await fetchBatch(lb, lo, today);
      temps.forEach((t, j) => {
        if (t !== null) pointData[`${lb[j]},${lo[j]}`] = t;
      });
      if (i + BATCH < total) await sleep(DELAY_MS);
    }

    const pixels = interpolate(pointData);

    const header = {
      type: 'forecast',
      date: today,
      generated: new Date().toISOString(),
      grid_step_deg: STEP,
      texture_w: W,
      texture_h: H,
      variable: VARIABLE,
      temp_min: TEMP_MIN,
      temp_max: TEMP_MAX,
      ocean_sentinel: OCEAN,
      weeks: 1,
      dates: [today],
    };

    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(headerBytes.length, 0);
    const body = Buffer.concat([lenBuf, headerBytes, Buffer.from(pixels)]);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=82800, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(body);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
