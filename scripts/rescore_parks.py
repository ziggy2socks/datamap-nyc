#!/usr/bin/env python3
"""
Rescore park_score using augmented open spaces (includes state/regional parks).
Reads existing parcels.geojson, recomputes park_score, writes updated file.
Uses same algorithm as build_parcel_data.py.
"""

import json, math, sys
import numpy as np
from pathlib import Path

DATA_DIR   = Path(__file__).parent.parent / "data"
RAW_DIR    = DATA_DIR / "raw"
PROC_DIR   = DATA_DIR / "processed"

PARKS_FILE          = RAW_DIR  / "open_spaces_augmented.json"
PARCELS_GEOJSON_IN  = PROC_DIR / "parcels.geojson"
PARCELS_GEOJSON_OUT = PROC_DIR / "parcels_rescored.geojson"

METERS_PER_DEG  = 111320.0
SEARCH_RADIUS_M = 1609.34   # 1 mile
SAMPLE_SPACING_M = 15.0
DAMPING         = 50.0
GRID_CELL_DEG   = 0.01

# Park landuse codes to exclude from scoring (parks themselves)
PARK_LANDUSE = {'09', '00', ''}


# ──────────────────────────────────────────────────
# Park polygon sampling  (same as build_parcel_data)
# ──────────────────────────────────────────────────

def sample_ring(ring):
    pts = []
    n = len(ring)
    for i in range(n - 1):
        lon0, lat0 = ring[i]
        lon1, lat1 = ring[i + 1]
        dlat = lat1 - lat0
        dlon = lon1 - lon0
        dist_m = math.sqrt((dlat * METERS_PER_DEG) ** 2 +
                            (dlon * METERS_PER_DEG * math.cos(math.radians((lat0 + lat1) / 2))) ** 2)
        steps = max(1, int(dist_m / SAMPLE_SPACING_M))
        for s in range(steps):
            t = s / steps
            pts.append((lat0 + t * dlat, lon0 + t * dlon))
    return pts


def build_park_samples(parks_raw):
    print("[parks] Sampling park polygon edges…", flush=True)
    all_lats, all_lngs, all_acres = [], [], []
    for p in parks_raw:
        try:
            acres = float(p.get("acres") or 0)
            if acres <= 0:
                continue
            geom = p.get("multipolygon") or p.get("the_geom")
            if not geom:
                continue
            rings = []
            if geom["type"] == "Polygon":
                rings = [geom["coordinates"][0]]
            elif geom["type"] == "MultiPolygon":
                rings = [poly[0] for poly in geom["coordinates"]]
            for ring in rings:
                pts = sample_ring(ring)
                for lat, lng in pts:
                    all_lats.append(lat)
                    all_lngs.append(lng)
                    all_acres.append(acres)
        except Exception:
            continue
    lats = np.array(all_lats, dtype=np.float32)
    lngs = np.array(all_lngs, dtype=np.float32)
    acrs = np.array(all_acres, dtype=np.float32)
    print(f"[parks] {len(lats):,} sample points", flush=True)
    return lats, lngs, acrs


def build_grid_index(lats, lngs):
    grid = {}
    rows = (lats / GRID_CELL_DEG).astype(np.int32)
    cols = (lngs / GRID_CELL_DEG).astype(np.int32)
    for idx in range(len(lats)):
        key = (int(rows[idx]), int(cols[idx]))
        if key not in grid:
            grid[key] = []
        grid[key].append(idx)
    return grid, rows, cols


def gravity_score(plat, plng, lats, lngs, acrs, grid):
    """Compute gravity park score for one parcel."""
    radius_deg = SEARCH_RADIUS_M / METERS_PER_DEG
    r0 = int((plat - radius_deg) / GRID_CELL_DEG)
    r1 = int((plat + radius_deg) / GRID_CELL_DEG)
    c0 = int((plng - radius_deg) / GRID_CELL_DEG)
    c1 = int((plng + radius_deg) / GRID_CELL_DEG)

    indices = []
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            if (r, c) in grid:
                indices.extend(grid[(r, c)])

    if not indices:
        return 0.0

    idx_arr = np.array(indices, dtype=np.int32)
    lat_cos = math.cos(math.radians(plat))
    dlat_m = (lats[idx_arr] - plat) * METERS_PER_DEG
    dlng_m = (lngs[idx_arr] - plng) * METERS_PER_DEG * lat_cos
    dists  = np.sqrt(dlat_m ** 2 + dlng_m ** 2)

    mask = dists <= SEARCH_RADIUS_M
    if not mask.any():
        return 0.0

    dists_f = dists[mask] + DAMPING
    ac_f    = acrs[idx_arr][mask]
    return float(np.sum(ac_f / (dists_f ** 2)))


