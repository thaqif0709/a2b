#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).
"""Builds A2B's own place search from every open source we may keep, as files the phone searches (public/places/,
read by public/places.js), so finding a place takes no server.

  - Overture Maps: shops and landmarks (mostly from Meta and Microsoft), named streets (one entry per street per
    neighbourhood) and addresses.
  - OpenStreetMap, from Geofabrik's extract: named shops, offices, buildings, condos, housing areas (Taman …),
    villages, stations and more, and house addresses. Downloaded once into data/osm/ (~250 MB).
  - Foursquare Open Source Places (Apache 2.0), when HF_TOKEN is set: a Hugging Face token whose account has
    accepted the dataset's terms at https://huggingface.co/datasets/foursquare/fsq-os-places.

One place listed by several sources becomes one row: the same name, or one name and the same name with more words
("KFC" and "KFC Nu Sentral"), within 100 m (300 m for a landmark), keeping OpenStreetMap's pin, the fullest address
and every source; a landmark's copies pinned elsewhere by one source are dropped (see without_copies).

The places are written into public/places/ next to the kinds of place scripts/build-places.py writes there (@fuel,
@hospital, …; run it first): one file per area of 0.5 x 0.5 degrees and first letters of a word in a place's name,
for every word but the very common ones (COMMON, as in public/places.js). The files are a database made partly from
OpenStreetMap, so they're published under the ODbL (public/places/NOTICE.txt). Places drivers add come from the
server (see src/lib/suggestions.js), not from here.

    pip install duckdb
    npm run places && npm run locations                    # public/places/
    python3 scripts/build-locations.py --reuse             # again from the last downloads, in a minute

Overture publishes a new release monthly: https://docs.overturemaps.org/release-calendar/
Geofabrik's extract is rebuilt daily; --fresh-osm downloads it again.
"""
import argparse
import collections
import glob
import json
import math
import os
import pickle
import re
import sys
import time
import unicodedata
import urllib.request
import zlib

DEFAULT_RELEASE = '2026-10-21.0'
FSQ_RELEASE = '2026-10-15'  # https://huggingface.co/datasets/foursquare/fsq-os-places/tree/main/release
OSM_URL = 'https://download.geofabrik.de/asia/malaysia-singapore-brunei-latest.osm.pbf'
COUNTRY_BOXES = {'MY': (99.5, 0.8, 119.5, 7.5), 'SG': (103.55, 1.15, 104.1, 1.5), 'BN': (114.0, 4.0, 115.4, 5.1)}
AREA = 0.5  # degrees, as scripts/build-places.py; public/places.js reads it from index.json
SPLIT_OVER = 3000  # a file with more places than this is split by the next letter ("s" -> "sa", "sh", "st"…)
MAX_PREFIX = 3
# Words too common to look a place up by (each in over 15,000 names and addresses): the same list as COMMON in
# public/places.js. A search of only these ("kuala lumpur") is left to the server's geocoder.
COMMON = {
    'jalan', 'jln', 'lorong', 'lrg', 'persiaran', 'taman', 'tmn', 'kampung', 'kg', 'bandar', 'pusat', 'kota', 'bukit',
    'sungai', 'sg', 'batu', 'baru', 'jaya', 'alam', 'indah', 'perdana', 'sri', 'seri', 'kuala', 'lumpur', 'petaling', 'shah',
    'johor', 'bahru', 'ipoh', 'klang', 'kinabalu', 'kuching', 'miri', 'malaysia', 'lot', 'floor', 'ground', 'centre', 'mall',
    'restoran', 'restaurant', 'cafe', 'kedai', 'klinik', 'masjid', 'sdn', 'bhd', 'the', 'and',
}
# Categories that read as landmarks (and get found from further away): Overture's, then OpenStreetMap's tag values,
# then Foursquare's.
LANDMARKS = {
    'shopping_center', 'shopping_mall', 'train_station', 'metro_station', 'bus_station', 'airport', 'hospital', 'park',
    'university', 'college_university', 'mosque', 'hindu_temple', 'buddhist_temple', 'church', 'stadium', 'museum',
    'landmark_and_historical_building', 'tourist_attraction', 'convention_center', 'zoo', 'beach', 'theme_park',
    'mall', 'station', 'aerodrome', 'college', 'place_of_worship', 'attraction', 'ferry_terminal', 'terminal',
    'city', 'town', 'suburb', 'village', 'neighbourhood', 'quarter', 'residential',
    'shopping_plaza', 'rail_station',
}
SKIP_ROADS = "('footway', 'path', 'steps', 'cycleway', 'pedestrian', 'bridleway', 'track', 'unknown')"
# OpenStreetMap tags that make a named thing a place to search for, in the order their value names its category.
OSM_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'office', 'craft', 'healthcare', 'historic', 'place', 'railway',
            'public_transport', 'aeroway', 'building', 'landuse']
