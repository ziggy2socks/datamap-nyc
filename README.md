# datamap.nyc

Parcel-level GIS suitability mapping for New York City — a digital interpretation of Ian McHarg's acetate overlay method.

**Live:** [datamap.nyc](https://datamap.nyc)

---

## What it is

datamap.nyc layers open civic data onto every one of NYC's 857,000+ tax parcels, letting you see the city through multiple lenses simultaneously:

- **Park Access** — gravity-model score measuring cumulative open space access within 1 mile
- **School Zones** — NYC DOE attendance zones colored by ELA proficiency (2024 School Quality Reports)
- **Building Height** — floors above grade from MapPLUTO
- **Year Built** — construction era from 1850 to present
- **Residential Density** — units per 1,000 sf of lot area
- **Flood Risk** — FEMA 100-year floodplain + NYC DEP stormwater zones

**Overlays** — combine any layers into a weighted composite (McHarg-style suitability map). Create, save, and apply named overlays to find where multiple criteria converge.

---

## Stack

- **Map:** MapLibre GL JS + PMTiles (vector tiles, no tile server needed)
- **Frontend:** Vite + React + TypeScript
- **Data pipeline:** Python (stdlib only, no pip beyond numpy)
- **Basemap:** Carto Light raster tiles
- **Data sources:** NYC Open Data, NYC MapPLUTO, NYC Parks, FEMA NFHL, NYC DOE

---

## Data

All data is public and citable:

| Layer | Source | Dataset |
|---|---|---|
| Parcel geometry + attributes | NYC MapPLUTO 24v2 | NYC Open Data `64uk-42ks` |
| Park/open space polygons | NYC Parks Dept. | NYC Open Data |
| School zone polygons | NYC DOE 2024–25 | `cmjf-yawu`, `t26j-jbq7`, `ruu9-egea` |
| School quality scores | NYC DOE School Quality Reports 2024 | `dnpx-dfnc` |
| 100-year floodplain | FEMA NFHL (2020) | Via NYC DEP |
| Stormwater flood risk | NYC DEP (2022) | NYC Open Data |

---

## Running locally

```bash
npm install
npm run dev
```

You'll also need the `parcels.pmtiles` file (174MB, not committed to git). Either:
- Run the data pipeline: `python3 scripts/build_parcel_data.py`
- Or set `VITE_PMTILES_URL` in `.env.local` to point to the hosted file

School zone GeoJSONs are committed to `public/data/` and work out of the box.

---

## Data pipeline

```bash
# Build parcel data (park scoring, school zone join, overlay percentile ranks)
# Uses cached data/raw/ — does NOT re-download unless cache is missing
python3 scripts/build_parcel_data.py

# Build school zone data (download + quality score join)
python3 scripts/build_school_zones.py
```

Pipeline outputs `data/processed/parcels.pmtiles` (~174MB). Requires `tippecanoe` and `numpy`.

---

## Design

Light mode. Inter (UI) + JetBrains Mono (data). Swiss editorial precision applied to civic data.

Inspired by Ian McHarg's *Design with Nature* (1969) — the idea that landscape suitability emerges from layering environmental, social, and physical data. McHarg used physical acetate sheets on a light table. We use weighted composites on a web map.

---

*Built with NYC open data. All scores are analytical tools, not recommendations.*
