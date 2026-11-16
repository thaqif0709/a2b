// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// "Where I parked": dropped automatically when a drive by car or motorbike ends, cleared once the car moves again.
test('a parked spot is saved when a drive ends and cleared when driving starts again', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const body = (name) => app.slice(app.indexOf(`function ${name}(`), app.indexOf('\n}\n', app.indexOf(`function ${name}(`)));
  assert.match(body('saveParkedSpot'), /travel !== 'drive' && travel !== 'motorcycle'/);
  assert.match(body('saveParkedSpot'), /local\.set\('parkedAt', \{ lngLat: state\.pos\.lngLat/);
  assert.match(body('endDrive'), /if \(mode === 'drive'\) saveParkedSpot\(\);/);
  assert.match(body('startDrive'), /clearParkedSpot\(\)/);
  assert.match(body('clearParkedSpot'), /local\.set\('parkedAt', null\)/);
});
