// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Keeps the screen on whenever A2B is on screen: people glance at the map, plan a route or drive, and the phone going
// dark mid-glance is annoying (and unsafe while driving).
//
// The Screen Wake Lock is asked for first. The browser drops it whenever the page is hidden (and on low battery), so
// it's asked for again when A2B comes back and on the next tap. Where the lock can't work, the old trick takes over:
// a tiny, silent, muted video looping out of sight counts as "something is playing", so the phone stays awake.
// That is needed on iPhones running A2B from the home screen before iOS 18.4 (the lock "succeeds" there but does
// nothing), on browsers without the lock, and whenever the lock is refused (Low Power Mode, battery saver).

// 2 s of a black 64×64 frame with a silent audio track (made with ffmpeg), inline so it needs no network or cache.
const VIDEO = 'data:video/mp4;base64,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';

const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const HOME_SCREEN = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

let lock = null;
let refused = !('wakeLock' in navigator);
let video = null;

export async function requestWakeLock() {
  if (document.visibilityState !== 'visible') return;
  if ('wakeLock' in navigator && !(lock && !lock.released)) {
    try {
      lock = await navigator.wakeLock.request('screen');
      refused = false;
    } catch {
      refused = true; // asked again next time: Low Power Mode may have been switched off
    }
  }
  if (refused || (IOS && HOME_SCREEN)) playVideo();
  else video?.pause(); // the lock works: no need to keep a video running
}

function playVideo() {
  if (!video) {
    video = document.createElement('video');
    video.muted = true; // never takes the phone's audio, so music and spoken directions carry on
    video.loop = true;
    video.playsInline = true;
    for (const a of ['muted', 'playsinline', 'loop']) video.setAttribute(a, '');
    video.setAttribute('aria-hidden', 'true');
    video.src = VIDEO;
    video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.append(video);
  }
  if (video.paused) video.play().catch(() => {}); // some phones only allow it from a tap: the next one starts it
}

export function keepScreenOn() {
  requestWakeLock();
  for (const type of ['pointerdown', 'click']) document.addEventListener(type, requestWakeLock, { passive: true });
  document.addEventListener('visibilitychange', requestWakeLock);
}
