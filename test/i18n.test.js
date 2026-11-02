// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { MS } from '../public/i18n-ms.js';
import { pickLang, useLang, tr, trPlural, trServer, locale } from '../public/i18n.js';
import { validatePassword } from '../src/lib/auth.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const unescape = (s) => s.replace(/\\(.)/g, '$1');
const STRING = String.raw`(['"])((?:\\.|(?!\1).)*)\1`;

// Unit abbreviations that read the same in Malay.
const SAME = new Set(['km', 'min']);
// Server messages only a developer or a broken app version would see: English is fine.
const DEVELOPER = new Set([
  'Database is not configured (see README).', 'Body must be JSON.', 'kind is add, move or gone.', 'action is approve or reject.',
  'kind must be saved or recent.', 'lat and lng are required.', 'bbox=west,south,east,north is required.', 'lines=<line id>,... is required.',
]);

// Every message the app passes through tr() or trPlural() (by its "many" form, the one Malay is keyed by).
function appMessages() {
  const found = [];
  for (const f of readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
    const src = read(`public/${f}`).replace(/^\s*\/\/.*$/gm, ''); // not the examples in comments
    assert.doesNotMatch(src, /\btr(?:Plural)?\([^)]*`[^`]*\$\{/, `${f}: tr() takes {placeholders}, not \${} (the English is the key)`);
    for (const m of src.matchAll(new RegExp(String.raw`\btr\(\s*${STRING}`, 'g'))) found.push(unescape(m[2]));
    for (const m of src.matchAll(/\btrPlural\([^,]+,\s*(['"])(?:\\.|(?!\1).)*\1,\s*(['"])((?:\\.|(?!\2).)*)\2/g)) found.push(unescape(m[3]));
  }
  return found;
}

// index.html's text and labels, as translatePage() sees them.
function pageMessages() {
  let html = read('public/index.html');
  html = html.slice(html.indexOf('<body>'), html.lastIndexOf('<script'));
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(\w+)[^>]*translate="no"[^>]*>[\s\S]*?<\/\1>/g, '');
  const found = [...html.matchAll(/(?:aria-label|placeholder|title|alt)="([^"]+)"/g)].map((m) => m[1]);
  for (const m of html.matchAll(/>([^<>]+)</g)) found.push(m[1].replace(/\s+/g, ' ').trim());
  return found.filter((s) => /\p{L}/u.test(s));
}

// What the server says to drivers: httpError's messages, the *_MESSAGE constants and the password rules.
function serverMessages() {
  const found = [validatePassword(''), validatePassword('x'.repeat(201))];
  const files = ['src/worker.js', ...readdirSync(new URL('../src/lib/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `src/lib/${f}`)];
  const literal = String.raw`(['"\x60])((?:\\.|(?!\1).)*)\1`;
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(new RegExp(String.raw`httpError\(\s*(?:[\w.]+ \|\| )?${literal}`, 'g'))) found.push(m[2]);
    for (const m of src.matchAll(new RegExp(String.raw`const \w*MESSAGE = ${literal}`, 'g'))) found.push(m[2]);
  }
  return found.map((s) => unescape(s.replace(/\$\{[^}]+\}/g, '{n}'))).filter((s) => !DEVELOPER.has(s));
}

test('every message has its Malay', () => {
  const missing = [...new Set([...appMessages(), ...pageMessages(), ...serverMessages()])].filter((s) => !SAME.has(s) && !(s in MS));
  assert.deepEqual(missing, []);
});

test('every Malay entry is still used (an English text changed means its key changes too)', () => {
  const used = new Set([...appMessages(), ...pageMessages(), ...serverMessages()]);
  assert.deepEqual(Object.keys(MS).filter((k) => !used.has(k)), []);
});

test('the Malay keeps the same {placeholders} and has each key once', () => {
  const holes = (s) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
  for (const [en, ms] of Object.entries(MS)) assert.deepEqual(holes(ms), holes(en), en);
  const src = read('public/i18n-ms.js');
  const keys = [...src.matchAll(/^\s*(['"])((?:\\.|(?!\1).)*)\1:(?:\s|$)/gm)].length;
  assert.equal(keys, Object.keys(MS).length, 'no key is written twice');
});

test('the language follows the setting, or else the phone', () => {
  assert.equal(pickLang('ms', ['en-US']), 'ms');
  assert.equal(pickLang('en', ['ms-MY']), 'en');
  assert.equal(pickLang('auto', ['ms-MY', 'en-GB']), 'ms');
  assert.equal(pickLang('auto', ['en-MY', 'ms-MY']), 'en');
  assert.equal(pickLang('auto', ['zh-CN', 'ms']), 'ms');
  assert.equal(pickLang('auto', ['zh-CN']), 'en');
  assert.equal(pickLang(undefined, []), 'en');
});

test('tr, trPlural and trServer in both languages', () => {
  try {
    useLang('en');
    assert.equal(tr('Where to?'), 'Where to?');
    assert.equal(tr('Not in the dictionary {x}', { x: 1 }), 'Not in the dictionary 1');
    assert.equal(trPlural(1, '{n} other person is waiting too. You\'ll get in when a spot opens.', "{n} other people are waiting too. You'll get in when a spot opens."), "1 other person is waiting too. You'll get in when a spot opens.");
    assert.equal(trServer('You can suggest up to 5 places a day. Thank you!'), 'You can suggest up to 5 places a day. Thank you!');
    assert.deepEqual(locale(), []);

    useLang('ms');
    assert.equal(tr('Where to?'), 'Ke mana?');
    assert.equal(tr('Not in the dictionary'), 'Not in the dictionary');
    assert.equal(tr('{active} of {max}', { active: 3, max: 50 }), '3 daripada 50');
    assert.equal(trPlural(1, '{n} other person is waiting too. You\'ll get in when a spot opens.', "{n} other people are waiting too. You'll get in when a spot opens."), '1 orang lain juga sedang menunggu. Anda akan masuk apabila ada tempat kosong.');
    assert.equal(trServer('Wrong email or password.'), 'E-mel atau kata laluan salah.');
    assert.equal(trServer('You can suggest up to 5 places a day. Thank you!'), 'Anda boleh mencadangkan sehingga 5 tempat sehari. Terima kasih!');
    assert.equal(trServer('No path could be found for input'), 'No path could be found for input');
    assert.equal(locale(), 'ms-MY');
  } finally {
    useLang('en');
  }
});