SOURCE_ORDER = ['osm', 'overture', 'foursquare']  # whose pin and name a merged place keeps
SOURCE_BITS = {'osm': 1, 'overture': 2, 'foursquare': 4}  # as public/places.js reads them
NEAR_M = 100
NEAR_LANDMARK_M = 300
NEAR_VENUE_M = 500  # a mall or a station is big: its listings can be this far apart
COPY_SPOT_M = 3000  # a landmark confirmed within this of itself is in one spot
NAMED_AFTER_M = 5000  # a shop named after a mall is in it, or near it
MALLS = {'shopping_center', 'shopping_mall', 'mall'}
# Where "one of a kind, so the same name elsewhere is a copy" holds: malls and airports. Not hospitals or universities,
# whose departments (Jabatan Patologi, Faculty of Civil Engineering) are real in many.
ONE_OF_A_KIND = MALLS | {'airport', 'aerodrome'}
NOT_DISTINCT = {'mall', 'plaza', 'store', 'shop', 'one', 'stop', 'centre', 'center', 'city', 'the', 'square', 'point',
                'galleria', 'complex', 'shopping', 'pusat', 'mart', 'big'}
VENUES = {'shopping_center', 'shopping_mall', 'mall', 'train_station', 'metro_station', 'rail_station', 'station', 'airport',
          'aerodrome', 'terminal', 'ferry_terminal', 'bus_station', 'hospital', 'university', 'college_university', 'stadium',
          'museum', 'zoo', 'theme_park', 'convention_center', 'tourist_attraction', 'attraction'}
# Words that say what kind of place it is, or the company form, not which one.
GENERIC = {'sdn', 'bhd', 'berhad', 'plt', 'the', 'and', 'dan', 'klinik', 'clinic', 'kedai', 'restoran', 'restaurant',
           'cafe', 'hotel', 'masjid', 'surau', 'sekolah', 'school', 'taman', 'jalan', 'bank', 'stesen', 'station'}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--release', default=DEFAULT_RELEASE)
    ap.add_argument('--country', default='MY')
    ap.add_argument('--min-confidence', type=float, default=0.6)
    ap.add_argument('--osm', help='an .osm.pbf to read instead of downloading Geofabrik\'s')
    ap.add_argument('--fresh-osm', action='store_true', help='download Geofabrik\'s extract again')
    ap.add_argument('--no-osm', action='store_true', help='leave OpenStreetMap\'s places and addresses out')
    ap.add_argument('--fsq-release', default=FSQ_RELEASE)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'public', 'places'))
    ap.add_argument('--addresses', action='store_true', help='also house addresses (153,000 more rows; the geocoder has them)')
    ap.add_argument('--reuse', action='store_true', help='reuse the last run\'s downloads (data/locations-sources.pickle)')
    args = ap.parse_args()
    try:
        import duckdb
    except ImportError:
        sys.exit('Needs DuckDB: pip install duckdb')
    if args.country not in COUNTRY_BOXES:
        sys.exit(f'No bounding box for {args.country}; add one to COUNTRY_BOXES.')
    data = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'data'))
    saved = os.path.join(data, 'locations-sources.pickle')
    if args.reuse:
        with open(saved, 'rb') as f:
            places, streets, addresses = pickle.load(f)
        print(f'Reusing {saved}', flush=True)
    else:
        places, streets, addresses = download(args, duckdb, data)
        with open(saved, 'wb') as f:
            pickle.dump((places, streets, addresses), f)
    rows = merge_duplicates([(name, addr, cat, kind_of(name, cat), lat, lng, src) for name, addr, cat, lat, lng, src in places])
    rows += [(name, addr, cat, 'street', lat, lng, src) for name, addr, cat, lat, lng, src in streets]
    if args.addresses:
        rows += merge_duplicates([(name, addr, cat, 'address', lat, lng, src) for name, addr, cat, lat, lng, src in addresses])
    write_files(rows, os.path.abspath(args.out), f'{args.release}+{time.strftime("%Y%m%d")}')
    common_words(rows)


