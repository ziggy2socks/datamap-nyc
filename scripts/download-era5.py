#!/usr/bin/env python3
"""
Download ERA5 soil temperature data from Copernicus Climate Data Store.

Downloads monthly mean soil temperature (layer 1, 0-7cm) for a full year
as a single NetCDF file. Much faster and more reliable than per-point API calls.

Setup:
  1. Register at cds.climate.copernicus.eu
  2. Create ~/.cdsapirc with your credentials:
       url: https://cds.climate.copernicus.eu/api
       key: YOUR_API_KEY
  3. pip install cdsapi xarray netcdf4 numpy

Usage:
  python3 scripts/download-era5.py --year 2024
  python3 scripts/download-era5.py --year 2023 --year 2022
"""

import argparse
import cdsapi
from pathlib import Path

def download_year(year: int, out_dir: Path):
    out_path = out_dir / f"era5_soil_temp_{year}.nc"
    if out_path.exists():
        print(f"{year}: already downloaded at {out_path} ({out_path.stat().st_size // 1024}KB) — skipping")
        return out_path

    print(f"{year}: requesting ERA5 download from CDS...")
    c = cdsapi.Client()

    # Monthly means for the full year, then we'll resample to weekly in process script
    c.retrieve(
        "reanalysis-era5-land-monthly-means",
        {
            "product_type": "monthly_averaged_reanalysis",
            "variable": "soil_temperature_level_1",  # 0–7cm depth
            "year": str(year),
            "month": [f"{m:02d}" for m in range(1, 13)],
            "time": "00:00",
            "format": "netcdf",
            "area": [90, -180, -90, 180],  # global
        },
        str(out_path),
    )

    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"{year}: downloaded → {out_path} ({size_mb:.1f} MB)")
    return out_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, action="append", dest="years", required=True,
                        help="Year(s) to download (repeatable: --year 2024 --year 2023)")
    args = parser.parse_args()

    out_dir = Path(__file__).parent.parent / "data" / "era5-raw"
    out_dir.mkdir(parents=True, exist_ok=True)

    for year in args.years:
        download_year(year, out_dir)

if __name__ == "__main__":
    main()
