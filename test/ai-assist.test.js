// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildRequest, DEFAULT_BASE_URL, DEFAULT_MODEL } from '../public/ai-assist.js';

// Bring your own AI key: the request is built the same way for any OpenAI-compatible provider. Pure (no fetch),
// so this runs without a network call.
test('builds an OpenAI-compatible chat request, with sensible defaults', () => {
  const { url, init } = buildRequest({ apiKey: 'sk-test', question: 'where can I park near KLCC?' });
  assert.equal(url, `${DEFAULT_BASE_URL}/chat/completions`);
  assert.equal(init.headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(init.body);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'where can I park near KLCC?' }]);
});

test('a trailing slash on a custom base URL, a chosen model, and a system prompt all carry through', () => {
  const { url, init } = buildRequest({
    baseUrl: 'https://my-ollama.local/v1/',
    apiKey: 'local-key',
    model: 'llama3',
    question: 'how do I avoid tolls to Ipoh?',
    system: 'You are a brief driving assistant.',
  });
  assert.equal(url, 'https://my-ollama.local/v1/chat/completions');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'llama3');
  assert.deepEqual(body.messages[0], { role: 'system', content: 'You are a brief driving assistant.' });
});

test('refuses to build a request with no key or no question', () => {
  assert.throws(() => buildRequest({ question: 'hi' }), /API key/);
  assert.throws(() => buildRequest({ apiKey: 'sk-test', question: '   ' }), /[Aa]sk something/);
});

// Ask AI's whole point is bringing your own provider, which could be any host: the CSP must let the browser
// reach it directly (and a local Ollama over plain http), or every request would silently fail.
test('the CSP lets the browser reach any AI provider, not just the ones A2B itself talks to server-side', async () => {
  const headers = await readFile(new URL('../public/_headers', import.meta.url), 'utf8');
  const csp = headers.match(/Content-Security-Policy:(.*)/)[1];
  const connect = csp.match(/connect-src ([^;]+)/)[1];
  assert.match(connect, /\bhttps:(?!\/\/)/, 'any https host, not only the ones already listed');
  assert.match(connect, /http:\/\/localhost:\*/, 'a local Ollama (or similar) over plain http');
});
