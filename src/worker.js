// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { ensureSchema } from './lib/schema.js';
import {
  hashPassword, verifyPassword, normalizeEmail, validatePassword, cleanName, createSession, createRecoveryCode,
  consumeRecoveryCode, currentUser, destroySession, sessionCookie, publicUser, randomToken, sha256, readCookie,
} from './lib/auth.js';
import { generateSecret, otpauthURL, verifyTOTP, verifyTOTPStep, twoFactorMode } from './lib/twofactor.js';
import { probesRepo, annotateWithProbes, PROBE_RETENTION_MS } from './lib/probes.js';
import { searchPlaces, reverseGeocode, fetchRoutes, fetchRouteAttributes, annotateWithReports, httpError, corridorBox, routeReportBox, roadMidpoint, MAX_EXCLUDE } from './lib/providers.js';
import { constructionTwins } from './lib/construction.js';
import { liveTraffic, applyTraffic } from './lib/traffic.js';
import { loadCameras, camerasAlong } from './lib/cameras.js';
import { parkingNear, parkingQuery, parkingResults } from './lib/parking.js';
import { plazaDetails } from './lib/tolls.js';
import { refreshChargers, allChargers } from './lib/chargers.js';
import { reportsRepo } from './lib/reports.js';
import { presenceRepo, limits, validDevice } from './lib/presence.js';
import { usageRepo, USAGE_DAYS, dayOf } from './lib/usage.js';
import { planTransit, withRealWalks } from './lib/transit.js';

const MAX_BODY = 64 * 1024;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 8; // per address: wrong passwords for one account stop here (per-network throttles
// were dropped: behind the Pages proxy every client shares one IP, so they would lock out everyone at once)
const CHALLENGE_TTL_MS = 10 * 60_000; // the second login step lasts ten minutes
const CHALLENGE_MAX_ATTEMPTS = 5; // wrong codes per challenge, then it dies and the driver logs in again
const RECENTS_KEPT = 20;
const FULL_MESSAGE = 'A2B is full right now. You will be let in when a spot opens.';
const SETTINGS_KEYS = { voice: 'boolean', speed_warning: 'boolean', units: ['metric', 'imperial'], theme: ['auto', 'day', 'night'], avoid_tolls: 'boolean', avoid_highways: 'boolean', avoid_ferries: 'boolean', alerts: 'boolean', traffic_probe: 'boolean', map_pois: 'boolean' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    try {
      if (url.pathname === '/api/health') return json({ ok: true, database: Boolean(env.DB) });
      if (!env.DB) throw httpError('Database is not configured (see README).', 500);
      await ensureSchema(env.DB);
      return await route(request, env, url);
    } catch (e) {
      if (!e.status || e.status >= 500) console.error(e);
      return json({ error: e.message || String(e), code: e.code }, e.status && e.status < 600 ? e.status : 500);
    }
  },

  // Daily housekeeping (see [triggers] in wrangler.toml). Reports are kept: they count towards drivers' stats.
  async scheduled(_event, env) {
    if (!env.DB) return;
    await ensureSchema(env.DB);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM trips WHERE updated_at < ?').bind(now - 2 * 86400_000),
      env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(now - LOGIN_WINDOW_MS),
      env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM presence WHERE last_seen < ?').bind(now - 86400_000),
      env.DB.prepare('DELETE FROM usage_devices WHERE day < ?').bind(dayOf(now - USAGE_DAYS * 86400_000)),
      env.DB.prepare('DELETE FROM usage_daily WHERE day < ?').bind(dayOf(now - USAGE_DAYS * 86400_000)),
      env.DB.prepare('DELETE FROM probe_segments WHERE updated_at < ?').bind(now - PROBE_RETENTION_MS),
      env.DB.prepare('DELETE FROM probe_devices WHERE updated_at < ?').bind(now - PROBE_RETENTION_MS),
      env.DB.prepare('DELETE FROM probe_limits WHERE last_at < ?').bind(now - PROBE_RETENTION_MS),
    ]);
    await refreshChargers(env, { now }).catch((e) => console.warn('chargers', e.message)); // weekly, per source
  },
};

