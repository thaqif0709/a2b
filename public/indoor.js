// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Which mall a shop is in, and on which floor, read from its address. GPS doesn't reach inside a mall and there are
// no indoor maps of Malaysian malls, so a walk to a shop in one ends with a card (app.js) saying the floor and unit
// and pointing at the shop in a straight line. Overture addresses often carry them, in the mall's own words:
// "Lot L2.53, Level 2, The Exchange TRX, …", "LG-82B, IOI City Mall, …". This reads them conservatively: a house
// number or a postcode must never read as a floor, and a shophouse's "1st Floor" near a mall isn't in the mall.

import { words } from './text.js';
import { distance } from './geo.js';

export const MALL_NEAR_M = 300; // a mall's pin can be this far from a shop inside it (big malls are 300 m across)

// Malls whose name says nothing like "Mall": [pattern, the name to show]. Earlier entries win.
const KNOWN_MALLS = [
  [/\bexchange trx\b/, 'The Exchange TRX'],
  [/\bpavill?ion bukit jalil\b/, 'Pavilion Bukit Jalil'],
  [/\bpavill?ion damansara\b/, 'Pavilion Damansara Heights'],
  [/\bpavill?ion elite\b/, 'Pavilion Elite'],
  [/\bpavill?ion (?:kl|kuala lumpur|bukit bintang)\b/, 'Pavilion Kuala Lumpur'],
  [/\bsuria klcc\b/, 'Suria KLCC'],
  [/\bthe gardens? mall\b|\bthe gardens? (?:mid ?valley|lingkaran syed putra)\b/, 'The Gardens Mall'],
  [/\bmid ?valley southkey\b/, 'Mid Valley Southkey'],
  [/\bmid ?valley mega ?mall\b|\bmega ?mall mid ?valley\b/, 'Mid Valley Megamall'],
  [/\bsunway pyramid\b/, 'Sunway Pyramid'],
  [/\bsunway velocity\b/, 'Sunway Velocity Mall'],
  [/\bsunway putra mall\b/, 'Sunway Putra Mall'],
  [/\bsunway carnival\b/, 'Sunway Carnival Mall'],
  [/\b(?:1|one) ?utama\b/, '1 Utama'],
  [/\bioi city mall\b/, 'IOI City Mall'],
  [/\bioi mall\b/, 'IOI Mall Puchong'],
  [/\bberjaya times? square\b|\btimes square kl\b/, 'Berjaya Times Square'],
  [/\bfahrenheit ?88\b/, 'Fahrenheit88'],
  [/\bstarhill gallery\b/, 'Starhill Gallery'],
  [/\bnu sentral\b/, 'NU Sentral'],
  [/\bbangsar village\b/, 'Bangsar Village'],
  [/\bpublika\b/, 'Publika'],
  [/\bmytown\b/, 'MyTOWN'],
  [/\bsung[ae]i wang\b/, 'Sungei Wang Plaza'],
  [/\b(?:plaza )?low ?yat\b/, 'Plaza Low Yat'],
  [/\blot 10 (?:shopping|mall)\b/, 'Lot 10'],
  [/\bsubang parade\b/, 'Subang Parade'],
  [/\bthe summit (?:subang|usj)\b/, 'The Summit USJ'],
  [/\bthe starling\b/, 'The Starling'],
  [/\bgurney paragon\b/, 'Gurney Paragon'],
  [/\bgurney plaza\b/, 'Gurney Plaza'],
  [/\bavenue k\b/, 'Avenue K'],
];
// Words that make a part of an address a mall's name ("Paradigm Mall", "Bangsar Shopping Centre")…
const MALL_WORDS = /\b(?:mega ?mall|mall|shopping (?:centre|center|complex|mall|plaza|gallery|fair)|galleria)\b/;
// …and words that might ("Kompleks Pernas Sogo", "Plaza Damas" is offices and shops), trusted only with a floor.
const MAYBE_MALL_WORDS = /\b(?:plaza|kompleks|komplex|complex|arcade|square)\b/;
const GENERIC = new Set(['the', 'shopping', 'mall', 'mega', 'megamall', 'centre', 'center', 'complex', 'gallery', 'fair', 'galleria', 'plaza', 'kompleks', 'komplex', 'arcade', 'square']);
const STREET_START = /^(?:jalan|jln|jl|lorong|lrg|persiaran|lebuh|lebuhraya|lingkaran|taman|bandar|no)\b/;

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const nth = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const num = (w) => (/^\d+$/.test(w) ? Number(w) : NUMBERS.indexOf(w) + 1 || ORDINALS.indexOf(w) + 1 || null);

