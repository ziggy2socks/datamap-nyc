#!/usr/bin/env python3
"""
Bake today's soil temperature forecast into a binary tile for the globe.

Fetches soil_temperature_0_to_7cm from Open-Meteo forecast API
(free tier, no auth, same CORS rules as archive) for the current date
at 2° global grid, then bakes into the same .bin format used by
soil_globe_texture_YYYY.bin.

Output: public/data/soil_globe_texture_forecast.bin

Run daily via cron (~6am UTC) so the globe always has a fresh "today" tile:
  0 6 * * * cd /path/to/datamap && python3 scripts/bake-forecast-today.py

The frontend LIVE button loads this file instead of calling Open-Meteo directly.
Staleness: max 24h — fine for soil temperature.
"""

import json
import math
import struct
import time
import urllib.request
import urllib.error
from datetime import date, timedelta
from pathlib import Path

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

# ── Config ────────────────────────────────────────────────────────────────────
FORECAST_URL = "https://forecast-api.open-meteo.com/v1/forecast"
VARIABLE     = "soil_temperature_0_to_7cm"   # hourly; we'll average to daily
STEP         = 2        # 2° grid — matches historical tiles
W, H         = 720, 360 # texture resolution
BATCH        = 200      # points per API request (conservative)
DELAY        = 0.5      # seconds between batches
MAX_RETRIES  = 4
OCEAN_SENTINEL = 255
TEMP_MIN     = -55.0
TEMP_MAX     =  50.0

OUT_PATH = Path(__file__).parent.parent / "public" / "data" / "soil_globe_texture_forecast.bin"

# ── Grid ──────────────────────────────────────────────────────────────────────
def build_grid():
    lats, lons = [], []
    for lat in range(-88, 89, STEP):
        for lon in range(-178, 179, STEP):
            lats.append(lat)
            lons.append(lon)
    return lats, lons

# ── Encoding ─────────────────────────────────────────────────────────────────
def temp_to_u8(t: float) -> int:
    return max(0, min(254, round((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN) * 254)))

# ── Forecast fetch ────────────────────────────────────────────────────────────
def fetch_batch_forecast(lats_batch, lons_batch, target_date: date) -> list:
    """
    Fetch hourly soil_temperature_0_to_7cm for target_date and average to daily mean.
    Returns list of floats (or None) for each point.
    """
    date_str = target_date.isoformat()
    lat_str  = ",".join(str(x) for x in lats_batch)
    lon_str  = ",".join(str(x) for x in lons_batch)
    url = (
        f"{FORECAST_URL}"
        f"?latitude={lat_str}"
        f"&longitude={lon_str}"
        f"&hourly={VARIABLE}"
        f"&start_date={date_str}"
        f"&end_date={date_str}"
        f"&timezone=UTC"
        f"&forecast_days=1"
    )

    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                data = json.loads(r.read())
            if isinstance(data, dict):
                data = [data]
            results = []
            for pt in data:
                hourly = pt.get("hourly", {}).get(VARIABLE, [])
                valid  = [v for v in hourly if v is not None]
                results.append(sum(valid) / len(valid) if valid else None)
            return results
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 30 * (2 ** attempt)
                print(f"    429 rate-limit, waiting {wait}s...")
                time.sleep(wait)
            else:
                print(f"    HTTP {e.code}: {e}")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(10)
                else:
                    return [None] * len(lats_batch)
        except Exception as e:
            print(f"    Error: {e} — retrying...")
            time.sleep(5)

    return [None] * len(lats_batch)