def download(args, duckdb, data):
    """Every source's places, streets and addresses, as (name, address, category, lat, lng, source) rows."""
    w, s, e, n = COUNTRY_BOXES[args.country]
    in_box = f'bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n}'
    base = f's3://overturemaps-us-west-2/release/{args.release}'
    con = duckdb.connect()
    con.execute('INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;')
    con.execute(f"SET temp_directory = '{os.path.join(data, 'duckdb-tmp')}'")
    con.execute("CREATE SECRET overture (TYPE s3, PROVIDER config, KEY_ID '', SECRET '', REGION 'us-west-2')")

    def step(label, sql, params=()):
        t0 = time.time()
        rows = con.execute(sql, list(params)).fetchall()
        print(f'  {label}: {len(rows):,} in {time.time() - t0:.0f}s', flush=True)
        return rows

    print(f'Overture {args.release}, {args.country}', flush=True)
    # The country's outline: streets, and OpenStreetMap places, carry no country of their own.
    con.execute(f"""
        CREATE TABLE outline AS SELECT geometry FROM read_parquet('{base}/theme=divisions/type=division_area/*', hive_partitioning=1)
        WHERE subtype = 'country' AND country = '{args.country}'  -- no box: the sea border can reach past it
    """)
    inside = 'EXISTS (SELECT 1 FROM outline o WHERE ST_Contains(o.geometry, ST_Point({lng}, {lat})))'
    places = step('shops and landmarks', f"""
        WITH p AS (
          SELECT names.primary AS name,
                 concat_ws(', ', nullif(trim(addresses[1].freeform), ''), nullif(trim(addresses[1].locality), '')) AS address,
                 coalesce(basic_category, taxonomy.primary, '') AS category, (bbox.ymin + bbox.ymax) / 2 AS lat, (bbox.xmin + bbox.xmax) / 2 AS lng,
                 contains(CAST(sources AS VARCHAR), 'OpenStreetMap') AS osm, addresses[1].country AS country
          FROM read_parquet('{base}/theme=places/type=place/*', hive_partitioning=1)
          WHERE {in_box} AND confidence >= ? AND names.primary IS NOT NULL
            AND coalesce(operating_status, 'open') NOT IN ('permanently_closed', 'temporarily_closed', 'closed')
            AND (addresses[1].country = ? OR addresses[1].country IS NULL)
        )
        SELECT name, address, category, lat, lng, CASE WHEN osm THEN 'osm' ELSE 'overture' END FROM p
        WHERE country = ? OR {inside.format(lng='p.lng', lat='p.lat')}
    """, [args.min_confidence, args.country, args.country])

    streets = step('named streets', f"""
        WITH seg AS (
          SELECT names.primary AS name, (bbox.ymin + bbox.ymax) / 2 AS lat, (bbox.xmin + bbox.xmax) / 2 AS lng
          FROM read_parquet('{base}/theme=transportation/type=segment/*', hive_partitioning=1)
          WHERE {in_box} AND subtype = 'road' AND names.primary IS NOT NULL AND coalesce(class, 'unknown') NOT IN {SKIP_ROADS}
        )
        SELECT any_value(name), '', 'street', avg(lat), avg(lng), 'osm'
        FROM seg WHERE {inside.format(lng='seg.lng', lat='seg.lat')}
        GROUP BY lower(name), round(lat * 20), round(lng * 20)
    """)
    addresses = step('addresses', f"""
        SELECT trim(coalesce(number, '') || CASE WHEN number IS NULL THEN '' ELSE ', ' END || coalesce(street, '')),
               trim(coalesce(postcode, '') || ' ' || coalesce(postal_city, '')), 'address',
               (bbox.ymin + bbox.ymax) / 2, (bbox.xmin + bbox.xmax) / 2, 'overture'
        FROM read_parquet('{base}/theme=addresses/type=address/*', hive_partitioning=1)
        WHERE {in_box} AND country = ? AND street IS NOT NULL
    """, [args.country])

    if not args.no_osm:
        pbf = args.osm or osm_extract(os.path.join(data, 'osm'), args.fresh_osm)
        print(f'OpenStreetMap {os.path.basename(pbf)}', flush=True)
        osm_places, osm_addresses = read_osm(con, step, pbf, w, s, e, n, inside)
        places = osm_places + places
        addresses += osm_addresses
    places += read_foursquare(con, step, args.fsq_release, args.country, w, s, e, n, inside)
    return places, streets, addresses