// A floor: { label } as the card shows it ("Level 2", "Lower Ground (LG)") and { say } in a sentence ("the 2nd floor").
const level = (n) => ({ label: `Level ${n}`, say: `Level ${n}`, n });
const FLOORS = {
  lg: { label: 'Lower Ground (LG)', say: 'the Lower Ground floor' },
  ug: { label: 'Upper Ground (UG)', say: 'the Upper Ground floor' },
  g: { label: 'Ground Floor', say: 'the Ground Floor' },
  concourse: { label: 'Concourse', say: 'the Concourse level' },
  park: { label: 'Park Level', say: 'the Park Level' },
  mezzanine: { label: 'Mezzanine', say: 'the Mezzanine floor' },
  rooftop: { label: 'Rooftop', say: 'the rooftop' },
};
const lowerGround = (n) => (n ? { label: `Lower Ground ${n} (LG${n})`, say: `Lower Ground ${n}` } : FLOORS.lg);
const basement = (n) => ({ label: `Basement ${n} (B${n})`, say: `Basement ${n}` });

// Floors written out, each [pattern on the lowercased address, floor from the match]. The first in the address wins.
const N = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)';
const NTH = `(\\d{1,2})(?:st|nd|rd|th)|(${ORDINALS.join('|')})`;
const FLOOR_PATTERNS = [
  [/\blower ground(?: floor| level)?(?: ?(\d))?\b|\blevel lg ?(\d)?\b|\blg(\d)? (?:floor|level)\b/, (m) => lowerGround(m[1] ?? m[2] ?? m[3])],
  [/\bupper ground(?: floor| level)?\b|\blevel ug\b|\bug (?:floor|level)\b/, () => FLOORS.ug],
  [/\b(?:ground|grd|gnd|g) (?:floor|level|flr)\b|\blevel (?:g|ground)\b/, () => FLOORS.g],
  [/\blevel concourse\b|\bconcourse (?:level|floor)\b/, () => FLOORS.concourse],
  [/\bpark level\b/, () => FLOORS.park],
  [/\bmezzanine\b/, () => FLOORS.mezzanine],
  [/\brooftop\b/, () => FLOORS.rooftop],
  [/\bbasement ?(\d)\b|\blevel b(\d)\b/, (m) => basement(m[1] ?? m[2])],
  [new RegExp(`\\b(?:${NTH}) (?:floor|flr|fl|level)\\b`), (m) => {
    const n = m[1] ? Number(m[1]) : num(m[2]);
    return { label: `${nth(n)} Floor`, say: `the ${nth(n)} floor`, n };
  }],
  [new RegExp(`\\b(?:level|lvl|floor|flr|tingkat|aras) ?${N}(?![\\d.-])\\b`), (m) => level(num(m[1]))],
];

// A shop's lot in a mall: "L2.53", "LG-82B", "G.74.0", "2-62", "F215". Written after "Lot"/"Unit", or first in the
// address with a mall's floor letters (so "5 Jalan BK 5/6" and "SS15" aren't lots), or anywhere when it starts with
// a level ("… Kompleks Pernas Sogo L6-R8"). Dots may be spaced ("Lot 7 . 01 . 06").
const CODE = '[a-z]{0,3}\\s?[.-]?\\s?\\d{1,4}(?:\\s?[.-]\\s?[a-z]{0,2}\\d{1,4}[a-z]?)*[a-z]?';
const AFTER_WORD = new RegExp(`\\b(?:lot|unit|suite|shop|kiosk)\\b(?:\\s?(?:no\\.?|number|#))?\\s?[:.]?\\s?(${CODE})(?![\\w/])`);
const FLOOR_LETTERS = '(?:lg|ug|gf|g|l\\d{1,2}|b\\d|f|k|s|c|pl|gs|e|m)';
const LEADING = new RegExp(`^\\s*(${FLOOR_LETTERS}\\d{0,2}\\s?(?:[.-]\\s?[a-z]?\\d{1,4}(?:[.-]\\d{1,4})*[a-z]?|\\d{3,4}[a-z]?)|\\d{1,2}\\s?\\.\\s?\\d{1,3}\\s?\\.\\s?\\d{1,3}[a-z]?)(?![\\w/])`);
const ANYWHERE = /\b((?:lg|ug|l\d{1,2})[.-][a-z]?\d{1,4}(?:[.-]\d{1,4})*[a-z]?)(?![\w/])/;
const tidyCode = (c) => c.replace(/\s*([.-])\s*/g, '$1').replace(/\s+/g, '').toUpperCase();

