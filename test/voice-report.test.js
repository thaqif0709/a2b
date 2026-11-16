// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matchReportPhrase } from '../public/voice-report.js';

test('matches a report type from what was heard, in different phrasings', () => {
  assert.equal(matchReportPhrase('report police'), 'police');
  assert.equal(matchReportPhrase('Report cops ahead'), 'police');
  assert.equal(matchReportPhrase('report crash'), 'crash');
  assert.equal(matchReportPhrase('please report a pothole'), 'hazard');
  assert.equal(matchReportPhrase('report road closed'), 'closure');
});

test('ignores speech with no report word, or no matching type', () => {
  assert.equal(matchReportPhrase('turn left in 500 metres'), null);
  assert.equal(matchReportPhrase('report the weather'), null);
});

// Off by default, listens only while driving, and stops the moment the drive ends.
test('the app only listens for reports while actually driving', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const body = (name) => app.slice(app.indexOf(`function ${name}(`), app.indexOf('\n}\n', app.indexOf(`function ${name}(`)));
  assert.match(body('startDrive'), /if \(state\.settings\.voice_report\) voiceReporter\.start\(\);/);
  assert.match(body('endDrive'), /voiceReporter\.stop\(\);/);
  assert.match(body('voiceReport'), /mode !== 'drive'/);
  const core = await readFile(new URL('../public/core.js', import.meta.url), 'utf8');
  assert.match(core, /voice_report: false/, 'off by default: it needs microphone permission');
});
