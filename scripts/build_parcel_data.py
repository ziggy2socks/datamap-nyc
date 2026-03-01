#!/usr/bin/env python3
"""
datamap.nyc — Parcel data pipeline
Computes gravity-based park access score for all NYC parcels and exports PMTiles.

Steps:
1. Download MapPLUTO parcel centroids + attributes from NYC Open Data
2. Download NYC open space polygons
3. Compute gravity-based park access score per parcel:
     score = Σ (park_acres / (distance_m + 50)²) for all parks within 1 mile
4. Export as GeoJSON → convert to PMTiles via tippecanoe

Usage: python3 scripts/build_parcel_data.py
Output: data/processed/parcels.pmtiles
"""

import json
import math
import os
import subprocess
import urllib.request
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
RAW_DIR = DATA_DIR / "raw"
PROC_DIR = DATA_DIR / "processed"
RAW_DIR.mkdir(parents=True, exist_ok=True)
PROC_DIR.mkdir(parents=True, exist_ok=True)

PLUTO_API = "https://data.cityofnewyork.us/resource/64uk-42ks.json"
PARKS_FILE = RAW_DIR / "open_spaces.json"
PARCELS_FILE = RAW_DIR / "parcels.json"
OUTPUT_GEOJSON = PROC_DIR / "parcels.geojson"
OUTPUT_PMTILES = PROC_DIR / "parcels.pmtiles"

METERS_PER_DEGREE_LAT = 111320
SEARCH_RADIUS_MILES = 1.0
SEARCH_RADIUS_M = SEARCH_RADIUS_MILES * 1609.34
DAMPING = 50  # meters — prevents ∞ score inside parks


def deg_to_m(dlat, dlng, ref_lat):
    """Approximate degree difference to meters."""
    dy = dlat * METERS_PER_DEGREE_LAT
    dx = dlng * METERS_PER_DEGREE_LAT * math.cos(math.radians(ref_lat))
    return math.sqrt(dx*dx + dy*dy)


def download_parcels():
    if PARCELS_FILE.exists():
        print(f"[parcels] Using cached {PARCELS_FILE}")
        return json.loads(PARCELS_FILE.read_text())

    print("[parcels] Downloading MapPLUTO from NYC Open Data...")
    fields = "bbl,address,borough,numfloors,landuse,zonedist1,lotarea,latitude,longitude,yearbuilt,unitsres,unitstotal,bldgclass"
    limit = 50000
    offset = 0
    all_records = []

    while True:
        url = (f"{PLUTO_API}?$select={fields}"
               f"&$where=latitude+IS+NOT+NULL+AND+longitude+IS+NOT+NULL"
               f"&$limit={limit}&$offset={offset}"
               f"&$order=bbl")
        print(f"  Fetching offset {offset}...")
        with urllib.request.urlopen(url) as r:
            batch = json.loads(r.read())
        all_records.extend(batch)
        if len(batch) < limit:
            break
        offset += limit

    print(f"[parcels] Downloaded {len(all_records)} parcels")
    PARCELS_FILE.write_text(json.dumps(all_records))
    return all_records


def load_parks():
    print(f"[parks] Loading {len(json.loads(PARKS_FILE.read_text()))} open spaces")
    raw = json.loads(PARKS_FILE.read_text())
    parks = []
    for p in raw:
        try:
            acres = float(p.get("acres") or 0)
            if acres <= 0:
                continue
            geom = p.get("multipolygon") or p.get("the_geom")
            if not geom:
                continue
            # Compute centroid of first polygon ring
            coords_list = geom["coordinates"]
            if geom["type"] == "MultiPolygon":
                ring = coords_list[0][0]
            else:
                ring = coords_list[0]
            lngs = [c[0] for c in ring]
            lats = [c[1] for c in ring]
            parks.append({
                "name": p.get("signname", ""),
                "acres": acres,
                "lat": sum(lats) / len(lats),
                "lng": sum(lngs) / len(lngs),
            })
        except Exception:
            continue
    print(f"[parks] {len(parks)} parks with valid geometry")
    return parks


