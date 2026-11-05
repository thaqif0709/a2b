#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).
"""Builds src/lib/bus-transit-data.json: Rapid KL bus routes from the
official GTFS feed published on data.gov.my for A2B's transit trips
(intended for eventual ride-mode bus integration, Phase 1 isolated).

    python3 scripts/build-transit-bus.py
"""

import csv
import io
import json
import math
import os
import re
import sys
import time
import urllib.request
import zipfile

FEED = 'prasarana-bus'
URL = 'https://api.data.gov.my/gtfs-static/prasarana?category=rapid-bus-kl'
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'lib', 'bus-transit-data.json')
UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)'
TRANSFER_M = 250
R = 6371008.8

ACRONYMS = {'KL', 'KLCC', 'MRT', 'MRR2', 'BRT', 'TBS', 'PJ', 'USJ', 'UV', 'PU', 'X', 'MRT3', 'LRT2'}


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return zipfile.ZipFile(io.BytesIO(r.read()))


def table(z, name):
    path = next((n for n in z.namelist() if n.endswith(name) and not n.startswith('__MACOSX')), None)
    if not path:
        return []
    text = z.read(path).decode('utf-8-sig')
    return [{k.strip(): (v or '').strip() for k, v in row.items() if k} for row in csv.DictReader(io.StringIO(text))]


def secs(t):
    h, m, s = (int(x) for x in t.split(':'))
    return h * 3600 + m * 60 + s


def title(name):
    name = name.strip()
    words = re.split(r'(\s+|-|/|\(|\))', name)
    out = []
    for w in words:
        if not w:
            continue
        if w.upper() in ACRONYMS or re.search(r'\d', w):
            out.append(w.upper() if w.isalpha() and len(w) <= 4 else w)
        elif w.isupper() or w.islower():
            out.append(w[:1].upper() + w[1:].lower())
        else:
            out.append(w)
    return ''.join(out).replace('  ', ' ')


def distance(a, b):
    dlat, dlng = math.radians(b[0] - a[0]), math.radians(b[1] - a[1])
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(min(1, math.sqrt(h)))


def encode(coords, precision=5):
    out, plat, plng, f = [], 0, 0, 10 ** precision
    for lng, lat in coords:
        ilat, ilng = round(lat * f), round(lng * f)
        for d in (ilat - plat, ilng - plng):
            v = ~(d << 1) if d < 0 else d << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plng = ilat, ilng
    return ''.join(out)


def simplify(coords, tol=0.00005):
    if len(coords) < 3:
        return coords
    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = coords[a], coords[b]
        best, idx = 0, None
        for i in range(a + 1, b):
            x, y = coords[i]
            dx, dy = x2 - x1, y2 - y1
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / (math.hypot(dx, dy) or 1e-12)
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [c for c, k in zip(coords, keep) if k]


def main():
    data = {'built': time.strftime('%Y-%m-%d'), 'feeds': {}, 'lines': {}, 'stops': [], 'services': {}, 'patterns': [], 'shapes': {}}
    stop_index = {}

    def stop(s):
        key = f"{FEED}:{s['stop_id']}"
        if key not in stop_index:
            stop_index[key] = len(data['stops'])
            data['stops'].append([title(s['stop_name']), round(float(s['stop_lat']), 6), round(float(s['stop_lon']), 6), s['stop_id']])
        return stop_index[key]

    z = fetch(URL)
    routes = {r['route_id']: r for r in table(z, 'routes.txt')}
    stops = {s['stop_id']: s for s in table(z, 'stops.txt')}
    trips = table(z, 'trips.txt')
    times = {}
    for st in table(z, 'stop_times.txt'):
        times.setdefault(st['trip_id'], []).append(st)
    freqs = {}
    for f in table(z, 'frequencies.txt'):
        freqs.setdefault(f['trip_id'], []).append([secs(f['start_time']), secs(f['end_time']), int(f['headway_secs'])])
    cal_end = None
    for c in table(z, 'calendar.txt'):
        days = [int(c[d]) for d in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')]
        data['services'][f"{FEED}:{c['service_id']}"] = {'days': days, 'start': c['start_date'], 'end': c['end_date'], 'add': [], 'remove': []}
        if cal_end is None or c['end_date'] > cal_end:
            cal_end = c['end_date']

    for s in table(z, 'shapes.txt'):
        data['shapes'].setdefault(f"{FEED}:{s['shape_id']}", []).append((int(s['shape_pt_sequence']), float(s['shape_pt_lon']), float(s['shape_pt_lat'])))

    groups = {}
    for t in trips:
        r = routes.get(t['route_id'])
        if not r or r['route_type'] != '3' or t['trip_id'] not in times:
            continue
        line = f"{FEED}:{r['route_id']}"
        data['lines'][line] = {
            'short': r['route_short_name'] or r['route_id'],
            'name': r['route_long_name'] or r['route_short_name'],
            'color': '#' + (r.get('route_color') or '2b5f8a'),
            'text': '#' + (r.get('route_text_color') or 'FFFFFF'),
            'kind': 'Bus',
        }
        st = sorted(times[t['trip_id']], key=lambda x: int(x['stop_sequence']))
        ids = tuple(stop(stops[x['stop_id']]) for x in st if x['stop_id'] in stops)
        if len(ids) < 2:
            continue
        arr = [secs(x['arrival_time']) for x in st if x['stop_id'] in stops]
        dep = [secs(x['departure_time']) for x in st if x['stop_id'] in stops]
        key = (line, t.get('direction_id', '0'), f"{FEED}:{t['service_id']}", ids)
        g = groups.setdefault(key, {'line': line, 'service': key[2], 'stops': list(ids), 'headsign': t['trip_headsign'].strip(), 'shape': None, 'trips': [], 'freq': None})
        if not g['headsign']:
            g['headsign'] = title(data['stops'][ids[-1]][0])
        if t.get('shape_id'):
            g['shape'] = f"{FEED}:{t['shape_id']}"
        if t['trip_id'] in freqs:
            g['offsets'] = [a - dep[0] for a in arr]
            g['freq'] = sorted(freqs[t['trip_id']])
        else:
            g['trips'].append(dep)
    for g in groups.values():
        if g['freq'] is None:
            g['trips'].sort(key=lambda d: d[0])
            del g['freq']
        else:
            del g['trips']
        data['patterns'].append(g)

    data['feeds'][FEED] = {'until': cal_end, 'source': URL}

    pts = [(s[1], s[2]) for s in data['stops']]
    data['nearby'] = [[[j, round(distance(a, b))] for j, b in enumerate(pts) if j != i and distance(a, b) <= TRANSFER_M] for i, a in enumerate(pts)]

    used = {g['shape'] for g in data['patterns'] if g.get('shape')}
    data['shapes'] = {k: encode(simplify([(lng, lat) for _, lng, lat in sorted(v)])) for k, v in data['shapes'].items() if k in used}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
    print(f"Wrote {len(data['lines'])} lines, {len(data['stops'])} stops, {len(data['patterns'])} patterns "
          f"({os.path.getsize(OUT) / 1024:.0f} KB) to {os.path.relpath(OUT)}",
          flush=True)


if __name__ == '__main__':
    sys.exit(main())
