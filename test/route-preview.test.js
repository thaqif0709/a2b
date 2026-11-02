// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAutoStartRoute } from '../public/route-preview.js';

const readyPreview = {
  mode: 'preview',
  travel: 'drive',
  routeAvailable: true,
  hasLocation: true,
  buttonDisabled: false,
  pageHidden: false,
  blockingOverlayOpen: false,
  closuresIgnored: false,
};

test('a clear route may keep the existing auto-start behavior', () => {
  assert.equal(canAutoStartRoute(readyPreview), true);
});

test('a route that may pass a reported closure requires an explicit start', () => {
  assert.equal(canAutoStartRoute({ ...readyPreview, closuresIgnored: true }), false);
});

test('an unknown closure status does not auto-start', () => {
  assert.equal(canAutoStartRoute({ ...readyPreview, closuresIgnored: undefined }), false);
});

test('existing preview, location, visibility and overlay guards still block auto-start', () => {
  for (const change of [
    { mode: 'browse' },
    { routeAvailable: false },
    { hasLocation: false },
    { buttonDisabled: true },
    { pageHidden: true },
    { blockingOverlayOpen: true },
  ]) {
    assert.equal(canAutoStartRoute({ ...readyPreview, ...change }), false);
  }
});

test('riding routes auto-start like driving ones', () => {
  assert.equal(canAutoStartRoute({ ...readyPreview, travel: 'motorcycle' }), true);
  assert.equal(canAutoStartRoute({ ...readyPreview, travel: 'motorcycle', closuresIgnored: true }), false);
});

test('walking routes and trips by train never auto-start', () => {
  assert.equal(canAutoStartRoute({ ...readyPreview, travel: 'walk' }), false);
  assert.equal(canAutoStartRoute({ ...readyPreview, travel: 'transit' }), false);
  assert.equal(canAutoStartRoute({ ...readyPreview, travel: undefined }), false);
});

test('every trip starts on Drive: Walk or Train is not remembered, and goes back to Drive afterwards', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const body = (name) => app.slice(app.indexOf(`function ${name}(`), app.indexOf('\n}\n', app.indexOf(`function ${name}(`)));
  assert.match(app, /^let travel = 'drive';$/m);
  assert.doesNotMatch(app, /local\.(get|set)\('travel'/, 'not kept for next time');
  assert.match(body('backToBrowse'), /resetTravel\(\)/, 'closing the preview, or stopping a trip');
  assert.match(body('endDrive'), /else \{[^}]*resetTravel\(\)/, 'arriving');
  assert.match(body('resetTravel'), /travel = 'drive'/);
});

// Only cars' speeds: walkers would look like a jam, and motorcycles filter past jams.
test('walking and riding speeds are not shared as traffic', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(mode === 'drive' && travel === 'drive' && !sim\) noteProbeFix\(fix\)/);
});
