#!/usr/bin/env python3
"""
Rasterize parcel scores to XYZ PNG tile sets for McHarg-style overlay display.

Pipeline:
  1. Load parcels.geojson (857k features, scored)
  2. For each layer field, rasterize parcel polygons to XYZ PNG tiles (z8–z13)
     using rasterio.features.rasterize (fast, vectorized)
  3. Apply colormap (diverging warm→cool per layer)
  4. Output: public/raster/{layer}/{z}/{x}/{y}.png

Usage:
  python3 scripts/build_raster_tiles.py --layer park_score
  python3 scripts/build_raster_tiles.py --layer park_score --min-zoom 8 --max-zoom 13
"""

import json
import math
import argparse
from pathlib import Path

import numpy as np
from PIL import Image
from rasterio.features import rasterize as rio_rasterize, MergeAlg
from rasterio.transform import from_bounds
from shapely.geometry import shape, mapping
from shapely.ops import transform as shapely_transform
import pyproj

# ── paths ─────────────────────────────────────────────────────────────────────
PROJECT      = Path(__file__).parent.parent
PARCELS_FILE = PROJECT / "data" / "processed" / "parcels.geojson"
OUT_DIR      = PROJECT / "public" / "raster"

# ── NYC bbox (WGS84) ──────────────────────────────────────────────────────────
NYC = {"min_lng": -74.26, "max_lng": -73.70, "min_lat": 40.47, "max_lat": 40.93}

TILE_SIZE = 256  # px

# ── layer config ──────────────────────────────────────────────────────────────
LAYERS = {
    "park_score": {
        "label":    "Park Access",
        "sentinel": -1.0,          # park parcels — skip
        "colormap": "park",
        "scale":    100.0,         # field range (0–100)
    },
    "floors_pct": {
        "label":    "Building Height",
        "sentinel": None,
        "colormap": "slate",
        "scale":    100.0,
    },
    "year_pct": {
        "label":    "Building Age",
        "sentinel": None,
        "colormap": "straw",
        "scale":    100.0,
    },
    "density_pct": {
        "label":    "Density",
        "sentinel": None,
        "colormap": "purple",
        "scale":    100.0,
    },
    "el_ela_pct": {
        "label":    "Elementary School Quality",
        "sentinel": None,
        "colormap": "school",
        "scale":    100.0,
    },
}

# ── colormaps (value 0–255 uint8 → RGBA) ─────────────────────────────────────
def make_colormap(stops):
    """
    Build a 256-entry lookup table from color stops.
    stops: [(t, (r,g,b,a)), ...] where t in [0,1]
    Returns np.array shape (256, 4) uint8.
    """
    lut = np.zeros((256, 4), dtype=np.uint8)
    stops = sorted(stops, key=lambda s: s[0])
    for i in range(256):
        t = i / 255.0
        if t <= stops[0][0]:
            lut[i] = stops[0][1]
        elif t >= stops[-1][0]:
            lut[i] = stops[-1][1]
        else:
            for k in range(len(stops) - 1):
                t0, c0 = stops[k]
                t1, c1 = stops[k + 1]
                if t0 <= t <= t1:
                    frac = (t - t0) / (t1 - t0)
                    lut[i] = [
                        int(c0[j] + (c1[j] - c0[j]) * frac)
                        for j in range(4)
                    ]
                    break
    return lut

# Diverging terra cotta → warm gray → forest green (park access)
LUT_PARK = make_colormap([
    (0.00, (180,  80,  40, 210)),
    (0.20, (210, 140,  70, 190)),
    (0.40, (225, 200, 155, 150)),
    (0.50, (190, 185, 175, 110)),
    (0.60, (150, 185, 140, 150)),
    (0.80, ( 70, 150,  80, 190)),
    (1.00, ( 28,  96,  46, 210)),
])

# Sequential cool slate (building height)
LUT_SLATE = make_colormap([
    (0.00, (215, 210, 202, 100)),
    (0.40, (140, 150, 165, 170)),
    (0.80, ( 70,  85, 110, 210)),
    (1.00, ( 28,  40,  70, 230)),
])