# ── Interpolate 2° point data → 720×360 texture ──────────────────────────────
def interpolate_to_texture(point_data: dict) -> bytes:
    """Bilinear interpolate 2° grid to 720×360 uint8."""
    GRID_W = int(360 / STEP) + 1
    GRID_H = int(180 / STEP) + 1

    if HAS_NUMPY:
        import numpy as np
        sparse = np.full((GRID_H, GRID_W), float("nan"))
        for key, temp in point_data.items():
            lat, lon = map(float, key.split(","))
            gx = round((lon + 178) / STEP)
            gy = round((88 - lat) / STEP)
            if 0 <= gx < GRID_W and 0 <= gy < GRID_H:
                sparse[gy, gx] = temp

        pixels = bytearray(H * W)
        for ty in range(H):
            for tx in range(W):
                lon = tx * 0.5 - 179.75
                lat = 89.75 - ty * 0.5
                gxf = (lon + 178) / STEP
                gyf = (88 - lat) / STEP
                gx0, gy0 = int(gxf), int(gyf)
                gx1 = min(gx0 + 1, GRID_W - 1)
                gy1 = min(gy0 + 1, GRID_H - 1)
                fx, fy = gxf - gx0, gyf - gy0
                v00 = sparse[gy0, gx0]
                v10 = sparse[gy0, gx1]
                v01 = sparse[gy1, gx0]
                v11 = sparse[gy1, gx1]
                vals = [
                    (v00, (1-fx)*(1-fy)), (v10, fx*(1-fy)),
                    (v01, (1-fx)*fy),     (v11, fx*fy)
                ]
                valid_vals = [(v, w) for v, w in vals if not math.isnan(v)]
                if not valid_vals:
                    pixels[ty * W + tx] = OCEAN_SENTINEL
                    continue
                total_w = sum(w for _, w in valid_vals)
                temp = sum(v * w for v, w in valid_vals) / total_w if total_w else None
                pixels[ty * W + tx] = temp_to_u8(temp) if temp is not None else OCEAN_SENTINEL
    else:
        # Pure Python fallback (slower but works)
        sparse = {}
        for key, temp in point_data.items():
            lat, lon = map(float, key.split(","))
            gx = round((lon + 178) / STEP)
            gy = round((88 - lat) / STEP)
            if 0 <= gx < GRID_W and 0 <= gy < GRID_H:
                sparse[(gy, gx)] = temp

        pixels = bytearray(H * W)
        for ty in range(H):
            for tx in range(W):
                lon = tx * 0.5 - 179.75
                lat = 89.75 - ty * 0.5
                gxf = (lon + 178) / STEP
                gyf = (88 - lat) / STEP
                gx0, gy0 = int(gxf), int(gyf)
                gx1 = min(gx0 + 1, GRID_W - 1)
                gy1 = min(gy0 + 1, GRID_H - 1)
                fx, fy = gxf - gx0, gyf - gy0
                vals = [
                    (sparse.get((gy0, gx0)), (1-fx)*(1-fy)),
                    (sparse.get((gy0, gx1)), fx*(1-fy)),
                    (sparse.get((gy1, gx0)), (1-fx)*fy),
                    (sparse.get((gy1, gx1)), fx*fy),
                ]
                valid_vals = [(v, w) for v, w in vals if v is not None]
                if not valid_vals:
                    pixels[ty * W + tx] = OCEAN_SENTINEL
                    continue
                total_w = sum(w for _, w in valid_vals)
                temp = sum(v * w for v, w in valid_vals) / total_w if total_w else None
                pixels[ty * W + tx] = temp_to_u8(temp) if temp is not None else OCEAN_SENTINEL

    return bytes(pixels)

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    today = date.today()
    print(f"Baking forecast tile for {today}...")

    lats, lons = build_grid()
    total = len(lats)
    batches = math.ceil(total / BATCH)
    print(f"Grid: {total:,} points, {batches} batches")

    point_data = {}
    start = time.time()

    for bi, i in enumerate(range(0, total, BATCH)):
        lats_b = lats[i:i+BATCH]
        lons_b = lons[i:i+BATCH]
        temps  = fetch_batch_forecast(lats_b, lons_b, today)

        for j, temp in enumerate(temps):
            if temp is not None:
                key = f"{lats_b[j]},{lons_b[j]}"
                point_data[key] = temp

        if (bi + 1) % 20 == 0 or bi == batches - 1:
            pct = (bi + 1) / batches * 100
            elapsed = time.time() - start
            eta = elapsed / (bi + 1) * (batches - bi - 1)
            print(f"  Batch {bi+1}/{batches} ({pct:.0f}%) — {len(point_data)} pts — ETA {eta:.0f}s")

        if bi < batches - 1:
            time.sleep(DELAY)

    land_pts = len(point_data)
    print(f"\nFetched {land_pts:,} land points. Interpolating to texture...")

    pixels = interpolate_to_texture(point_data)

    header = {
        "type": "forecast",
        "date": today.isoformat(),
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "grid_step_deg": STEP,
        "texture_w": W,
        "texture_h": H,
        "variable": VARIABLE,
        "temp_min": TEMP_MIN,
        "temp_max": TEMP_MAX,
        "ocean_sentinel": OCEAN_SENTINEL,
        "weeks": 1,
        "dates": [today.isoformat()],
    }

    header_bytes = json.dumps(header).encode("utf-8")
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "wb") as f:
        f.write(struct.pack("<I", len(header_bytes)))
        f.write(header_bytes)
        f.write(pixels)

    size_kb = OUT_PATH.stat().st_size / 1024
    elapsed = time.time() - start
    print(f"\n✓ Wrote {OUT_PATH.name} — {size_kb:.0f}KB in {elapsed:.0f}s")
    print(f"  Date: {today}")
    print(f"  Land points: {land_pts:,}")

if __name__ == "__main__":
    main()
