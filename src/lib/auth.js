// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Accounts: PBKDF2 password hashes and random session tokens (only their SHA-256 is stored).

const ITERATIONS = 100_000; // the most Workers' WebCrypto allows for PBKDF2
const SESSION_DAYS = 30; // a fresh sign-in lasts this long; drivers who keep using the app slide up to the cap
const SESSION_MAX_DAYS = 60; // ...but never past this, however active they are
const SESSION_TOUCH_MS = 3600_000; // the last-seen stamp is rewritten this often at most, to spare D1 writes
export const COOKIE = 'a2b_session';

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// Opaque tokens handed to the browser (email links, 2FA challenges). Only their SHA-256 is stored.
export function randomToken(bytes = 32) {
  return randomHex(bytes);
}

export async function hashPassword(password, saltHex = randomHex(16)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/../g), (h) => parseInt(h, 16));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return { hash: toHex(bits), salt: saltHex };
}

export async function verifyPassword(password, hash, salt) {
  const got = (await hashPassword(password, salt)).hash;
  let diff = got.length ^ hash.length;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export async function sha256(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function normalizeEmail(email) {
  const e = String(email ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200 ? e : null;
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

export function cleanName(name, email) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return n || String(email).split('@')[0].slice(0, 40);
}

export async function createSession(db, userId, device = null) {
  const token = randomHex(32);
  const now = Date.now();
  const expires = now + SESSION_DAYS * 86400_000;
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, device, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256(token), userId, device ?? null, now, now, expires)
    .run();
  return { token, expires };
}

export function readCookie(request, name = COOKIE) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export async function currentUser(db, request) {
  const token = readCookie(request);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const hash = await sha256(token);
  const row = await db
    .prepare('SELECT u.*, s.token_hash, s.device AS session_device, s.created_at AS session_created, s.last_seen AS session_seen, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .bind(hash, Date.now())
    .first();
  if (!row) return null;
  // Sliding sessions: a driver who keeps using the app stays signed in, up to the hard cap; sessions from
  // before this change have no creation stamp and simply run out. The last-seen stamp moves at most hourly.
  const now = Date.now();
  if (row.session_expires - now < (SESSION_DAYS / 2) * 86400_000 && row.session_created > 0 && now - row.session_created < SESSION_MAX_DAYS * 86400_000) {
    row.session_expires = Math.min(now + SESSION_DAYS * 86400_000, row.session_created + SESSION_MAX_DAYS * 86400_000);
    await db.prepare('UPDATE sessions SET expires_at = ?, last_seen = ? WHERE token_hash = ?').bind(row.session_expires, now, hash).run();
    row.session_seen = now;
  } else if (now - (row.session_seen ?? 0) > SESSION_TOUCH_MS) {
    await db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(now, hash).run();
    row.session_seen = now;
  }
  return row;
}

export async function destroySession(db, request) {
  const token = readCookie(request);
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

// Losing a password shouldn't lose the account: a recovery code is shown once at sign-up (the driver writes
// it down) and resets the password later. Only its hash is stored, each code works once, and using it signs
// every device out — same as changing the password.
export async function createRecoveryCode(db, userId) {
  const code = toHex(crypto.getRandomValues(new Uint8Array(8)));
  await db
    .prepare(
      `INSERT INTO recovery_codes (user_id, code_hash, created_at, used) VALUES (?, ?, ?, 0)
       ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at, used = 0`,
    )
    .bind(userId, await sha256(code), Date.now())
    .run();
  return code;
}

export async function consumeRecoveryCode(db, userId, code) {
  const row = await db.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').bind(userId).first();
  if (!row || row.used) return false; // no expiry: a code from sign-up day still works in month three
  if ((await sha256(String(code ?? ''))) !== row.code_hash) return false;
  await db.prepare('UPDATE recovery_codes SET used = 1 WHERE user_id = ?').bind(userId).run();
  return true;
}

export function sessionCookie(request, token, expires) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  if (!token) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expires).toUTCString()}${secure}`;
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    points: u.points,
    totp_enabled: u.totp_enabled === 1,
    home: u.home ? JSON.parse(u.home) : null,
    work: u.work ? JSON.parse(u.work) : null,
    settings: JSON.parse(u.settings || '{}'),
    created_at: u.created_at,
  };
}
