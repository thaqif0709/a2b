#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).
"""Builds A2B's offline-friendly place search data from Overture Maps (free, open data).

Downloads Overture's places for one country, keeps the reasonably confident ones that are still open, and
writes them as small JSON files into public/places/: one file per area of 0.5 x 0.5 degrees (about
55 x 55 km) and first letter of a word in the place's name. Searching "nandos" near you downloads only
the "n" file for your area and the areas next to it, and searches it on the phone, so this costs nothing
to host and uses no database. Each area also gets a file per kind of place people look for nearby (petrol
stations, hospitals, clinics, police stations, convenience stores, EV chargers; see TYPES), for searches like "petrol"
that name a kind of place rather than a place: most petrol stations are just called "Petronas" or "Shell".

OpenStreetMap-sourced places are left out: A2B already searches OpenStreetMap through Photon, and leaving
them out keeps these files free of ODbL share-alike terms.

    pip install duckdb
    python3 scripts/build-places.py                       # Malaysia, latest release set below
    python3 scripts/build-places.py --country SG --release 2026-11-18.0

Overture publishes a new release monthly: https://docs.overturemaps.org/release-calendar/
"""

import argparse
import json
import math
import os
import re
import shutil
import sys
import time
import unicodedata

DEFAULT_RELEASE = '2026-10-21.0'
AREA = 0.5  # degrees; public/places.js reads it from index.json
SPLIT_OVER = 3000  # a file with more places than this is split by the next letter ("s" -> "sa", "sh", "st"…)
MAX_PREFIX = 3

# Kinds of place searched for by type (public/places.js TYPE_WORDS): Overture categories, and for categories that
# mix kinds (its "hospital" covers every klinik too), what the name must or mustn't say. Files are named "@<type>".
HOSPITAL_NAME = re.compile(r'\b(hospital|hospitals|hosp|medical cent(re|er)|medical specialist|specialist (cent(re|er)|hospital)|pusat perubatan)\b', re.I)
CLINIC_NAME = re.compile(r'\b(klinik|clinic|poliklinik|polyclinic|kesihatan|medical clinic|dr|doctor)\b', re.I)
DENTAL_NAME = re.compile(r'\b(dental|dentist|pergigian|gigi|orthodontic)\b', re.I)
CLINIC_CATEGORIES = {
    'primary_care_or_general_clinic', 'walk_in_clinic', 'urgent_care_clinic', 'outpatient_care_facility',
    'pediatric_clinic', 'emergency_or_urgent_care_facility',
}
TYPES = {
    'fuel': lambda name, cat: cat in ('gas_station', 'fueling_station'),
    'hospital': lambda name, cat: cat in ('specialty_hospital', 'emergency_department')
        or (cat in ('hospital', 'specialized_medical_facility', 'medical_service', 'health_care')
            and bool(HOSPITAL_NAME.search(name)) and not CLINIC_NAME.search(name)),
    'clinic': lambda name, cat: not DENTAL_NAME.search(name) and (
        cat in CLINIC_CATEGORIES
        or (cat in ('hospital', 'health_care', 'medical_service') and bool(CLINIC_NAME.search(name)))),
    'police': lambda name, cat: cat == 'police_station',
    'convenience': lambda name, cat: cat == 'convenience_store',
    'ev': lambda name, cat: cat == 'ev_charging_station',  # the server adds OpenStreetMap's and Open Charge Map's
    # Not searched for: tells which mall a shop is in, when its address gives a floor but not the mall (public/indoor.js).
    'mall': lambda name, cat: cat == 'shopping_mall',
}

