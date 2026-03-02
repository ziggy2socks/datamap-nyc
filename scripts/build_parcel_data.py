#!/usr/bin/env python3
"""
datamap.nyc — Parcel data pipeline (fast numpy version)

Gravity park access score:
  score = Σ acres_i / (dist_to_nearest_park_edge_i + DAMPING)²

Speed strategy:
  1. Sample each park polygon into dense edge points (~every 10m)
  2. Grid-index all park sample points by 0.01° cell
  3. Per parcel: look up nearby cells, vectorised numpy distance to all sample pts
  → ~3-5 minutes total for 857k parcels
"""

import json, math, subprocess, sys
import numpy as np
from pathlib import Path

DATA_DIR      = Path(__file__).parent.parent / "data"
RAW_DIR       = DATA_DIR / "raw"
PROC_DIR      = DATA_DIR / "processed"
RAW_DIR.mkdir(parents=True, exist_ok=True)
PROC_DIR.mkdir(parents=True, exist_ok=True)

PLUTO_API      = "https://data.cityofnewyork.us/resource/64uk-42ks.json"
PARKS_FILE     = RAW_DIR  / "open_spaces.json"
PARCELS_FILE   = RAW_DIR  / "parcels.json"
OUTPUT_GEOJSON = PROC_DIR / "parcels.geojson"
OUTPUT_PMTILES = PROC_DIR / "parcels.pmtiles"

METERS_PER_DEG = 111320.0
SEARCH_RADIUS_M = 1609.34   # 1 mile
SAMPLE_SPACING_M = 15.0     # sample park edges every ~15 m
DAMPING = 50.0              # prevents ∞ inside park
GRID_CELL_DEG = 0.01        # ~1 km grid cell for spatial index

BOROUGH_NAMES = {"MN":"Manhattan","BX":"Bronx","BK":"Brooklyn","QN":"Queens","SI":"Staten Island"}


# ──────────────────────────────────────────────────
# Download parcels
# ──────────────────────────────────────────────────
def download_parcels():
    import urllib.request
    if PARCELS_FILE.exists():
        print(f"[parcels] Using cached {PARCELS_FILE}", flush=True)
        return json.loads(PARCELS_FILE.read_text())
    print("[parcels] Downloading MapPLUTO…", flush=True)
    fields = "bbl,address,borough,numfloors,landuse,zonedist1,lotarea,latitude,longitude,yearbuilt,unitsres,bldgclass"
    limit, offset, records = 50000, 0, []
    while True:
        url = (f"{PLUTO_API}?$select={fields}"
               f"&$where=latitude+IS+NOT+NULL+AND+longitude+IS+NOT+NULL"
               f"&$limit={limit}&$offset={offset}&$order=bbl")
        print(f"  offset {offset}…", flush=True)
        with urllib.request.urlopen(url) as r:
            batch = json.loads(r.read())
        records.extend(batch)
        if len(batch) < limit: break
        offset += limit
    print(f"[parcels] {len(records)} parcels", flush=True)
    PARCELS_FILE.write_text(json.dumps(records))
    return records


# ──────────────────────────────────────────────────
# Sample park edges into dense point clouds
# ──────────────────────────────────────────────────
def sample_ring(ring_coords, spacing_m=SAMPLE_SPACING_M):
    """Return list of (lat, lng, acres) sample points along ring edges."""
    pts = []
    n = len(ring_coords)
    for i in range(n - 1):
        ax, ay = ring_coords[i]    # lng, lat
        bx, by = ring_coords[i+1]
        # segment length in metres
        cos_lat = math.cos(math.radians((ay + by) / 2))
        dx = (bx - ax) * METERS_PER_DEG * cos_lat
        dy = (by - ay) * METERS_PER_DEG
        seg_len = math.sqrt(dx*dx + dy*dy)
        if seg_len < 1e-6:
            pts.append((ay, ax))
            continue
        steps = max(1, int(seg_len / spacing_m))
        for s in range(steps + 1):
            t = s / steps
            pts.append((ay + t*(by-ay), ax + t*(bx-ax)))
    return pts


def build_park_samples(parks_raw):
    """
    Returns:
      sample_lats, sample_lngs  — 1-D numpy arrays (all sample points)
      sample_acres              — 1-D numpy array  (park acreage for each point)
    """
    print("[parks] Sampling park polygon edges…", flush=True)
    all_lats, all_lngs, all_acres = [], [], []

    for p in parks_raw:
        try:
            acres = float(p.get("acres") or 0)
            if acres <= 0: continue
            geom = p.get("multipolygon") or p.get("the_geom")
            if not geom: continue

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
    print(f"[parks] {len(lats):,} sample points from park edges", flush=True)
    return lats, lngs, acrs


