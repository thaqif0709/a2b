// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// The app in the driver's language. A message is looked up by its English text, so code reads as before and
// anything not yet translated stays in English:
//   tr('Where to?')                      tr('Continue to {name}?', { name })
//   trPlural(n, '{n} driver', '{n} drivers')
// index.html is translated as it stands (translatePage); text the app writes later goes through tr().
// test/i18n.test.js checks the translations.

// The languages A2B speaks, each named in itself, with its word for "language" (shown under Settings › Language).
// English is the code itself. Every other one has its words in public/i18n-<code>.js, fetched only by phones that
// use it (the offline shell keeps them all). To add one: write its file like i18n-ms.js, list it here and in sw.js.
export const LANGUAGES = [
  { code: 'en', name: 'English', word: 'Language' },
  { code: 'ms', name: 'Bahasa Melayu', word: 'Bahasa', locale: 'ms-MY', load: () => import('./i18n-ms.js') },
];

let lang = 'en';
let words = {}; // the current language's dictionary; empty in English
let asked = 0;

export const currentLang = () => lang;

// The setting is 'auto' or a language code. Auto follows the phone: the first of its languages that A2B has.
export function pickLang(setting, languages = globalThis.navigator?.languages ?? []) {
  const has = (code) => LANGUAGES.some((l) => l.code === code);
  if (has(setting)) return setting;
  for (const l of languages) {
    const code = String(l).slice(0, 2).toLowerCase();
    if (has(code)) return code;
  }
  return 'en';
}

// Fetches the language's words and switches the whole page over; screens the app draws pick it up the next time
// they're drawn. If the words can't be had (offline before they were ever saved), the app stays as it is.
export async function useLang(setting) {
  const language = LANGUAGES.find((l) => l.code === pickLang(setting));
  const ask = ++asked;
  let dict = {};
  try {
    if (language.load) dict = (await language.load()).default;
  } catch {
    return;
  }
  if (ask !== asked) return; // switched again while this one was on its way
  lang = language.code;
  words = dict;
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  translatePage();
}

const fill = (s, params) => s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));

export function tr(en, params) {
  const s = words[en] || en;
  return params ? fill(s, params) : s;
}

// English has one and many. The others here say "5 pemandu" and "1 pemandu" alike, so they have one entry, keyed
// by the many.
export function trPlural(n, one, other, params = {}) {
  return tr(n === 1 && lang === 'en' ? one : other, { n, ...params });
}

// The server's messages are English sentences (see src/). One with a number in it, like "up to 5 places a day",
// is looked up with the number as {n}.
export function trServer(msg) {
  if (!msg || words[msg]) return tr(msg);
  const nums = [];
  const key = String(msg).replace(/\d+/g, (d) => (nums.push(d), '{n}'));
  return words[key] && nums.length === 1 ? fill(words[key], { n: nums[0] }) : msg;
}

// For toLocaleTimeString and friends: the language's own dates and times ("3:45 PTG" in Malay); in English, the
// phone's own way.
export function locale() {
  const own = LANGUAGES.find((l) => l.code === lang)?.locale;
  if (own) return own;
  return /^en/i.test(globalThis.navigator?.language ?? 'en') ? [] : 'en-MY';
}

// ---------- index.html ----------
// Its text and labels are English. Each is remembered with the English it had when the page loaded, so switching
// back and forth works; a spot the app has since written its own text into is left to the app. translate="no"
// keeps a part as it is (the language names on the Welcome card).
const ATTRS = ['aria-label', 'placeholder', 'title', 'alt'];
let spots = null; // [{ node, attr, en, lead, trail, shown }]

function collect(root) {
  const list = [];
  const kept = (el) => el.closest('[translate="no"], script, style');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const en = node.data.replace(/\s+/g, ' ').trim();
    if (!/\p{L}/u.test(en) || kept(node.parentElement)) continue;
    const [, lead, trail] = node.data.match(/^(\s*)[\s\S]*?(\s*)$/);
    list.push({ node, en, lead, trail, shown: node.data });
  }
  for (const el of root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','))) {
    if (kept(el)) continue;
    for (const attr of ATTRS) {
      const en = el.getAttribute(attr);
      if (en && /\p{L}/u.test(en)) list.push({ node: el, attr, en, shown: en });
    }
  }
  return list;
}

export function translatePage() {
  spots ??= collect(document.body);
  for (const s of spots) {
    if (!s.node.isConnected) continue;
    const now = s.attr ? s.node.getAttribute(s.attr) : s.node.data;
    if (now !== s.shown) continue; // the app wrote its own text here
    s.shown = s.attr ? tr(s.en) : `${s.lead}${tr(s.en)}${s.trail}`;
    if (s.attr) s.node.setAttribute(s.attr, s.shown);
    else s.node.data = s.shown;
  }
}
