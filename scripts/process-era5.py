#!/usr/bin/env python3
"""
Process downloaded ERA5 NetCDF files into globe-ready JSON.

Reads era5_soil_temp_{year}.nc, resamples to 2° grid,
extracts 52 weekly snapshots, writes public/data/soil_globe_{year}.json
in the exact format the GlobeApp expects.

Usage:
  python3 scripts/process-era5.py --year 2024
  python3 scripts/process-era5.py --year 2024 --year 2023
"""

import argparse
import json
import time
import numpy as np
import xarray as xr
from pathlib import Path
from datetime import date, timedelta

GRID_STEP = 2  # degrees

def weekly_mondays(year: int):
    d = date(year, 1, 1)
    while d.weekday() != 0:
        d += timedelta(days=1)
    mondays = []
    while d.year == year:
        mondays.append(d)
        d += timedelta(weeks=1)
    return mondays

def build_grid(step=GRID_STEP):
    lats, lons = [], []
    for lat in range(-90 + step, 91, step):
        for lon in range(-180 + step, 181, step):
            lats.append(lat)
            lons.append(lon)
    return lats, lons

def process_year(year: int, raw_dir: Path, out_dir: Path):
    # Support extracted zip contents
    nc_path = raw_dir / f"era5_soil_temp_{year}.nc"
    extracted = raw_dir / f"era5_{year}_extracted" / "data_stream-moda.nc"
    if extracted.exists():
        nc_path = extracted
    elif not nc_path.exists():
        print(f"ERROR: {nc_path} not found. Run download-era5.py --year {year} first.")
        return

    out_path = out_dir / f"soil_globe_{year}.json"
    print(f"{year}: loading {nc_path} ...")

    ds = xr.open_dataset(nc_path)
    print(f"  Variables: {list(ds.data_vars)}")
    print(f"  Coords: {list(ds.coords)}")

    # ERA5 soil temp variable name
    var_name = None
    for candidate in ["stl1", "soil_temperature_level_1", "STL1"]:
        if candidate in ds.data_vars:
            var_name = candidate
            break
    if var_name is None:
        var_name = list(ds.data_vars)[0]
    print(f"  Using variable: {var_name}")

    da = ds[var_name]

    # Time coord may be 'valid_time' not 'time'
    time_dim = "valid_time" if "valid_time" in da.coords else "time"
    time_vals = da[time_dim].values
    print(f"  Time steps: {len(time_vals)}")

    # Convert Kelvin → Celsius (ERA5 stores in K)
    # Sample a non-nan value to check
    sample = float(da.isel({time_dim: 0}).values[~np.isnan(da.isel({time_dim: 0}).values)][0])
    if sample > 100:
        print(f"  Converting K → °C (sample raw: {sample:.1f}K)")
        da = da - 273.15

    lat_name = "latitude" if "latitude" in da.coords else "lat"
    lon_name = "longitude" if "longitude" in da.coords else "lon"
    print(f"  Grid shape: {da.shape}")

    # Pre-extract lat/lon arrays and data as numpy for fast nearest-neighbor sampling
    lat_vals = da[lat_name].values   # (1801,)
    lon_vals = da[lon_name].values   # (3600,)

    target_lats, target_lons = build_grid(GRID_STEP)
    total_points = len(target_lats)

    # Pre-compute nearest indices for our 2° grid (same for all time steps)
    print("  Pre-computing grid indices...")
    lat_indices = np.array([int(np.argmin(np.abs(lat_vals - tgt))) for tgt in target_lats])
    lon_indices = np.array([int(np.argmin(np.abs(lon_vals - tgt))) for tgt in target_lons])

    dates = weekly_mondays(year)
    print(f"  Building {len(dates)} weekly frames for {total_points} grid points...")

    frames = []
    for wi, monday in enumerate(dates):
        # Find nearest monthly time step
        monday_dt = np.datetime64(monday.strftime("%Y-%m-%d"))
        diffs = np.abs(time_vals - monday_dt)
        ti = int(np.argmin(diffs))

        # Extract slice as numpy array (1801 × 3600)
        arr = da.isel({time_dim: ti}).values  # shape (lat, lon)

        # Sample at our 2° grid using pre-computed indices
        temps_raw = arr[lat_indices, lon_indices]

        frame = [
            None if np.isnan(v) else round(float(v), 1)
            for v in temps_raw
        ]
        frames.append(frame)

        if (wi + 1) % 13 == 0 or wi == 0:
            valid = sum(1 for v in frame if v is not None)
            print(f"  Week {wi+1}/{len(dates)}: {valid}/{total_points} valid")

        if (wi + 1) % 10 == 0:
            print(f"  Week {wi+1}/{len(dates)} done")

    # Verify
    non_null = sum(1 for f in frames for v in f if v is not None)
    total = len(frames) * total_points
    print(f"  {non_null:,}/{total:,} valid values ({100*non_null/total:.1f}%)")

    out = {
        "year": year,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "grid_step_deg": GRID_STEP,
        "total_points": total_points,
        "lats": target_lats,
        "lons": target_lons,
        "dates": [d.strftime("%Y-%m-%d") for d in dates],
        "variable": "soil_temperature_0_to_7cm_mean",
        "source": "ERA5-Land via Copernicus CDS",
        "frames": frames,
    }

    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"  ✓ Wrote {out_path} ({size_mb:.1f} MB)")
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