async function route(request, env, url) {
  const db = env.DB;
  const method = request.method;
  const path = url.pathname;
  const parts = path.split('/').filter(Boolean); // ['api', ...]
  const user = await currentUser(db, request);
  const reports = reportsRepo(db);
  const needUser = () => {
    if (!user) throw httpError('Sign in first.', 401);
    return user;
  };
  // Search and routing use the free public servers, so they need one of the spots (see presence.js).
  const presence = presenceRepo(db);
  const usage = usageRepo(db);
  const count = (field) => usage.bump(field).catch((e) => console.warn('usage', e.message)); // never fails a request
  const device = request.headers.get('x-a2b-device');
  const needSpot = async () => {
    if (!validDevice(device)) throw httpError('Missing device id. Update the app to the latest version.', 400);
    if ((user && isTester(env, user)) || (await presence.hasSpot(device))) return;
    throw Object.assign(httpError(FULL_MESSAGE, 503), { code: 'full' });
  };

  if (path === '/api/presence' && method === 'POST') {
    if (!validDevice(device)) throw httpError('Missing device id.', 400);
    const result = await presence.checkIn(device, user, limits(env), { always: Boolean(user && isTester(env, user)) });
    await usage.sawDevice(device, user, result).catch((e) => console.warn('usage', e.message));
    return json(result);
  }

  // The owner's usage dashboard; anyone else gets a plain "not found".
  if (path === '/api/stats' && method === 'GET') {
    if (!user || !isTester(env, user)) throw httpError('Not found.', 404);
    return json(await usage.report(limits(env)));
  }

  // ---------- Feedback ----------
  // From Settings › Feedback, with or without an account; read by the owner in Settings › Testing.
  if (path === '/api/feedback' && method === 'POST') {
    // Open to anyone with a valid device id, even when A2B is full: that's exactly when feedback is most
    // needed. The 10-a-day limit below still applies.
    if (!validDevice(device)) throw httpError('Missing device id. Update the app to the latest version.', 400);
    const body = await readJson(request);
    const message = String(body.message ?? '').trim().slice(0, FEEDBACK_MAX);
    if (message.length < 3) throw httpError('Write a few words first.', 400);
    const who = user ? ['user_id = ?', user.id] : validDevice(device) ? ['device = ?', device] : null;
    if (!who) throw httpError('Missing device id.', 400);
    const sent = await db.prepare(`SELECT COUNT(*) AS n FROM feedback WHERE ${who[0]} AND created_at > ?`).bind(who[1], Date.now() - 86400_000).first();
    if (sent.n >= FEEDBACK_PER_DAY) throw httpError("That's a lot of feedback for one day, thank you! Try again tomorrow.", 429);
    await db
      .prepare('INSERT INTO feedback (user_id, device, message, app, ua, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(user?.id ?? null, validDevice(device) ? device : null, message, String(body.app ?? '').slice(0, 20) || null, (request.headers.get('user-agent') ?? '').slice(0, 300) || null, Date.now())
      .run();
    return json({ ok: true }, 201);
  }

  if (path === '/api/feedback' && method === 'GET') {
    if (!user || !isTester(env, user)) throw httpError('Not found.', 404);
    const rows = await db
      .prepare('SELECT f.id, f.message, f.app, f.ua, f.created_at, f.closed_at, u.name, u.email FROM feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.closed_at IS NOT NULL, f.created_at DESC LIMIT 200')
      .all();
    return json({ feedback: rows.results });
  }

  // Close a piece of feedback (handled) or reopen it: { closed: true | false }. Feedback is never deleted here, so
  // nothing is lost to a stray tap. DELETE, which older copies of the app send for "Done", closes it too.
  const oneFeedback = path.match(/^\/api\/feedback\/(\d+)$/);
  if (oneFeedback && (method === 'PATCH' || method === 'DELETE')) {
    if (!user || !isTester(env, user)) throw httpError('Not found.', 404);
    const closed = method === 'DELETE' || (await readJson(request)).closed !== false;
    await db.prepare('UPDATE feedback SET closed_at = ? WHERE id = ?').bind(closed ? Date.now() : null, Number(oneFeedback[1])).run();
    return json({ ok: true, closed });
  }

  // Public knob the sign-in screen reads: whether two-factor login is on.
  if (path === '/api/config' && method === 'GET') {
    return json({
      twoFactor: { mode: twoFactorMode(env) },
    });
  }

  // ---------- Accounts ----------
  if (path === '/api/auth/signup' && method === 'POST') {
    if (!validDevice(device)) throw httpError('Missing device id. Update the app to the latest version.', 400);
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!email) throw httpError('Enter a valid email address.', 400);
    const bad = validatePassword(body.password);
    if (bad) throw httpError(bad, 400);
    // The message stays the same whether the address is taken, but the status still differs (409 vs 201),
    // so this endpoint can still tell whether an address is registered.
    if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) throw httpError('This email address is already registered.', 409);
    const { hash, salt } = await hashPassword(body.password);
    const settings = cleanSettings(body.settings ?? {});
    let row;
    try {
      row = await db
        .prepare('INSERT INTO users (email, name, pass_hash, pass_salt, settings, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
        .bind(email, cleanName(body.name, email), hash, salt, JSON.stringify(settings), Date.now())
        .first();
    } catch (e) {
      // Two sign-ups for the same address at once: the loser gets the same answer as a plain duplicate.
      if (String(e.message).includes('UNIQUE')) throw httpError('This email address is already registered.', 409);
      throw e;
    }
    await count('signups');
    return withSession(request, db, row, 201, { device, recovery: await createRecoveryCode(db, row.id) });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!email) throw httpError('Wrong email or password.', 401);
    const recent = await db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?').bind(email, Date.now() - LOGIN_WINDOW_MS).first();
    if (recent.n >= LOGIN_MAX_FAILURES) throw httpError('Too many wrong passwords. Try again in 15 minutes.', 429);
    const row = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (!row || !(await verifyPassword(String(body.password ?? ''), row.pass_hash, row.pass_salt))) {
      await db.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').bind(email, Date.now()).run();
      throw httpError('Wrong email or password.', 401);
    }
    const tf = twoFactorMode(env);
    if (tf !== 'off' && row.totp_enabled) {
      // No session yet: failures stay counted, so wrong codes lock the account like wrong passwords do.
      return json({ two_factor_required: true, challenge_id: await issueChallenge(db, row.id, 'totp') }, 202);
    }
    if (tf === 'required' && !row.totp_enabled) {
      // This account predates the requirement: set up the authenticator as the second login step.
      const secret = generateSecret();
      const challenge_id = await issueChallenge(db, row.id, 'totp_setup', secret);
      return json({ two_factor_setup_required: true, challenge_id, secret, otpauth_url: otpauthURL(secret, row.email) }, 202);
    }
    await db.prepare('DELETE FROM login_failures WHERE email = ?').bind(email).run();
    return withSession(request, db, row, 200, { device });
  }

  // A lost password shouldn't lose the account: the recovery code shown once at sign-up resets it. The answers
  // stay the same for unknown addresses, so the endpoint can't list who has an account.
  if (path === '/api/auth/recover' && method === 'POST') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const bad = validatePassword(body.password);
    if (bad) throw httpError(bad, 400);
    const row = email ? await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first() : null;
    if (!row || !(await consumeRecoveryCode(db, row.id, body.code))) throw httpError('Wrong email or recovery code.', 401);
    const { hash, salt } = await hashPassword(body.password);
    await db.batch([
      db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(hash, salt, row.id),
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.id),
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(row.id),
    ]);
    const me = await db.prepare('SELECT * FROM users WHERE id = ?').bind(row.id).first();
    return withSession(request, db, me, 200, { device });
  }

  // ---------- Two-factor authentication (TOTP authenticator apps) ----------
  if (path === '/api/auth/2fa/setup' && method === 'POST') {
    if (twoFactorMode(env) === 'off') throw httpError('Not found.', 404);
    const u = needUser();
    if (u.totp_enabled) throw httpError('Two-factor is already on for this account.', 400);
    const secret = generateSecret();
    await db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').bind(secret, u.id).run();
    return json({ secret, otpauth_url: otpauthURL(secret, u.email) });
  }

  if (path === '/api/auth/2fa/enable' && method === 'POST') {
    if (twoFactorMode(env) === 'off') throw httpError('Not found.', 404);
    const u = needUser();
    const body = await readJson(request);
    if (u.totp_enabled) throw httpError('Two-factor is already on for this account.', 400);
    if (!u.totp_secret) throw httpError('Start two-factor setup first.', 400);
    // The enabling code counts as used: it can't log in within the next minute.
    const step = await verifyTOTPStep(u.totp_secret, body.code);
    if (step == null || (u.totp_last_step != null && step <= u.totp_last_step)) {
      throw Object.assign(httpError('That code is wrong. Check your authenticator app and try again.', 401), { code: 'totp_invalid' });
    }
    const row = await db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ? RETURNING *').bind(step, u.id).first();
    return json({ ok: true, user: publicUser(row) });
  }

  if (path === '/api/auth/2fa/disable' && method === 'POST') {
    if (twoFactorMode(env) === 'off') throw httpError('Not found.', 404);
    const u = needUser();
    const body = await readJson(request);
    if (!u.totp_enabled) throw httpError('Two-factor is already off.', 400);
    const fails = await db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?').bind(u.email, Date.now() - LOGIN_WINDOW_MS).first();
    if (fails.n >= LOGIN_MAX_FAILURES) throw Object.assign(httpError('Too many wrong codes. Try again in 15 minutes.', 429), { code: 'locked_out' });
    const okCode = body.code && u.totp_secret && (await verifyTOTP(u.totp_secret, body.code));
    const okPass = body.current_password && (await verifyPassword(String(body.current_password), u.pass_hash, u.pass_salt));
    if (!okCode && !okPass) {
      // Counted like a wrong password: a borrowed session can't guess the password or codes without limit.
      await db.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').bind(u.email, Date.now()).run();
      throw httpError('Enter a current code or your password to turn it off.', 403);
    }
    await db.prepare('DELETE FROM login_failures WHERE email = ?').bind(u.email).run();
    const row = await db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ? RETURNING *').bind(u.id).first();
    return json({ ok: true, user: publicUser(row) });
  }

  // The second login step: a code from the authenticator app, for the challenge login issued.
  if (path === '/api/auth/2fa/verify' && method === 'POST') {
    if (twoFactorMode(env) === 'off') throw httpError('Not found.', 404);
    const body = await readJson(request);
    const cid = String(body.challenge_id ?? '');
    if (!/^[0-9a-f]{64}$/.test(cid)) throw httpError('That login step expired. Log in again.', 400);
    const ch = await db.prepare('SELECT * FROM auth_challenges WHERE token_hash = ?').bind(await sha256(cid)).first();
    if (!ch || ch.expires_at <= Date.now()) {
      if (ch) await db.prepare('DELETE FROM auth_challenges WHERE token_hash = ?').bind(ch.token_hash).run();
      throw httpError('That login step expired. Log in again.', 400);
    }
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(ch.user_id).first();
    if (row) {
      // Wrong codes count towards the same per-account lockout as wrong passwords — checked here too,
      // so guessing can't continue across challenges once the count is reached.
      const fails = await db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?').bind(row.email, Date.now() - LOGIN_WINDOW_MS).first();
      if (fails.n >= LOGIN_MAX_FAILURES) throw Object.assign(httpError('Too many wrong codes. Try again in 15 minutes.', 429), { code: 'locked_out' });
    }
    const secret = ch.purpose === 'totp_setup' ? ch.secret : row?.totp_secret;
    // verifyTOTPStep returns the matched 30 s step (or null), so a code can't be replayed in a later challenge.
    const step = secret ? await verifyTOTPStep(secret, body.code) : null;
    if (!row || !secret || step == null || (row.totp_last_step != null && step <= row.totp_last_step)) {
      // A wrong code counts like a wrong password: after a few, the account locks for a while,
      // and the challenge dies after a few wrong codes, so it can't be guessed one code at a time.
      await db.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').bind(row?.email ?? '', Date.now()).run();
      const attempts = (ch.attempts ?? 0) + 1;
      if (attempts >= CHALLENGE_MAX_ATTEMPTS) {
        await db.prepare('DELETE FROM auth_challenges WHERE token_hash = ?').bind(ch.token_hash).run();
        throw Object.assign(httpError('Too many wrong codes. Log in again.', 429), { code: 'totp_attempts' });
      }
      await db.prepare('UPDATE auth_challenges SET attempts = ? WHERE token_hash = ?').bind(attempts, ch.token_hash).run();
      throw Object.assign(httpError('That code is wrong. Check your authenticator app and try again.', 401), { code: 'totp_invalid' });
    }
    await db.prepare('DELETE FROM auth_challenges WHERE token_hash = ?').bind(ch.token_hash).run();
    let user = row;
    if (ch.purpose === 'totp_setup' && !row.totp_enabled) {
      user = await db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_last_step = ? WHERE id = ? RETURNING *').bind(secret, step, row.id).first();
    } else {
      user = await db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? RETURNING *').bind(step, row.id).first();
    }
    await db.prepare('DELETE FROM login_failures WHERE email = ?').bind(row.email).run();
    return withSession(request, db, user, 200, { device });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    await destroySession(db, request);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, null) });
  }

  if (path === '/api/me' && method === 'GET') {
    if (!user) return json({ user: null });
    const sessions = (
      await db.prepare('SELECT token_hash, device, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').bind(user.id).all()
    ).results.map((s) => ({ id: s.token_hash.slice(0, 12), device: s.device, last_seen: s.last_seen, current: s.token_hash === user.token_hash }));
    return json({ user: publicUser(user), stats: await reports.stats(user.id), tester: isTester(env, user), sessions });
  }

  if (path === '/api/me' && method === 'PATCH') {
    const u = needUser();
    const body = await readJson(request);
    const sets = [], args = [];
    let revokeSessions = false;
    if ('name' in body) sets.push('name = ?'), args.push(cleanName(body.name, u.email));
    for (const k of ['home', 'work']) {
      if (k in body) sets.push(`${k} = ?`), args.push(body[k] ? JSON.stringify(cleanPlace(body[k])) : null);
    }
    if ('settings' in body) sets.push('settings = ?'), args.push(JSON.stringify({ ...JSON.parse(u.settings || '{}'), ...cleanSettings(body.settings) }));
    if ('password' in body) {
      if (!(await verifyPassword(String(body.current_password ?? ''), u.pass_hash, u.pass_salt))) throw httpError('Current password is wrong.', 403);
      const bad = validatePassword(body.password);
      if (bad) throw httpError(bad, 400);
      const { hash, salt } = await hashPassword(body.password);
      sets.push('pass_hash = ?', 'pass_salt = ?'), args.push(hash, salt);
      revokeSessions = true; // a changed password signs every device out, including stolen sessions
    }
    if (!sets.length) return json({ user: publicUser(u) });
    const row = await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? RETURNING *`).bind(...args, u.id).first();
    if (revokeSessions) {
      await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id).run();
      const sess = await createSession(db, u.id, validDevice(device) ? device : null);
      return json({ user: publicUser(row) }, 200, { 'set-cookie': sessionCookie(request, sess.token, sess.expires) });
    }
    return json({ user: publicUser(row) });
  }

  // Sign one device out remotely (the list comes with /api/me).
  const sessDel = path.match(/^\/api\/me\/sessions\/([0-9a-f]{12})$/);
  if (sessDel && method === 'DELETE') {
    const u = needUser();
    const res = await db.prepare('DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 12) = ?').bind(u.id, sessDel[1]).run();
    if (!res.meta.changes) throw httpError('Session not found.', 404);
    return json({ ok: true });
  }

  if (path === '/api/me' && method === 'DELETE') {
    const u = needUser();
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
      db.prepare('DELETE FROM places WHERE user_id = ?').bind(u.id),
      db.prepare('DELETE FROM trips WHERE user_id = ?').bind(u.id),
      db.prepare('DELETE FROM votes WHERE user_id = ?').bind(u.id),
      db.prepare('DELETE FROM feedback WHERE user_id = ?').bind(u.id),
      db.prepare('DELETE FROM auth_challenges WHERE user_id = ?').bind(u.id),
      db.prepare('UPDATE reports SET removed = 1 WHERE user_id = ?').bind(u.id),
      db.prepare("UPDATE users SET email = 'deleted-' || id || '@invalid', name = 'Former driver', pass_hash = '', pass_salt = '', home = NULL, work = NULL, totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?").bind(u.id),
    ]);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, null) });
  }

  if (path === '/api/leaderboard' && method === 'GET') {
    const rows = (await db.prepare("SELECT id, name, points FROM users WHERE pass_hash != '' ORDER BY points DESC, id LIMIT 20").all()).results;
    return json({ leaders: rows.map((r) => ({ name: r.name, points: r.points, me: user?.id === r.id })) });
  }

  // ---------- Places: saved favourites and recent destinations ----------
  if (path === '/api/places' && method === 'GET') {
    const u = needUser();
    const rows = (await db.prepare('SELECT * FROM places WHERE user_id = ? ORDER BY used_at DESC LIMIT 100').bind(u.id).all()).results;
    return json({ saved: rows.filter((r) => r.kind === 'saved'), recent: rows.filter((r) => r.kind === 'recent').slice(0, RECENTS_KEPT) });
  }

  // A guest who signs up brings the places saved on this device into the new account, in one go.
  if (path === '/api/places/import' && method === 'POST') {
    const u = needUser();
    const body = await readJson(request);
    const now = Date.now();
    const have = (await db.prepare('SELECT kind, lat, lng FROM places WHERE user_id = ?').bind(u.id).all()).results;
    const near = (a, b) => Math.abs(a.lat - b.lat) < 0.0002 && Math.abs(a.lng - b.lng) < 0.0002;
    const inserts = [];
    for (const [kind, cap] of [['saved', 100], ['recent', RECENTS_KEPT]]) {
      const list = Array.isArray(body[kind]) ? body[kind].slice(0, cap) : [];
      const taken = have.filter((r) => r.kind === kind);
      list.forEach((raw, i) => {
        let p;
        try {
          p = cleanPlace(raw);
        } catch {
          return; // skip a malformed entry rather than lose the rest
        }
        if (taken.some((t) => near(t, p))) return;
        taken.push(p);
        const usedAt = Number.isFinite(Number(raw.used_at)) && Number(raw.used_at) <= now ? Number(raw.used_at) : now - i; // keep the list's order
        inserts.push(db.prepare('INSERT INTO places (user_id, kind, name, address, lat, lng, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(u.id, kind, p.name, p.address, p.lat, p.lng, usedAt));
      });
    }
    if (inserts.length) await db.batch(inserts);
    await db
      .prepare(`DELETE FROM places WHERE user_id = ? AND kind = 'recent' AND id NOT IN (SELECT id FROM places WHERE user_id = ? AND kind = 'recent' ORDER BY used_at DESC LIMIT ${RECENTS_KEPT})`)
      .bind(u.id, u.id)
      .run();
    const rows = (await db.prepare('SELECT * FROM places WHERE user_id = ? ORDER BY used_at DESC LIMIT 100').bind(u.id).all()).results;
    return json({ imported: inserts.length, saved: rows.filter((r) => r.kind === 'saved'), recent: rows.filter((r) => r.kind === 'recent').slice(0, RECENTS_KEPT) });
  }

  if (path === '/api/places' && method === 'POST') {
    const u = needUser();
    const body = await readJson(request);
    const kind = body.kind === 'saved' ? 'saved' : 'recent';
    const p = cleanPlace(body);
    const now = Date.now();
    // One row per place and kind: re-using a destination just moves it to the top.
    const existing = await db
      .prepare('SELECT id FROM places WHERE user_id = ? AND kind = ? AND ABS(lat - ?) < 0.0002 AND ABS(lng - ?) < 0.0002')
      .bind(u.id, kind, p.lat, p.lng)
      .first();
    let row;
    if (existing) {
      row = await db.prepare('UPDATE places SET used_at = ?, name = ?, address = ? WHERE id = ? RETURNING *').bind(now, p.name, p.address, existing.id).first();
    } else {
      row = await db
        .prepare('INSERT INTO places (user_id, kind, name, address, lat, lng, used_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
        .bind(u.id, kind, p.name, p.address, p.lat, p.lng, now)
        .first();
    }
    if (kind === 'recent') {
      await db
        .prepare(`DELETE FROM places WHERE user_id = ? AND kind = 'recent' AND id NOT IN (SELECT id FROM places WHERE user_id = ? AND kind = 'recent' ORDER BY used_at DESC LIMIT ${RECENTS_KEPT})`)
        .bind(u.id, u.id)
        .run();
    }
    return json({ place: row }, existing ? 200 : 201);
  }

  if (parts[1] === 'places' && parts[2] && method === 'PATCH') {
    const u = needUser();
    const body = await readJson(request);
    const name = String(body.name ?? '').trim().slice(0, 80);
    if (!name) throw httpError('Name cannot be empty.', 400);
    const row = await db.prepare('UPDATE places SET name = ? WHERE id = ? AND user_id = ? RETURNING *').bind(name, Number(parts[2]), u.id).first();
    if (!row) throw httpError('Place not found.', 404);
    return json({ place: row });
  }

  if (parts[1] === 'places' && parts[2] && method === 'DELETE') {
    const u = needUser();
    await db.prepare('DELETE FROM places WHERE id = ? AND user_id = ?').bind(Number(parts[2]), u.id).run();
    return json({ ok: true });
  }

  // ---------- Search and routing ----------
  if (path === '/api/search' && method === 'GET') {
    await needSpot();
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    if (q.length < 2) return json({ places: [] });
    await count('searches');
    // Round the location to ~1 km so nearby people typing the same thing share a cached answer.
    const round = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN);
    const lat = round(num(url, 'lat')), lng = round(num(url, 'lng'));
    const lang = cleanLang(url.searchParams.get('lang'));
    const parking = await searchParking(env, q, num(url, 'lat'), num(url, 'lng'), lang).catch(() => null);
    if (parking) return parking;
    const key = new Request(`https://cache.a2b/search?q=${encodeURIComponent(q.toLowerCase())}&lat=${lat}&lng=${lng}&lang=${lang}`);
    const cache = globalThis.caches?.default;
    const hit = cache && (await cache.match(key));
    if (hit) return hit;
    const res = json(await searchPlaces(env, { q, lat, lng, lang }), 200, { 'cache-control': 'public, max-age=600' });
    if (cache) await cache.put(key, res.clone());
    return res;
  }

  if (path === '/api/parking' && method === 'GET') {
    await needSpot();
    const lat = num(url, 'lat'), lng = num(url, 'lng');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError('lat and lng are required.', 400);
    // Car parks don't move: share answers for the same spot (to ~100 m) for a day.
    const key = new Request(`https://cache.a2b/parking?lat=${lat.toFixed(3)}&lng=${lng.toFixed(3)}`);
    const cache = globalThis.caches?.default;
    const hit = cache && (await cache.match(key));
    if (hit) return hit;
    const res = json({ parking: await parkingNear(env, [lng, lat]) }, 200, { 'cache-control': 'public, max-age=86400' });
    if (cache) await cache.put(key, res.clone());
    return res;
  }

  // EV chargers (src/lib/chargers.js): all of them, a few hundred small rows, for the phone to search and draw. Only
  // the nightly job fills the table, never a request: a whole-country Overpass download takes up to a minute, and
  // drivers asking at once would each start one. Until the first run the list is empty (the phone still has
  // Overture's chargers), and phones ask again sooner.
  if (path === '/api/chargers' && method === 'GET') {
    await needSpot();
    const chargers = await allChargers(db);
    return json({ chargers }, 200, { 'cache-control': `private, max-age=${chargers.length ? 3600 : 600}` });
  }

  if (path === '/api/reverse' && method === 'GET') {
    await needSpot();
    const lat = num(url, 'lat'), lng = num(url, 'lng');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError('lat and lng are required.', 400);
    return json({ place: await reverseGeocode(env, { lat, lng }) });
  }

  // Trips by train (LRT, MRT, Monorail, BRT, KTM Komuter): see src/lib/transit.js.
  if (path === '/api/transit' && method === 'POST') {
    await needSpot();
    const body = await readJson(request);
    const from = lngLat(body.from), to = lngLat(body.to);
    if (!from || !to) throw httpError('A trip needs a start and a destination.', 400);
    const at = Number.isFinite(body.at) && Math.abs(body.at - Date.now()) < 7 * 86400_000 ? body.at : Date.now();
    // Moving along a line (a phone on a train): the trip starts on that train.
    const m = body.moving;
    const moving = m && Number.isFinite(m.speed) && Number.isFinite(m.heading) ? { speed: m.speed, heading: m.heading } : null;
    const plan = await withRealWalks(env, planTransit(from, to, at, { moving }));
    await count('routes'); // with driving and walking routes
    return json(plan);
  }

  if (path === '/api/route' && method === 'POST') {
    await needSpot();
    const body = await readJson(request);
    const from = lngLat(body.from), to = lngLat(body.to);
    if (!from || !to) throw httpError('Route needs a start and a destination.', 400);
    // On foot, the driving extras (closures, roadworks, speed limits, tolls, traffic, cameras) don't apply.
    const walk = body.travel === 'walk';
    const via = (Array.isArray(body.via) ? body.via : []).slice(0, 3).map(lngLat).filter(Boolean);
    const area = corridorBox([from, ...via, to]);
    const exclude = walk || body.avoid_closures === false ? [] : await reports.closuresNear(area);
    const opts = {
      from, to, via, exclude,
      avoid: body.avoid ?? {},
      units: body.units === 'imperial' ? 'imperial' : 'metric',
      lang: typeof body.lang === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.lang) ? body.lang : 'en-US',
      heading: Number(body.heading),
      travel: walk ? 'walk' : 'drive',
    };
    const first = await fetchRoutes(env, opts);
    if (walk) {
      const { routes } = first;
      for (const r of routes) {
        delete r.shapes;
        Object.assign(r, { travel: 'walk', limits: null, tolls: [], cameras: [], reports: [], delay: 0 });
      }
      routes.sort((a, b) => a.duration - b.duration);
      await count('routes');
      return json({ routes, closures_avoided: 0, closures_ignored: false, construction_avoided: 0 });
    }
    let { routes } = first;
    const closuresIgnored = first.dropped;
    // A route along a road that's probably still being built (see construction.js): ask again around it, and
    // take the new routes unless they're a lot slower. Kept routes that still use one carry a warning.
    let constructionAvoided = 0;
    let twins = await constructionTwins(env.ASSETS, routes).catch(() => routes.map(() => []));
    const spots = twins.flat().slice(0, MAX_EXCLUDE - exclude.length);
    if (spots.length && !closuresIgnored) {
      const again = await fetchRoutes(env, { ...opts, exclude: [...exclude, ...spots] }).catch(() => null);
      const fastest = (rs) => Math.min(...rs.map((r) => r.duration));
      if (again && !again.dropped && fastest(again.routes) <= fastest(routes) * 1.5 + 300) {
        routes = again.routes;
        constructionAvoided = spots.length;
        twins = await constructionTwins(env.ASSETS, routes).catch(() => routes.map(() => []));
      }
    }
    routes.forEach((r, i) => {
      if (twins[i]?.length) r.warning = 'construction';
    });
    const routeArea = routeReportBox(routes, [from, to]);
    const [live, probeSegs] = await Promise.all([
      reports.inBox(routeArea, user?.id),
      // Congested blocks from opted-in drivers; a slow lookup never holds up the route.
      probesRepo(db).congested(routeArea).catch(() => []),
      // Speed limits and toll plazas are nice-to-haves: a slow or failing lookup never holds up the route.
      ...routes.map(async (r) => {
        const a = await fetchRouteAttributes(env, r.shapes, r.coords).catch(() => null);
        r.limits = a?.limits ?? null;
        r.tolls = (a?.tolls ?? []).map((at) => ({ at }));
        r.tunnels = a?.tunnels ?? [];
      }),
      // Live traffic, when TomTom is set up: the route's time with today's traffic, and where the jams are.
      ...routes.map(async (r) => {
        if (!env.TOMTOM_KEY) return;
        const [, traffic] = await Promise.all([count('tomtom'), liveTraffic(env, r).catch(() => null)]);
        applyTraffic(r, traffic);
      }),
      // Fixed speed cameras on each route, from the built list.
      loadCameras(env.ASSETS)
        .catch(() => [])
        .then((cams) => routes.forEach((r) => (r.cameras = camerasAlong(r.coords, cams)))),
    ]);
    for (const r of routes) delete r.shapes;
    const plazas = routes.flatMap((r) => r.tolls.map((t) => [t, r.coords[t.at]]));
    const details = await plazaDetails(db, plazas.map(([, p]) => p)).catch(() => []);
    plazas.forEach(([t], i) => Object.assign(t, details[i] ?? {}));
    annotateWithReports(routes, live);
    annotateWithProbes(routes, probeSegs, routeArea);
    routes.sort((a, b) => a.duration - b.duration);
    await count('routes');
    return json({ routes, closures_avoided: closuresIgnored ? 0 : exclude.length, closures_ignored: closuresIgnored, construction_avoided: constructionAvoided });
  }

  // ---------- Reports ----------
  if (path === '/api/reports' && method === 'GET') {
    const box = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
    if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) throw httpError('bbox=west,south,east,north is required.', 400);
    const [w, s, e, n] = box;
    // Very zoomed-out views would return the whole world; clamp to a sane area around the centre.
    const cx = (w + e) / 2, cy = (s + n) / 2;
    const hw = Math.min((e - w) / 2, 1.5), hh = Math.min((n - s) / 2, 1);
    return json({ reports: await reports.inBox([cx - hw, cy - hh, cx + hw, cy + hh], user?.id), now: Date.now() });
  }

  if (path === '/api/reports' && method === 'POST') {
    const u = needUser();
    const body = await readJson(request);
    const reporterAt = await lastPosition(db, u.id);
    return json(await reports.create(u, body, { roadAt: (p, heading) => roadMidpoint(env, p, heading), reporterAt }), 201);
  }

  if (parts[1] === 'reports' && parts[3] === 'vote' && method === 'POST') {
    const u = needUser();
    const body = await readJson(request);
    return json(await reports.vote(u, Number(parts[2]), body.vote));
  }

  // ---------- Opt-in probe traffic ----------
  // Small batches of recent speed fixes from drivers who switched it on. Each batch must repeat the
  // consent flag; the fixes are folded into anonymous block totals and never stored. Guests may
  // contribute too: only the device id (hashed, for rate limiting) is needed, never an account.
  if (path === '/api/probe' && method === 'POST') {
    if (!validDevice(device)) throw httpError('Missing device id.', 400);
    await needSpot(); // writes only come from checked-in devices, like every other upstream- or DB-heavy endpoint
    const body = await readJson(request);
    if (body.consent !== true) throw httpError('Probe sharing needs consent: switch it on in Settings first.', 403);
    const { stored } = await probesRepo(db).contribute(await sha256(device), body.points);
    return json({ ok: true, stored }, 202);
  }

  // ---------- Shared drives (live ETA link) ----------
  if (path === '/api/trips' && method === 'POST') {
    const u = needUser();
    const body = await readJson(request);
    const dest = cleanPlace(body.destination ?? {});
    const token = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await db
      .prepare('INSERT INTO trips (token, user_id, dest_name, dest_lat, dest_lng, eta, route, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(token, u.id, dest.name, dest.lat, dest.lng, Number(body.eta) || null, JSON.stringify(simplify(body.route ?? [])), Date.now())
      .run();
    return json({ token, url: new URL(`/drive/${token}`, url).toString() }, 201);
  }

  if (parts[1] === 'trips' && parts[2] && method === 'PATCH') {
    const u = needUser();
    const body = await readJson(request);
    const sets = ['updated_at = ?'], args = [Date.now()];
    const pos = lngLat(body.position);
    if (pos) sets.push('lng = ?', 'lat = ?'), args.push(pos[0], pos[1]);
    if (Number.isFinite(Number(body.heading))) sets.push('heading = ?'), args.push(Number(body.heading));
    if (Number.isFinite(Number(body.eta))) sets.push('eta = ?'), args.push(Number(body.eta));
    if (Array.isArray(body.route)) sets.push('route = ?'), args.push(JSON.stringify(simplify(body.route)));
    // ended: 'arrived' (1) or 'stopped' (2, the driver stopped sharing). Stopping also forgets where they were.
    if (body.ended === 'stopped') sets.push('ended = 2', 'lat = NULL', 'lng = NULL', 'heading = NULL', "route = '[]'");
    else if (body.ended) sets.push('ended = 1');
    const res = await db
      .prepare(`UPDATE trips SET ${sets.join(', ')} WHERE token = ? AND user_id = ? AND ended = 0`)
      .bind(...args, parts[2], u.id)
      .run();
    if (!res.meta.changes) throw httpError('Drive not found.', 404);
    return json({ ok: true });
  }

  if (parts[1] === 'trips' && parts[2] && method === 'GET') {
    const t = await db
      .prepare('SELECT t.*, u.name AS driver FROM trips t JOIN users u ON u.id = t.user_id WHERE t.token = ?')
      .bind(parts[2])
      .first();
    if (!t || Date.now() - t.updated_at > 12 * 3600_000) throw httpError('This drive has ended or the link is wrong.', 404);
    return json({
      driver: t.driver,
      destination: { name: t.dest_name, lat: t.dest_lat, lng: t.dest_lng },
      position: t.lat == null ? null : { lat: t.lat, lng: t.lng, heading: t.heading },
      eta: t.eta,
      route: JSON.parse(t.route || '[]'),
      updated_at: t.updated_at,
      ended: Boolean(t.ended),
      stopped: t.ended === 2,
      now: Date.now(), // lets viewers line their clock up with updated_at
    });
  }

  throw httpError('Not found.', 404);
}