# Rough bounding boxes, so Overture only has to scan the right parts of its files.
COUNTRY_BOXES = {
    'MY': (99.5, 0.8, 119.5, 7.5),
    'SG': (103.55, 1.15, 104.1, 1.5),
    'BN': (114.0, 4.0, 115.4, 5.1),
}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--release', default=DEFAULT_RELEASE)
    ap.add_argument('--country', default='MY', help='ISO country code as used in Overture addresses')
    ap.add_argument('--min-confidence', type=float, default=0.6)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'public', 'places'))
    args = ap.parse_args()

    try:
        import duckdb
    except ImportError:
        sys.exit('Needs DuckDB: pip install duckdb')

    box = COUNTRY_BOXES.get(args.country)
    if not box:
        sys.exit(f'No bounding box for {args.country}; add one to COUNTRY_BOXES.')

    con = duckdb.connect()
    con.execute('INSTALL httpfs; LOAD httpfs;')
    # Overture's bucket is public; anonymous access avoids picking up unrelated AWS credentials.
    con.execute("CREATE SECRET overture (TYPE s3, PROVIDER config, KEY_ID '', SECRET '', REGION 'us-west-2')")
    src = f"read_parquet('s3://overturemaps-us-west-2/release/{args.release}/theme=places/type=place/*', hive_partitioning=1)"
    w, s, e, n = box
    print(f'Reading Overture {args.release} places for {args.country}…', flush=True)
    t0 = time.time()
    rows = con.execute(f"""
        SELECT names.primary AS name,
               (bbox.xmin + bbox.xmax) / 2 AS lng,
               (bbox.ymin + bbox.ymax) / 2 AS lat,
               addresses[1].freeform AS street,
               addresses[1].locality AS locality,
               coalesce(basic_category, taxonomy.primary) AS category,
               confidence
        FROM {src}
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n}
          AND addresses[1].country = ?
          AND confidence >= ?
          AND names.primary IS NOT NULL
          AND coalesce(operating_status, 'open') NOT IN ('permanently_closed', 'temporarily_closed', 'closed')
          AND NOT contains(CAST(sources AS VARCHAR), 'OpenStreetMap')  -- any OSM source at all
        ORDER BY confidence DESC
    """, [args.country, args.min_confidence]).fetchall()
    print(f'  {len(rows):,} places in {time.time() - t0:.0f}s', flush=True)

    shards = {}  # 'area/prefix' -> [(place, words)]
    typed = {}  # 'area/@kind' -> [(place, words)]
    for name, lng, lat, street, locality, category, _conf in rows:
        area = f'{math.floor(lat / AREA)}_{math.floor(lng / AREA)}'
        address = ', '.join(dict.fromkeys(p.strip() for p in (street, locality) if p and p.strip()))[:70]
        place = [name.strip()[:70], round(lng, 5), round(lat, 5), address, category or '']
        name_words = words(name)
        for letter in sorted({shard_letter(w) for w in name_words}):
            shards.setdefault(f'{area}/{letter}', []).append((place, name_words))
        for kind, test in TYPES.items():
            if test(name, category or ''):
                typed.setdefault(f'{area}/@{kind}', []).append((place, name_words))
    shards = split_big(shards)
    shards.update(typed)  # never split: one file per kind and area

    out = os.path.abspath(args.out)
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)
    total_bytes = 0
    areas = {}
    for key, entries in shards.items():
        area, letter = key.split('/')
        places = [p for p, _ in entries]
        os.makedirs(os.path.join(out, area), exist_ok=True)
        body = json.dumps({'p': places}, ensure_ascii=False, separators=(',', ':'))
        total_bytes += len(body.encode())
        with open(os.path.join(out, area, f'{letter}.json'), 'w', encoding='utf-8') as f:
            f.write(body)
        areas.setdefault(area, {})[letter] = len(places)

    index = {
        'source': 'Overture Maps Foundation places',
        'release': args.release,
        'country': args.country,
        'built': time.strftime('%Y-%m-%d'),
        'area': AREA,
        'minConfidence': args.min_confidence,
        'count': len(rows),
        'areas': sorted(areas),
        'attribution': 'Places: Overture Maps Foundation (Meta, Microsoft, Foursquare, AllThePlaces and others)',
    }
    with open(os.path.join(out, 'index.json'), 'w') as f:
        json.dump(index, f, separators=(',', ':'))
    # Each area lists its own files, so a phone only fetches the lists for the areas around it.
    for area, prefixes in areas.items():
        with open(os.path.join(out, area, 'files.json'), 'w') as f:
            json.dump(dict(sorted(prefixes.items())), f, separators=(',', ':'))
    with open(os.path.join(out, 'NOTICE.txt'), 'w') as f:
        f.write(NOTICE.format(release=args.release))

    biggest = max(shards.items(), key=lambda kv: len(kv[1]))
    print(f'  {len(areas):,} areas, {len(shards):,} files, {total_bytes / 1e6:.1f} MB before compression; '
          f'biggest file {biggest[0]} has {len(biggest[1]):,} places', flush=True)
    print(f'Wrote {out}')


# Same rules as normalizeText() in public/text.js: case, accents and apostrophes don't matter.
def normalize(text):
    text = unicodedata.normalize('NFD', text or '')
    text = ''.join(c for c in text if not unicodedata.combining(c)).lower()
    return re.sub(r"['\u2019`.]", '', text)


def words(text):
    return [w for w in re.split(r'[\W_]+', normalize(text)) if w]


def split_big(shards):
    # Busy prefixes get split by one more letter until each file is small. A place goes in every file
    # matching a word of its name; a word shorter than the new prefix stays in the parent file.
    done = {}
    todo = list(shards.items())
    while todo:
        key, entries = todo.pop()
        area, prefix = key.split('/')
        if len(entries) <= SPLIT_OVER or len(prefix) >= MAX_PREFIX or prefix == '_':
            done[key] = entries
            continue
        parts, keep = {}, []
        for place, name_words in entries:
            longer = {w[: len(prefix) + 1] for w in name_words if w.startswith(prefix) and len(w) > len(prefix)}
            longer = {p for p in longer if p.isascii() and p.isalnum()}
            if not longer:
                keep.append((place, name_words))
            for p in longer:
                parts.setdefault(p, []).append((place, name_words))
        if keep:
            done[key] = keep
        todo.extend((f'{area}/{p}', e) for p, e in parts.items())
    return done


def shard_letter(word):
    c = word[0]
    return c if c.isascii() and c.isalnum() else '_'


NOTICE = """Place data in this folder comes from the Overture Maps Foundation places dataset, release {release}
(https://overturemaps.org). Each place keeps the licence of its original source:

- Meta and Microsoft places: Community Data License Agreement - Permissive 2.0 (https://cdla.dev/permissive-2-0/)
- Foursquare Open Source Places: Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)
- AllThePlaces: CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/)
- Other sources: see https://docs.overturemaps.org/attribution

OpenStreetMap-sourced places are not included here. Fields have been trimmed (name, position, short address,
category) and the data split into map cells for A2B's place search.
"""

if __name__ == '__main__':
    main()