def build_grid_index(lats, lngs):
    """Build dict: (row, col) → array of indices into lats/lngs."""
    print("[index] Building spatial grid index…", flush=True)
    rows = np.floor(lats / GRID_CELL_DEG).astype(np.int32)
    cols = np.floor(lngs / GRID_CELL_DEG).astype(np.int32)
    grid = {}
    for i in range(len(lats)):
        key = (int(rows[i]), int(cols[i]))
        if key not in grid: grid[key] = []
        grid[key].append(i)
    # Convert to numpy arrays for fast indexing
    grid_np = {k: np.array(v, dtype=np.int32) for k, v in grid.items()}
    print(f"[index] {len(grid_np)} cells", flush=True)
    return grid_np


# ──────────────────────────────────────────────────
# Gravity scoring — vectorised
# ──────────────────────────────────────────────────
def compute_scores(parcels, lats, lngs, acrs, grid):
    print(f"[score] Scoring {len(parcels):,} parcels…", flush=True)

    radius_cells = int(math.ceil(SEARCH_RADIUS_M / (GRID_CELL_DEG * METERS_PER_DEG))) + 1
    scores = np.zeros(len(parcels), dtype=np.float32)
    valid_mask = np.zeros(len(parcels), dtype=bool)

    report_every = max(1, len(parcels) // 40)

    for i, p in enumerate(parcels):
        if i % report_every == 0:
            pct = 100 * i // len(parcels)
            print(f"  {i:,}/{len(parcels):,} ({pct}%)", flush=True)

        try:
            plat = float(p["latitude"])
            plng = float(p["longitude"])
        except (KeyError, ValueError, TypeError):
            continue

        cos_lat = math.cos(math.radians(plat))
        valid_mask[i] = True

        # Collect nearby sample point indices via grid
        pr = int(math.floor(plat / GRID_CELL_DEG))
        pc = int(math.floor(plng / GRID_CELL_DEG))
        nearby = []
        for dr in range(-radius_cells, radius_cells + 1):
            for dc in range(-radius_cells, radius_cells + 1):
                idxs = grid.get((pr+dr, pc+dc))
                if idxs is not None:
                    nearby.append(idxs)

        if not nearby:
            continue

        idx = np.concatenate(nearby)
        nlats = lats[idx]
        nlngs = lngs[idx]
        nacrs = acrs[idx]

        # Distance in metres (vectorised)
        dy = (nlats - plat) * METERS_PER_DEG
        dx = (nlngs - plng) * METERS_PER_DEG * cos_lat
        dist_m = np.sqrt(dx*dx + dy*dy)

        # Within search radius
        mask = dist_m <= SEARCH_RADIUS_M
        if not mask.any():
            continue

        d = dist_m[mask]
        a = nacrs[mask]

        # Gravity: Σ acres / (dist + damping)²
        scores[i] = float(np.sum(a / (d + DAMPING) ** 2))  # acres/m² — gravity value

    print(f"[score] Done", flush=True)

    # Percentile rank among NON-PARK parcels only (landuse 09 / unknown excluded)
    # Park parcels get score -1 (sentinel — filtered out in frontend)
    # This prevents park parcels from anchoring the 100th percentile
    EXCLUDE_LU = {'09', '00', ''}
    scoreable = np.array([
        i for i, p in enumerate(parcels)
        if p.get('landuse', '').zfill(2) not in EXCLUDE_LU
    ], dtype=np.int32)

    sub = scores[scoreable]
    n = len(sub)
    order = np.argsort(sub)
    sub_ranks = np.empty(n, dtype=np.float32)
    sub_ranks[order] = np.arange(n, dtype=np.float32)
    prank = np.round(sub_ranks / (n - 1) * 100, 1)

    # Build full output arrays
    norm = np.full(len(scores), -1.0, dtype=np.float32)  # -1 = excluded
    norm[scoreable] = prank

    return norm.tolist(), scores.tolist()


# ──────────────────────────────────────────────────
# School zone spatial join
# ──────────────────────────────────────────────────

def point_in_polygon(lat, lng, ring_coords):
    """Ray-casting point-in-polygon for a single ring (lng, lat pairs)."""
    inside = False
    j = len(ring_coords) - 1
    for i in range(len(ring_coords)):
        xi, yi = ring_coords[i][0], ring_coords[i][1]
        xj, yj = ring_coords[j][0], ring_coords[j][1]
        if ((yi > lat) != (yj > lat)) and (lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside

def build_zone_index(zone_geojson):
    """Build list of (bbox, ring_coords, properties) for fast lookup."""
    zones = []
    for feat in zone_geojson.get("features", []):
        props = feat.get("properties", {})
        geom = feat.get("geometry", {})
        if not geom: continue
        # Collect all rings from polygon/multipolygon
        rings = []
        if geom["type"] == "Polygon":
            rings = [geom["coordinates"][0]]
        elif geom["type"] == "MultiPolygon":
            rings = [poly[0] for poly in geom["coordinates"]]
        for ring in rings:
            if len(ring) < 3: continue
            lngs = [c[0] for c in ring]
            lats = [c[1] for c in ring]
            bbox = (min(lats), max(lats), min(lngs), max(lngs))
            zones.append((bbox, ring, props))
    print(f"  {len(zones)} zone rings indexed", flush=True)
    return zones

def join_school_zones(parcels):
    """For each parcel, find its elementary school zone and attach score fields."""
    print("[school] Loading school zone GeoJSONs…", flush=True)
    zone_files = {
        "elementary": PROC_DIR / "school_zones_elementary.geojson",
        "middle":     PROC_DIR / "school_zones_middle.geojson",
        "high":       PROC_DIR / "school_zones_high.geojson",
    }
    zone_indexes = {}
    for key, path in zone_files.items():
        if not path.exists():
            print(f"  WARNING: {path} not found — skipping {key}", flush=True)
            continue
        gj = json.loads(path.read_text())
        print(f"  Indexing {key}…", flush=True)
        zone_indexes[key] = build_zone_index(gj)

    if not zone_indexes:
        print("[school] No zone files found — skipping join", flush=True)
        return [{}] * len(parcels)

    print(f"[school] Joining {len(parcels):,} parcels to school zones…", flush=True)
    results = []
    report_every = max(1, len(parcels) // 20)

    for i, p in enumerate(parcels):
        if i % report_every == 0:
            pct = 100 * i // len(parcels)
            print(f"  {i:,}/{len(parcels):,} ({pct}%)", flush=True)

        try:
            plat = float(p["latitude"])
            plng = float(p["longitude"])
        except (KeyError, ValueError, TypeError):
            results.append({})
            continue

        row = {}
        for key, zones in zone_indexes.items():
            for bbox, ring, props in zones:
                minlat, maxlat, minlng, maxlng = bbox
                if not (minlat <= plat <= maxlat and minlng <= plng <= maxlng):
                    continue
                if point_in_polygon(plat, plng, ring):
                    prefix = key[:2]  # "el", "mi", "hi"
                    row[f"{prefix}_ela_pct"]   = props.get("ela_percentile")
                    row[f"{prefix}_math_pct"]  = props.get("math_percentile")
                    row[f"{prefix}_ela_score"] = props.get("ela_score")
                    row[f"{prefix}_dbn"]       = props.get("dbn", "")
                    row[f"{prefix}_school"]    = props.get("school_name", "")
                    break

        results.append(row)

    matched = sum(1 for r in results if r)
    print(f"[school] Matched {matched:,} of {len(parcels):,} parcels", flush=True)
    return results


# ──────────────────────────────────────────────────
# Percentile rank helpers
# ──────────────────────────────────────────────────

def percentile_rank_array(values, exclude_zeros=False):
    """Compute 0–100 percentile rank for a list of floats.
    Returns list same length as values; None inputs get -1."""
    arr = np.array([v if v is not None else float('nan') for v in values], dtype=np.float64)
    valid = ~np.isnan(arr)
    if exclude_zeros:
        valid = valid & (arr > 0)
    sub = arr[valid]
    n = len(sub)
    if n == 0:
        return [-1.0] * len(values)
    order = np.argsort(sub)
    ranks = np.empty(n, dtype=np.float64)
    ranks[order] = np.arange(n, dtype=np.float64)
    prank = np.round(ranks / max(n - 1, 1) * 100, 1)
    result = np.full(len(values), -1.0)
    result[valid] = prank
    return result.tolist()


# ──────────────────────────────────────────────────
# Export
# ──────────────────────────────────────────────────
def export_geojson(parcels, park_scores, park_scores_raw=None, school_join=None):
    print(f"[export] Computing overlay percentile ranks…", flush=True)

    # Pre-compute percentile ranks for all overlay-eligible continuous fields
    floors_vals  = [float(p["numfloors"]) if p.get("numfloors") else 0 for p in parcels]
    year_vals    = [int(p["yearbuilt"]) if p.get("yearbuilt") else 0 for p in parcels]
    density_vals = [
        (int(p["unitsres"]) * 1000 / max(float(p["lotarea"]), 1))
        if p.get("unitsres") and p.get("lotarea") else 0
        for p in parcels
    ]

    floors_pct  = percentile_rank_array(floors_vals,  exclude_zeros=True)
    year_pct    = percentile_rank_array(year_vals,    exclude_zeros=True)
    density_pct = percentile_rank_array(density_vals, exclude_zeros=True)

    print(f"[export] Writing GeoJSON…", flush=True)
    features = []
    raw_iter = iter(park_scores_raw) if park_scores_raw else None
    sj = school_join or [{}] * len(parcels)

    for idx, (p, score) in enumerate(zip(parcels, park_scores)):
        try:
            lat = float(p["latitude"])
            lng = float(p["longitude"])
        except (KeyError, ValueError, TypeError):
            continue

        sz = sj[idx] if idx < len(sj) else {}

        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {
                # ── Identity ──
                "bbl":        str(p.get("bbl","")).split(".")[0],
                "address":    p.get("address",""),
                "borough":    BOROUGH_NAMES.get(p.get("borough",""), p.get("borough","")),
                "zonedist1":  p.get("zonedist1",""),
                "bldgclass":  p.get("bldgclass",""),
                "landuse":    p.get("landuse","").zfill(2),
                # ── Raw values ──
                "numfloors":  float(p["numfloors"]) if p.get("numfloors") else 0,
                "lotarea":    float(p["lotarea"]) if p.get("lotarea") else 0,
                "yearbuilt":  int(p["yearbuilt"]) if p.get("yearbuilt") else 0,
                "unitsres":   int(p["unitsres"]) if p.get("unitsres") else 0,
                # ── Park access ──
                "park_score":   round(score, 1),
                "park_gravity": round(next(raw_iter), 6) if raw_iter else 0,
                # ── Percentile ranks (0–100, –1 = excluded/no data) ──
                "floors_pct":   round(floors_pct[idx], 1),
                "year_pct":     round(year_pct[idx], 1),
                "density_pct":  round(density_pct[idx], 1),
                # ── School zone join (elementary) ──
                "el_ela_pct":   sz.get("el_ela_pct"),
                "el_math_pct":  sz.get("el_math_pct"),
                "el_ela_score": sz.get("el_ela_score"),
                "el_dbn":       sz.get("el_dbn", ""),
                "el_school":    sz.get("el_school", ""),
                # ── School zone join (middle) ──
                "mi_ela_pct":   sz.get("mi_ela_pct"),
                "mi_math_pct":  sz.get("mi_math_pct"),
                "mi_ela_score": sz.get("mi_ela_score"),
                "mi_dbn":       sz.get("mi_dbn", ""),
                # ── School zone join (high) ──
                "hi_ela_pct":   sz.get("hi_ela_pct"),
                "hi_math_pct":  sz.get("hi_math_pct"),
                "hi_ela_score": sz.get("hi_ela_score"),
                "hi_dbn":       sz.get("hi_dbn", ""),
            }
        })

    fc = {"type": "FeatureCollection", "features": features}
    OUTPUT_GEOJSON.write_text(json.dumps(fc))
    print(f"[export] {OUTPUT_GEOJSON} ({OUTPUT_GEOJSON.stat().st_size/1e6:.1f} MB)", flush=True)


def build_pmtiles():
    print("[pmtiles] Running tippecanoe…", flush=True)
    cmd = [
        "tippecanoe", "-o", str(OUTPUT_PMTILES), "--force",
        "-z14", "-Z10",
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        "--no-tile-compression",
        "-l", "parcels",
        str(OUTPUT_GEOJSON),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("tippecanoe stderr:", r.stderr[-2000:], flush=True)
        raise RuntimeError("tippecanoe failed")
    print(f"[pmtiles] Done → {OUTPUT_PMTILES} ({OUTPUT_PMTILES.stat().st_size/1e6:.1f} MB)", flush=True)


# ──────────────────────────────────────────────────
if __name__ == "__main__":
    parcels   = download_parcels()
    parks_raw = json.loads(PARKS_FILE.read_text())
    lats, lngs, acrs = build_park_samples(parks_raw)
    grid      = build_grid_index(lats, lngs)
    scores, raw_scores = compute_scores(parcels, lats, lngs, acrs, grid)
    school_join = join_school_zones(parcels)
    export_geojson(parcels, scores, raw_scores, school_join)
    build_pmtiles()

    # Notify completion
    import subprocess as sp
    sp.run(["openclaw", "system", "event",
            "--text", "datamap: parcel data rebuild complete — PMTiles ready",
            "--mode", "now"], capture_output=True)

    print("\n✓ Pipeline complete.", flush=True)