NOT_LANDMARK = re.compile(r'^(surau|entrance|exit|pintu|laluan|lif|lift|escalator|tangga)\b', re.I)


def kind_of(name, category):
    """'landmark' or 'place'. A surau is a prayer room, and an entrance, a lift or a stair is part of a landmark."""
    return 'landmark' if category in LANDMARKS and not NOT_LANDMARK.match(name) else 'place'


def osm_extract(folder, fresh):
    path = os.path.join(folder, os.path.basename(OSM_URL))
    if fresh or not os.path.exists(path):
        os.makedirs(folder, exist_ok=True)
        print(f'Downloading {OSM_URL} …', flush=True)
        urllib.request.urlretrieve(OSM_URL, path + '.part')
        os.replace(path + '.part', path)
    return path


def read_osm(con, step, pbf, w, s, e, n, inside):
    """OpenStreetMap's named places and its house addresses inside the country, as rows like Overture's."""
    pbf = pbf.replace("'", "''")
    con.execute(f"""
        CREATE TEMP TABLE osm AS SELECT kind, id, tags, refs, lat, lon FROM ST_ReadOSM('{pbf}')
        WHERE kind = 'node' OR (kind = 'way' AND (map_contains(tags, 'name') OR map_contains(tags, 'addr:housenumber')))
    """)
    wanted = ' OR '.join(f"map_contains(tags, '{k}')" for k in OSM_KEYS)
    category = 'coalesce(' + ', '.join(f"nullif(nullif(tags['{k}'], 'yes'), '')" for k in OSM_KEYS) + ", 'building')"
    tag = lambda k: f"nullif(trim(tags['{k}']), '')"
    # A way's pin is the middle of its points.
    con.execute(f"""
        CREATE TEMP TABLE osm_features AS
        WITH f AS (
          SELECT * FROM osm
          WHERE (map_contains(tags, 'name') AND NOT map_contains(tags, 'highway') AND ({wanted}))
             OR (map_contains(tags, 'addr:housenumber') AND map_contains(tags, 'addr:street'))
        ), mid AS (
          SELECT r.id, avg(p.lat) AS lat, avg(p.lon) AS lon
          FROM (SELECT id, unnest(refs) AS node_id FROM f WHERE kind = 'way') r JOIN osm p ON p.kind = 'node' AND p.id = r.node_id
          GROUP BY r.id
        )
        SELECT f.tags, coalesce(f.lat, mid.lat) AS lat, coalesce(f.lon, mid.lon) AS lng
        FROM f LEFT JOIN mid ON f.kind = 'way' AND mid.id = f.id
        WHERE coalesce(f.lat, mid.lat) BETWEEN {s} AND {n} AND coalesce(f.lon, mid.lon) BETWEEN {w} AND {e}
    """)
    con.execute('DROP TABLE osm')
    street_address = f"concat_ws(', ', {tag('addr:housenumber')}, {tag('addr:street')})"
    area = f"concat_ws(' ', {tag('addr:postcode')}, coalesce({tag('addr:city')}, {tag('addr:place')}, {tag('addr:suburb')}))"
    places = step('OpenStreetMap places', f"""
        SELECT trim(tags['name']), concat_ws(', ', nullif({street_address}, ''), nullif({area}, '')), {category}, lat, lng, 'osm'
        FROM osm_features
        WHERE map_contains(tags, 'name') AND {inside.format(lng='lng', lat='lat')}
    """)
    addresses = step('OpenStreetMap addresses', f"""
        SELECT {street_address}, {area}, 'address', lat, lng, 'osm'
        FROM osm_features
        WHERE NOT map_contains(tags, 'name') AND map_contains(tags, 'addr:housenumber') AND map_contains(tags, 'addr:street')
          AND {inside.format(lng='lng', lat='lat')}
    """)
    return places, addresses


