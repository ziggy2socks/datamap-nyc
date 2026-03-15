#!/usr/bin/env python3
"""
Bake global soil temperature data for the frost-globe visualization.

Fetches soil_temperature_0_to_7cm_mean from Open-Meteo historical API
for a 2° global grid (16,200 points) across 52 weekly snapshots of 2024.

Output:
  public/data/soil_globe_2024.json  — compact float32 array + manifest
  public/data/soil_globe_manifest.json — grid/time metadata

Usage:
  python3 scripts/bake-globe-data.py
  python3 scripts/bake-globe-data.py --year 2023
  python3 scripts/bake-globe-data.py --dry-run   # test with 1 batch
"""

import json
import time
import math
import argparse
import urllib.request
import urllib.error
from datetime import date, timedelta
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
GRID_STEP = 2          # degrees — 2° = ~16,200 points
BATCH_SIZE = 100       # points per API request
MAX_RETRIES = 5
RETRY_DELAY = 30       # seconds between retries on 429
REQUEST_DELAY = 0.4    # seconds between batches (be nice to the API)
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
VARIABLE = "soil_temperature_0_to_7cm_mean"

# ── Build grid ────────────────────────────────────────────────────────────────
def build_grid(step=GRID_STEP):
    lats, lons = [], []
    for lat in range(-90 + step, 91, step):   # -88 to 90
        for lon in range(-180 + step, 181, step):  # -178 to 180
            lats.append(lat)
            lons.append(lon)
    return lats, lons

# ── Weekly dates for a year ───────────────────────────────────────────────────
def weekly_mondays(year):
    d = date(year, 1, 1)
    # Find first Monday
    while d.weekday() != 0:
        d += timedelta(days=1)
    mondays = []
    while d.year == year:
        mondays.append(d)
        d += timedelta(weeks=1)
    return mondays

# ── Fetch one batch of points for one date ────────────────────────────────────
def fetch_batch(lats_batch, lons_batch, target_date):
    lat_str = ",".join(str(x) for x in lats_batch)
    lon_str = ",".join(str(x) for x in lons_batch)
    date_str = target_date.strftime("%Y-%m-%d")
    url = (
        f"{ARCHIVE_URL}"
        f"?latitude={lat_str}"
        f"&longitude={lon_str}"
        f"&start_date={date_str}"
        f"&end_date={date_str}"
        f"&daily={VARIABLE}"
        f"&timezone=GMT"
    )

    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                data = json.loads(r.read())
            # data is a list of dicts when multiple points
            if isinstance(data, dict):
                data = [data]
            temps = []
            for pt in data:
                vals = pt.get("daily", {}).get(VARIABLE, [None])
                temps.append(vals[0])  # single date
            return temps
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = RETRY_DELAY * (2 ** attempt)  # exponential: 30, 60, 120, 240, 480s
                print(f"    429 rate-limit, waiting {wait}s (attempt {attempt+1}/{MAX_RETRIES})...")
                time.sleep(wait)
            else:
                print(f"    HTTP {e.code} error: {e}")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(RETRY_DELAY)
                else:
                    return [None] * len(lats_batch)
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < MAX_RETRIES - 1:
                print(f"    Retry {attempt+1}/{MAX_RETRIES} after error: {e}")
                time.sleep(RETRY_DELAY)
            else:
                print(f"    FAILED after {MAX_RETRIES} attempts: {e}")
                return [None] * len(lats_batch)
    return [None] * len(lats_batch)

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2024)
    parser.add_argument("--dry-run", action="store_true", help="Fetch only first batch of first week")
    args = parser.parse_args()

    year = args.year
    out_dir = Path(__file__).parent.parent / "public" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"soil_globe_{year}.json"
    manifest_path = out_dir / "soil_globe_manifest.json"

    lats, lons = build_grid()
    total_points = len(lats)
    batches = math.ceil(total_points / BATCH_SIZE)
    dates = weekly_mondays(year)

    print(f"Grid: {total_points:,} points ({GRID_STEP}° resolution)")
    print(f"Dates: {len(dates)} weekly Mondays in {year}")
    print(f"Batches per date: {batches} (batch size {BATCH_SIZE})")
    print(f"Total API requests: {batches * len(dates):,}")
    print(f"Est. time: ~{batches * len(dates) * (REQUEST_DELAY + 1) / 60:.0f} min")
    print()

    if args.dry_run:
        dates = dates[:1]
        print(f"DRY RUN — fetching only first week ({dates[0]}) first batch")

    # frames[week_idx] = [temp_for_point_0, temp_for_point_1, ...]
    all_frames = []

    # ── Resume support: load existing file if present ────────────────────────
    completed_dates = set()
    if out_path.exists() and not args.dry_run:
        try:
            with open(out_path) as f:
                existing = json.load(f)
            all_frames = existing.get("frames", [])
            completed_dates = set(existing.get("dates", []))
            print(f"Resuming: {len(completed_dates)} weeks already complete: {sorted(completed_dates)[:3]}...")
        except Exception as e:
            print(f"Could not load existing file for resume: {e}")
            all_frames = []

    start_total = time.time()

    for wi, target_date in enumerate(dates):
        date_str = target_date.strftime("%Y-%m-%d")
        if date_str in completed_dates:
            print(f"[{wi+1:02d}/{len(dates)}] {target_date} ... skipped (already complete)")
            continue

        print(f"[{wi+1:02d}/{len(dates)}] {target_date} ...", end=" ", flush=True)
        week_start = time.time()
        frame_temps = []

        for bi, start_i in enumerate(range(0, total_points if not args.dry_run else BATCH_SIZE, BATCH_SIZE)):
            end_i = min(start_i + BATCH_SIZE, total_points)
            lats_b = lats[start_i:end_i]
            lons_b = lons[start_i:end_i]
            temps = fetch_batch(lats_b, lons_b, target_date)
            frame_temps.extend(temps)
            time.sleep(REQUEST_DELAY)

            if args.dry_run:
                break  # only first batch

        # Round to 1 decimal to save space; None → null
        frame_rounded = [round(t, 1) if t is not None else None for t in frame_temps]
        all_frames.append(frame_rounded)
        completed_dates.add(date_str)

        # Write incrementally after each week so resume works on interruption
        out_partial = {
            "year": year,
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "grid_step_deg": GRID_STEP,
            "total_points": total_points,
            "lats": lats,
            "lons": lons,
            "dates": sorted(completed_dates),
            "variable": VARIABLE,
            "frames": all_frames,
        }
        with open(out_path, "w") as f:
            json.dump(out_partial, f, separators=(",", ":"))

        elapsed = time.time() - week_start
        non_null = sum(1 for v in frame_rounded if v is not None)
        print(f"{non_null}/{len(frame_rounded)} valid  ({elapsed:.1f}s)")

    total_elapsed = time.time() - start_total
    print(f"\nDone in {total_elapsed/60:.1f} min. Writing output...")

    # Write main data file
    out = {
        "year": year,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "grid_step_deg": GRID_STEP,
        "total_points": total_points,
        "lats": lats,
        "lons": lons,
        "dates": [d.strftime("%Y-%m-%d") for d in dates],
        "variable": VARIABLE,
        "frames": all_frames,
    }
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"Wrote {out_path} ({size_mb:.1f} MB)")

    # Write manifest (small file, loaded first by the globe)
    manifest = {
        "years_available": [year],
        "grid_step_deg": GRID_STEP,
        "total_points": total_points,
        "variable": VARIABLE,
        "files": {str(year): f"soil_globe_{year}.json"},
    }
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Wrote {manifest_path}")

if __name__ == "__main__":
    main()