async function withSession(request, db, row, status, { device = null, recovery = null } = {}) {
  const { token, expires } = await createSession(db, row.id, validDevice(device) ? device : null);
  const body = { user: publicUser(row) };
  if (recovery) body.recovery_code = recovery; // shown once: there is no other way to see it again
  return json(body, status, { 'set-cookie': sessionCookie(request, token, expires) });
}

// The first half of a two-factor login: the app answers with the code for this challenge id.
async function issueChallenge(db, userId, purpose, secret = null) {
  const token = randomToken(32);
  const now = Date.now();
  await db
    .prepare('INSERT INTO auth_challenges (token_hash, user_id, purpose, secret, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256(token), userId, purpose, secret, now, now + CHALLENGE_TTL_MS)
    .run();
  return token;
}

// The driver's last shared-drive position, when it's fresh: what "around you" means for a report.
async function lastPosition(db, userId) {
  const t = await db
    .prepare('SELECT lng, lat FROM trips WHERE user_id = ? AND lat IS NOT NULL AND updated_at > ? ORDER BY updated_at DESC LIMIT 1')
    .bind(userId, Date.now() - 30 * 60_000)
    .first();
  return t ? [t.lng, t.lat] : null;
}

// Cache keys are built from this, so it has to be URL-safe: letters and dashes only.
function cleanLang(v) {
  return ((v ?? 'en').match(/[a-zA-Z-]+/)?.[0] ?? 'en').slice(0, 5);
}

// Testing tools (demo drive) are for the accounts listed in the TESTER_EMAILS secret, comma separated
// (`wrangler secret put TESTER_EMAILS`), so the addresses never ship in the code.
// A search for parking (see parkingQuery): the car parks around the place named, or around the searcher, and
// where that is, so the app can add the parking it knows from Overture. Null when it isn't a search for parking,
// or the place named isn't found, so the ordinary search answers instead.
async function searchParking(env, q, lat, lng, lang) {
  const area = parkingQuery(q);
  if (area == null) return null;
  const here = Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
  let at = here, from = null;
  if (area) {
    const { places } = await searchPlaces(env, { q: area, lat, lng, lang });
    // A mall or venue before a station of the same name ("Mid Valley"), as the app ranks them.
    const place = ['place', 'area'].map((k) => places.find((p) => p.landmark === k)).find(Boolean) ?? places[0];
    if (!place) return null;
    at = [place.lng, place.lat];
    from = place.name;
  }
  if (!at) return null;
  // Car parks don't move: share answers for the same spot (to ~100 m) for a day.
  const key = new Request(`https://cache.a2b/search-parking/2?at=${at.map((v) => v.toFixed(3)).join(',')}&from=${encodeURIComponent(from ?? '')}`);
  const cache = globalThis.caches?.default;
  const hit = cache && (await cache.match(key));
  if (hit) return hit;
  const places = await parkingResults(env, at, from);
  const res = json({ places, parking: { lng: at[0], lat: at[1], from } }, 200, { 'cache-control': 'public, max-age=86400' });
  if (cache) await cache.put(key, res.clone());
  return res;
}

const FEEDBACK_MAX = 2000; // characters
const FEEDBACK_PER_DAY = 10; // per account, or per device without one

function isTester(env, user) {
  const list = String(env.TESTER_EMAILS ?? '').split(',').map((e) => normalizeEmail(e)).filter(Boolean);
  return list.includes(normalizeEmail(user.email));
}

function cleanSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, rule] of Object.entries(SETTINGS_KEYS)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (rule === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(rule) && rule.includes(v)) out[k] = v;
  }
  return out;
}

