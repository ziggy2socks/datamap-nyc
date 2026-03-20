#!/usr/bin/env python3
"""
Process ERA5 NetCDF into a compact binary texture file for the frost globe.

Output format: soil_globe_texture_{year}.bin
  Header (JSON, null-terminated):
    { width, height, weeks, dates: [...], temp_min, temp_max }
  Body:
    width * height * weeks bytes (uint8)
    Each byte = temperature remapped from [temp_min, temp_max] → [0, 255]
    255 = ocean/no-data sentinel

Grid: equirectangular, 720×360 pixels = 0.5° per pixel
  pixel (x, y): lon = x * 0.5 - 179.75, lat = 89.75 - y * 0.5

Usage:
  python3 scripts/process-era5-texture.py --year 2024
"""

import argparse
import json
import struct
import time
import numpy as np
import pandas as pd
import xarray as xr
from pathlib import Path
from datetime import date, timedelta

WIDTH  = 720   # 0.5° lon resolution
HEIGHT = 360   # 0.5° lat resolution
OCEAN_SENTINEL = 255  # uint8 value reserved for ocean/no-data
TEMP_MIN = -55.0      # °C — floor for color mapping
TEMP_MAX = 50.0       # °C — ceiling for color mapping

def weekly_mondays(year: int):
    d = date(year, 1, 1)
    while d.weekday() != 0:
        d += timedelta(days=1)
    mondays = []
    while d.year == year:
        mondays.append(d)
        d += timedelta(weeks=1)
    return mondays

def process_year(year: int, raw_dir: Path, out_dir: Path):
    # Find NetCDF file (handle zip-extracted path)
    nc_path = raw_dir / f"era5_{year}_extracted" / "data_stream-moda.nc"
    if not nc_path.exists():
        nc_path = raw_dir / f"era5_soil_temp_{year}.nc"
    if not nc_path.exists():
        print(f"ERROR: NetCDF not found for {year}. Run download-era5.py first.")
        return

    out_path = out_dir / f"soil_globe_texture_{year}.bin"
    print(f"{year}: loading {nc_path}...")

    ds  = xr.open_dataset(nc_path)
    var = next((v for v in ["stl1","soil_temperature_level_1","STL1"] if v in ds.data_vars), list(ds.data_vars)[0])
    da  = ds[var]
    time_dim = "valid_time" if "valid_time" in da.coords else "time"
    time_vals = da[time_dim].values

    # Convert K → °C
    sample = float(da.isel({time_dim: 0}).values[~np.isnan(da.isel({time_dim: 0}).values)][0])
    if sample > 100:
        da = da - 273.15

    lat_vals = da["latitude"].values   # descending: 90 → -90
    lon_vals = da["longitude"].values  # -180 → 179.9

    # Cap to end of last available month (inclusive)
    last_month_end = pd.Timestamp(time_vals[-1]).to_period('M').to_timestamp('M').date()
    all_dates = weekly_mondays(year)
    dates = [d for d in all_dates if d <= last_month_end]
    if not dates:
        dates = all_dates[:1]
    weeks = len(dates)
    print(f"  {weeks} weekly frames → {WIDTH}×{HEIGHT} texture ({WIDTH*HEIGHT:,} pixels)")

    # Pre-compute ERA5 pixel → texture pixel mapping
    # Texture pixel (tx, ty): lon = tx*0.5 - 179.75, lat = 89.75 - ty*0.5
    tex_lons = np.arange(WIDTH)  * 0.5 - 179.75
    tex_lats = np.arange(HEIGHT) * (-0.5) + 89.75

    # Nearest-neighbor indices into ERA5 grid
    lon_idx = np.array([int(np.argmin(np.abs(lon_vals - lo))) for lo in tex_lons])
    lat_idx = np.array([int(np.argmin(np.abs(lat_vals - la))) for la in tex_lats])

    # Output buffer: HEIGHT × WIDTH × weeks, uint8
    buf = np.full((weeks, HEIGHT, WIDTH), OCEAN_SENTINEL, dtype=np.uint8)

    temp_range = TEMP_MAX - TEMP_MIN

    for wi, monday in enumerate(dates):
        monday_dt = np.datetime64(monday.strftime("%Y-%m-%d"))
        ti = int(np.argmin(np.abs(time_vals - monday_dt)))
        arr = da.isel({time_dim: ti}).values  # (lat, lon)

        # Sample texture grid using pre-computed indices
        sampled = arr[np.ix_(lat_idx, lon_idx)]  # (HEIGHT, WIDTH)

        # Remap to uint8: 0-254 = data, 255 = ocean/NaN
        valid = ~np.isnan(sampled)
        clamped = np.clip(sampled, TEMP_MIN, TEMP_MAX)
        remapped = ((clamped - TEMP_MIN) / temp_range * 254).astype(np.uint8)
        frame = np.where(valid, remapped, OCEAN_SENTINEL)
        buf[wi] = frame.astype(np.uint8)

        if (wi + 1) % 13 == 0 or wi == 0:
            land = int(valid.sum())
            print(f"  Week {wi+1}/{weeks}: {land:,} land pixels / {WIDTH*HEIGHT:,}")

    # Write binary file
    # Format: [4-byte header length][JSON header][raw bytes]
    header = {
        "year": year,
        "width": WIDTH,
        "height": HEIGHT,
        "weeks": weeks,
        "temp_min": TEMP_MIN,
        "temp_max": TEMP_MAX,
        "ocean_sentinel": OCEAN_SENTINEL,
        "dates": [d.strftime("%Y-%m-%d") for d in dates],
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    header_bytes = json.dumps(header).encode("utf-8")

    with open(out_path, "wb") as f:
        # 4-byte little-endian uint32: header length
        f.write(struct.pack("<I", len(header_bytes)))
        f.write(header_bytes)
        # Raw pixel data: weeks × HEIGHT × WIDTH bytes
        f.write(buf.tobytes())

    raw_mb  = out_path.stat().st_size / (1024*1024)
    data_mb = (weeks * HEIGHT * WIDTH) / (1024*1024)
    print(f"  ✓ {out_path.name}  ({raw_mb:.1f}MB raw, {data_mb:.1f}MB pixel data)")
    print(f"  Tip: gzip this file — temperature fields compress ~3-4x")

    ds.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, action="append", dest="years", required=True)
    args = parser.parse_args()

    raw_dir = Path(__file__).parent.parent / "data" / "era5-raw"
    out_dir = Path(__file__).parent.parent / "public" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    for year in args.years:
        process_year(year, raw_dir, out_dir)

if __name__ == "__main__":
    main()
