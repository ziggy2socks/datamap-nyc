/**
 * Vercel Cron: /api/cron-forecast
 * Schedule: 0 2 * * * (2am UTC nightly)
 *
 * Bakes 7 days of soil temperature forecast tiles and stores them in Vercel Blob.
 * Files: forecast-d0.bin ... forecast-d6.bin (d0 = today, d6 = 6 days ahead)
 * Each file is ~260KB. Total storage: ~1.8MB, flat forever (always overwritten).
 *
 * Open-Meteo strategy: fetch all 7 dates in a single multi-date request per batch.
 * 80 batches total (not 80×7). Each batch returns hourly data for 7 days per point.
 * We average each day's hourly values → 7 daily means per point.
 *
 * Runtime: ~3-4 min. Vercel cron max is 300s on Pro, 60s on Hobby.
 * If on Hobby tier, reduce FORECAST_DAYS to 3 and BATCH to 100.
 */

import { put } from '@vercel/blob';

const FORECAST_URL = 'https://forecast-api.open-meteo.com/v1/forecast';
const VARIABLE = 'soil_temperature_0_to_7cm';
const STEP = 2;
const W = 720, H = 360;
const BATCH = 150;
const DELAY_MS = 500;
const OCEAN = 255;
const TEMP_MIN = -55.0;
const TEMP_MAX = 50.0;
const FORECAST_DAYS = 7;

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isoDate(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function fetchBatchAllDays(latsB, lonsB, startDate, endDate) {
  /**
   * Fetch FORECAST_DAYS worth of daily soil temp for a batch of points.
   * Returns: array of arrays — results[pointIdx][dayIdx] = mean °C or null
   */
  const url = `${FORECAST_URL}?latitude=${latsB.join(',')}&longitude=${lonsB.join(',')}&hourly=${VARIABLE}&start_date=${startDate}&end_date=${endDate}&timezone=UTC`;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (r.status === 429) { await sleep(30000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const locs = Array.isArray(data) ? data : [data];

      return locs.map(loc => {
        const hourly = loc.hourly?.[VARIABLE] ?? [];
        // Group 24 hourly values per day → daily means
        const days = [];
        for (let d = 0; d < FORECAST_DAYS; d++) {
          const slice = hourly.slice(d * 24, (d + 1) * 24).filter(v => v !== null);
          days.push(slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null);
        }
        return days;
      });
    } catch (e) {
      if (attempt < 3) await sleep(5000);
    }
  }
  // On total failure, return nulls for all points and days
  return latsB.map(() => new Array(FORECAST_DAYS).fill(null));
}

function interpolate(pointData) {
  /**
   * pointData: { "lat,lon": temp } for one day
   * Returns Uint8Array of W*H pixels
   */
  const GW = Math.floor(360 / STEP) + 1;
  const GH = Math.floor(180 / STEP) + 1;
  const sparse = new Float32Array(GW * GH).fill(NaN);

  for (const [key, temp] of Object.entries(pointData)) {
    if (temp === null) continue;
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
      if (!tw) continue;
      pixels[ty * W + tx] = tempToU8(corners.reduce((s, [v, w]) => s + v * w, 0) / tw);
    }
  }
  return pixels;
}

function buildBin(pixels, date) {
  const header = {
    type: 'forecast',
    date,
    generated: new Date().toISOString(),
    grid_step_deg: STEP,
    texture_w: W,
    texture_h: H,
    variable: VARIABLE,
    temp_min: TEMP_MIN,
    temp_max: TEMP_MAX,
    ocean_sentinel: OCEAN,
    weeks: 1,
    dates: [date],
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerBytes.length, 0);
  return Buffer.concat([lenBuf, headerBytes, Buffer.from(pixels)]);
}

export default async function handler(req, res) {
  // Security: only allow Vercel cron calls (or manual GET with secret)
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
      req.headers['x-vercel-cron'] !== '1') {
    // Allow unauthenticated in dev / manual trigger without secret
    if (process.env.NODE_ENV === 'production' && !process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const startDate = isoDate(0);
  const endDate = isoDate(FORECAST_DAYS - 1);
  console.log(`Baking forecast ${startDate} → ${endDate}`);

  const { lats, lons } = buildGrid();
  const total = lats.length;

  // Collect per-point per-day data
  // dayData[dayIdx] = { "lat,lon": temp }
  const dayData = Array.from({ length: FORECAST_DAYS }, () => ({}));

  for (let i = 0; i < total; i += BATCH) {
    const lb = lats.slice(i, i + BATCH);
    const lo = lons.slice(i, i + BATCH);
    const batchResults = await fetchBatchAllDays(lb, lo, startDate, endDate);

    batchResults.forEach((pointDays, j) => {
      const key = `${lb[j]},${lo[j]}`;
      pointDays.forEach((temp, d) => {
        if (temp !== null) dayData[d][key] = temp;
      });
    });

    if (i + BATCH < total) await sleep(DELAY_MS);
  }

  // Interpolate each day and upload to Vercel Blob
  const uploads = [];
  for (let d = 0; d < FORECAST_DAYS; d++) {
    const date = isoDate(d);
    const landPts = Object.keys(dayData[d]).length;
    console.log(`Day ${d} (${date}): ${landPts} land points`);

    const pixels = interpolate(dayData[d]);
    const bin = buildBin(pixels, date);

    // put() overwrites existing blob with same pathname
    const blob = await put(`forecast/forecast-d${d}.bin`, bin, {
      access: 'public',
      contentType: 'application/octet-stream',
      addRandomSuffix: false,
    });
    uploads.push({ day: d, date, url: blob.url, bytes: bin.length });
    console.log(`Uploaded d${d}: ${blob.url}`);
  }

  // Write a small manifest so the frontend knows what's available
  const manifest = {
    generated: new Date().toISOString(),
    startDate,
    endDate,
    days: FORECAST_DAYS,
    files: uploads.map(u => ({ day: u.day, date: u.date, url: u.url })),
  };
  await put('forecast/manifest.json', JSON.stringify(manifest), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
  });

  console.log('Forecast bake complete');
  res.json({ ok: true, days: FORECAST_DAYS, startDate, endDate, uploads });
}