def compute_scores(parcels, parks):
    """
    Gravity-based park access score per parcel.
    score = Σ acres_i / (dist_i + DAMPING)²
    for all parks within SEARCH_RADIUS_M.
    """
    print(f"[score] Computing gravity scores for {len(parcels)} parcels...")

    # Build a simple grid index for parks to speed up lookup
    # (Avoid full O(n*m) — use bounding box pre-filter)
    radius_deg_lat = SEARCH_RADIUS_M / METERS_PER_DEGREE_LAT
    
    scored = []
    report_every = max(1, len(parcels) // 20)

    for i, parcel in enumerate(parcels):
        if i % report_every == 0:
            print(f"  {i}/{len(parcels)} ({100*i//len(parcels)}%)")
        try:
            plat = float(parcel["latitude"])
            plng = float(parcel["longitude"])
        except (KeyError, ValueError):
            continue

        radius_deg_lng = SEARCH_RADIUS_M / (METERS_PER_DEGREE_LAT * math.cos(math.radians(plat)))

        score = 0.0
        for park in parks:
            # Bounding box pre-filter
            if abs(park["lat"] - plat) > radius_deg_lat:
                continue
            if abs(park["lng"] - plng) > radius_deg_lng:
                continue
            dist = deg_to_m(park["lat"] - plat, park["lng"] - plng, plat)
            if dist > SEARCH_RADIUS_M:
                continue
            score += park["acres"] / (dist + DAMPING) ** 2

        parcel["park_score"] = round(score * 1e6, 2)  # scale to readable int range
        scored.append(parcel)

    print(f"[score] Done — {len(scored)} parcels scored")
    return scored


def normalize(scored):
    """Normalize park_score to 0–100."""
    values = [p["park_score"] for p in scored if p["park_score"] > 0]
    if not values:
        return scored
    p95 = sorted(values)[int(len(values) * 0.95)]  # cap at 95th percentile
    for p in scored:
        raw = p["park_score"]
        p["park_score_norm"] = min(100, round(100 * raw / p95, 1)) if p95 > 0 else 0
    return scored


def export_geojson(scored):
    print(f"[export] Writing GeoJSON ({len(scored)} features)...")
    features = []
    for p in scored:
        try:
            lat = float(p["latitude"])
            lng = float(p["longitude"])
        except (KeyError, ValueError):
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {
                "bbl": p.get("bbl", ""),
                "address": p.get("address", ""),
                "borough": p.get("borough", ""),
                "numfloors": float(p["numfloors"]) if p.get("numfloors") else 0,
                "landuse": p.get("landuse", ""),
                "zonedist1": p.get("zonedist1", ""),
                "lotarea": float(p["lotarea"]) if p.get("lotarea") else 0,
                "yearbuilt": int(p["yearbuilt"]) if p.get("yearbuilt") else 0,
                "unitsres": int(p["unitsres"]) if p.get("unitsres") else 0,
                "bldgclass": p.get("bldgclass", ""),
                "park_score": p.get("park_score_norm", 0),
            }
        })
    fc = {"type": "FeatureCollection", "features": features}
    OUTPUT_GEOJSON.write_text(json.dumps(fc))
    print(f"[export] Wrote {OUTPUT_GEOJSON} ({OUTPUT_GEOJSON.stat().st_size / 1e6:.1f} MB)")


def build_pmtiles():
    print("[pmtiles] Running tippecanoe...")
    cmd = [
        "tippecanoe",
        "-o", str(OUTPUT_PMTILES),
        "--force",
        "-z14", "-Z10",          # zoom 10–14
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        "--no-tile-compression",
        "-l", "parcels",
        str(OUTPUT_GEOJSON),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("tippecanoe stderr:", result.stderr[-2000:])
        raise RuntimeError("tippecanoe failed")
    print(f"[pmtiles] Done → {OUTPUT_PMTILES} ({OUTPUT_PMTILES.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    parcels = download_parcels()
    parks = load_parks()
    scored = compute_scores(parcels, parks)
    scored = normalize(scored)
    export_geojson(scored)
    build_pmtiles()
    print("\n✓ Pipeline complete.")
    print(f"  GeoJSON: {OUTPUT_GEOJSON}")
    print(f"  PMTiles: {OUTPUT_PMTILES}")
