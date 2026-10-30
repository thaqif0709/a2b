// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).
// Run with Node --experimental-vm-modules. Parse modules without executing app code or contacting providers.
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { SourceTextModule, runInNewContext } from 'node:vm';

const root = resolve(process.argv[2] || 'public');
const shell = new Set();
const handlers = new Map();
const installWork = [];
runInNewContext(await readFile(resolve(root, 'sw.js'), 'utf8'), {
  self: { addEventListener: (type, callback) => handlers.set(type, callback), skipWaiting: async () => {} },
  caches: { open: async () => ({ addAll: async (urls) => urls.forEach((url) => shell.add(url)) }) },
  fetch: async () => ({ ok: false }), // optional remote library precache is outside the local module graph
});
handlers.get('install')({ waitUntil: (promise) => installWork.push(promise) });
await Promise.all(installWork);

const html = await readFile(resolve(root, 'index.html'), 'utf8');
const queue = [...html.matchAll(/<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>/g)].map((m) => m[1]);
if (!queue.length) throw new Error('No module entrypoints found in index.html');
const visited = new Set();
const missing = [];
while (queue.length) {
  const pathname = queue.shift();
  if (visited.has(pathname)) continue;
  visited.add(pathname);
  if (!shell.has(pathname)) missing.push(pathname);
  const file = resolve(root, `.${pathname}`);
  if (!file.startsWith(root + sep)) throw new Error(`Import escapes public directory: ${pathname}`);
  const source = await readFile(file, 'utf8');
  // The JavaScript parser catches syntax errors as well as static imports and re-exports.
  const module = new SourceTextModule(source, { identifier: pathname });
  const dynamic = [...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  for (const specifier of [...module.dependencySpecifiers, ...dynamic]) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
    const url = new URL(specifier, `https://shell.invalid${pathname}`);
    if (url.origin !== 'https://shell.invalid') continue;
    if (url.search || url.hash) throw new Error(`Versioned local import needs an explicit precache key: ${specifier}`);
    queue.push(url.pathname);
  }
}
if (missing.length) throw new Error(`Offline shell is missing imported modules: ${missing.join(', ')}`);
console.log(`Offline shell covers ${visited.size} local modules; all parsed successfully.`);