def read_foursquare(con, step, release, country, w, s, e, n, inside):
    """Foursquare's open places inside the country's outline (its own country field isn't always right), still open,
    not flagged by its users (closed, doesn't exist, …) and seen in the last three years, when HF_TOKEN is set."""
    token = os.environ.get('HF_TOKEN')
    if not token:
        print('Foursquare: skipped (set HF_TOKEN to include it)', flush=True)
        return []
    con.execute('CREATE SECRET fsq (TYPE huggingface, TOKEN ?)', [token])
    print(f'Foursquare {release}', flush=True)
    return step('Foursquare places', f"""
        SELECT trim(name), concat_ws(', ', nullif(trim(address), ''), nullif(trim(locality), '')),
               lower(regexp_replace(coalesce(list_last(string_split(fsq_category_labels[1], ' > ')), ''), '[^A-Za-z0-9]+', '_', 'g')),
               latitude, longitude, 'foursquare'
        FROM read_parquet('hf://datasets/foursquare/fsq-os-places/release/dt={release}/places/parquet/*.parquet')
        WHERE country = ? AND date_closed IS NULL AND name IS NOT NULL AND coalesce(len(unresolved_flags), 0) = 0
          AND latitude BETWEEN {s} AND {n} AND longitude BETWEEN {w} AND {e}
          AND CAST(date_refreshed AS DATE) >= current_date - INTERVAL 3 YEAR
          AND {inside.format(lng='longitude', lat='latitude')}
    """, [country])


def name_words(name):
    t = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()
    return [x for x in re.split(r'[^a-z0-9]+', t) if x and x not in ('sdn', 'bhd', 'berhad', 'plt', 'm')]


def same_name(a, b):
    """The same name, or one is the other with more words after it, which then has a word of its own."""
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    if long_[:len(short)] != short:
        return False
    return short == long_ or any(len(x) >= 3 and x not in GENERIC for x in short)


def same_kind(a, b):
    """Whether two listings could be the same kind of place, for joining names that only start alike: "KFC" and
    "KFC Nu Sentral", but not the "Mid Valley" bus stop and Mid Valley Megamall."""
    if not a or not b or a == b or (a in VENUES and b in VENUES):
        return True
    # Sources name kinds differently (OpenStreetMap's fast_food is Overture's fast_food_restaurant): a shared word will do.
    return bool((set(a.split('_')) & set(b.split('_'))) - {'and', 'or', 'of', 'other', 'service', 'services', 'store', 'shop'})


