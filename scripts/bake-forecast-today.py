#!/usr/bin/env python3
"""
Bake today's soil temperature forecast tile for the globe.
Run daily via cron: 0 6 * * * cd /path/to/datamap && python3 scripts/bake-forecast-today.py
Output: public/data/soil_globe_texture_forecast.bin
"""
import json
import math
import struct
import time
import requests
from datetime import date
from pathlib import Path

FORECAST_URL = "https://forecast-api.open-meteo.com/v1/forecast"
VARIABLE = "soil_temperature_0_to_7cm"
STEP = 2
W, H = 720, 360
BATCH = 200
DELAY = 0.5
MAX_RETRIES = 4
OCEAN = 255
TEMP_MIN = -55.0
TEMP_MAX = 50.0
OUT_PATH = Path("/home/zig19/.openclaw/workspace/projects/datamap/public/data/soil_globe_texture_forecast.bin")


def build_grid():
    lats, lons = [], []
    for lat in range(-88, 89, STEP):
        for lon in range(-178, 179, STEP):
            lats.append(lat)
            lons.append(lon)
    return lats, lons


def temp_to_u8(t):
    return max(0, min(254, round((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN) * 254)))


def fetch_batch(lats_b, lons_b, today):
    url = (
        f"{FORECAST_URL}"
        f"?latitude={','.join(map(str, lats_b))}"
        f"&longitude={','.join(map(str, lons_b))}"
        f"&hourly={VARIABLE}"
        f"&start_date={today}"
        f"&end_date={today}"
        f"&timezone=UTC&forecast_days=1"
    )
    for attempt in range(MAX_RETRIES):
        try:
            r = requests.get(url, timeout=30)
            if r.status_code == 429:
                wait = 30 * (2 ** attempt)
                print(f"    429 — waiting {wait}s...")
                time.sleep(wait)
                continue
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict):
                data = [data]
            out = []
            for pt in data:
                vals = [v for v in pt.get("hourly", {}).get(VARIABLE, []) if v is not None]
                out.append(sum(vals) / len(vals) if vals else None)
            return out
        except Exception as e:
            print(f"    retry {attempt + 1}/{MAX_RETRIES}: {e}")
            time.sleep(5)
    return [None] * len(lats_b)


def interpolate(point_data):
    import numpy as np
    GW = int(360 / STEP) + 1
    GH = int(180 / STEP) + 1
    sparse = np.full((GH, GW), float("nan"))
    for key, temp in point_data.items():
        lat, lon = map(float, key.split(","))
        gx = round((lon + 178) / STEP)
        gy = round((88 - lat) / STEP)
        if 0 <= gx < GW and 0 <= gy < GH:
            sparse[gy, gx] = temp
    pixels = bytearray(H * W)
    for ty in range(H):
        for tx in range(W):
            lon = tx * 0.5 - 179.75
            lat = 89.75 - ty * 0.5
            gxf = (lon + 178) / STEP
            gyf = (88 - lat) / STEP
            gx0, gy0 = int(gxf), int(gyf)
            gx1 = min(gx0 + 1, GW - 1)
            gy1 = min(gy0 + 1, GH - 1)
            fx, fy = gxf - gx0, gyf - gy0
            corners = [
                (sparse[gy0, gx0], (1 - fx) * (1 - fy)),
                (sparse[gy0, gx1], fx * (1 - fy)),
                (sparse[gy1, gx0], (1 - fx) * fy),
                (sparse[gy1, gx1], fx * fy),
            ]
            valid = [(v, w) for v, w in corners if not math.isnan(v)]
            if not valid:
                pixels[ty * W + tx] = OCEAN
                continue
            tw = sum(w for _, w in valid)
            pixels[ty * W + tx] = temp_to_u8(sum(v * w for v, w in valid) / tw) if tw else OCEAN
    return bytes(pixels)


def main():
    today = date.today().isoformat()
    print(f"Baking forecast for {today}...")
    lats, lons = build_grid()
    total = len(lats)
    batches = math.ceil(total / BATCH)
    print(f"Grid: {total:,} points, {batches} batches")
    pts = {}
    for bi, i in enumerate(range(0, total, BATCH)):
        lb = lats[i:i + BATCH]
        lo = lons[i:i + BATCH]
        temps = fetch_batch(lb, lo, today)
        for j, t in enumerate(temps):
            if t is not None:
                pts[f"{lb[j]},{lo[j]}"] = t
        if (bi + 1) % 10 == 0 or bi == batches - 1:
            print(f"  Batch {bi + 1}/{batches} — {len(pts)} land pts so far")
        if bi < batches - 1:
            time.sleep(DELAY)
    print(f"Interpolating {len(pts)} land points to {W}x{H} texture...")
    pixels = interpolate(pts)
    header = {
        "type": "forecast",
        "date": today,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "grid_step_deg": STEP,
        "texture_w": W,
        "texture_h": H,
        "variable": VARIABLE,
        "temp_min": TEMP_MIN,
        "temp_max": TEMP_MAX,
        "ocean_sentinel": OCEAN,
        "weeks": 1,
        "dates": [today],
    }
    hb = json.dumps(header).encode()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "wb") as f:
        f.write(struct.pack("<I", len(hb)))
        f.write(hb)
        f.write(pixels)
    print(f"Done — {OUT_PATH.stat().st_size / 1024:.0f}KB written to {OUT_PATH.name}")


if __name__ == "__main__":
    main()
