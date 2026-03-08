#!/usr/bin/env python3
"""
Fetch yearly 311 complaint aggregates from NYC Open Data and write
static JSON files to public/data/311_year_{year}.json

Usage:
  python3 scripts/fetch_311_year.py           # fetch current year
  python3 scripts/fetch_311_year.py 2020 2025 # fetch range
  python3 scripts/fetch_311_year.py all       # fetch 2020 to current year
"""

import sys, json, time, urllib.request, urllib.error
from pathlib import Path
from datetime import datetime

API = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json'
OUT_DIR = Path(__file__).parent.parent / 'public' / 'data'

def fetch_year(year: int) -> list[dict]:
    """Fetch by quarter and merge — avoids single long query timeout."""
    quarters = [
        (f'{year}-01-01', f'{year}-04-01'),
        (f'{year}-04-01', f'{year}-07-01'),
        (f'{year}-07-01', f'{year}-10-01'),
        (f'{year}-10-01', f'{year+1}-01-01'),
    ]
    all_rows: list[dict] = []
    t0 = time.time()
    for i, (start, end) in enumerate(quarters, 1):
        qs = (
            f'$select=date_trunc_ym(created_date)+AS+month,complaint_type,count(*)+AS+cnt'
            f'&$where=created_date>=\'{start}\'AND+created_date<\'{end}\''
            f'&$group=date_trunc_ym(created_date),complaint_type'
            f'&$order=month+ASC'
            f'&$limit=2000'
        )
        url = f'{API}?{qs}'
        print(f'  Fetching {year} Q{i}... ', end='', flush=True)
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={'Accept': 'application/json'})
                with urllib.request.urlopen(req, timeout=90) as r:
                    rows = json.loads(r.read())
                print(f'{len(rows)} rows', flush=True)
                all_rows.extend(rows)
                break
            except Exception as e:
                if attempt == 2:
                    raise
                print(f'retry {attempt+1}...', end='', flush=True)
                time.sleep(3)
    elapsed = time.time() - t0
    # Merge quarter rows — same month/type may appear from rounding; sum them
    merged: dict[tuple, int] = {}
    for r in all_rows:
        key = (r['month'], r['complaint_type'])
        merged[key] = merged.get(key, 0) + int(r['cnt'])
    result = [{'month': k[0], 'complaint_type': k[1], 'cnt': str(v)} for k, v in merged.items()]
    print(f'  {year}: {len(result)} unique month×type rows in {elapsed:.1f}s total')
    return result

def write_year(year: int, raw: list[dict]):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    def parse_month(v: str) -> int:
        # May be ISO string (from Socrata) or already an int (from merged dict)
        if isinstance(v, int):
            return v  # already 0-based from merged dict... wait, merged keeps the raw string
        return datetime.fromisoformat(v.replace('.000', '')).month - 1
    rows = [
        {
            'month': parse_month(r['month']),
            'type':  r['complaint_type'],
            'count': int(r['cnt']),
        }
        for r in raw
    ]
    payload = {
        'year':      year,
        'generated': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'rows':      rows,
    }
    out = OUT_DIR / f'311_year_{year}.json'
    out.write_text(json.dumps(payload, separators=(',', ':')))
    size_kb = out.stat().st_size / 1024
    print(f'  → {out.relative_to(Path.cwd())} ({size_kb:.1f} KB)')

def main():
    current_year = datetime.now().year

    if len(sys.argv) == 1:
        years = [current_year]
    elif sys.argv[1] == 'all':
        years = list(range(2020, current_year + 1))
    else:
        try:
            if len(sys.argv) == 2:
                years = [int(sys.argv[1])]
            else:
                start, end = int(sys.argv[1]), int(sys.argv[2])
                years = list(range(start, end + 1))
        except ValueError:
            print('Usage: fetch_311_year.py [year | start end | all]')
            sys.exit(1)

    print(f'Fetching {len(years)} year(s): {years}')
    for year in years:
        try:
            raw = fetch_year(year)
            write_year(year, raw)
        except urllib.error.URLError as e:
            print(f'  ERROR fetching {year}: {e}')
        except Exception as e:
            print(f'  ERROR processing {year}: {e}')
            raise

    print('Done.')

if __name__ == '__main__':
    main()
