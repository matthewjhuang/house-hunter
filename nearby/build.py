#!/usr/bin/env python3
"""Builds nearby/nearby.json: every Coles, Woolworths, Aldi and Chemist Warehouse in
greater Melbourne, and every named public park of at least 1 hectare, from
OpenStreetMap (Overpass API).

The travel-times Edge Function reads this file from GitHub to find each listing's
closest store of each kind and closest park, so none of it is stored in Supabase.
A GitHub Action (.github/workflows/nearby-data.yml) reruns this monthly; you can also
run it by hand:

    python3 nearby/build.py

Standard library only. If Overpass is down or returns suspiciously little, it exits
with an error and leaves the existing file alone.
"""
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

OUT = Path(__file__).with_name("nearby.json")
BBOX = "-38.30,144.55,-37.50,145.55"  # greater Melbourne: Werribee to the Dandenongs
MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
UA = "HouseHunter/1.0 (https://matthewjhuang.github.io/house-hunter/)"
MIN_PARK_HA = 1.0
PARK_POINTS = 16  # boundary points kept per park, for distance to its edge

# Brand patterns, checked against brand then name. Coles Express is a petrol station.
BRANDS = {
    "coles": r"^coles\b(?!.*express)",
    "woolworths": r"^(woolworths|woolies)\b",
    "aldi": r"^aldi\b",
    "chemist_warehouse": r"chemist warehouse",
}
# Each brand's least plausible count for all of greater Melbourne.
MINIMUMS = {"coles": 100, "woolworths": 100, "aldi": 60, "chemist_warehouse": 80, "parks": 1500}


def overpass(query):
    last = None
    for attempt in range(3):
        for url in MIRRORS:
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": query}).encode(), headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=180) as res:
                    return json.load(res)["elements"]
            except Exception as err:  # network errors, 429/502/504, bad JSON
                last = err
                print(f"  {url}: {err}", file=sys.stderr)
        time.sleep(30 * (attempt + 1))
    raise SystemExit(f"Overpass failed: {last}")


def ring_area(pts):
    """Area in square metres of a closed [(lat, lon), ...] ring."""
    if len(pts) < 4:
        return 0.0
    k = math.cos(math.radians(sum(p[0] for p in pts) / len(pts))) * 111_320
    return abs(sum(x1 * k * y2 * 111_320 - x2 * k * y1 * 111_320 for (y1, x1), (y2, x2) in zip(pts, pts[1:]))) / 2


def stitch(ways):
    """Joins a relation's member ways into closed rings."""
    ways = [list(w) for w in ways if w]
    rings = []
    while ways:
        cur = ways.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, w in enumerate(ways):
                if w[0] == cur[-1]:
                    cur += w[1:]
                elif w[-1] == cur[-1]:
                    cur += w[::-1][1:]
                elif w[-1] == cur[0]:
                    cur = w[:-1] + cur
                elif w[0] == cur[0]:
                    cur = w[::-1][:-1] + cur
                else:
                    continue
                ways.pop(i)
                changed = True
                break
        rings.append(cur)
    return rings


def geometry(e):
    """(area in ha, outline points) for a park way or relation."""
    if e["type"] == "way":
        pts = [(p["lat"], p["lon"]) for p in e.get("geometry", [])]
        return ring_area(pts) / 10_000, pts
    members = e.get("members", [])
    outer = [[(p["lat"], p["lon"]) for p in m.get("geometry", [])] for m in members if m.get("role") in ("outer", "") and m.get("geometry")]
    inner = [[(p["lat"], p["lon"]) for p in m.get("geometry", [])] for m in members if m.get("role") == "inner" and m.get("geometry")]
    area = sum(ring_area(r) for r in stitch(outer)) - sum(ring_area(r) for r in stitch(inner))
    return area / 10_000, [p for r in outer for p in r]


def sample(pts, n):
    step = max(1, len(pts) // n)
    return [[round(y, 5), round(x, 5)] for y, x in pts[::step][:n]]


def main():
    print("Parks…")
    parks = []
    for e in overpass(f'[out:json][timeout:170][bbox:{BBOX}];(way["leisure"="park"];relation["leisure"="park"];'
                      f'way["leisure"="nature_reserve"];relation["leisure"="nature_reserve"];);out tags geom;'):
        t = e.get("tags", {})
        if not t.get("name") or t.get("access") in ("private", "no"):
            continue
        ha, pts = geometry(e)
        if ha >= MIN_PARK_HA and pts:
            parks.append([t["name"], round(ha, 1), sample(pts, PARK_POINTS)])

    print("Stores…")
    stores = {b: [] for b in BRANDS}
    for e in overpass(f'[out:json][timeout:170][bbox:{BBOX}];(nwr["shop"="supermarket"];nwr["amenity"="pharmacy"];nwr["shop"="chemist"];);out tags center;'):
        t = e.get("tags", {})
        lat = e.get("lat") or e.get("center", {}).get("lat")
        lon = e.get("lon") or e.get("center", {}).get("lon")
        if lat is None:
            continue
        for brand, rx in BRANDS.items():
            if re.search(rx, t.get("brand", ""), re.I) or re.search(rx, t.get("name", ""), re.I):
                stores[brand].append([round(lat, 5), round(lon, 5), t.get("name") or t.get("brand")])
                break

    counts = {**{b: len(v) for b, v in stores.items()}, "parks": len(parks)}
    print(counts)
    short = [k for k, n in counts.items() if n < MINIMUMS[k]]
    if short:
        raise SystemExit(f"Too few results for {short}; keeping the existing file")

    data = {"updated": date.today().isoformat(), "source": "© OpenStreetMap contributors (ODbL)", "stores": stores, "parks": sorted(parks)}
    OUT.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"Wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