def merge_duplicates(rows):
    """One row per place listed by several sources (see the top of this file). rows: (name, address, category, kind,
    lat, lng, source); the source order decides whose pin and name are kept."""
    rank = {src: i for i, src in enumerate(SOURCE_ORDER)}
    order = sorted(range(len(rows)), key=lambda i: rank.get(rows[i][6], len(rank)))
    cell = 0.003  # ~330 m, so a match is always in this cell or one next to it
    kept, grid = [], {}
    for i in order:
        name, addr, cat, kind, lat, lng, src = rows[i]
        words = name_words(name)
        if not words:
            continue
        at = (round(lat / cell), round(lng / cell))
        match = None
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for k in grid.get((words[0], at[0] + dy, at[1] + dx), ()):
                    o = kept[k]
                    reach = NEAR_VENUE_M if cat in VENUES or o['category'] in VENUES else NEAR_LANDMARK_M if 'landmark' in (kind, o['kind']) else NEAR_M
                    if metres(lat, lng, o['lat'], o['lng']) <= reach and same_name(words, o['words']) and (
                            words == o['words'] or same_kind(cat, o['category'])):
                        match = o
                        break
                if match:
                    break
            if match:
                break
        if match:
            match['address'] = match['address'] or addr  # the most trusted source's (they come in SOURCE_ORDER)
            match['category'] = match['category'] or cat
            if kind == 'landmark':
                match['kind'] = 'landmark'
            if src not in match['sources']:
                match['sources'].append(src)
            continue
        grid.setdefault((words[0], *at), []).append(len(kept))
        kept.append({'name': name, 'words': words, 'address': addr, 'category': cat, 'kind': kind, 'lat': lat, 'lng': lng, 'sources': [src]})
    print(f'  merged: {len(rows):,} -> {len(kept):,}', flush=True)
    for p in kept:  # a "mall" or "station" only Foursquare lists is mostly a check-in page ("Trx" at KL Sentral)
        if p['kind'] == 'landmark' and p['category'] in VENUES and p['sources'] == ['foursquare']:
            p['kind'] = 'place'
    kept = without_copies(kept)
    return [(p['name'], p['address'], p['category'], p['kind'], p['lat'], p['lng'], '+'.join(p['sources'])) for p in kept]


def without_copies(kept):
    """Drops copies of a one-of-a-kind venue (a mall, a station, an airport…) pinned elsewhere: listings of that exact
    name and also a venue, without OpenStreetMap behind them, once OpenStreetMap or two sources confirm it in one spot
    ("Sunway Pyramid" near Seremban, "The Exchange TRX" 4 km off). They're mostly check-in pages people made somewhere
    else. Only venues: names like "Masjid Jamek" or "Taman Desa" are real in many towns; and a name confirmed in
    several towns (a chain of malls) keeps all."""
    key = lambda p: ' '.join(p['words'])
    by_name = {}
    for p in kept:
        if p['category'] in ONE_OF_A_KIND and ('osm' in p['sources'] or len(p['sources']) > 1):
            by_name.setdefault(key(p), []).append(p)
    spots = {}  # name -> (its confirmed listings, all in one spot; whether OpenStreetMap confirms it)
    for k, a in by_name.items():
        confirmed = [x for x in a if 'osm' in x['sources']] or a  # OpenStreetMap's word first
        if all(metres(x['lat'], x['lng'], confirmed[0]['lat'], confirmed[0]['lng']) <= COPY_SPOT_M for x in confirmed):
            spots[k] = (confirmed, 'osm' in confirmed[0]['sources'])

    # A venue only Overture lists (its places are vetted: confidence over 0.6), in one spot, still outranks
    # Foursquare-only listings of its name elsewhere ("Sunway Pyramid" 630 m from KL Sentral).
    by_overture = {}
    for p in kept:
        if p['category'] in ONE_OF_A_KIND and p['sources'] == ['overture'] and key(p) not in spots:
            by_overture.setdefault(key(p), []).append(p)
    for k, a in by_overture.items():
        if all(metres(x['lat'], x['lng'], a[0]['lat'], a[0]['lng']) <= COPY_SPOT_M for x in a):
            spots[k] = (a, False)

    def copy(p):
        spot = spots.get(key(p))
        if not spot or (p['category'] and p['category'] not in ONE_OF_A_KIND) or 'osm' in p['sources']:
            return False
        confirmed, _ = spot
        if confirmed[0]['sources'] == ['overture']:
            return p['sources'] == ['foursquare']
        # One source only: two that agree are a real place, as OpenStreetMap may know just one of a chain's malls
        # (Boulevard Shopping Mall is in Miri, Kuching and Bintulu).
        return not any(p is x for x in confirmed) and len(p['sources']) == 1

    out = [p for p in kept if not copy(p)]
    print(f'  copies of venues pinned elsewhere: {len(kept) - len(out):,} dropped', flush=True)

    # And a shop named after a mall it's far from ("KFC NU Sentral" 24 km from NU Sentral), from one source: a
    # check-in page made elsewhere too. Only malls OpenStreetMap or two sources confirm, with names of two words or
    # more: stations and towns share names ("Puchong"), and "Pavilion" alone is in many names.
    times = collections.Counter(key(p) for p in out)  # a name on 3 or more listings is a chain's (MR DIY, AEON Big)
    venues = {k: c for k, (c, _) in spots.items()
              if len(k.split()) >= 2 and c[0]['category'] in MALLS and 'osm' in c[0]['sources'] and len(c[0]['sources']) > 1
              and times[k] <= 2 and any(len(x) >= 4 and x not in NOT_DISTINCT for x in k.split())}
    longest = max((len(k.split()) for k in venues), default=0)

    every = collections.defaultdict(list)  # every listing of each of those names, to measure from all of them
    for p in out:
        if key(p) in venues:
            every[key(p)].append(p)

    def misplaced(p):
        if p['sources'] != ['foursquare']:  # check-in pages; Overture's places are vetted
            return False
        w = p['words']
        for n in range(min(longest, len(w) - 1), 1, -1):
            for i in range(len(w) - n + 1):
                k = ' '.join(w[i:i + n])
                if k in venues and k != key(p):
                    return all(metres(p['lat'], p['lng'], x['lat'], x['lng']) > NAMED_AFTER_M for x in every[k])
        return False

    kept, out = out, [p for p in out if not misplaced(p)]
    print(f'  shops named after a venue far away: {len(kept) - len(out):,} dropped', flush=True)
    return out


