#!/usr/bin/env python3
"""
Add flood zone fields to parcels GeoJSON — fast numpy version.

Strategy:
  1. Build a raster grid of NYC at ~25m resolution
  2. Rasterize each flood polygon into the grid
  3. Look up each parcel centroid in the grid
  → <2 minutes total
"""

import json, math, subprocess, sys
import numpy as np
from pathlib import Path

DATA_DIR     = Path(__file__).parent.parent / "data"
RAW_DIR      = DATA_DIR / "raw"
PROC_DIR     = DATA_DIR / "processed"

PARCELS_FILE     = PROC_DIR / "parcels.geojson"
FLOOD_100_FILE   = RAW_DIR  / "flood_100yr.geojson"
FLOOD_STORM_FILE = RAW_DIR  / "flood_moderate.geojson"

# NYC bounding box + raster resolution
NYC_MIN_LNG, NYC_MAX_LNG = -74.26, -73.69
NYC_MIN_LAT, NYC_MAX_LAT =  40.49,  40.93
CELL_DEG = 0.0002   # ~18m resolution — fine enough for parcel-level accuracy

# Grid dimensions
COLS = int((NYC_MAX_LNG - NYC_MIN_LNG) / CELL_DEG) + 1
ROWS = int((NYC_MAX_LAT - NYC_MIN_LAT) / CELL_DEG) + 1


def lng_to_col(lng):
    return np.clip(((lng - NYC_MIN_LNG) / CELL_DEG).astype(int), 0, COLS-1)

def lat_to_row(lat):
    return np.clip(((lat - NYC_MIN_LAT) / CELL_DEG).astype(int), 0, ROWS-1)


def rasterize_ring(grid, ring_coords):
    """
    Scanline fill a polygon ring into the boolean grid.
    Uses numpy broadcasting for fast edge intersection testing.
    """
    ring = np.array(ring_coords, dtype=np.float32)
    if len(ring) < 3:
        return

    # Bounding box in grid coords
    min_col = max(0, int((ring[:, 0].min() - NYC_MIN_LNG) / CELL_DEG))
    max_col = min(COLS-1, int((ring[:, 0].max() - NYC_MIN_LNG) / CELL_DEG) + 1)
    min_row = max(0, int((ring[:, 1].min() - NYC_MIN_LAT) / CELL_DEG))
    max_row = min(ROWS-1, int((ring[:, 1].max() - NYC_MIN_LAT) / CELL_DEG) + 1)

    if min_row >= max_row or min_col >= max_col:
        return

    xs = ring[:, 0]  # lng
    ys = ring[:, 1]  # lat

    # For each row in bbox, find x-intersections of edges with scanline
    for row in range(min_row, max_row + 1):
        lat = NYC_MIN_LAT + row * CELL_DEG

        # Edges that cross this scanline
        ax, ay = xs[:-1], ys[:-1]
        bx, by = xs[1:],  ys[1:]

        # Edges where one endpoint is above and one below scanline
        mask = ((ay <= lat) & (by > lat)) | ((by <= lat) & (ay > lat))
        if not mask.any():
            continue

        # X position of intersection
        ax_m, ay_m, bx_m, by_m = ax[mask], ay[mask], bx[mask], by[mask]
        x_cross = ax_m + (lat - ay_m) / (by_m - ay_m + 1e-12) * (bx_m - ax_m)

        # Convert to column indices, sort
        cols_cross = np.sort(((x_cross - NYC_MIN_LNG) / CELL_DEG).astype(int))
        cols_cross = np.clip(cols_cross, min_col, max_col)

        # Fill between pairs of intersections (XOR fill = handles holes correctly)
        for i in range(0, len(cols_cross) - 1, 2):
            c0 = max(min_col, cols_cross[i])
            c1 = min(max_col, cols_cross[i+1])
            if c0 <= c1:
                grid[row, c0:c1+1] ^= True  # XOR = handle holes


def load_and_rasterize(path, label):
    print(f"[rasterize] {label}...", flush=True)
    fc = json.loads(path.read_text())

    grid = np.zeros((ROWS, COLS), dtype=bool)
    ring_count = 0

    for feat in fc["features"]:
        geom = feat.get("geometry", {})
        gtype = geom.get("type", "")
        coords = geom.get("coordinates", [])

        if gtype == "Polygon":
            polys = [coords]
        elif gtype == "MultiPolygon":
            polys = coords
        else:
            continue

        for poly in polys:
            for ring in poly:
                rasterize_ring(grid, ring)
                ring_count += 1
                if ring_count % 1000 == 0:
                    print(f"  {ring_count} rings...", flush=True)

    in_zone = grid.sum()
    total = ROWS * COLS
    print(f"  {ring_count} rings rasterized → {in_zone:,}/{total:,} cells ({100*in_zone/total:.1f}%) in zone", flush=True)
    return grid


def tag_parcels(lats, lngs, grid, label):
    rows = lat_to_row(lats)
    cols = lng_to_col(lngs)
    result = grid[rows, cols]
    in_zone = result.sum()
    print(f"[tag] {label}: {in_zone:,}/{len(result):,} parcels in zone ({100*in_zone/len(result):.1f}%)", flush=True)
    return result


if __name__ == "__main__":
    print(f"[init] Grid: {ROWS}×{COLS} = {ROWS*COLS:,} cells at {CELL_DEG*111320:.0f}m resolution", flush=True)

    print("[load] parcels.geojson...", flush=True)
    fc = json.loads(PARCELS_FILE.read_text())
    feats = fc["features"]
    print(f"  {len(feats):,} features", flush=True)

    lats = np.array([f["geometry"]["coordinates"][1] for f in feats], dtype=np.float32)
    lngs = np.array([f["geometry"]["coordinates"][0] for f in feats], dtype=np.float32)

    # Rasterize flood polygons
    grid_100yr = load_and_rasterize(FLOOD_100_FILE,   "100yr floodplain")
    grid_storm  = load_and_rasterize(FLOOD_STORM_FILE, "moderate stormwater")

    # Tag parcels
    in_100yr = tag_parcels(lats, lngs, grid_100yr, "100yr")
    in_storm  = tag_parcels(lats, lngs, grid_storm,  "stormwater")

    # Patch GeoJSON
    print("[patch] Writing flood fields...", flush=True)
    for i, feat in enumerate(feats):
        feat["properties"]["flood_100yr"] = int(in_100yr[i])
        feat["properties"]["flood_storm"]  = int(in_storm[i])

    print("[write] parcels.geojson...", flush=True)
    PARCELS_FILE.write_text(json.dumps(fc))
    print(f"  {PARCELS_FILE.stat().st_size/1e6:.1f} MB", flush=True)

    # Rebuild PMTiles
    OUTPUT = PROC_DIR / "parcels.pmtiles"
    print("[pmtiles] tippecanoe...", flush=True)
    r = subprocess.run([
        "tippecanoe", "-o", str(OUTPUT), "--force",
        "-z14", "-Z10", "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping", "--no-tile-compression",
        "-l", "parcels", str(PARCELS_FILE),
    ], capture_output=True, text=True)
    if r.returncode != 0:
        print("ERROR:", r.stderr[-1000:], flush=True)
        sys.exit(1)
    print(f"  {OUTPUT.stat().st_size/1e6:.1f} MB", flush=True)

    subprocess.run(["openclaw", "system", "event",
                    "--text", "datamap: flood layers done — PMTiles ready",
                    "--mode", "now"], capture_output=True)
    print("✓ Complete", flush=True)
