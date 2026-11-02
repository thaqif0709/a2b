// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LANGUAGES, pickLang, useLang, tr, trPlural, trServer, locale } from '../public/i18n.js';
import { validatePassword } from '../src/lib/auth.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const unescape = (s) => s.replace(/\\(.)/g, '$1');
const STRING = String.raw`(['"])((?:\\.|(?!\1).)*)\1`;

// Every language but English, with its words.
const DICTS = await Promise.all(LANGUAGES.filter((l) => l.load).map(async (l) => [l.code, (await l.load()).default]));
// Kept complete: a message without its Malay fails. A language added later may lag behind, its missing messages
// showing in English, so it's only counted.
const COMPLETE = new Set(['ms']);
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

const used = () => new Set([...appMessages(), ...pageMessages(), ...serverMessages()]);

test('every message has its Malay (and how far the other languages are)', (t) => {
  const all = [...used()].filter((s) => !SAME.has(s));
  for (const [code, dict] of DICTS) {
    const missing = all.filter((s) => !(s in dict));
    if (COMPLETE.has(code)) assert.deepEqual(missing, [], code);
    else t.diagnostic(`${code}: ${all.length - missing.length} of ${all.length} messages translated`);
  }
});

test('every entry is still used (an English text changed means its key changes too)', () => {
  const now = used();
  for (const [code, dict] of DICTS) assert.deepEqual(Object.keys(dict).filter((k) => !now.has(k)), [], code);
});

test('each translation keeps the same {placeholders} and has each key once', () => {
  const holes = (s) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
  for (const [code, dict] of DICTS) {
    for (const [en, said] of Object.entries(dict)) assert.deepEqual(holes(said), holes(en), `${code}: ${en}`);
    const src = read(`public/i18n-${code}.js`);
    const keys = [...src.matchAll(/(?:^|[{,])\s*(['"])((?:\\.|(?!\1).)*)\1\s*:/gm)].length;
    assert.equal(keys, Object.keys(dict).length, `${code}: no key is written twice`);
  }
});

test('the offline shell keeps every language', () => {
  const sw = read('public/sw.js');
  for (const [code] of DICTS) assert.match(sw, new RegExp(`'/i18n-${code}\\.js'`), code);
});

test('the language follows the setting, or else the phone', () => {
  assert.equal(pickLang('ms', ['en-US']), 'ms');
  assert.equal(pickLang('en', ['ms-MY']), 'en');
  assert.equal(pickLang('auto', ['ms-MY', 'en-GB']), 'ms');
  assert.equal(pickLang('auto', ['en-MY', 'ms-MY']), 'en');
  assert.equal(pickLang('auto', ['ja-JP', 'ms']), 'ms');
  assert.equal(pickLang('auto', ['ja-JP']), 'en');
  assert.equal(pickLang('auto', ['zh-Hant-TW', 'en']), 'zh');
  assert.equal(pickLang(undefined, []), 'en');
});

test('tr, trPlural and trServer in English, Malay and Chinese', async () => {
  try {
    await useLang('en');
    assert.equal(tr('Where to?'), 'Where to?');
    assert.equal(tr('Not in the dictionary {x}', { x: 1 }), 'Not in the dictionary 1');
    assert.equal(trPlural(1, '{n} other person is waiting too. You\'ll get in when a spot opens.', "{n} other people are waiting too. You'll get in when a spot opens."), "1 other person is waiting too. You'll get in when a spot opens.");
    assert.equal(trServer('You can suggest up to 5 places a day. Thank you!'), 'You can suggest up to 5 places a day. Thank you!');
    assert.deepEqual(locale(), []);

    await useLang('ms');
    assert.equal(tr('Where to?'), 'Ke mana?');
    assert.equal(tr('Not in the dictionary'), 'Not in the dictionary');
    assert.equal(tr('{active} of {max}', { active: 3, max: 50 }), '3 daripada 50');
    assert.equal(trPlural(1, '{n} other person is waiting too. You\'ll get in when a spot opens.', "{n} other people are waiting too. You'll get in when a spot opens."), '1 orang lain juga sedang menunggu. Anda akan masuk apabila ada tempat kosong.');
    assert.equal(trServer('Wrong email or password.'), 'E-mel atau kata laluan salah.');
    assert.equal(trServer('You can suggest up to 5 places a day. Thank you!'), 'Anda boleh mencadangkan sehingga 5 tempat sehari. Terima kasih!');
    assert.equal(trServer('No path could be found for input'), 'No path could be found for input');
    assert.equal(locale(), 'ms-MY');

    await useLang('zh');
    assert.equal(tr('Where to?'), '去哪里？');
    assert.equal(trPlural(1, '{n} other person is waiting too. You\'ll get in when a spot opens.', "{n} other people are waiting too. You'll get in when a spot opens."), '还有 1 人在等待。有空位时你就能进入。');
    assert.equal(trServer('You can suggest up to 5 places a day. Thank you!'), '你每天最多可以建议 5 个地点。谢谢！');
    assert.equal(locale(), 'zh-MY');
  } finally {
    await useLang('en');
  }
});
