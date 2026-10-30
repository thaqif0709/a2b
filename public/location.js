// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// A transient error does not end a geolocation watch: keep accepting its fixes, especially on tunnel exit.
// Replace it only when retrying the first acquisition; reject callbacks from watches actually replaced.
export function createLocationWatch({ geolocation, onFix, onState, setTimer = setTimeout, clearTimer = clearTimeout,
  retryMs = 15_000, accuracyLimit = 80, hasPosition = () => false }) {
  let watchId = null, retryTimer = null, generation = 0, active = false, status = 'idle', receivedPosition = false;
  const report = (next) => {
    if (status === next) return;
    status = next;
    onState(next);
  };
  const cancelRetry = () => {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  };
  const stop = () => {
    generation++;
    active = false;
    cancelRetry();
    if (watchId !== null) geolocation.clearWatch(watchId);
    watchId = null;
  };
  const start = () => {
    if (active) return;
    cancelRetry();
    if (!geolocation?.watchPosition) return report('unsupported');
    const token = ++generation;
    active = true;
    report('acquiring');
    const current = () => active && token === generation;
    const fail = (error) => {
      if (!current()) return;
      const next = error?.code === 1 ? 'denied' : error?.code === 3 ? 'timeout' : 'unavailable';
      report(next);
      if (next === 'denied') { stop(); return; } // only a deliberate retry may ask again
      if (receivedPosition || hasPosition() || retryTimer !== null) return;
      const retryToken = generation;
      retryTimer = setTimer(() => {
        if (retryToken !== generation) return;
        retryTimer = null;
        if (receivedPosition || hasPosition()) return;
        stop(); // replace only now: the old watch remained usable throughout the wait
        start();
      }, retryMs);
    };
    try {
      const id = geolocation.watchPosition((position) => {
        if (!current()) return;
        const { longitude, latitude, accuracy } = position.coords ?? {};
        if (!Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
            !Number.isFinite(accuracy) || accuracy < 0) return fail({ code: 2 });
        receivedPosition = true;
        cancelRetry();
        report(accuracy > accuracyLimit ? 'inaccurate' : 'ready');
        onFix(position);
      }, fail, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
      // Also handles an implementation that calls back synchronously before returning its watch ID.
      if (current()) watchId = id;
      else geolocation.clearWatch(id);
    } catch {
      fail({ code: 2 });
    }
  };
  return { start, stop, get status() { return status; } };
}

export function locationMessage(status) {
  return {
    acquiring: 'Finding your location…',
    denied: 'Location permission is off. Allow location for this site in your browser settings, then try again.',
    timeout: 'Finding your location took too long. Still listening for GPS.',
    unavailable: 'Your location is temporarily unavailable. Still listening for GPS.',
    inaccurate: 'Location signal is weak. Waiting for a more accurate fix.',
    unsupported: 'This browser cannot provide location. You can still plan from the map.',
  }[status] ?? '';
}
