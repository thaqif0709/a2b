// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// First visit: a short welcome (what A2B is, that it's a beta, and how to put it on the home screen), shown
// once per device. Its "Let's go" is what asks for location, so the browser's prompt doesn't land on top of it.
// It's where a driver first picks English or Bahasa Melayu (Settings has it too).
// Also hides the launch splash once the map is ready.

import { $, local, saveSettings } from './core.js';
import { LANGUAGES, tr, currentLang, useLang } from './i18n.js';

const SHARE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M8 10H6v10h12V10h-2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// done(): called once the driver is through (straight away for people who've seen it before).
export function welcome(done) {
  if (local.get('welcomed', false)) return done();
  const showInstall = () => ($('welcome-install').innerHTML = installed()
    ? ''
    : isIos()
      ? tr('<b>Use it like an app:</b> in Safari, tap Share <span class="w-ic">{icon}</span>, then <b>Add to Home Screen</b>, keep <b>Open as Web App</b> on, and open A2B from its new icon.', { icon: SHARE_ICON })
      : tr('<b>Use it like an app:</b> in Chrome, tap ⋮, then <b>Add to home screen</b> (or <b>Install app</b>), and open A2B from its new icon.'));
  const langs = $('welcome-lang');
  langs.innerHTML = LANGUAGES.map((l) => `<button data-lang="${l.code}" lang="${l.code}">${l.name}</button>`).join('');
  const markLang = () => langs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.lang === currentLang()));
  langs.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    saveSettings({ lang: b.dataset.lang });
    await useLang(b.dataset.lang);
    markLang();
    showInstall();
  };
  showInstall();
  markLang();
  $('welcome').classList.remove('hidden');
  $('welcome-go').onclick = () => {
    local.set('welcomed', true);
    $('welcome').classList.add('hidden');
    done();
  };
}

export function hideSplash() {
  const s = $('splash');
  if (!s || s.classList.contains('out')) return;
  s.classList.add('out');
  setTimeout(() => s.remove(), 400);
}