def common_words(rows, over=15_000):
    """Prints the words in more names and addresses than `over`: COMMON (here and in public/places.js) should hold these."""
    counts = {}
    for name, addr, *_ in rows:
        for w in set(name_words(f'{name} {addr}')):
            if len(w) >= 3:
                counts[w] = counts.get(w, 0) + 1
    top = sorted((c, w) for w, c in counts.items() if c > over)
    print(f'Words in over {over:,} names and addresses (COMMON here and in public/places.js): ' + ', '.join(w for c, w in reversed(top)))


def metres(lat1, lng1, lat2, lng2):
    x = math.radians(lng2 - lng1) * math.cos(math.radians((lat1 + lat2) / 2))
    return 6371000 * math.hypot(x, math.radians(lat2 - lat1))


def index_words(name):
    """The words a place is filed under: all but the very common ones, the 1-letter ones and plain numbers."""
    return sorted({w for w in name_words(name) if len(w) >= 2 and w not in COMMON and not w.isdigit()})


def place_id(name, lat, lng):
    """A short ID that stays the same across rebuilds while a place keeps its name and pin, for drivers' corrections."""
    return format(zlib.crc32(f'{name}|{lat:.4f}|{lng:.4f}'.encode()), 'x')


def write_files(rows, out, release):
    """Writes the rows into public/places/ as the phone reads them (see searchNearby in public/places.js), keeping
    the kinds-of-place files (@fuel, …) scripts/build-places.py put there. A row: [name, lng, lat, address, category,
    kind ('l' landmark, 's' street, '' other), the sources that list it (SOURCE_BITS added up), id]."""
    shards = {}
    for name, addr, cat, kind, lat, lng, src in rows:
        ws = index_words(name)
        if not ws:
            continue
        area = f'{math.floor(lat / AREA)}_{math.floor(lng / AREA)}'
        place = [name[:70], round(lng, 5), round(lat, 5), addr[:70], cat or '', {'landmark': 'l', 'street': 's'}.get(kind, ''),
                 sum(SOURCE_BITS[x] for x in src.split('+')), place_id(name, lat, lng)]
        for letter in sorted({w[0] if w[0].isascii() and w[0].isalnum() else '_' for w in ws}):
            shards.setdefault(f'{area}/{letter}', []).append((place, ws))
    shards = split_big(shards)

    kinds = {}  # area -> {'@fuel': n, …}, from build-places.py
    for listing in glob.glob(os.path.join(out, '*', 'files.json')):
        area = os.path.basename(os.path.dirname(listing))
        with open(listing) as f:
            kinds[area] = {k: v for k, v in json.load(f).items() if k.startswith('@')}
        for old in glob.glob(os.path.join(os.path.dirname(listing), '*.json')):
            if not os.path.basename(old).startswith(('@', 'files.json')):
                os.remove(old)  # the name files build-places.py wrote: these replace them
    if not kinds:
        print('  no kinds of place (@fuel, …) found there: run scripts/build-places.py first', flush=True)

    areas, total = {}, 0
    for key, entries in shards.items():
        area, letter = key.split('/')
        os.makedirs(os.path.join(out, area), exist_ok=True)
        body = json.dumps({'p': [p for p, _ in entries]}, ensure_ascii=False, separators=(',', ':'))
        total += len(body.encode())
        with open(os.path.join(out, area, f'{letter}.json'), 'w', encoding='utf-8') as f:
            f.write(body)
        areas.setdefault(area, {})[letter] = len(entries)
    for area in set(areas) | set(kinds):
        os.makedirs(os.path.join(out, area), exist_ok=True)
        with open(os.path.join(out, area, 'files.json'), 'w') as f:
            json.dump(dict(sorted({**areas.get(area, {}), **kinds.get(area, {})}.items())), f, separators=(',', ':'))

    index_path = os.path.join(out, 'index.json')
    index = json.load(open(index_path)) if os.path.exists(index_path) else {}
    index.update({
        'source': 'A2B places: Overture Maps, OpenStreetMap and Foursquare Open Source Places, merged',
        'release': release,  # versions every file's URL, so phones fetch the new ones
        'built': time.strftime('%Y-%m-%d'),
        'area': AREA,
        'count': len(rows),
        'areas': sorted(set(areas) | set(kinds)),
        'attribution': 'Places: © OpenStreetMap contributors (ODbL), Overture Maps Foundation, Foursquare',
        'licence': 'ODbL 1.0 (see NOTICE.txt)',
    })
    with open(index_path, 'w') as f:
        json.dump(index, f, separators=(',', ':'))
    with open(os.path.join(out, 'NOTICE.txt'), 'w') as f:
        f.write(NOTICE.format(release=release))
    files = sum(len(v) for v in areas.values())
    print(f'Wrote {len(rows):,} places into {files:,} name files ({total / 1e6:.0f} MB before compression) in {out}', flush=True)


