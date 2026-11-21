// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// A real emergency can't wait for a report to be sent: Call 999 is a plain tel: link, and notifying an emergency
// contact is a one-tap sms: link with the driver's location, no account or server round trip either way.
test('a crash report offers to call or text for help straight away, with no network needed', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="tel:999"/);
  assert.match(html, /id="btn-notify-contact"/);

  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const body = (name) => app.slice(app.indexOf(`function ${name}(`), app.indexOf('\n}\n', app.indexOf(`function ${name}(`)));
  assert.match(body('pickReportType'), /key !== 'crash'/, 'shown for crash, hidden for every other report type');
  assert.match(app, /location\.href = `sms:\$\{contact\}\?body=/);

  const panels = await readFile(new URL('../public/panels.js', import.meta.url), 'utf8');
  assert.match(panels, /id="s-emergency-contact"/, 'off by default; set in Settings, kept on this phone only');
});
