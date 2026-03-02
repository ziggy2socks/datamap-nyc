#!/usr/bin/env python3
"""
build_school_zones.py
Download NYC school zone polygons + quality scores, join, and export GeoJSON.

Sources:
  - Elementary zones: NYC Open Data cmjf-yawu
  - Middle zones:     NYC Open Data t26j-jbq7
  - High school zones: NYC Open Data ruu9-egea
  - Quality scores:   NYC DOE School Quality Reports dnpx-dfnc (2024)
"""

import json, os, math, urllib.request, urllib.parse, sys
from pathlib import Path

BASE = Path(__file__).parent.parent
RAW  = BASE / "data" / "raw"
PROC = BASE / "data" / "processed"
RAW.mkdir(parents=True, exist_ok=True)
PROC.mkdir(parents=True, exist_ok=True)

ZONE_SOURCES = {
    "elementary": ("cmjf-yawu", "Elementary"),
    "middle":     ("t26j-jbq7", "Middle"),
    "high":       ("ruu9-egea", "High"),
}

# ── helpers ──────────────────────────────────────────────────────────────────

def fetch_json(url: str, label: str) -> object:
    print(f"  Fetching {label}…", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "datamap-nyc/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    return data

def fetch_geojson(dataset_id: str, label: str, cache_path: Path) -> dict:
    if cache_path.exists():
        print(f"  Using cached {label} zones ({cache_path.name})")
        return json.loads(cache_path.read_text())
    url = f"https://data.cityofnewyork.us/resource/{dataset_id}.geojson?$limit=5000"
    data = fetch_json(url, f"{label} zones ({dataset_id})")
    cache_path.write_text(json.dumps(data))
    print(f"  Saved {len(data.get('features', []))} features → {cache_path.name}")
    return data

def fetch_quality_metric(metric_name: str) -> list:
    """Fetch one metric for all schools from DOE School Quality Reports."""
    params = urllib.parse.urlencode({
        "$where": f"report_year=2024 AND metric_variable_name='{metric_name}'",
        "$limit": "5000",
    })
    url = f"https://data.cityofnewyork.us/resource/dnpx-dfnc.json?{params}"
    return fetch_json(url, metric_name)

def polygon_centroid(geometry: dict) -> tuple[float, float]:
    """Compute centroid of first ring of first polygon."""
    geom_type = geometry.get("type", "")
    coords = geometry.get("coordinates", [])
    try:
        if geom_type == "Polygon":
            ring = coords[0]
        elif geom_type == "MultiPolygon":
            ring = coords[0][0]
        else:
            return (0.0, 0.0)
        lngs = [c[0] for c in ring]
        lats = [c[1] for c in ring]
        return (sum(lngs) / len(lngs), sum(lats) / len(lats))
    except Exception:
        return (0.0, 0.0)

def percentile_rank(value: float | None, all_values: list[float]) -> float | None:
    """Compute percentile rank (0-100) of value among all_values."""
    if value is None or not all_values:
        return None
    below = sum(1 for v in all_values if v < value)
    rank = (below / len(all_values)) * 100
    return round(rank, 1)

# ── Step 1: Download zone GeoJSONs ───────────────────────────────────────────

print("\n=== Downloading school zone polygons ===")
zones = {}
for key, (dataset_id, label) in ZONE_SOURCES.items():
    cache = RAW / f"school_zones_{key}.geojson"
    zones[key] = fetch_geojson(dataset_id, label, cache)

# ── Step 2: Download quality scores ──────────────────────────────────────────

print("\n=== Downloading school quality scores ===")
quality_cache = RAW / "school_quality_scores.json"
if quality_cache.exists():
    print("  Using cached quality scores")
    all_metrics = json.loads(quality_cache.read_text())
else:
    metrics_to_fetch = [
        "rating_mean_ela_all",
        "rating_mean_mth_all",
        "attendance_k8_all",
        "attendance_hs_all",
    ]
    all_metrics = []
    for m in metrics_to_fetch:
        rows = fetch_quality_metric(m)
        all_metrics.extend(rows)
        print(f"    {m}: {len(rows)} schools")
    quality_cache.write_text(json.dumps(all_metrics))
    print(f"  Saved {len(all_metrics)} total metric rows → {quality_cache.name}")

# ── Step 3: Build per-school score lookup ────────────────────────────────────

print("\n=== Building quality score lookup ===")
scores: dict[str, dict] = {}  # dbn -> {school_name, ela, math, attendance}

for row in all_metrics:
    dbn = row.get("dbn", "").strip()
    if not dbn:
        continue
    if dbn not in scores:
        scores[dbn] = {
            "school_name": row.get("school_name", ""),
            "school_type": row.get("school_type", ""),
            "ela_score": None,
            "math_score": None,
            "attendance": None,
        }
    metric = row.get("metric_variable_name", "")
    val = row.get("metric_value")
    try:
        val = float(val) if val is not None else None
    except (ValueError, TypeError):
        val = None

    if metric == "rating_mean_ela_all":
        scores[dbn]["ela_score"] = val
    elif metric == "rating_mean_mth_all":
        scores[dbn]["math_score"] = val
    elif metric in ("attendance_k8_all", "attendance_hs_all"):
        scores[dbn]["attendance"] = val

print(f"  {len(scores)} schools with quality data")

# ── Step 4: Compute percentile ranks ─────────────────────────────────────────

ela_vals  = [s["ela_score"]  for s in scores.values() if s["ela_score"]  is not None]
math_vals = [s["math_score"] for s in scores.values() if s["math_score"] is not None]

ela_mean  = sum(ela_vals)  / len(ela_vals)  if ela_vals  else 0
math_mean = sum(math_vals) / len(math_vals) if math_vals else 0
print(f"  ELA scores available:  {len(ela_vals)} schools (mean={ela_mean:.2f})")
print(f"  Math scores available: {len(math_vals)} schools (mean={math_mean:.2f})")

for dbn, info in scores.items():
    info["ela_percentile"]  = percentile_rank(info["ela_score"],  ela_vals)
    info["math_percentile"] = percentile_rank(info["math_score"], math_vals)

# ── Step 5: Join scores to zone GeoJSONs ─────────────────────────────────────

print("\n=== Joining quality scores to zone polygons ===")
school_locations = []

for key, label in [("elementary", "Elementary"), ("middle", "Middle"), ("high", "High")]:
    geojson = zones[key]
    matched = 0
    missing = 0

    for feat in geojson.get("features", []):
        props = feat.get("properties", {})
        dbn = (props.get("dbn") or "").strip()
        info = scores.get(dbn, {})

        props["zone_type"]       = key
        props["school_name"]     = info.get("school_name") or props.get("label", dbn)
        props["ela_score"]       = info.get("ela_score")
        props["math_score"]      = info.get("math_score")
        props["attendance"]      = info.get("attendance")
        props["ela_percentile"]  = info.get("ela_percentile")
        props["math_percentile"] = info.get("math_percentile")

        if info:
            matched += 1
        else:
            missing += 1

        # Build school location entry
        geom = feat.get("geometry", {})
        lng, lat = polygon_centroid(geom)
        if lng != 0.0 and lat != 0.0:
            school_locations.append({
                "dbn": dbn,
                "school_name": props["school_name"],
                "zone_type": key,
                "ela_score": props["ela_score"],
                "math_score": props["math_score"],
                "attendance": props["attendance"],
                "ela_percentile": props["ela_percentile"],
                "math_percentile": props["math_percentile"],
                "lng": round(lng, 6),
                "lat": round(lat, 6),
            })

    out_path = PROC / f"school_zones_{key}.geojson"
    out_path.write_text(json.dumps(geojson, separators=(",", ":")))
    size_mb = out_path.stat().st_size / 1_048_576
    print(f"  {label}: {matched} matched, {missing} no score data → {out_path.name} ({size_mb:.1f} MB)")

# ── Step 6: Save school locations ────────────────────────────────────────────

loc_path = PROC / "school_locations.json"
loc_path.write_text(json.dumps(school_locations, separators=(",", ":")))
print(f"\n  Saved {len(school_locations)} school locations → {loc_path.name}")

# ── Step 7: Create public/data symlinks ──────────────────────────────────────

print("\n=== Creating public/data symlinks ===")
pub_data = BASE / "public" / "data"
pub_data.mkdir(parents=True, exist_ok=True)

for key in ("elementary", "middle", "high"):
    src = PROC / f"school_zones_{key}.geojson"
    dst = pub_data / f"school_zones_{key}.geojson"
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    dst.symlink_to(src)
    print(f"  Linked public/data/school_zones_{key}.geojson → {src}")

print("\n✅ Done! School zone data ready.")
print(f"   Elementary: {len(zones['elementary'].get('features',[]))} zones")
print(f"   Middle:     {len(zones['middle'].get('features',[]))} zones")
print(f"   High:       {len(zones['high'].get('features',[]))} zones")