# Sequential straw → umber (building age: low=new, high=old)
LUT_STRAW = make_colormap([
    (0.00, (240, 232, 195, 100)),
    (0.40, (200, 170, 110, 170)),
    (0.80, (150, 100,  50, 210)),
    (1.00, ( 90,  55,  18, 230)),
])

# Sequential indigo-purple (density)
LUT_PURPLE = make_colormap([
    (0.00, (228, 220, 235, 100)),
    (0.40, (170, 140, 200, 170)),
    (0.80, (110,  60, 170, 210)),
    (1.00, ( 58,  18, 120, 230)),
])

# Diverging red→gray→green (school quality)
LUT_SCHOOL = make_colormap([
    (0.00, (160,  55,  55, 215)),
    (0.35, (210, 140,  80, 175)),
    (0.50, (192, 185, 170, 115)),
    (0.65, (130, 185, 138, 155)),
    (1.00, ( 28, 112,  60, 215)),
])

LUTS = {
    "park":   LUT_PARK,
    "slate":  LUT_SLATE,
    "straw":  LUT_STRAW,
    "purple": LUT_PURPLE,
    "school": LUT_SCHOOL,
}

# ── tile math ─────────────────────────────────────────────────────────────────
def tile_bounds(tx, ty, zoom):
    """(min_lng, min_lat, max_lng, max_lat) for XYZ tile."""
    n = 2 ** zoom
    min_lng = tx / n * 360.0 - 180.0
    max_lng = (tx + 1) / n * 360.0 - 180.0
    max_lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))
    min_lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + 1) / n))))
    return min_lng, min_lat, max_lng, max_lat

def tiles_for_bbox(min_lng, min_lat, max_lng, max_lat, zoom):
    n = 2 ** zoom
    def x(lng): return int((lng + 180) / 360 * n)
    def y(lat):
        lr = math.radians(lat)
        return int((1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n)
    return [(tx, ty)
            for tx in range(x(min_lng), x(max_lng) + 1)
            for ty in range(y(max_lat), y(min_lat) + 1)]

# ── projection helpers ────────────────────────────────────────────────────────
_wgs84_to_3857 = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
_3857_to_wgs84 = pyproj.Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)

def wgs84_to_3857_bounds(min_lng, min_lat, max_lng, max_lat):
    x0, y0 = _wgs84_to_3857.transform(min_lng, min_lat)
    x1, y1 = _wgs84_to_3857.transform(max_lng, max_lat)
    return x0, y0, x1, y1

# ── spatial grid index ───────────────────────────────────────────────────────
GRID_DEG = 0.02  # ~2km grid cells

