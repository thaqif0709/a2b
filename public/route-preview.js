// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Auto-start only driving and riding routes, and only when the server confirms it did not have to ignore a reported
// closure. Walking routes and trips by train always wait for a tap on Go, and so does a route sheet pulled down to
// look at the map.
export function canAutoStartRoute({
  mode,
  travel,
  routeAvailable,
  hasLocation,
  buttonDisabled,
  pageHidden,
  blockingOverlayOpen,
  sheetCollapsed,
  closuresIgnored,
}) {
  return mode === 'preview'
    && (travel === 'drive' || travel === 'motorcycle')
    && routeAvailable
    && hasLocation
    && !buttonDisabled
    && !pageHidden
    && !blockingOverlayOpen
    && !sheetCollapsed
    && closuresIgnored === false;
}
