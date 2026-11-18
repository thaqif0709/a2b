// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { createD1 } from './d1-shim.js';
import { sha256, verifyPassword, RECOVERY_WINDOW_MS } from '../src/lib/auth.js';

const env = { DB: createD1() };
const originalPassword = 'original-test-password';
let sequence = 0;
async function call(path, body, cookie = null) {
  const headers = { 'x-a2b-device': 'recovery-test-device', 'cf-connecting-ip': '192.0.2.1' };
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const response = await worker.fetch(new Request(`https://a2b.test${path}`, {
    method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: response.status, cookie: response.headers.get('set-cookie'), body: await response.json() };
}
async function account() {
  const email = `recovery-${++sequence}@example.test`;
  const response = await call('/api/auth/signup', { email, password: originalPassword });
  assert.equal(response.status, 201);
  return { email, id: response.body.user.id, code: response.body.recovery_code, cookie: response.cookie.split(';')[0] };
}
const reset = (a, password = 'replacement-test-password', code = a.code) => call('/api/auth/recover', { email: a.email, code, password });
const snapshot = async (id) => ({
  user: await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first(),
  code: await env.DB.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').bind(id).first(),
  sessions: (await env.DB.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY token_hash').bind(id).all()).results,
});

test('competing recovery requests have one winner, one password and one valid session', async () => {
  const a = await account();
  await call('/api/auth/login', { email: a.email, password: originalPassword });
  // Release both requests at the actual batch boundary, after both have prepared all their secrets.
  const batch = env.DB.batch;
  let arrived = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  env.DB.batch = async (statements) => {
    if (++arrived === 2) release();
    await gate;
    return batch(statements);
  };
  let responses;
  try {
    responses = await Promise.all([reset(a, 'first-new-password'), reset(a, 'second-new-password')]);
  } finally { env.DB.batch = batch; }
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
  const winnerIndex = responses.findIndex((r) => r.status === 200);
  const winner = responses[winnerIndex], loser = responses[1 - winnerIndex];
  assert.equal(loser.cookie, null);
  assert.equal(loser.body.recovery_code, undefined);
  const state = await snapshot(a.id);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].token_hash, await sha256(winner.cookie.split(';')[0].split('=')[1]));
  assert.ok(await verifyPassword(winnerIndex ? 'second-new-password' : 'first-new-password', state.user.pass_hash, state.user.pass_salt));
  assert.equal(await verifyPassword(winnerIndex ? 'first-new-password' : 'second-new-password', state.user.pass_hash, state.user.pass_salt), false);
  assert.equal((await call('/api/me', undefined, a.cookie)).body.user, null);
  assert.equal((await call('/api/me', undefined, winner.cookie.split(';')[0])).body.user.id, a.id);
  assert.equal((await reset(a)).status, 401, 'old code stays invalid');
  assert.match(winner.body.recovery_code, /^[0-9a-f]{16}$/);
  assert.notEqual(winner.body.recovery_code, a.code);
  assert.equal(state.code.code_hash, await sha256(winner.body.recovery_code));
  const me = await call('/api/me', undefined, winner.cookie.split(';')[0]);
  assert.equal(me.body.recovery_code, undefined, 'replacement is shown only in the reset response');
  assert.equal((await reset(a, 'next-replacement-password', winner.body.recovery_code)).status, 200);
});

for (const [stage, table, operation, condition] of [
  ['password update', 'users', 'UPDATE OF pass_hash', 'NEW.id'],
  ['session revocation', 'sessions', 'DELETE', 'OLD.user_id'],
  ['replacement session insertion', 'sessions', 'INSERT', 'NEW.user_id'],
]) {
  test(`failure during ${stage} rolls back code, password and sessions`, async (t) => {
    t.mock.method(console, 'error', () => {}); // expected synthetic database error; never print credentials
    const a = await account();
    const before = await snapshot(a.id);
    await env.DB.prepare(`CREATE TRIGGER recovery_fault BEFORE ${operation} ON ${table}
      WHEN ${condition} = ${a.id} BEGIN SELECT RAISE(ABORT, 'synthetic recovery fault'); END`).run();
    let failed;
    try { failed = await reset(a); } finally { await env.DB.prepare('DROP TRIGGER recovery_fault').run(); }
    assert.equal(failed.status, 500);
    assert.equal(failed.cookie, null);
    assert.equal(failed.body.recovery_code, undefined);
    assert.deepEqual(await snapshot(a.id), before);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM recovery_attempts WHERE email = ?').bind(a.email).first()).n, 0);
    assert.equal((await reset(a)).status, 200, 'same code can retry after the technical failure');
  });
}

test('recovery attempts are atomically limited per normalized email, never shared IP', async () => {
  const a = await account(), b = await account();
  const failures = await Promise.all(Array.from({ length: 12 }, () => reset(a, 'new-test-password', 'incorrect')));
  assert.equal(failures.filter((r) => r.status === 401).length, 8);
  assert.equal(failures.filter((r) => r.status === 429).length, 4);
  assert.equal((await reset({ ...a, email: `  ${a.email.toUpperCase()}  ` })).status, 429);
  assert.equal((await reset(b)).status, 200, 'another account on the same IP can recover');
  await env.DB.prepare('UPDATE recovery_attempts SET at = ? WHERE email = ?').bind(Date.now() - RECOVERY_WINDOW_MS - 1, a.email).run();
  assert.equal((await reset(a)).status, 200, 'expired attempts no longer block the valid code');
  const unknown = { email: 'unregistered@example.test', code: 'incorrect' };
  for (let i = 0; i < 8; i++) assert.equal((await reset(unknown)).status, 401);
  assert.equal((await reset(unknown)).status, 429, 'unknown addresses have the same throttling response');
});

test('malformed percent-encoded cookies are treated as signed out', async () => {
  const response = await call('/api/me', undefined, 'a2b_session=%E0%A4%A');
  assert.equal(response.status, 200);
  assert.equal(response.body.user, null);
});