def split_big(shards):
    """Busy prefixes split by one more letter until each file is small, as in scripts/build-places.py. A place goes in
    every file matching a word it's filed under; a word shorter than the new prefix stays in the parent file."""
    done, todo = {}, list(shards.items())
    while todo:
        key, entries = todo.pop()
        area, prefix = key.split('/')
        if len(entries) <= SPLIT_OVER or len(prefix) >= MAX_PREFIX or prefix == '_':
            done[key] = entries
            continue
        parts, keep = {}, []
        for place, ws in entries:
            longer = {w[:len(prefix) + 1] for w in ws if w.startswith(prefix) and len(w) > len(prefix)}
            longer = {x for x in longer if x.isascii() and x.isalnum()}
            if not longer:
                keep.append((place, ws))
            for x in longer:
                parts.setdefault(x, []).append((place, ws))
        if keep:
            done[key] = keep
        todo.extend((f'{area}/{x}', e) for x, e in parts.items())
    return done


NOTICE = """A2B's place search data (release {release}): places from OpenStreetMap, Overture Maps and Foursquare, merged
into one list for A2B (https://github.com/thaqif0709/a2b) by scripts/build-locations.py.

This database is made available under the Open Database License (ODbL) 1.0:
https://opendatacommons.org/licenses/odbl/1-0/. Any rights in individual contents of the database are licensed
under the licences of their sources:

- OpenStreetMap: © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)
- Overture Maps Foundation places: CDLA Permissive 2.0 (https://cdla.dev/permissive-2-0/), from Meta, Microsoft,
  Foursquare, AllThePlaces and others (https://docs.overturemaps.org/attribution); its streets are OpenStreetMap's
- Foursquare Open Source Places: Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)

The kinds-of-place files (@fuel, @hospital, …) are from Overture Maps only (scripts/build-places.py).
"""


if __name__ == '__main__':
    main()
