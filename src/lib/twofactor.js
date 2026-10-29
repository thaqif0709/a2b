// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Optional two-factor authentication (TOTP, RFC 6238: SHA-1, 30 s step, 6 digits).
// No dependencies: HMAC comes from WebCrypto, so this runs on Workers and in plain node --test.
// Admin knob: TWO_FACTOR=off | optional | required (see wrangler.toml and .dev.vars.example).

const STEP_MS = 30_000;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(bytes = 20) {
  const rnd = crypto.getRandomValues(new Uint8Array(bytes));
  let out = '';
  let bits = 0, value = 0;
  for (const b of rnd) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) out += B32[(value >>> (bits - 5)) & 31], bits -= 5;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function decodeSecret(secret) {
  const s = String(secret ?? '').toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  const out = [];
  let bits = 0, value = 0;
  for (const c of s) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) out.push((value >>> (bits - 8)) & 255), bits -= 8;
  }
  return new Uint8Array(out);
}

export function otpauthURL(secret, email, issuer = 'A2B') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

async function hotp(secretBytes, counter) {
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(counter & 0xffn);
    counter >>= 8n;
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = mac[mac.length - 1] & 0x0f;
  const code = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

export async function totpCode(secret, at = Date.now()) {
  return hotp(decodeSecret(secret), BigInt(Math.floor(at / STEP_MS)));
}

// Accepts codes from the neighbouring time steps (window=1) so slight clock drift doesn't lock people out.
// Returns the matched 30 s step, or null: the caller records it so a code can't be replayed in a later challenge.
export async function verifyTOTPStep(secret, code, { window = 1, at = Date.now() } = {}) {
  const c = String(code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{6,8}$/.test(c)) return null;
  const short = c.slice(-6);
  const step = Math.floor(at / STEP_MS);
  const bytes = decodeSecret(secret);
  if (!bytes.length) return null;
  for (let d = -window; d <= window; d++) {
    if ((await hotp(bytes, BigInt(step + d))) === short) return step + d;
  }
  return null;
}

export async function verifyTOTP(secret, code, opts) {
  return (await verifyTOTPStep(secret, code, opts)) != null;
}

export function twoFactorMode(env) {
  const v = String(env.TWO_FACTOR ?? 'off').trim().toLowerCase();
  if (['off', 'false', 'disabled', 'no'].includes(v)) return 'off';
  if (['required', 'require', 'enforced', 'mandatory'].includes(v)) return 'required';
  return 'optional';
}
