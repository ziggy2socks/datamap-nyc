#!/usr/bin/env python3
"""
Fetch 311 complaint lat/lng from NYC Open Data and bucket into a ~50m grid.
Writes static JSON files to public/data/311_heatmap_{year}.json

Each cell: { lat, lng, count } where lat/lng is the cell center.
Grid resolution: ~0.0005 degrees ≈ 55m N-S, 40m E-W at NYC latitude.

Usage:
  python3 scripts/fetch_311_heatmap.py           # current year
  python3 scripts/fetch_311_heatmap.py 2020 2025 # range
  python3 scripts/fetch_311_heatmap.py all       # 2020 to current year
"""

import sys, json, time, urllib.request, urllib.error
from pathlib import Path
from datetime import datetime
from collections import defaultdict

API     = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json'
OUT_DIR = Path(__file__).parent.parent / 'public' / 'data'

# ~50m resolution (0.0005° ≈ 55m N–S, ~40m E–W at 40.7°N)
GRID_RES = 0.0005

# NYC bounding box — filter out garbage coordinates
LAT_MIN, LAT_MAX = 40.4, 40.95
LNG_MIN, LNG_MAX = -74.3, -73.65

BATCH = 50_000   # rows per API request
MAX_ROWS_PER_QUARTER = 2_000_000  # safety cap


def snap(val: float) -> float:
    """Snap a coordinate to the nearest grid center."""
    return round(round(val / GRID_RES) * GRID_RES, 6)


def fetch_quarter(year: int, q: int) -> dict[tuple[float, float], int]:
    """
    Fetch one quarter of lat/lng data, return bucketed {(lat, lng): count}.
    Uses offset pagination to pull all rows.
    """
    starts = [f'{year}-01-01', f'{year}-04-01', f'{year}-07-01', f'{year}-10-01']
    ends   = [f'{year}-04-01', f'{year}-07-01', f'{year}-10-01', f'{year+1}-01-01']
    start, end = starts[q], ends[q]

    grid: dict[tuple[float, float], int] = defaultdict(int)
    offset = 0
    total_fetched = 0

    while True:
        qs = (
            f'$select=latitude,longitude'
            f'&$where=created_date>=\'{start}\'AND+created_date<\'{end}\''
            f'+AND+latitude+IS+NOT+NULL+AND+longitude+IS+NOT+NULL'
            f'&$limit={BATCH}&$offset={offset}'
        )
        url = f'{API}?{qs}'

        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={'Accept': 'application/json'})
                with urllib.request.urlopen(req, timeout=120) as r:
                    rows = json.loads(r.read())
                break
            except Exception as e:
                if attempt == 3:
                    raise
                wait = 5 * (attempt + 1)
                print(f'    retry {attempt+1} (wait {wait}s)...', end='', flush=True)
                time.sleep(wait)

        if not rows:
            break

        for row in rows:
            try:
                lat = float(row['latitude'])
                lng = float(row['longitude'])
            except (KeyError, ValueError, TypeError):
                continue
            # Filter bogus coordinates
            if not (LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX):
                continue
            grid[(snap(lat), snap(lng))] += 1

        total_fetched += len(rows)
        offset += BATCH
        print(f'\r    Q{q+1} offset={offset:,} cells={len(grid):,}   ', end='', flush=True)

        if len(rows) < BATCH or total_fetched >= MAX_ROWS_PER_QUARTER:
            break

    print()  # newline after progress
    return dict(grid)


def fetch_year(year: int) -> dict[tuple[float, float], int]:
    """Fetch all 4 quarters, merge grids."""
    merged: dict[tuple[float, float], int] = defaultdict(int)
    t0 = time.time()
    for q in range(4):
        print(f'  Q{q+1}...', flush=True)
        try:
            qgrid = fetch_quarter(year, q)
            for k, v in qgrid.items():
                merged[k] += v
        except Exception as e:
            print(f'  ERROR in Q{q+1}: {e}')
            raise
    elapsed = time.time() - t0
    total = sum(merged.values())
    print(f'  {year}: {len(merged):,} cells, {total:,} complaints in {elapsed:.0f}s')
    return dict(merged)


def write_year(year: int, grid: dict[tuple[float, float], int]):
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Compute p99 to detect default-coordinate artifacts
    # (311 system assigns a default lat/lng to complaints with no real address)
    all_counts = sorted(grid.values())
    p99 = all_counts[int(len(all_counts) * 0.999)]  # 99.9th percentile
    cap = max(p99 * 3, 5000)  # anything 3× above p99.9 is an artifact

    # Filter: remove singleton cells (noise) and cap artifact outliers
    cells = sorted(
        [
            {'lat': k[0], 'lng': k[1], 'count': min(v, cap)}
            for k, v in grid.items()
            if v >= 2  # drop single-complaint cells (reduces file size ~12%)
            and not (v > cap)  # drop artifact outliers entirely
        ],
        key=lambda c: c['count'],
        reverse=True,
    )

    # Summary stats for debugging
    counts = [c['count'] for c in cells]
    p50 = sorted(counts)[len(counts) // 2]
    p95 = sorted(counts)[int(len(counts) * 0.95)]
    p99 = sorted(counts)[int(len(counts) * 0.99)]
    total = sum(counts)
    print(f'  stats: cells={len(cells):,} total={total:,} median={p50} p95={p95} p99={p99} max={counts[0]}')

    payload = {
        'year':      year,
        'generated': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'res':       GRID_RES,
        'cells':     cells,
    }
    out = OUT_DIR / f'311_heatmap_{year}.json'
    out.write_text(json.dumps(payload, separators=(',', ':')))
    size_kb = out.stat().st_size / 1024
    print(f'  → {out.name} ({size_kb:.0f} KB, {len(cells):,} cells)')


def main():
    current_year = datetime.now().year

    if len(sys.argv) == 1:
        years = [current_year]
    elif sys.argv[1] == 'all':
        years = list(range(2020, current_year + 1))
    else:
        try:
            if len(sys.argv) == 2:
                years = [int(sys.argv[1])]
            else:
                start, end = int(sys.argv[1]), int(sys.argv[2])
                years = list(range(start, end + 1))
        except ValueError:
            print('Usage: fetch_311_heatmap.py [year | start end | all]')
            sys.exit(1)

    print(f'Fetching heatmap grids for: {years}')
    print(f'Grid resolution: {GRID_RES}° (~50m), batch size: {BATCH:,}')
    for year in years:
        print(f'\n── {year} ──')
        try:
            grid = fetch_year(year)
            write_year(year, grid)
        except Exception as e:
            print(f'  FAILED {year}: {e}')

    print('\nDone.')


if __name__ == '__main__':
    main()
