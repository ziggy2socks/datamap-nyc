#!/usr/bin/env python3
"""
Download MapPLUTO parcel polygons from NYC Planning ArcGIS Online.
Fetches BBL + polygon geometry, saves as GeoJSON.
Only downloads what we need: BBL (for joining) + geometry.
"""
import json, urllib.request, urllib.parse, time
from pathlib import Path

OUT_DIR = Path(__file__).parent.parent / "data" / "raw" / "mappluto"
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_FILE = OUT_DIR / "mappluto_polygons.geojson"

BASE_URL = "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query"
PAGE_SIZE = 2000

def fetch_page(offset: int) -> dict:
    params = {
        "where": "1=1",
        "outFields": "BBL",  # Just BBL for the join
        "returnGeometry": "true",
        "resultOffset": str(offset),
        "resultRecordCount": str(PAGE_SIZE),
        "f": "geojson",
        "outSR": "4326",
    }
    url = BASE_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "datamap-nyc/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())

def main():
    all_features = []
    offset = 0
    total_expected = None

    print("Downloading MapPLUTO polygons from NYC Planning ArcGIS Online...")

    # First request to get count
    count_url = BASE_URL + "?where=1%3D1&returnCountOnly=true&f=json"
    req = urllib.request.Request(count_url, headers={"User-Agent": "datamap-nyc/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        count_data = json.loads(resp.read())
    total_expected = count_data.get("count", 0)
    print(f"Total parcels to fetch: {total_expected:,}")

    while True:
        print(f"  Fetching offset {offset:,} / {total_expected:,}...", flush=True)
        try:
            data = fetch_page(offset)
        except Exception as e:
            print(f"  Error at offset {offset}: {e}, retrying in 5s...")
            time.sleep(5)
            try:
                data = fetch_page(offset)
            except Exception as e2:
                print(f"  Fatal error: {e2}")
                break

        features = data.get("features", [])
        if not features:
            print("  No more features.")
            break

        all_features.extend(features)
        offset += len(features)

        print(f"  Got {len(features)} features, total so far: {len(all_features):,}")

        if len(features) < PAGE_SIZE:
            print("  Last page reached.")
            break

        time.sleep(0.1)  # Be polite to the API

    print(f"\nTotal features downloaded: {len(all_features):,}")

    fc = {
        "type": "FeatureCollection",
        "features": all_features,
    }

    print(f"Writing to {OUT_FILE}...")
    OUT_FILE.write_text(json.dumps(fc))
    size_mb = OUT_FILE.stat().st_size / 1e6
    print(f"Done. File size: {size_mb:.1f} MB")

if __name__ == "__main__":
    main()
