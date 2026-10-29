// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Optional two-factor logins (TOTP authenticator apps).
// Admin knob: TWO_FACTOR=off | optional | required (see wrangler.toml / .dev.vars.example).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { createD1 } from './d1-shim.js';
import { totpCode } from '../src/lib/twofactor.js';

const ASSETS = {
  async fetch(req) {
    return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
  },
};
const env = { DB: createD1(), ASSETS };

function client({ device = 'auth-test-device' } = {}) {
  let cookie = '';
  const headers = { 'x-a2b-device': device };
  return async (method, path, body) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await worker.fetch(new Request(`https://a2b.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json(), cookie: set };
  };
}

test('config advertises two-factor, off by default', async () => {
  const r = await client()('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { twoFactor: { mode: 'off' } });
});

test('signup and login are single-step when two-factor is off', async () => {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { email: 'plain@test.com', password: 'password1', name: 'Plain' });
  assert.equal(s.status, 201);
  assert.ok(s.cookie, 'session cookie is set');
  assert.equal(s.body.user.totp_enabled, false);
  const me = await c('GET', '/api/me');
  assert.equal(me.body.user.email, 'plain@test.com');
  assert.equal((await client()('POST', '/api/auth/login', { email: 'plain@test.com', password: 'password1' })).status, 200);
});

test('two-factor: setup, enable, login with code', async () => {
  env.TWO_FACTOR = 'optional';
  try {
    const c = client();
    await c('POST', '/api/auth/signup', { email: 'totp@test.com', password: 'password1', name: 'Totp' });
    const setup = await c('POST', '/api/auth/2fa/setup', {});
    assert.equal(setup.status, 200);
    assert.match(setup.body.secret, /^[A-Z2-7]+$/);
    assert.match(setup.body.otpauth_url, /^otpauth:\/\/totp\//);
    assert.equal((await c('POST', '/api/auth/2fa/enable', { code: '000000' })).status, 401);
    const enablingCode = await totpCode(setup.body.secret);
    const enable = await c('POST', '/api/auth/2fa/enable', { code: enablingCode });
    assert.equal(enable.status, 200);
    assert.equal(enable.body.user.totp_enabled, true);
    const stored = await env.DB.prepare('SELECT totp_last_step FROM users WHERE email = ?').bind('totp@test.com').first();
    assert.ok(stored.totp_last_step != null, 'the enabling code counts as used');

    const login = client();
    const first = await login('POST', '/api/auth/login', { email: 'totp@test.com', password: 'password1' });
    assert.equal(first.status, 202, 'password alone is not enough');
    assert.equal(first.body.two_factor_required, true);
    assert.match(first.body.challenge_id, /^[0-9a-f]{64}$/);
    assert.equal((await login('GET', '/api/me')).body.user, null, 'still logged out');
    const used = await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: enablingCode });
    assert.equal(used.status, 401, 'the enabling code cannot log in');
    const wrong = await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: '000000' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'totp_invalid');
    const me = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind('totp@test.com').first();
    const done = await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: await totpCode(me.totp_secret, Date.now() + 35000) });
    assert.equal(done.status, 200, 'the next code finishes login');
    assert.equal((await login('GET', '/api/me')).body.user.email, 'totp@test.com');
    const replay = await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: await totpCode(me.totp_secret) });
    assert.equal(replay.status, 400, 'a challenge works once');

    const off = await login('POST', '/api/auth/2fa/disable', { code: '000000' });
    assert.equal(off.status, 403, 'a wrong code cannot turn it off');
    const bye = await login('POST', '/api/auth/2fa/disable', { current_password: 'password1' });
    assert.equal(bye.status, 200);
    assert.equal(bye.body.user.totp_enabled, false);
    assert.equal((await client()('POST', '/api/auth/login', { email: 'totp@test.com', password: 'password1' })).status, 200, 'login is single-step again');
  } finally {
    delete env.TWO_FACTOR;
  }
});

test('a challenge dies after a few wrong codes, and wrong codes count per account', async () => {
  env.TWO_FACTOR = 'optional';
  try {
    const c = client();
    await c('POST', '/api/auth/signup', { email: 'brute@test.com', password: 'password1' });
    const setup = await c('POST', '/api/auth/2fa/setup', {});
    await c('POST', '/api/auth/2fa/enable', { code: await totpCode(setup.body.secret) });

    const login = client();
    const first = await login('POST', '/api/auth/login', { email: 'brute@test.com', password: 'password1' });
    assert.equal(first.status, 202);
    for (let i = 0; i < 4; i++) {
      const w = await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: '000000' });
      assert.equal(w.status, 401);
      assert.equal(w.body.code, 'totp_invalid');
    }
    const fifth = await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: '000000' });
    assert.equal(fifth.status, 429);
    assert.equal(fifth.body.code, 'totp_attempts');
    const me = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind('brute@test.com').first();
    const dead = await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: await totpCode(me.totp_secret) });
    assert.equal(dead.status, 400, 'even the right code fails once the challenge is dead');

    // 5 wrong codes counted: 3 more lock the account, like wrong passwords do.
    const second = await login('POST', '/api/auth/login', { email: 'brute@test.com', password: 'password1' });
    assert.equal(second.status, 202);
    for (let i = 0; i < 3; i++) {
      assert.equal((await login('POST', '/api/auth/2fa/verify', { challenge_id: second.body.challenge_id, code: '000000' })).status, 401);
    }
    const locked = await login('POST', '/api/auth/login', { email: 'brute@test.com', password: 'password1' });
    assert.equal(locked.status, 429, 'wrong codes count towards the per-account lockout');
  } finally {
    delete env.TWO_FACTOR;
  }
});

test('wrong codes across challenges lock the account at verify', async () => {
  env.TWO_FACTOR = 'optional';
  try {
    const c = client();
    await c('POST', '/api/auth/signup', { email: 'many@test.com', password: 'password1' });
    const setup = await c('POST', '/api/auth/2fa/setup', {});
    await c('POST', '/api/auth/2fa/enable', { code: await totpCode(setup.body.secret) });

    const login = client();
    const first = await login('POST', '/api/auth/login', { email: 'many@test.com', password: 'password1' });
    assert.equal(first.status, 202);
    for (let i = 0; i < 5; i++) {
      await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: '000000' });
    }
    const second = await login('POST', '/api/auth/login', { email: 'many@test.com', password: 'password1' });
    assert.equal(second.status, 202, '5 failures are still under the lockout');
    for (let i = 0; i < 3; i++) {
      assert.equal((await login('POST', '/api/auth/2fa/verify', { challenge_id: second.body.challenge_id, code: '000000' })).status, 401);
    }
    const me = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind('many@test.com').first();
    const locked = await login('POST', '/api/auth/2fa/verify', { challenge_id: second.body.challenge_id, code: await totpCode(me.totp_secret) });
    assert.equal(locked.status, 429, 'the lockout is checked at verify, even for the right code');
    assert.equal(locked.body.code, 'locked_out');
  } finally {
    delete env.TWO_FACTOR;
  }
});

test('wrong disable attempts lock the account', async () => {
  env.TWO_FACTOR = 'optional';
  try {
    const c = client();
    await c('POST', '/api/auth/signup', { email: 'nodisable@test.com', password: 'password1' });
    const setup = await c('POST', '/api/auth/2fa/setup', {});
    await c('POST', '/api/auth/2fa/enable', { code: await totpCode(setup.body.secret) });
    for (let i = 0; i < 8; i++) {
      assert.equal((await c('POST', '/api/auth/2fa/disable', { current_password: 'wrongpass' })).status, 403);
    }
    const locked = await c('POST', '/api/auth/2fa/disable', { current_password: 'password1' });
    assert.equal(locked.status, 429, 'even the right password is refused once locked');
    assert.equal(locked.body.code, 'locked_out');
    assert.equal((await client()('POST', '/api/auth/login', { email: 'nodisable@test.com', password: 'password1' })).status, 429);
  } finally {
    delete env.TWO_FACTOR;
  }
});

test('a used code cannot be replayed in a new challenge', async () => {
  env.TWO_FACTOR = 'optional';
  try {
    const c = client();
    await c('POST', '/api/auth/signup', { email: 'replay@test.com', password: 'password1' });
    const setup = await c('POST', '/api/auth/2fa/setup', {});
    await c('POST', '/api/auth/2fa/enable', { code: await totpCode(setup.body.secret) });
    const code = await totpCode(setup.body.secret, Date.now() + 35000);

    const login = client();
    const first = await login('POST', '/api/auth/login', { email: 'replay@test.com', password: 'password1' });
    assert.equal((await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code })).status, 200);

    const login2 = client();
    const second = await login2('POST', '/api/auth/login', { email: 'replay@test.com', password: 'password1' });
    assert.equal(second.status, 202);
    const again = await login2('POST', '/api/auth/2fa/verify', { challenge_id: second.body.challenge_id, code });
    assert.equal(again.status, 401, 'the same step code is rejected in a later challenge');
    assert.equal(again.body.code, 'totp_invalid');
  } finally {
    delete env.TWO_FACTOR;
  }
});

test('two-factor off disables the endpoints; required enrols on next login', async () => {
  const c = client();
  await c('POST', '/api/auth/signup', { email: 'enrol@test.com', password: 'password1' });
  env.TWO_FACTOR = 'off';
  try {
    assert.equal((await c('POST', '/api/auth/2fa/setup', {})).status, 404);
    assert.equal((await c('POST', '/api/auth/login', { email: 'enrol@test.com', password: 'password1' })).status, 200);
  } finally {
    delete env.TWO_FACTOR;
  }
  env.TWO_FACTOR = 'required';
  try {
    const login = client();
    const first = await login('POST', '/api/auth/login', { email: 'enrol@test.com', password: 'password1' });
    assert.equal(first.status, 202);
    assert.equal(first.body.two_factor_setup_required, true);
    const done = await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: await totpCode(first.body.secret) });
    assert.equal(done.status, 200);
    assert.equal(done.body.user.totp_enabled, true);
    const next = await client()('POST', '/api/auth/login', { email: 'enrol@test.com', password: 'password1' });
    assert.equal(next.body.two_factor_required, true, 'now a normal two-factor login');
  } finally {
    delete env.TWO_FACTOR;
  }
});

test('deleting the account clears two-factor data', async () => {
  env.TWO_FACTOR = 'optional';
  try {
    const c = client();
    await c('POST', '/api/auth/signup', { email: 'bye@test.com', password: 'password1' });
    const setup = await c('POST', '/api/auth/2fa/setup', {});
    await c('POST', '/api/auth/2fa/enable', { code: await totpCode(setup.body.secret) });
    assert.equal((await c('DELETE', '/api/me')).status, 200);
    const gone = await env.DB.prepare('SELECT totp_secret, totp_enabled, totp_last_step FROM users WHERE name = ?').bind('Former driver').first();
    assert.equal(gone.totp_secret, null);
    assert.equal(gone.totp_enabled, 0);
    assert.equal(gone.totp_last_step, null);
  } finally {
    delete env.TWO_FACTOR;
  }
});
