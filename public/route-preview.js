// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Place names are untrusted text. Keep the decorative spinner separate from the message.
export function showRouteLoading(element, message) {
  const spinner = element.ownerDocument.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  element.replaceChildren(spinner, element.ownerDocument.createTextNode(message));
}

// Auto-start only driving and riding routes, and only when the server confirms it did not have to ignore a reported
// closure. Walking routes and trips by train always wait for a tap on Go.
export function canAutoStartRoute({
  mode,
  travel,
  routeAvailable,
  hasLocation,
  buttonDisabled,
  pageHidden,
  blockingOverlayOpen,
  closuresIgnored,
}) {
  return mode === 'preview'
    && (travel === 'drive' || travel === 'motorcycle')
    && routeAvailable
    && hasLocation
    && !buttonDisabled
    && !pageHidden
    && !blockingOverlayOpen
    && closuresIgnored === false;
}
