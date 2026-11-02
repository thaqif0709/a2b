// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactSign, signPlaces, withSign } from '../public/signs.js';

// As the public Valhalla gives them, KL Sentral to Seremban (trimmed).
const EXIT_218 = {
  exit_number_elements: [{ text: '218' }],
  exit_branch_elements: [{ text: '241', consecutive_count: 2 }],
  exit_toward_elements: [{ text: 'Seremban' }, { text: 'Labu' }],
  exit_name_elements: [{ text: 'Seremban' }],
};
const TO_E37 = {
  exit_branch_elements: [{ text: 'E37', consecutive_count: 1 }],
  exit_toward_elements: ['E2', 'E26', 'E9', 'KLIA', 'Puchong', 'Putrajaya', 'Sungai Besi', 'Johor Bahru'].map((text) => ({ text })),
};

test('a sign, compact: the exit number, the roads (numbers out of the places) and where it goes', () => {
  assert.deepEqual(compactSign(EXIT_218), { exit: '218', roads: ['241'], toward: ['Seremban', 'Labu'] });
  assert.deepEqual(compactSign(TO_E37), { roads: ['E37', 'E2'], toward: ['KLIA', 'Puchong', 'Putrajaya'] });
  assert.deepEqual(compactSign({ exit_branch_elements: [{ text: 'FT2' }] }), { roads: ['FT2'] });
  assert.equal(compactSign({ exit_toward_elements: [] }), null);
  assert.equal(compactSign(undefined), null);
});

test('the places on the banner: two at most', () => {
  assert.equal(signPlaces(compactSign(TO_E37)), 'KLIA / Puchong');
  assert.equal(signPlaces({ roads: ['241'] }), '');
});

test('spoken cues name what the sign says and the cue doesn’t, never twice', () => {
  const s = compactSign(EXIT_218);
  assert.equal(withSign('Take exit 218.', s), 'Take exit 218 towards Seremban and Labu.');
  assert.equal(withSign('Take exit 218 onto 241 toward Seremban, Labu.', s), 'Take exit 218 onto 241 toward Seremban, Labu.');
  assert.equal(withSign('Keep left.', s), 'Keep left, exit 218 towards Seremban and Labu.');
  assert.equal(withSign('Keep right to take E37 toward E2, E26.', compactSign(TO_E37)), 'Keep right to take E37 toward E2, E26.', 'already says where');
  assert.equal(withSign('Keep left to take 241.', { roads: ['241'] }), 'Keep left to take 241.');
  assert.equal(withSign('Turn right.', null), 'Turn right.');
});
