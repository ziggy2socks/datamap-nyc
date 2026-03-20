#!/usr/bin/env python3
"""
Fill the 2026 ERA5 gap using Open-Meteo archive API.

ERA5 monthly means have a ~5-day lag — our 2026 binary only has Jan data.
This script fetches Feb + recent March 2026 weekly frames from Open-Meteo
archive (which covers up to ~5 days ago) and appends them to the 2026 binary.

Usage:
  python3 scripts/fill-2026-gap.py

Writes: public/data/soil_globe_texture_2026.bin (updated in place)
"""

import json, struct, time, math
from datetime import date, timedelta
from pathlib import Path
import numpy as np
import requests

BIN_PATH = Path(__file__).parent.parent / "public/data/soil_globe_texture_2026.bin"
W, H     = 720, 360
STEP     = 2        # 2° source grid
BATCH    = 200      # conservative batch size to avoid 429
DELAY    = 0.5      # seconds between batches
OCEAN_SENTINEL = 255
TEMP_MIN = -55.0
TEMP_MAX =  50.0

def weekly_mondays(year: int, from_date: date, to_date: date):
    """All Mondays in [from_date, to_date]."""
    d = from_date
    while d.weekday() != 0:
        d += timedelta(days=1)
    out = []
    while d <= to_date:
        out.append(d)
        d += timedelta(weeks=1)
    return out

def temp_to_u8(t: float) -> int:
    return max(0, min(254, round((t - TEMP_MIN) / (TEMP_MAX - TEMP_MIN) * 254)))

def fetch_week(monday: date, lats: list, lons: list) -> dict[str, float]:
    """Fetch mean soil temp for the 7 days starting at monday. Returns {lat,lon: temp}."""
    end = monday + timedelta(days=6)
    results = {}
    total = len(lats)
    batches = math.ceil(total / BATCH)

    for i in range(batches):
        bL = lats[i*BATCH:(i+1)*BATCH]
        bLon = lons[i*BATCH:(i+1)*BATCH]
        url = (
            f"https://archive-api.open-meteo.com/v1/archive"
            f"?latitude={','.join(map(str, bL))}"
            f"&longitude={','.join(map(str, bLon))}"
            f"&daily=soil_temperature_0_to_7cm_mean"
            f"&start_date={monday.isoformat()}"
            f"&end_date={end.isoformat()}"
            f"&timezone=UTC"
        )

        for attempt in range(4):
            try:
                r = requests.get(url, timeout=30)
                if r.status_code == 429:
                    wait = 5 * (attempt + 1)
                    print(f"    429 — waiting {wait}s...")
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                break
            except requests.exceptions.RequestException as e:
                print(f"    Error: {e} — retrying...")
                time.sleep(3)
        else:
            print(f"    Skipping batch after 4 failures")
            continue

        data = r.json()
        locs = data if isinstance(data, list) else [data]
        for j, loc in enumerate(locs):
            temps = loc.get("daily", {}).get("soil_temperature_0_to_7cm_mean", [])
            valid = [v for v in temps if v is not None]
            if not valid:
                continue
            mean = sum(valid) / len(valid)
            results[f"{bL[j]},{bLon[j]}"] = mean

        if i < batches - 1:
            time.sleep(DELAY)

    return results

def interpolate_to_texture(point_data: dict[str, float]) -> np.ndarray:
    """Bilinear interpolate 2° point data into 720×360 uint8 texture."""
    GRID_W = int(360 / STEP) + 1
    GRID_H = int(180 / STEP) + 1
    sparse = np.full((GRID_H, GRID_W), np.nan)

    for key, temp in point_data.items():
        lat, lon = map(float, key.split(','))
        gx = round((lon + 178) / STEP)
        gy = round((88 - lat) / STEP)
        if 0 <= gx < GRID_W and 0 <= gy < GRID_H:
            sparse[gy, gx] = temp

    pixels = np.full(H * W, OCEAN_SENTINEL, dtype=np.uint8)
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

            vals = [(v, w) for v, w in [
                (v00, (1-fx)*(1-fy)), (v10, fx*(1-fy)),
                (v01, (1-fx)*fy),     (v11, fx*fy)
            ] if not np.isnan(v)]

            if not vals:
                continue
            total_w = sum(w for _, w in vals)
            if total_w == 0:
                continue
            temp = sum(v * w for v, w in vals) / total_w
            pixels[ty * W + tx] = temp_to_u8(temp)

    return pixels

def main():
    # Read existing binary
    with open(BIN_PATH, 'rb') as f:
        hlen = struct.unpack('<I', f.read(4))[0]
        header = json.loads(f.read(hlen))
        existing_pixels = f.read()

    existing_dates = [date.fromisoformat(d) for d in header['dates']]
    last_date = max(existing_dates)
    print(f"Existing 2026 data: {len(existing_dates)} weeks, last = {last_date}")

    # Determine gap: next Monday after last existing date, up to 5 days ago
    cutoff = date.today() - timedelta(days=5)
    start  = last_date + timedelta(weeks=1)
    if start > cutoff:
        print("No gap to fill — data is current.")
        return

    new_mondays = weekly_mondays(2026, start, cutoff)
    print(f"Filling {len(new_mondays)} new weeks: {new_mondays[0]} → {new_mondays[-1]}")

    # Build 2° grid
    lats, lons = [], []
    for lat in range(-88, 89, STEP):
        for lon in range(-178, 179, STEP):
            lats.append(lat); lons.append(lon)
    print(f"Grid: {len(lats)} points, {math.ceil(len(lats)/BATCH)} batches/week")

    new_frames = []
    for i, monday in enumerate(new_mondays):
        print(f"\nWeek {i+1}/{len(new_mondays)}: {monday}")
        pts = fetch_week(monday, lats, lons)
        land = sum(1 for v in pts.values() if v is not None)
        print(f"  Got {land} land points")
        frame = interpolate_to_texture(pts)
        new_frames.append((monday, frame))
        time.sleep(1)  # breathe between weeks

    if not new_frames:
        print("No new data fetched.")
        return

    # Rebuild binary with all frames
    all_dates = existing_dates + [d for d, _ in new_frames]
    all_pixels = bytearray(existing_pixels)
    for _, frame in new_frames:
        all_pixels.extend(frame.tobytes())

    header['weeks'] = len(all_dates)
    header['dates'] = [d.isoformat() for d in all_dates]

    header_bytes = json.dumps(header).encode('utf-8')
    with open(BIN_PATH, 'wb') as f:
        f.write(struct.pack('<I', len(header_bytes)))
        f.write(header_bytes)
        f.write(all_pixels)

    size_mb = BIN_PATH.stat().st_size / 1024 / 1024
    print(f"\n✓ Updated {BIN_PATH.name} — {len(all_dates)} weeks, {size_mb:.1f}MB")
    print(f"  Dates: {all_dates[0]} → {all_dates[-1]}")

if __name__ == '__main__':
    main()
