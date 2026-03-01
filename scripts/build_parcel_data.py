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

    # Normalize via percentile rank (0–100)
    # Every parcel gets its rank position: "better than X% of NYC parcels"
    # This spreads the distribution uniformly regardless of raw score skew
    n = len(scores)
    order = np.argsort(scores)
    ranks = np.empty(n, dtype=np.float32)
    ranks[order] = np.arange(n, dtype=np.float32)
    norm = np.round(ranks / (n - 1) * 100, 1)
    return norm.tolist(), scores.tolist()  # percentile ranks + raw gravity values


# ──────────────────────────────────────────────────
# Export
# ──────────────────────────────────────────────────
def export_geojson(parcels, park_scores, park_scores_raw=None):
    print(f"[export] Writing GeoJSON…", flush=True)
    features = []
    raw_iter = iter(park_scores_raw) if park_scores_raw else None
    for p, score in zip(parcels, park_scores):
        try:
            lat = float(p["latitude"])
            lng = float(p["longitude"])
        except (KeyError, ValueError, TypeError):
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {
                "bbl":        str(p.get("bbl","")).split(".")[0],
                "address":    p.get("address",""),
                "borough":    BOROUGH_NAMES.get(p.get("borough",""), p.get("borough","")),
                "numfloors":  float(p["numfloors"]) if p.get("numfloors") else 0,
                "landuse":    p.get("landuse","").zfill(2),
                "zonedist1":  p.get("zonedist1",""),
                "lotarea":    float(p["lotarea"]) if p.get("lotarea") else 0,
                "yearbuilt":  int(p["yearbuilt"]) if p.get("yearbuilt") else 0,
                "unitsres":   int(p["unitsres"]) if p.get("unitsres") else 0,
                "bldgclass":  p.get("bldgclass",""),
                "park_score": round(score, 1),
                "park_gravity": round(next(raw_iter), 6) if raw_iter else 0,
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
    export_geojson(parcels, scores, raw_scores)
    build_pmtiles()

    # Notify completion
    import subprocess as sp
    sp.run(["openclaw", "system", "event",
            "--text", "datamap: parcel data rebuild complete — PMTiles ready",
            "--mode", "now"], capture_output=True)

    print("\n✓ Pipeline complete.", flush=True)
