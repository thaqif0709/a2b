// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Spoken directions, read by the phone's own speech voices (speechSynthesis): offline, no download.
// One voice for now: Daniel (British English, built into iPhones, iPads and Macs), the most natural-sounding of
// the built-in ones. Phones without him, like Android ones, use their best-sounding English voice.

import { state } from './core.js';
import { spokenCodes } from './nav.js';

const QUALITY = /premium|enhanced|natural|neural|siri|wavenet|online/i;

// The voice directions are read in, or null when the phone has none.
export function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  const better = (a, b) => QUALITY.test(b.name) - QUALITY.test(a.name);
  const daniel = voices.filter((v) => /\bdaniel\b/i.test(v.name)).sort(better)[0];
  if (daniel) return daniel;
  const lang = (navigator.language || 'en-US').toLowerCase();
  const score = (v) => (v.lang.toLowerCase().replace('_', '-') === lang ? 4 : 0) + (QUALITY.test(v.name) ? 6 : 0) + (/google/i.test(v.name) ? 3 : 0) + (v.default ? 1 : 0);
  return voices.sort((a, b) => score(b) - score(a))[0] ?? null;
}

// Directions should play over the driver's music, not stop it. By default an iPhone gives a page that makes sound
// the main audio, which pauses Spotify or Apple Music and leaves it paused. Safari's Audio Session API (iOS 17 and
// later) lets a page say its sounds are short: 'transient' plays them on top of whatever else is playing.
// Older iPhones and other browsers don't have it and keep their own behaviour.
if (typeof navigator !== 'undefined' && navigator.audioSession) {
  try {
    navigator.audioSession.type = 'transient';
  } catch {}
}

// Voice lists load late on some browsers; ask early so the first direction has them.
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  speechSynthesis.getVoices();
  speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices());
  // iPhones and iPads (Safari, and Chrome there, which is Safari underneath) only let a page talk once it has spoken
  // during a tap. A drive that starts by itself after its countdown would otherwise stay silent the whole way, so
  // the first tap anywhere says something silent to unlock the voice for the rest of the visit.
  const unlock = () => {
    try {
      if (speechSynthesis.speaking || speechSynthesis.pending) return remove(); // this tap already spoke (Start)
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {}
    remove();
  };
  // Listening on the document, after the tap's own handlers, so a button that speaks goes first.
  const remove = () => { for (const type of ['touchend', 'click']) document.removeEventListener(type, unlock); };
  for (const type of ['touchend', 'click']) document.addEventListener(type, unlock, { passive: true });
}

// For as long as the phone is talking, other sound (radio, music, a video) shouldn't be stopped outright:
// lower it, then put it back the moment the voice finishes.
function duckedMedia() {
  const els = [...document.querySelectorAll('audio, video')];
  const saved = els.map((el) => ({ el, volume: el.volume, muted: el.muted }));
  for (const { el } of saved) { if (!el.muted) el.volume = Math.max(0.05, el.volume * 0.2); }
  let done = false;
  const restore = () => {
    if (done) return; done = true;
    for (const { el, volume, muted } of saved) { el.volume = volume; if (muted !== el.muted) el.muted = muted; }
  };
  return restore;
}

export function speak(text, { force = false } = {}) {
  if (!text || (!state.settings.voice && !force) || !('speechSynthesis' in window)) return;
  try {
    const v = pickVoice();
    const u = new SpeechSynthesisUtterance(spokenCodes(text));
    if (v) u.voice = v;
    u.lang = v?.lang || 'en-GB';
    const restoreMedia = duckedMedia();
    const ms = Math.max(1500, spokenCodes(text).length * 75); // Android/Safari sometimes skip onend
    const timer = setTimeout(restoreMedia, ms);
    const finish = () => { clearTimeout(timer); restoreMedia(); };
    u.onend = finish;
    u.onerror = finish;
    // Cancel only what's actually talking: on iPhones a cancel straight before speak can drop the new line too.
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    speechSynthesis.resume(); // iOS can leave speech paused after the app was in the background
    speechSynthesis.speak(u);
  } catch {}
}