// The floor a lot's own code names, by the usual lettering: L2.53 on Level 2, LG-82B on LG, G.74.0 on the ground.
function floorFromUnit(unit) {
  const m = /^(LG|UG|G|L)(\d{0,2})(?=[.-]|\d)/.exec(unit);
  if (!m) return null;
  if (m[1] === 'L') return m[2] ? level(Number(m[2])) : null;
  if (m[1] === 'LG') return lowerGround(m[2] && /^\d[.-]/.test(unit.slice(2)) ? m[2] : null);
  if (m[1] === 'UG') return FLOORS.ug;
  return /^G[.-]?\d/.test(unit) ? FLOORS.g : null;
}

export function parseUnit(address) {
  const a = String(address ?? '').toLowerCase();
  const m = AFTER_WORD.exec(a) ?? LEADING.exec(a) ?? ANYWHERE.exec(a);
  if (!m || !/\d/.test(m[1])) return null;
  return tidyCode(m[1]);
}

export function parseFloor(address) {
  const a = String(address ?? '').toLowerCase();
  let best = null;
  for (const [re, floor] of FLOOR_PATTERNS) {
    const m = re.exec(a);
    if (m && (!best || m.index < best.index)) best = { index: m.index, floor: floor(m) };
  }
  if (best) return best.floor;
  const unit = parseUnit(address);
  return unit ? floorFromUnit(unit) : null;
}

const titleCase = (s) => (s === s.toUpperCase() || s === s.toLowerCase()
  ? s.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (_, b, c) => b + c.toUpperCase()).replace(/\bIoi\b/g, 'IOI').replace(/\bKl\b/g, 'KL')
  : s);

// A known mall named anywhere in the text, else null.
export function knownMall(text) {
  const t = words(text).join(' ');
  return KNOWN_MALLS.find(([re]) => re.test(t))?.[1] ?? null;
}

// The mall an address names, or null. `maybe` also takes a "Plaza …" or "Kompleks …" (only when there's a floor).
export function mallFromAddress(address, { maybe = false } = {}) {
  const known = knownMall(address);
  if (known) return known;
  for (const part of String(address ?? '').split(/[,;:()]/)) {
    // The name without the lot or floor written in the same part ("L2-53 SECOND FLOOR IOI CITY MALL").
    let name = part;
    for (const re of [AFTER_WORD, LEADING, ANYWHERE]) name = name.replace(new RegExp(re.source, 'i'), ' ');
    for (const [re] of FLOOR_PATTERNS) name = name.replace(new RegExp(re.source, 'i'), ' ');
    name = name.replace(/\s+/g, ' ').replace(/^[\s.&-]+|[\s.&-]+$/g, '');
    const low = name.toLowerCase();
    if (!/\p{L}{3}/u.test(name) || STREET_START.test(low) || words(low).every((w) => GENERIC.has(w))) continue;
    if (!MALL_WORDS.test(low) && !(maybe && MAYBE_MALL_WORDS.test(low))) continue;
    const ws = name.split(' ');
    return titleCase(ws.length <= 5 ? name : ws.slice(0, 5).join(' '));
  }
  return null;
}

