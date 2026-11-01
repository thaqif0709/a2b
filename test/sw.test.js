// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const pub = new URL('../public/', import.meta.url);
const sw = readFileSync(new URL('sw.js', pub), 'utf8');
const list = (name) => JSON.parse(sw.match(new RegExp(`const ${name} = (\\[.*?\\]);`))[1].replace(/'/g, '"'));

test('the offline shell holds every module the app loads', () => {
  // A module missing here can't be had on a phone that has opened the app only once and then lost its signal.
  const shell = list('SHELL');
  const modules = readdirSync(pub).filter((f) => f.endsWith('.js') && f !== 'sw.js').map((f) => `/${f}`);
  assert.deepEqual(modules.filter((m) => !shell.includes(m)), []);
});

test('the libraries the app loads are served from our own domain', () => {
  const html = readFileSync(new URL('index.html', pub), 'utf8');
  assert.doesNotMatch(html, /<(script|link)[^>]+(src|href)="https?:/, 'index.html loads nothing from another site');
  const maplibre = list('MAPLIBRE');
  for (const path of [...maplibre, ...[...html.matchAll(/(?:src|href)="(\/vendor\/[^"]+)"/g)].map((m) => m[1])]) {
    assert.ok(existsSync(new URL(`.${path}`, pub)), `${path} exists`);
  }
  const three = readFileSync(new URL('vehicle3d.js', pub), 'utf8').match(/const THREE_URL = '([^']+)'/)[1];
  assert.match(sw.match(/const VENDOR = .*/)[0], new RegExp(`'${three}'`), 'sw.js VENDOR lists the three.js file vehicle3d.js loads');
  assert.ok(existsSync(new URL(`.${three}`, pub)), `${three} exists`);
});
