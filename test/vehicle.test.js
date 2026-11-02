// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vehicleFor } from '../public/vehicle3d.js';

test('a motorbike while riding in Motorbike mode, otherwise the vehicle chosen in Settings', () => {
  assert.equal(vehicleFor('motorcycle', 'chevron'), 'motorbike');
  assert.equal(vehicleFor('motorcycle', 'car'), 'motorbike');
  assert.equal(vehicleFor('drive', 'car'), 'car');
  assert.equal(vehicleFor('drive', 'chevron'), 'chevron');
  assert.equal(vehicleFor(null, 'car'), 'car', 'not driving');
  assert.equal(vehicleFor('drive', 'something old'), 'chevron');
});