// A shopping mall's name from Overture's list, tidied ("1 Utama Shopping Centre,Bandar Utama" -> "1 Utama"), or null
// when it doesn't read as a mall: that list also has shops in malls and check-in pages ("CROCS KLCC").
export function mallName(name) {
  const known = knownMall(name);
  if (known) return known;
  const first = String(name ?? '').split(/[,(|]/)[0].split('@').at(-1).trim(); // "Pot Lepak@1 Shamelin Shopping Mall"
  return MALL_WORDS.test(first.toLowerCase()) && first.split(/\s+/).length <= 5 ? titleCase(first) : null;
}

// A shophouse on a street: a house number ("12, Jalan SS2/75", "No. 9 - 3, Third Floor, Jalan …", "8, Ground Floor,
// Lorong …") and a street.
const STREET = /\b(?:jalan|jln|jl|lorong|lrg|persiaran|lebuh|lingkaran)\b/;
const HOUSE_NO = new RegExp(`^\\s*(?:no\\.?\\s*)?\\d{1,4}[a-z]?(?:\\s?-\\s?\\d{1,3}[a-z]?)?(?=[\\s,&])|\\bno[.:]?\\s?\\d|\\b\\d{1,4}[a-z]?(?:-\\d{1,3}[a-z]?)?,?\\s+${STREET.source}`);
// An office tower, flats or a block of shops: not the mall next door ("G-01, Ground Floor, Wisma Lim Foo Yong").
const NOT_MALL = /\b(?:menara|wisma|tower|towers|block|blok|house|building|bangunan|dataran|residen\w*|condo\w*|apartments?|soho|office|business|industri\w*|hotel|hospital|medical|headquarters|convention|exhibition)\b/;
// A name that mentions a mall without being in it.
const NOT_IN_NAME = /\b(?:mrt|lrt|monorail|ktm|brt|station|stesen|bus|parking|car park|opposite|near|beside|depan|berhampiran)\b/;
const MALL_TOP_FLOOR = 10; // higher than this is an office or a hotel above the mall
// A lot numbered the way malls do: with a level's letters (L2.53, LG-82B, G.74.0) or dots (6.36.00), not "Lot 207".
const MALL_UNIT = /^(?:L\d|LG|UG|G[.-]?\d)|\d\.\d/;

// Whether a place is a shop inside a mall, and where: { mall, floor, unit, name } (floor and unit null when the address
// doesn't say), else null. `malls`: shopping malls listed near it, [{ name, lng, lat }] (places.js mallsAround).
// Inside means the address or the shop's name names a mall, or the address gives a floor or a mall-style lot and a
// mall is listed within MALL_NEAR_M. A mall itself isn't "inside a mall", nor is a shophouse upstairs on a street or
// an office in the tower next to one.
export function insideMall(place, malls = []) {
  if (!place) return null;
  const address = place.address ?? '';
  const low = address.toLowerCase();
  const floor = parseFloor(address);
  const unit = parseUnit(address);
  const shophouse = HOUSE_NO.test(low) && STREET.test(low) && !/\d\.\d/.test(unit ?? ''); // Pavilion: "Lot 6.36.00, 168, Jln …"
  let mall = mallFromAddress(address, { maybe: Boolean(floor) });
  // "Uniqlo Sunway Pyramid", but not "Pavilion Kuala Lumpur MRT Station", nor a "… 1Utama" pinned on another street.
  if (!mall && !shophouse && !NOT_IN_NAME.test(words(place.name).join(' '))) mall = knownMall(place.name);
  if (!mall) {
    if ((!floor && !(unit && MALL_UNIT.test(unit))) || shophouse || NOT_MALL.test(low) || floor?.n > MALL_TOP_FLOOR) return null;
    // The nearest listed mall, one we know by name first: the list's other names are often a shop's ("KFC Giant Mall").
    const at = [place.lng, place.lat];
    const near = malls
      .map((m) => ({ name: mallName(m.name), known: Boolean(knownMall(m.name)), m: distance(at, [m.lng, m.lat]) }))
      .filter((m) => m.name && m.m <= MALL_NEAR_M)
      .sort((a, b) => b.known - a.known || a.m - b.m)[0];
    if (!near) return null;
    mall = near.name;
  }
  // The mall itself (the pin for "Pavilion KL"), not a shop in it.
  const isMall = ['shopping_mall', 'mall'].includes(place.category) || onlyMall(place.name, mall);
  if (isMall && !floor && !unit) return null;
  return { mall, floor, unit: unit && !mall.endsWith(` ${unit}`) ? unit : null, name: shopName(place.name, mall) }; // "Lot 10"
}

// A name that's just the mall's: "Pavilion KL", "The Exchange TRX Shopping Mall".
const MALL_FILLER = new Set(['the', 'shopping', 'mall', 'centre', 'center', 'complex', 'kl', 'kuala', 'lumpur', 'malaysia']);
function onlyMall(name, mall) {
  let t = words(name).join(' ');
  for (const [re] of KNOWN_MALLS) t = t.replace(re, ' ');
  for (const w of words(mall)) t = t.replace(new RegExp(`\\b${w}\\b`), ' ');
  return t.split(' ').every((w) => !w || MALL_FILLER.has(w));
}

// The shop's name without the mall it's in tacked on ("Kanada-Ya - The Exchange TRX" -> "Kanada-Ya").
export function shopName(name, mall) {
  const m = /^(.+?)\s*(?:\s[-–|@]\s?|\s?@\s?|,\s*|\s\()(.+?)\)?$/.exec(String(name ?? '').trim());
  if (!m || !/\p{L}{2}/u.test(m[1])) return name;
  const tail = words(m[2]).join(' ');
  return tail && (knownMall(m[2]) === mall || tail === words(mall).join(' ')) ? m[1] : name;
}

// Which way, as a word, for when there's no compass to turn an arrow: "north-east".
export function compassWord(deg) {
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
