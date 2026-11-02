// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Searching by address ("129, BK 5/6, Bandar Kinrara, Puchong, 47180"), shared by the app and the Worker.
// Malaysian streets often end in a code, and "Jalan BK 5/6" is a different street from "BK 5/14" or "BK 6/5", so
// streets are compared as whole phrases with the slash kept (normalizeText in text.js turns it into a space).
// scripts/build-places.py files each shop under its street's words too (street_index_words, the same rules), so the
// phone's own search finds the shops on a street; TomTom answers the houses (src/lib/addresses.js).

// Words that start a street's name, and their short forms.
const STREET_WORDS = {
  jalan: 'jalan', jln: 'jalan', jl: 'jalan', lorong: 'lorong', lrg: 'lorong', persiaran: 'persiaran', lebuh: 'lebuh',
  lebuhraya: 'lebuhraya', lingkaran: 'lingkaran', lengkok: 'lengkok', changkat: 'changkat',
};
const KEYWORDS = new Set(Object.values(STREET_WORDS));
const CODE = /^\d+[a-z]?\/[a-z\d]+$/; // "5/6", "2/24", "12/1b": a code's numbers
const NUMBER = /^\d{1,4}[a-z]?$/; // a house or shop number; five digits is a postcode
const POSTCODE = /^\d{5}$/;
const UNIT_WORDS = new Set(['no', 'lot', 'unit', 'blok', 'block', 'level', 'tingkat', 'aras', 'g']);
const MAX_STREET_WORDS = 6;
const MAX_RESULTS = 12;

// Text for comparing streets: like normalizeText, but "SS2/24" and "ss 2 / 24" both become "ss 2/24", and "jln"
// becomes "jalan".
export function streetText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`.]/g, '')
    .replace(/(\d[a-z]?)\s*\/\s*(?=[a-z\d])/g, '$1/')
    .replace(/[^\p{L}\p{N}/]+/gu, ' ')
    .replace(/(\p{L})(?=\p{N})/gu, '$1 ')
    .split(' ')
    .flatMap((w) => (CODE.test(w) ? [w] : w.split('/')))
    .filter(Boolean)
    .map((w) => STREET_WORDS[w] ?? w)
    .join(' ');
}

// Where a street's name is among these words, as [start, end), or null: from "Jalan" (or "Lorong", …), or from the
// word before a code ("BK 5/6"), to the end of the code, else to a postcode or the end of the words.
function findStreet(ws) {
  const kw = ws.findIndex((w) => KEYWORDS.has(w));
  const code = ws.findIndex((w, i) => i > 0 && CODE.test(w) && /^\p{L}+$/u.test(ws[i - 1]) && (kw < 0 || i > kw));
  const start = kw >= 0 ? kw : code - 1;
  if (start < 0) return null;
  let end = code > start ? code + 1 : ws.length;
  const pc = ws.findIndex((w, i) => i > start && POSTCODE.test(w));
  if (pc > 0 && pc < end) end = pc;
  end = Math.min(end, start + MAX_STREET_WORDS);
  return end - start >= 2 ? [start, end] : null; // "jalan" alone isn't a street
}

// { street, number, postcode } when the search looks like an address, else null. street is in streetText's form
// ("jalan bk 5/6", or just "bk 5/6" when typed without "Jalan"), number the house number before it, if any.
// A name before the street ("nandos jalan ipoh") makes it a search for that place, not an address.
export function addressQuery(q) {
  const parts = String(q ?? '').split(/[,;\n]+/).map((p) => streetText(p).split(' ').filter(Boolean)).filter((p) => p.length);
  const postcode = parts.flat().find((w) => POSTCODE.test(w)) ?? null;
  const before = [];
  for (const ws of parts) {
    const at = findStreet(ws);
    if (!at) {
      before.push(...ws);
      continue;
    }
    const lead = [...before, ...ws.slice(0, at[0])];
    if (!lead.every((w) => NUMBER.test(w) || UNIT_WORDS.has(w) || /^[a-z]$/.test(w))) return null;
    return { street: ws.slice(...at).join(' '), number: lead.filter((w) => NUMBER.test(w)).at(-1) ?? null, postcode };
  }
  return postcode ? { street: null, number: null, postcode } : null;
}

// The words to look a street's places up by in /places/: its name words without "Jalan" ("bk" for "Jalan BK 5/6"),
// or for a street of numbers only, its first number. scripts/build-places.py (street_index_words) files each place
// under the last of these only, which is among them however much of the address was typed after the street.
export function streetIndexWords(street) {
  const ws = street.split(/[ /]/).filter(Boolean);
  const named = ws.filter((w) => /^\p{L}+$/u.test(w) && !KEYWORDS.has(w));
  return named.length ? named : ws.filter((w) => /^\d/.test(w)).slice(0, 1);
}

const padded = (p) => ` ${streetText(`${p.name} ${p.address ?? ''}`)} `;

// The place's name or address names the street searched for ("BK 5/6" isn't "BK 5/14").
export function onStreet(p, a) {
  return Boolean(a?.street) && padded(p).includes(` ${a.street} `);
}

// On the street, at the house number searched for (when one was): "129, Jalan BK 5/6" or, as OpenStreetMap's
// addresses read, "Jalan BK 5/6 129". The name and the address each on their own, so "SRA Bandar Kinrara 5" on
// "Jalan BK 5/6" isn't number 5.
export function isExact(p, a) {
  if (!onStreet(p, a)) return false;
  if (!a.number) return true;
  const street = a.street.replace(/^(?:jalan|lorong|persiaran|lebuh|lebuhraya|lingkaran|lengkok|changkat) /, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(` ${a.number} (?:\\p{L}+ )?${street} | ${street} ${a.number} `, 'u');
  return [p.name, p.address].some((t) => re.test(` ${streetText(t)} `));
}

// The address to ask TomTom about, or null: only for a search that looks like an address that no result already
// answers. A search for a name ("nandos", "trx") never asks.
export function addressToLookUp(q, places) {
  const a = addressQuery(q);
  return a && !places.some((p) => isExact(p, a)) ? a : null;
}

// The search's results with TomTom's addresses (`found`) added, ordered for an address search: the house (or the
// street) searched for first, then places on that street, then TomTom's near misses on other streets, then the rest.
export function withAddresses(places, found, a) {
  const rank = (p) => (isExact(p, a) ? 0 : onStreet(p, a) ? 1 : found.includes(p) ? 2 : 3);
  return [...found, ...places]
    .map((p, i) => ({ p, i, r: rank(p) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map(({ p }) => p)
    .slice(0, MAX_RESULTS);
}
