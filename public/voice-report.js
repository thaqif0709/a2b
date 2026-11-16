// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Hands-free reporting: say "report police" (or another type) while driving, no touching the phone.
// matchReportPhrase is pure (no DOM), so it runs in tests; VoiceReporter wraps the browser's speech recognition.

// Words a driver might actually say for each report type, beyond its own label.
const SYNONYMS = {
  traffic: ['traffic', 'jam', 'congestion'],
  police: ['police', 'cops'],
  crash: ['crash', 'accident'],
  hazard: ['hazard', 'pothole', 'object', 'debris'],
  lane: ['lane', 'blocked lane'],
  closure: ['closure', 'closed', 'road closed'],
  camera: ['camera', 'speed camera', 'aes'],
};

// text: whatever the recognizer heard. Returns a report type key, or null if nothing matched.
export function matchReportPhrase(text) {
  const heard = text.toLowerCase().replace(/[^a-z ]/g, ' ');
  if (!/\breport\b/.test(heard)) return null;
  for (const [key, words] of Object.entries(SYNONYMS)) {
    if (words.some((w) => heard.includes(w))) return key;
  }
  return null;
}

// Keeps listening for "report ..." while driving, restarting after each result or silence timeout.
// onMatch(key) fires with a report type key; onError(message) fires on a permission or support problem.
export class VoiceReporter {
  constructor({ onMatch, onError }) {
    this.onMatch = onMatch;
    this.onError = onError;
    this.recognition = null;
    this.wanted = false;
  }

  start() {
    this.wanted = true;
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return this.onError?.('Voice reporting needs a browser with speech recognition.');
    const r = new Recognition();
    r.continuous = false;
    r.interimResults = false;
    r.lang = 'en-MY';
    r.onresult = (e) => {
      const key = matchReportPhrase(e.results[e.results.length - 1][0].transcript);
      if (key) this.onMatch?.(key);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wanted = false;
        this.onError?.('Microphone permission is needed for voice reporting.');
      }
      // 'no-speech' and similar are routine while driving quietly; onend restarts listening.
    };
    r.onend = () => this.wanted && this.restart();
    this.recognition = r;
    r.start();
  }

  restart() {
    try {
      this.recognition?.start();
    } catch {
      // Already running, or the tab lost focus: onend will try again.
    }
  }

  stop() {
    this.wanted = false;
    this.recognition?.stop();
    this.recognition = null;
  }
}
