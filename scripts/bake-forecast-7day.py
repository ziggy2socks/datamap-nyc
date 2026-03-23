#!/usr/bin/env python3
"""
Bake 7-day soil temperature forecast tiles for the globe.

Fetches all 7 forecast days from Open-Meteo in a single pass
(each batch request covers all 7 dates simultaneously — efficient).

Output: public/data/forecast/forecast-d0.bin ... forecast-d6.bin
        public/data/forecast/manifest.json

d0 = today, d1 = tomorrow, ... d6 = 6 days from now.
Files are ~260KB each, ~1.8MB total. Always overwritten, never accumulates.

Run via GitHub Action (.github/workflows/bake-forecast.yml) at 2am UTC nightly.
"""

import json
import math
import struct
import time
import requests
from datetime import date, timedelta
from pathlib import Path

FORECAST_URL = "https://forecast-api.open-meteo.com/v1/forecast"
VARIABLE = "soil_temperature_0_to_7cm"
STEP = 2          # degrees — 2° source grid
W, H = 720, 360   # texture resolution
BATCH = 150       # points per API request
DELAY = 0.5       # seconds between batches
MAX_RETRIES = 4
OCEAN = 255
TEMP_MIN = -55.0
TEMP_MAX = 50.0
FORECAST_DAYS = 7

OUT_DIR = Path(__file__).parent.parent / "public" / "data" / "forecast"


def build_grid():
    lats, lons = [], []
    for lat in range(-88, 89, STEP):
        for lon in range(-178, 179, STEP):
            lats.append(lat)
            lons.append(lon)
    return lats, lons


def iso_date(offset=0):
    return (date.today() + timedelta(days=offset)).isoformat()


def temp_to_u8(t):
    return max(0, min(254, round((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN) * 254)))


def fetch_batch_all_days(lats_b, lons_b, start_date, end_date):
    """
    Fetch FORECAST_DAYS of hourly data for a batch of points in one request.
    Returns list[list[float|None]]: results[point_idx][day_idx]
    """
    url = (
        f"{FORECAST_URL}"
        f"?latitude={','.join(map(str, lats_b))}"
        f"&longitude={','.join(map(str, lons_b))}"
        f"&hourly={VARIABLE}"
        f"&start_date={start_date}"
        f"&end_date={end_date}"
        f"&timezone=UTC"
    )
    for attempt in range(MAX_RETRIES):
        try:
            r = requests.get(url, timeout=45)
            if r.status_code == 429:
                wait = 30 * (2 ** attempt)
                print(f"    429 — waiting {wait}s...")
                time.sleep(wait)
                continue
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict):
                data = [data]

            results = []
            for pt in data:
                hourly = pt.get("hourly", {}).get(VARIABLE, [])
                # Group into daily means (24 hourly values per day)
                days = []
                for d in range(FORECAST_DAYS):
                    slice_ = [v for v in hourly[d * 24:(d + 1) * 24] if v is not None]
                    days.append(sum(slice_) / len(slice_) if slice_ else None)
                results.append(days)
            return results

        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                print(f"    retry {attempt + 1}/{MAX_RETRIES}: {e}")
                time.sleep(5)
            else:
                print(f"    failed: {e}")

    # Total failure — return nulls
    return [[None] * FORECAST_DAYS for _ in lats_b]


def interpolate(point_data):
    """Bilinear interpolate 2° sparse grid → 720×360 uint8 texture."""
    import numpy as np
    GW = int(360 / STEP) + 1
    GH = int(180 / STEP) + 1
    sparse = np.full((GH, GW), float("nan"))

    for key, temp in point_data.items():
        if temp is None:
            continue
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


def write_bin(pixels, out_path, day_date):
    header = {
        "type": "forecast",
        "date": day_date,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "grid_step_deg": STEP,
        "texture_w": W,
        "texture_h": H,
        "variable": VARIABLE,
        "temp_min": TEMP_MIN,
        "temp_max": TEMP_MAX,
        "ocean_sentinel": OCEAN,
        "weeks": 1,
        "dates": [day_date],
    }
    hb = json.dumps(header).encode()
    with open(out_path, "wb") as f:
        f.write(struct.pack("<I", len(hb)))
        f.write(hb)
        f.write(pixels)


def main():
    start_date = iso_date(0)
    end_date = iso_date(FORECAST_DAYS - 1)
    print(f"Baking {FORECAST_DAYS}-day forecast: {start_date} → {end_date}")

    lats, lons = build_grid()
    total = len(lats)
    n_batches = math.ceil(total / BATCH)
    print(f"Grid: {total:,} points, {n_batches} batches (all {FORECAST_DAYS} days per batch)")

    # day_data[d] = { "lat,lon": mean_temp }
    day_data = [{} for _ in range(FORECAST_DAYS)]
    start_time = time.time()

    for bi, i in enumerate(range(0, total, BATCH)):
        lb = lats[i:i + BATCH]
        lo = lons[i:i + BATCH]
        batch_results = fetch_batch_all_days(lb, lo, start_date, end_date)

        for j, point_days in enumerate(batch_results):
            key = f"{lb[j]},{lo[j]}"
            for d, temp in enumerate(point_days):
                if temp is not None:
                    day_data[d][key] = temp

        if (bi + 1) % 10 == 0 or bi == n_batches - 1:
            elapsed = time.time() - start_time
            eta = elapsed / (bi + 1) * (n_batches - bi - 1)
            land_pts = len(day_data[0])
            print(f"  Batch {bi + 1}/{n_batches} — {land_pts} land pts — ETA {eta:.0f}s")

        if bi < n_batches - 1:
            time.sleep(DELAY)

    print(f"\nFetch complete in {(time.time() - start_time):.0f}s. Interpolating & writing tiles...")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    manifest_files = []
    for d in range(FORECAST_DAYS):
        day_date = iso_date(d)
        land_pts = len(day_data[d])
        print(f"  Day {d} ({day_date}): {land_pts} land points → interpolating...")
        pixels = interpolate(day_data[d])
        out_path = OUT_DIR / f"forecast-d{d}.bin"
        write_bin(pixels, out_path, day_date)
        size_kb = out_path.stat().st_size / 1024
        print(f"    → {out_path.name} ({size_kb:.0f}KB)")
        manifest_files.append({"day": d, "date": day_date, "path": f"/data/forecast/forecast-d{d}.bin"})

    # Write manifest
    manifest = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "start_date": start_date,
        "end_date": end_date,
        "days": FORECAST_DAYS,
        "files": manifest_files,
    }
    manifest_path = OUT_DIR / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    total_kb = sum(f.stat().st_size for f in OUT_DIR.glob("*.bin")) / 1024
    print(f"\n✓ Done — {FORECAST_DAYS} tiles + manifest, {total_kb:.0f}KB total")
    print(f"  Output: {OUT_DIR}")


if __name__ == "__main__":
    main()