def load_parcels(field, sentinel, scale):
    """
    Load parcels.geojson and build a spatial grid index for fast tile lookup.
    Returns a dict: (grid_x, grid_y) -> list of (geom_dict, uint8_value, bbox)
    """
    print(f"[load] parcels.geojson ...", flush=True)
    data = json.loads(PARCELS_FILE.read_text())
    features = data["features"]
    print(f"  {len(features):,} features", flush=True)

    print(f"[index] building spatial grid for {field} ...", flush=True)
    grid = {}
    skipped = 0
    indexed = 0

    for feat in features:
        props = feat.get("properties", {})
        val = props.get(field)
        if val is None:
            skipped += 1
            continue
        fval = float(val)
        if sentinel is not None and abs(fval - sentinel) < 0.001:
            skipped += 1
            continue
        geom = feat.get("geometry")
        if not geom:
            skipped += 1
            continue

        # Compute bbox
        gtype = geom["type"]
        if gtype == "Point":
            lng, lat = geom["coordinates"]
            bbox = (lng, lat, lng, lat)
        elif gtype == "Polygon":
            ring = geom["coordinates"][0]
            lngs = [c[0] for c in ring]
            lats = [c[1] for c in ring]
            bbox = (min(lngs), min(lats), max(lngs), max(lats))
        elif gtype == "MultiPolygon":
            all_coords = [c for p in geom["coordinates"] for c in p[0]]
            lngs = [c[0] for c in all_coords]
            lats = [c[1] for c in all_coords]
            bbox = (min(lngs), min(lats), max(lngs), max(lats))
        else:
            skipped += 1
            continue

        # Normalize to 0–255
        norm = max(0.0, min(1.0, fval / scale))
        uint_val = int(norm * 254) + 1  # 1–255 (0 = nodata)

        # Project to Web Mercator once (avoid per-tile reprojection)
        try:
            shp_wgs = shape(geom)
            if gtype == "Point":
                shp_3857 = shapely_transform(_wgs84_to_3857.transform, shp_wgs).buffer(10)
            else:
                shp_3857 = shapely_transform(_wgs84_to_3857.transform, shp_wgs)
            geom_3857 = mapping(shp_3857)
        except Exception:
            skipped += 1
            continue

        # Insert into all grid cells this bbox touches
        gx0 = int(math.floor(bbox[0] / GRID_DEG))
        gx1 = int(math.floor(bbox[2] / GRID_DEG))
        gy0 = int(math.floor(bbox[1] / GRID_DEG))
        gy1 = int(math.floor(bbox[3] / GRID_DEG))
        for gx in range(gx0, gx1 + 1):
            for gy in range(gy0, gy1 + 1):
                key = (gx, gy)
                if key not in grid:
                    grid[key] = []
                grid[key].append((geom_3857, uint_val, bbox))
        indexed += 1

    print(f"  {indexed:,} indexed  |  {skipped:,} skipped  |  {len(grid):,} grid cells", flush=True)
    return grid


def query_grid(grid, min_lng, min_lat, max_lng, max_lat):
    """Return all parcels whose bbox overlaps the given bounds."""
    gx0 = int(math.floor(min_lng / GRID_DEG))
    gx1 = int(math.floor(max_lng / GRID_DEG))
    gy0 = int(math.floor(min_lat / GRID_DEG))
    gy1 = int(math.floor(max_lat / GRID_DEG))

    seen = set()
    out = []
    for gx in range(gx0, gx1 + 1):
        for gy in range(gy0, gy1 + 1):
            for item in grid.get((gx, gy), []):
                geom, uint_val, bbox = item
                key = id(geom)
                if key in seen:
                    continue
                seen.add(key)
                # Precise bbox overlap
                if (bbox[2] < min_lng or bbox[0] > max_lng or
                        bbox[3] < min_lat or bbox[1] > max_lat):
                    continue
                out.append((geom, uint_val))
    return out

# ── render one tile ───────────────────────────────────────────────────────────
def render_tile(tx, ty, zoom, parcel_grid, lut):
    """
    Rasterize parcels into one 256×256 RGBA PNG tile.
    Returns PIL Image or None if empty.
    """
    min_lng, min_lat, max_lng, max_lat = tile_bounds(tx, ty, zoom)

    # Convert tile bounds to Web Mercator for rasterio transform
    x0, y0, x1, y1 = wgs84_to_3857_bounds(min_lng, min_lat, max_lng, max_lat)
    transform = from_bounds(x0, y0, x1, y1, TILE_SIZE, TILE_SIZE)

    # Fast grid lookup — only candidates that overlap this tile
    candidates = query_grid(parcel_grid, min_lng, min_lat, max_lng, max_lat)
    if not candidates:
        return None

    # Geometries are already in EPSG:3857 (projected at index time)
    shapes = [(geom_dict, uint_val) for geom_dict, uint_val in candidates]

    if not shapes:
        return None

    # Rasterize: burn parcel values into a uint8 grid
    # all_touched=True at low zoom so sub-pixel parcels still register
    arr = rio_rasterize(
        shapes,
        out_shape=(TILE_SIZE, TILE_SIZE),
        transform=transform,
        fill=0,           # nodata = 0
        dtype=np.uint8,
        all_touched=(zoom <= 12),
        merge_alg=MergeAlg.replace,
    )

    if arr.max() == 0:
        return None

    # Apply colormap: map uint8 values → RGBA using LUT
    rgba = lut[arr]           # shape (256, 256, 4)
    rgba[arr == 0, 3] = 0     # transparent for nodata pixels

    # At low zooms, apply Gaussian blur to create continuous heat-field look
    if zoom <= 11:
        from PIL import ImageFilter
        img = Image.fromarray(rgba, mode="RGBA")
        # Split, blur RGB+A separately, composite
        r, g, b, a = img.split()
        # Blur radius scales with zoom — more blur at lower zoom
        radius = max(1, (12 - zoom) * 2)
        r = r.filter(ImageFilter.GaussianBlur(radius=radius))
        g = g.filter(ImageFilter.GaussianBlur(radius=radius))
        b = b.filter(ImageFilter.GaussianBlur(radius=radius))
        a = a.filter(ImageFilter.GaussianBlur(radius=radius))
        return Image.merge("RGBA", (r, g, b, a))

    return Image.fromarray(rgba, mode="RGBA")