def percentile_rank(scores):
    """Convert scores array to percentile rank [0–1]. Ignores -1 sentinel."""
    valid_mask = scores >= 0
    valid = scores[valid_mask]
    ranks = np.zeros(len(scores), dtype=np.float32)
    if len(valid) == 0:
        return ranks
    sorted_valid = np.sort(valid)
    for i in np.where(valid_mask)[0]:
        rank = np.searchsorted(sorted_valid, scores[i], side='right') / len(sorted_valid)
        ranks[i] = rank
    return ranks


# ──────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────

def main():
    print(f"Loading parks from {PARKS_FILE}…", flush=True)
    parks_raw = json.loads(PARKS_FILE.read_text())
    print(f"  {len(parks_raw)} parks", flush=True)

    lats, lngs, acrs = build_park_samples(parks_raw)
    grid, _, _ = build_grid_index(lats, lngs)
    print("[parks] Grid index built", flush=True)

    print(f"Loading parcels from {PARCELS_GEOJSON_IN}…", flush=True)
    # Stream parse to avoid loading 635MB at once
    # Actually we need to load it all since we're rewriting
    print("  (this may take a minute to load 635MB…)", flush=True)
    with open(PARCELS_GEOJSON_IN) as f:
        fc = json.load(f)
    features = fc['features']
    print(f"  {len(features):,} parcels loaded", flush=True)

    # Compute raw gravity scores
    print("Scoring parcels…", flush=True)
    raw_scores = np.zeros(len(features), dtype=np.float32)
    excluded = np.zeros(len(features), dtype=bool)

    for i, feat in enumerate(features):
        if i % 50000 == 0:
            print(f"  {i:,}/{len(features):,}…", flush=True)
        props = feat['properties']
        lu = str(props.get('landuse') or '').strip()
        if lu in PARK_LANDUSE:
            excluded[i] = True
            raw_scores[i] = -1.0
            continue
        coords = feat['geometry']['coordinates']
        plng, plat = coords[0], coords[1]
        raw_scores[i] = gravity_score(plat, plng, lats, lngs, acrs, grid)

    print(f"  Done. {excluded.sum():,} excluded (park landuse)", flush=True)

    # Percentile rank
    print("Computing percentile ranks…", flush=True)
    # Mask: only non-excluded
    valid_mask = ~excluded
    valid_raw = raw_scores[valid_mask]
    sorted_valid = np.sort(valid_raw)
    pct_scores = np.full(len(features), -1.0, dtype=np.float32)
    valid_indices = np.where(valid_mask)[0]
    for idx in valid_indices:
        rank = float(np.searchsorted(sorted_valid, raw_scores[idx], side='right')) / len(sorted_valid)
        pct_scores[idx] = round(rank, 4)

    print("Patching parcels…", flush=True)
    changed = 0
    for i, feat in enumerate(features):
        old_score = feat['properties'].get('park_score', -99)
        if pct_scores[i] < 0:
            new_score = -1.0
        else:
            new_score = round(float(pct_scores[i]) * 100.0, 1)
        if abs(float(old_score) - new_score) > 0.1:
            changed += 1
        feat['properties']['park_score'] = new_score

    print(f"  {changed:,} parcels changed park_score", flush=True)

    print(f"Writing {PARCELS_GEOJSON_OUT}…", flush=True)
    with open(PARCELS_GEOJSON_OUT, 'w') as f:
        json.dump(fc, f)
    print(f"Done. Output: {PARCELS_GEOJSON_OUT}", flush=True)

    # Quick sanity: show scores near Gantry Plaza
    print("\nSanity check — parcels near Gantry Plaza State Park (~-73.957, 40.745):")
    gantry_lon, gantry_lat = -73.957, 40.745
    nearby = []
    for i, feat in enumerate(features):
        coords = feat['geometry']['coordinates']
        dlat = coords[1] - gantry_lat
        dlon = coords[0] - gantry_lon
        dist = math.sqrt(dlat**2 + dlon**2)
        if dist < 0.003:
            nearby.append((dist, i, feat['properties']['park_score'], feat['properties'].get('address','')))
    nearby.sort()
    for dist, i, score, addr in nearby[:10]:
        print(f"  {addr}: park_score={score:.1f} (dist={dist*111320:.0f}m)")


if __name__ == '__main__':
    main()
