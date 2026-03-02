#!/usr/bin/env python3
"""
Join MapPLUTO polygon geometry with our scored parcel data (by BBL),
then build a polygon PMTiles file for the fill-based preview layer.

Only keeps fields needed for map rendering + detail panel.
"""
import json, subprocess, sys
from pathlib import Path

DATA_DIR  = Path(__file__).parent.parent / "data"
RAW_DIR   = DATA_DIR / "raw"
PROC_DIR  = DATA_DIR / "processed"

MAPPLUTO_FILE = RAW_DIR / "mappluto" / "mappluto_polygons.geojson"
SCORED_FILE   = PROC_DIR / "parcels.geojson"
OUT_GEOJSON   = PROC_DIR / "parcels_polygon.geojson"
OUT_PMTILES   = PROC_DIR / "parcels_polygon.pmtiles"

# Fields to carry over from our scored data
SCORE_FIELDS = [
    "park_score", "floors_pct", "year_pct", "density_pct",
    "el_ela_pct", "mi_ela_pct", "hi_ela_pct",
    "flood_100yr", "flood_storm",
    "address", "borough", "landuse", "numfloors", "yearbuilt",
    "unitsres", "lotarea", "bldgclass", "zonedist1",
]

def main():
    print("[load] scored parcels...", flush=True)
    scored = json.loads(SCORED_FILE.read_text())
    # Build BBL → properties lookup
    bbl_to_props: dict[str, dict] = {}
    for feat in scored["features"]:
        props = feat["properties"]
        bbl = str(props.get("bbl", "")).split(".")[0].strip()
        if bbl:
            bbl_to_props[bbl] = props
    print(f"  {len(bbl_to_props):,} scored parcels indexed", flush=True)

    print("[load] MapPLUTO polygons...", flush=True)
    mappluto = json.loads(MAPPLUTO_FILE.read_text())
    print(f"  {len(mappluto['features']):,} polygon features", flush=True)

    print("[join] matching by BBL...", flush=True)
    matched = 0
    unmatched = 0
    out_features = []

    for feat in mappluto["features"]:
        geom = feat.get("geometry")
        if not geom:
            continue
        bbl_raw = feat["properties"].get("BBL", "")
        bbl = str(int(float(bbl_raw))) if bbl_raw else ""

        scored_props = bbl_to_props.get(bbl)
        if scored_props is None:
            unmatched += 1
            continue

        # Build output properties from scored data
        out_props = {"bbl": bbl}
        for field in SCORE_FIELDS:
            val = scored_props.get(field)
            if val is not None:
                out_props[field] = val

        out_features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": out_props,
        })
        matched += 1

        if matched % 100_000 == 0:
            print(f"  {matched:,} matched...", flush=True)

    print(f"  matched: {matched:,}  unmatched: {unmatched:,}", flush=True)

    print("[write] parcels_polygon.geojson...", flush=True)
    fc = {"type": "FeatureCollection", "features": out_features}
    OUT_GEOJSON.write_text(json.dumps(fc))
    print(f"  {OUT_GEOJSON.stat().st_size/1e6:.1f} MB", flush=True)

    print("[pmtiles] tippecanoe...", flush=True)
    result = subprocess.run([
        "tippecanoe",
        "-o", str(OUT_PMTILES), "--force",
        "-z14", "-Z12",
        "--drop-densest-as-needed",
        "--extend-zooms-if-still-dropping",
        "--no-tile-compression",
        "-l", "parcels_polygon",
        str(OUT_GEOJSON),
    ], capture_output=True, text=True)

    if result.returncode != 0:
        print("ERROR:", result.stderr[-2000:])
        sys.exit(1)

    print(f"  {OUT_PMTILES.stat().st_size/1e6:.1f} MB", flush=True)
    print("✓ Done", flush=True)

if __name__ == "__main__":
    main()