# ── main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--layer",    default="park_score", choices=list(LAYERS.keys()))
    parser.add_argument("--min-zoom", type=int, default=8)
    parser.add_argument("--max-zoom", type=int, default=13)
    args = parser.parse_args()

    cfg      = LAYERS[args.layer]
    field    = args.layer
    sentinel = cfg["sentinel"]
    scale    = cfg["scale"]
    lut      = LUTS[cfg["colormap"]]
    label    = cfg["label"]

    print(f"\n{'='*60}", flush=True)
    print(f"  Raster layer: {label}", flush=True)
    print(f"  Zoom: z{args.min_zoom}–z{args.max_zoom}", flush=True)
    print(f"{'='*60}\n", flush=True)

    parcel_grid = load_parcels(field, sentinel, scale)

    total_rendered = 0
    total_empty    = 0

    for zoom in range(args.min_zoom, args.max_zoom + 1):
        tile_list = tiles_for_bbox(
            NYC["min_lng"], NYC["min_lat"],
            NYC["max_lng"], NYC["max_lat"],
            zoom
        )

        z_dir = OUT_DIR / args.layer / str(zoom)
        z_dir.mkdir(parents=True, exist_ok=True)

        rendered = 0
        empty    = 0
        print(f"\n[z{zoom}] {len(tile_list)} tiles ...", flush=True)

        for i, (tx, ty) in enumerate(tile_list):
            img = render_tile(tx, ty, zoom, parcel_grid, lut)
            if img is not None:
                x_dir = z_dir / str(tx)
                x_dir.mkdir(exist_ok=True)
                img.save(x_dir / f"{ty}.png", format="PNG")
                rendered += 1
            else:
                empty += 1

            if (i + 1) % 20 == 0 or (i + 1) == len(tile_list):
                print(f"  {i+1}/{len(tile_list)}  rendered={rendered}  empty={empty}", flush=True)

        print(f"  z{zoom} complete", flush=True)
        total_rendered += rendered
        total_empty    += empty

    # Write metadata
    meta = {
        "layer":    args.layer,
        "label":    label,
        "minZoom":  args.min_zoom,
        "maxZoom":  args.max_zoom,
        "bounds":   [NYC["min_lng"], NYC["min_lat"], NYC["max_lng"], NYC["max_lat"]],
        "tileUrl":  f"/raster/{args.layer}/{{z}}/{{x}}/{{y}}.png",
    }
    (OUT_DIR / args.layer / "meta.json").write_text(json.dumps(meta, indent=2))

    print(f"\n✓ Done — {total_rendered} tiles rendered, {total_empty} empty", flush=True)
    print(f"  Output: public/raster/{args.layer}/", flush=True)


if __name__ == "__main__":
    main()
