#!/usr/bin/env python3
"""
Re-score park access using merged open spaces (NYC Parks + regional/state parks).
Reads existing parcels.geojson, replaces park_score and park_gravity fields,
then rebuilds PMTiles.
"""
import json, math, subprocess, sys
import numpy as np
from pathlib import Path

DATA_DIR  = Path(__file__).parent.parent / "data"
RAW_DIR   = DATA_DIR / "raw"
PROC_DIR  = DATA_DIR / "processed"

MERGED_PARKS_FILE = RAW_DIR / "open_spaces_merged.geojson"
PARCELS_FILE      = PROC_DIR / "parcels.geojson"
OUT_PMTILES       = PROC_DIR / "parcels.pmtiles"

# Scoring constants (must match original build_parcel_data.py)
SEARCH_RADIUS_M  = 1609.34   # 1 mile in meters
DAMPING          = 50.0
SAMPLE_SPACING_M = 15.0
GRID_CELL_DEG    = 0.01
METERS_PER_DEG   = 111320.0

EXCLUDED_LANDUSE = {'09', '00', ''}

def sample_ring(ring_coords, spacing_m=SAMPLE_SPACING_M):
    pts = []
    for i in range(len(ring_coords) - 1):
        ax, ay = ring_coords[i]
        bx, by = ring_coords[i + 1]
        seg_len = math.sqrt(((bx - ax) * METERS_PER_DEG * math.cos(math.radians((ay + by) / 2)))**2 + ((by - ay) * METERS_PER_DEG)**2)
        steps = max(1, int(seg_len / spacing_m))
        for s in range(steps + 1):
            t = s / steps
            pts.append((ay + t * (by - ay), ax + t * (bx - ax)))
    return pts

def build_park_samples(parks_geojson):
    print("[parks] Sampling park polygon edges...", flush=True)
    sample_lats, sample_lngs, sample_acres = [], [], []
    for feat in parks_geojson['features']:
        geom = feat['geometry']
        props = feat['properties']
        # Get acreage — try different field names
        acres = float(props.get('acres') or props.get('ACRES') or 0)
        if acres <= 0:
            acres = 1.0  # default for regional parks without acreage

        gtype = geom['type']
        coords = geom['coordinates']
        if gtype == 'Polygon':
            polys = [coords]
        elif gtype == 'MultiPolygon':
            polys = coords
        else:
            continue

        for poly in polys:
            for ring in poly:
                pts = sample_ring(ring)
                for lat, lng in pts:
                    sample_lats.append(lat)
                    sample_lngs.append(lng)
                    sample_acres.append(acres)

    print(f"  {len(sample_lats):,} edge sample points from {len(parks_geojson['features'])} parks", flush=True)
    return np.array(sample_lats, np.float32), np.array(sample_lngs, np.float32), np.array(sample_acres, np.float32)

def build_grid_index(lats, lngs):
    grid = {}
    for i, (lat, lng) in enumerate(zip(lats, lngs)):
        key = (int(lat / GRID_CELL_DEG), int(lng / GRID_CELL_DEG))
        grid.setdefault(key, []).append(i)
    return grid

def compute_scores(parcels, lats, lngs, acrs, grid):
    print("[score] Computing park gravity scores...", flush=True)
    radius_deg = SEARCH_RADIUS_M / METERS_PER_DEG
    n_cells = math.ceil(radius_deg / GRID_CELL_DEG) + 1
    scores = np.zeros(len(parcels), np.float64)

    for i, p in enumerate(parcels):
        if i % 100_000 == 0:
            print(f"  {i:,}/{len(parcels):,}...", flush=True)
        coords = p["geometry"]["coordinates"]
        plng, plat = coords[0], coords[1]
        center_row = int(plat / GRID_CELL_DEG)
        center_col = int(plng / GRID_CELL_DEG)

        candidates = []
        for dr in range(-n_cells, n_cells + 1):
            for dc in range(-n_cells, n_cells + 1):
                key = (center_row + dr, center_col + dc)
                candidates.extend(grid.get(key, []))

        if not candidates:
            continue

        idx = np.array(candidates)
        s_lats = lats[idx]
        s_lngs = lngs[idx]
        s_acrs = acrs[idx]

        dlat = (s_lats - plat) * METERS_PER_DEG
        dlng = (s_lngs - plng) * METERS_PER_DEG * math.cos(math.radians(plat))
        dist = np.sqrt(dlat**2 + dlng**2)

        mask = dist <= SEARCH_RADIUS_M
        if not mask.any():
            continue

        a = s_acrs[mask]
        d = dist[mask]
        scores[i] = float(np.sum(a / (d + DAMPING) ** 2))

    return scores

def percentile_rank(values, excluded_indices):
    valid_mask = np.ones(len(values), dtype=bool)
    for i in excluded_indices:
        valid_mask[i] = False
    valid_scores = values[valid_mask]
    valid_scores_sorted = np.sort(valid_scores)
    n = len(valid_scores_sorted)

    result = np.full(len(values), -1.0)
    for i, v in enumerate(values):
        if not valid_mask[i]:
            continue
        rank = np.searchsorted(valid_scores_sorted, v, side='left')
        result[i] = round(100.0 * rank / n, 1)
    return result

def main():
    print("[load] parks (merged)...", flush=True)
    parks_geojson = json.loads(MERGED_PARKS_FILE.read_text())
    print(f"  {len(parks_geojson['features'])} park features", flush=True)

    print("[load] parcels.geojson...", flush=True)
    fc = json.loads(PARCELS_FILE.read_text())
    parcels = fc['features']
    print(f"  {len(parcels):,} parcels", flush=True)

    # Build park sample points
    s_lats, s_lngs, s_acrs = build_park_samples(parks_geojson)
    grid = build_grid_index(s_lats, s_lngs)

    # Find excluded parcels (park parcels)
    excluded = set()
    for i, p in enumerate(parcels):
        lu = str(p['properties'].get('landuse', '')).strip()
        if lu in EXCLUDED_LANDUSE:
            excluded.add(i)
    print(f"[score] {len(excluded):,} park/excluded parcels (will get -1)", flush=True)

    # Compute gravity scores
    raw_scores = compute_scores(parcels, s_lats, s_lngs, s_acrs, grid)

    # Percentile rank (excluding park parcels)
    print("[rank] Computing percentile ranks...", flush=True)
    pct_ranks = percentile_rank(raw_scores, excluded)

    # Patch parcels
    print("[patch] Updating park_score fields...", flush=True)
    for i, feat in enumerate(parcels):
        feat['properties']['park_score']   = round(pct_ranks[i], 1)
        feat['properties']['park_gravity'] = round(float(raw_scores[i]), 6)

    print("[write] parcels.geojson...", flush=True)
    PARCELS_FILE.write_text(json.dumps(fc))
    print(f"  {PARCELS_FILE.stat().st_size/1e6:.1f} MB", flush=True)

    # Rebuild PMTiles
    print("[pmtiles] tippecanoe...", flush=True)
    r = subprocess.run([
        "tippecanoe", "-o", str(OUT_PMTILES), "--force",
        "-z14", "-Z12",
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        "--no-tile-compression",
        "-l", "parcels",
        str(PARCELS_FILE),
    ], capture_output=True, text=True)
    if r.returncode != 0:
        print("ERROR:", r.stderr[-1000:])
        sys.exit(1)
    print(f"  {OUT_PMTILES.stat().st_size/1e6:.1f} MB", flush=True)
    print("✓ Done", flush=True)

if __name__ == "__main__":
    main()
