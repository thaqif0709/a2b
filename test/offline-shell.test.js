// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const check = (root = 'public') => spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', 'scripts/check-offline-shell.mjs', root], { encoding: 'utf8' });

test('installed shell includes the full local frontend module graph and parses every module', () => {
  const result = check();
  assert.equal(result.status, 0, result.stderr);
});

test('shell check follows transitive re-exports, cycles and literal lazy imports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'a2b-shell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<script type="module" src="/app.js"></script>');
  await writeFile(join(root, 'app.js'), "export { value } from './nested.js'; import('./lazy.js');");
  await writeFile(join(root, 'nested.js'), "import './app.js'; export const value = 1;");
  await writeFile(join(root, 'lazy.js'), 'export const lazy = true;');
  const manifest = (files) => `self.addEventListener('install', e => e.waitUntil(caches.open('test').then(c => c.addAll(${JSON.stringify(files)}))));`;
  await writeFile(join(root, 'sw.js'), manifest(['/app.js']));
  const missing = check(root);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing imported modules: \/nested.js, \/lazy.js/);
  await writeFile(join(root, 'sw.js'), manifest(['/app.js', '/nested.js', '/lazy.js']));
  assert.equal(check(root).status, 0);
  await writeFile(join(root, 'lazy.js'), 'export const duplicated = 1; const duplicated = 2;');
  const invalid = check(root);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /SyntaxError/);
});
