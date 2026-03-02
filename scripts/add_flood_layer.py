#!/usr/bin/env python3
"""
Add flood zone fields to parcels GeoJSON.

For each parcel centroid, tests membership in:
  - flood_100yr:   FEMA 100-year floodplain (1% annual chance)
  - flood_storm:   NYC DEP moderate stormwater flooding (current sea level)

Adds boolean properties: flood_100yr (0/1), flood_storm (0/1)
Uses numpy-accelerated bounding box pre-filter + ray casting.

Runtime: ~5-8 min for 857k parcels (pure Python PIP per polygon ring,
but bbox pre-filter reduces actual PIP checks by ~95%).
"""

import json, math, sys
import numpy as np
from pathlib import Path

DATA_DIR    = Path(__file__).parent.parent / "data"
RAW_DIR     = DATA_DIR / "raw"
PROC_DIR    = DATA_DIR / "processed"

PARCELS_FILE    = PROC_DIR / "parcels.geojson"
FLOOD_100_FILE  = RAW_DIR  / "flood_100yr.geojson"
FLOOD_STORM_FILE= RAW_DIR  / "flood_moderate.geojson"


def extract_rings(geom):
    """All rings from Polygon/MultiPolygon as numpy arrays (N,2) [lng,lat]."""
    rings = []
    if geom["type"] == "Polygon":
        for ring in geom["coordinates"]:
            rings.append(np.array(ring, dtype=np.float32))
    elif geom["type"] == "MultiPolygon":
        for poly in geom["coordinates"]:
            for ring in poly:
                rings.append(np.array(ring, dtype=np.float32))
    return rings


def load_flood_layer(path):
    """Load flood GeoJSON → list of (bbox, ring_array) tuples."""
    print(f"[load] {path.name}...", flush=True)
    fc = json.loads(path.read_text())
    entries = []
    for feat in fc["features"]:
        geom = feat.get("geometry")
        if not geom:
            continue
        for ring in extract_rings(geom):
            if len(ring) < 3:
                continue
            min_lng, min_lat = ring[:, 0].min(), ring[:, 1].min()
            max_lng, max_lat = ring[:, 0].max(), ring[:, 1].max()
            entries.append({
                "bbox": (min_lat, max_lat, min_lng, max_lng),
                "ring": ring,
            })
    print(f"  {len(entries)} polygon rings", flush=True)
    return entries


def point_in_ring(lat, lng, ring):
    """Ray-casting PIP for a single ring (numpy array Nx2 [lng,lat])."""
    xs = ring[:, 0]
    ys = ring[:, 1]
    n = len(xs)
    j = n - 1
    inside = False
    for i in range(n):
        xi, yi = float(xs[i]), float(ys[i])
        xj, yj = float(xs[j]), float(ys[j])
        if ((yi > lat) != (yj > lat)) and (lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def tag_parcels(parcels_lats, parcels_lngs, flood_rings, label):
    """Returns boolean array: True if parcel centroid is inside any flood ring."""
    n = len(parcels_lats)
    result = np.zeros(n, dtype=bool)
    print(f"[tag] {label}: {len(flood_rings)} rings, {n} parcels...", flush=True)

    report_every = max(1, n // 20)

    for i in range(n):
        if i % report_every == 0:
            print(f"  {i}/{n} ({100*i//n}%)", flush=True)

        lat = float(parcels_lats[i])
        lng = float(parcels_lngs[i])

        for entry in flood_rings:
            min_lat, max_lat, min_lng, max_lng = entry["bbox"]
            # Bbox pre-filter
            if lat < min_lat or lat > max_lat:
                continue
            if lng < min_lng or lng > max_lng:
                continue
            if point_in_ring(lat, lng, entry["ring"]):
                result[i] = True
                break  # inside any ring = in flood zone

    in_zone = result.sum()
    print(f"  {in_zone} parcels in {label} ({100*in_zone/n:.1f}%)", flush=True)
    return result


if __name__ == "__main__":
    print("[load] parcels.geojson...", flush=True)
    fc = json.loads(PARCELS_FILE.read_text())
    feats = fc["features"]
    print(f"  {len(feats)} features", flush=True)

    # Extract lat/lng arrays
    lats = np.array([f["geometry"]["coordinates"][1] for f in feats], dtype=np.float32)
    lngs = np.array([f["geometry"]["coordinates"][0] for f in feats], dtype=np.float32)

    # Load flood layers
    rings_100yr = load_flood_layer(FLOOD_100_FILE)
    rings_storm = load_flood_layer(FLOOD_STORM_FILE)

    # Tag parcels
    in_100yr = tag_parcels(lats, lngs, rings_100yr, "100yr floodplain")
    in_storm  = tag_parcels(lats, lngs, rings_storm,  "moderate stormwater")

    # Patch GeoJSON
    print("[patch] Writing flood fields...", flush=True)
    for i, feat in enumerate(feats):
        feat["properties"]["flood_100yr"] = int(in_100yr[i])
        feat["properties"]["flood_storm"]  = int(in_storm[i])

    print("[write] parcels.geojson...", flush=True)
    PARCELS_FILE.write_text(json.dumps(fc))
    print(f"Done — {PARCELS_FILE.stat().st_size/1e6:.1f} MB", flush=True)

    # Rebuild PMTiles
    import subprocess
    OUTPUT_PMTILES = PROC_DIR / "parcels.pmtiles"
    print("[pmtiles] Running tippecanoe...", flush=True)
    r = subprocess.run([
        "tippecanoe", "-o", str(OUTPUT_PMTILES), "--force",
        "-z14", "-Z10",
        "--drop-densest-as-needed", "--extend-zooms-if-still-dropping",
        "--no-tile-compression", "-l", "parcels",
        str(PARCELS_FILE),
    ], capture_output=True, text=True)
    if r.returncode != 0:
        print("ERROR:", r.stderr[-1000:], flush=True)
    else:
        print(f"PMTiles: {OUTPUT_PMTILES.stat().st_size/1e6:.1f} MB", flush=True)
        subprocess.run(["openclaw", "system", "event",
                        "--text", "datamap: flood layers added to PMTiles — ready",
                        "--mode", "now"], capture_output=True)
    print("✓ Done", flush=True)