function cleanPlace(p) {
  const lat = Number(p.lat), lng = Number(p.lng);
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw httpError('Place needs a valid location.', 400);
  return { name: String(p.name ?? 'Place').trim().slice(0, 80) || 'Place', address: String(p.address ?? '').trim().slice(0, 200), lat, lng };
}

function lngLat(v) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const [lng, lat] = v.map(Number);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lng, lat] : null;
}

// Keeps shared routes small: at most ~400 points.
function simplify(coords) {
  const pts = coords.map(lngLat).filter(Boolean);
  const step = Math.max(1, Math.ceil(pts.length / 400));
  const out = pts.filter((_, i) => i % step === 0);
  if (pts.length && out.at(-1) !== pts.at(-1)) out.push(pts.at(-1));
  return out.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);
}

function num(url, key) {
  const v = url.searchParams.get(key);
  return v == null || v === '' ? NaN : Number(v);
}

async function readJson(request) {
  // Requiring a JSON content type also blocks cross-site form posts (they can't set it without CORS).
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw httpError('Body must be JSON.', 415);
  const text = await request.text();
  if (text.length > MAX_BODY) throw httpError('Request too large.', 413);
  try {
    const data = JSON.parse(text || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw httpError('Body must be JSON.', 400);
    return data;
  } catch (e) {
    if (e.status) throw e;
    throw httpError('Body must be JSON.', 400);
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
