// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { REPORT_TYPES, reportLabel, reportIcon, canReportFrom } from './report-types.js';
import { distance, bearing, cumulative, formatDistance, formatDuration, formatClock } from './geo.js';
import { Navigator, Simulator, reportsAlong, sliceAlong, spokenDistance, roundaboutTurn } from './nav.js';
import { canAutoStartRoute } from './route-preview.js';
import { TrainGuide, markerFor, walkText } from './train-guide.js';
import { Glide } from './motion.js';
import { Follow, shouldSend, nextPollDelay } from './follow.js';
import { sheetGesture, settle, rubberBand } from './sheet-drag.js';
import { searchNearby, mergeResults, attribution as placesAttribution, typeQuery, placesOfType, placesOfTypesIn, TYPES, addTypeSource, withoutBaseDuplicates } from './places.js';
import { start as startVehicle, DEFAULT_COLOR } from './vehicle3d.js';
import { turnIcon, roundaboutIcon, laneIcon, CAR, DEST_PIN, DROP_PIN, PLACE_ICONS, soundIcon } from './icons.js';
import {
  $, state, api, loadConfig, local, toast, esc, timeAgo, speak, loadLocalSettings, saveSettings, loadPlaces, addPlace, removePlace, renamePlace,
  isSaved, setHomeWork, armBack,
} from './core.js';
import { MAP_THEMES, BASE_STYLES, applyMapTheme } from './map-themes.js';
import { initPanels, openMenu, openAuth, openSettings, renderAvatar, refreshMe } from './panels.js';
import { startPresence, checkIn } from './presence.js';
import { noteProbeFix, startProbeSender, discardProbeBuffer } from './probe.js';
import { welcome, hideSplash } from './welcome.js';
import { watchUpdates, updateCheckpoint } from './update.js';
import { prefetchRouteTiles } from './offline.js';
import { DeadReckoner, shouldEstimate, nearTunnel, pointAt, BAD_ACCURACY_M } from './dead-reckoning.js';
import { matchesWordStarts } from './text.js';
import { signPlaces } from './signs.js';
import { mapPlace } from './map-places.js';

// Which map look to use for day or night (see map-themes.js). 'mapTheme' in local storage overrides it.
function mapThemeId(t = themeNow) {
  const chosen = local.get('mapTheme');
  if (chosen && MAP_THEMES[chosen]) return chosen;
  return t === 'night' ? 'plum_night' : 'bright_plum';
}
const styleUrl = (t) => BASE_STYLES[MAP_THEMES[mapThemeId(t)].base];
// Route line colours per map theme: brand plum, lighter at night so it stands out on the dark map.
// The stretch already driven stays visible in a muted tone.
const ROUTE = {
  day: { main: '#9b2c6b', casing: '#4a0f31', driven: '#c3b3bd', drivenCasing: '#8f7a87' },
  night: { main: '#d0569a', casing: '#5e1640', driven: '#8a7684', drivenCasing: '#3b2f39' },
};
// Walks are drawn as dots in the app's own colour (the route colour: plum by day, the brighter pink at night), so
// they read as a walk and still stand out on the dark map. The same dots for the walks in train trips.
const WALK_DOTS = { day: ROUTE.day.main, night: ROUTE.night.main };
const JAM_COLOURS = { 1: '#f2a516', 2: '#e8442e', 3: '#a3121c' }; // slow, queuing, stationary
const REPORT_REFRESH_MS = 60_000;
const STILL_SPEED = 1; // m/s; slower than this counts as standing still
const BROWSE_RESUME_MS = 15_000;
const FRAME_MS = 1000 / 30; // smooth enough for a car, and half the work of 60 fps
const TRIM_EVERY_MS = 100; // how often the driven part of the line is recoloured
const TRIM_BEHIND_M = 6; // recolour up to a little behind the car, so the route colour always starts under the car
const REROUTE_GAP_MS = 8000;

let map;
let carMarker, destMarker, dropMarker, stopMarker;
const routeLabels = [];
const reports = new Map(); // id -> report
const reportMarkers = new Map(); // id -> maplibregl.Marker
let follow = true;
let mode = 'browse'; // browse | preview | drive | ride (a train trip, train-guide.js) | watch
let transit = null; // { place, trips, selected } while showing trips by train
let themeNow = null;

// Preview / drive state
let dest = null;
// How to get there: 'drive' | 'walk' | 'transit'. Not remembered: every trip starts on Drive, so someone who walked once
// isn't given footpaths (no cameras, alerts or tolls) next time they're in the car. See resetTravel.
let travel = 'drive';
let stops = []; // places to visit on the way, in order, not yet reached
let origin = null, originMarker = null; // where routes start when it isn't where you are (picked in the preview)
let routes = [];
let selected = 0;
let nav = null;
let live = null;
let sim = null, simTimer = null;
let onRoute = []; // reports along the active route
const alerted = new Map(); // report id -> 'ahead' | 'asked'
let lastReroute = 0;
let rerouting = false;
let driveStarted = 0;
let wakeLock = null;
let share = null; // { token, url, last: { at, pos, eta } of the last update sent }
let shareTimer = null; // phones send no GPS while standing still, so the heartbeat needs its own clock
let recenterTimer = null;
const glide = new Glide(); // slides the car between GPS fixes
let shown = null; // where the car is drawn this frame
let lastFixAt = 0; // when the last GPS fix came
let frameId = 0, lastFrame = 0;
let camZoom = null;
let userMoving = false;
let touching = false; // a finger (or mouse button) is down on the map
let vehicle3d = false; // the car is drawn as a 3D model (vehicle3d.js) rather than the flat arrow
let lastUserMove = 0;
let lineFor = null; // the route the driving line currently holds
let trimmedAt = 0, trimmedTo = -1; // when, and to what fraction of the route, the driven part was last recoloured
let trail = []; // lines driven earlier in this drive: parts of routes replaced by a reroute, and detours off them
let offTrail = []; // where the car has been since it left the current route
const tollsSpoken = new Set(); // toll plazas (route + index) already announced this drive
const camerasWarned = new Set(); // fixed speed cameras (route + index) already announced this drive
const cameraPins = [];

// ================= Boot =================
// With Reduce Motion on (an iPhone accessibility setting), MapLibre turns every camera move into an instant
// jump, including the glide after flicking the map, so the map stops dead and recenters snap. A map needs that
// movement to keep you oriented, so MapLibre is told the setting is off. It asks via matchMedia, lazily, after
// this runs. Our own CSS still sees the real setting.
const realMatchMedia = window.matchMedia.bind(window);
window.matchMedia = (query) => realMatchMedia(/prefers-reduced-motion:\s*reduce/.test(query) ? 'not all' : query);

// The trip sheet while driving (arrival time, then Add a stop, Share, Overview, Stop). Like an iPhone sheet
// it follows the finger: drag it up or down from anywhere on it, and a flick finishes the move.
const tripSheet = (() => {
  let open = false;
  let from = 0; // where the sheet sat when the drag began
  let justDragged = () => false;
  const bar = () => $('eta-bar');
  // How far down the closed sheet sits: the whole menu, plus the gap under a floating sheet on wide screens,
  // less the destination row, which stays in view so you can always see where you're headed.
  const closedOffset = () => {
    const menu = $('eta-menu'), dest = $('trip-dest');
    const keep = dest.offsetHeight ? dest.offsetTop + dest.offsetHeight - menu.offsetTop : 0;
    document.body.style.setProperty('--trip-keep', `${keep}px`); // lifts the speedo and buttons above it
    return menu.offsetHeight - keep + (parseFloat(getComputedStyle(bar()).bottom) || 0);
  };
  const place = (y, animate) => {
    bar().classList.toggle('dragging', !animate);
    bar().style.transform = `translateY(${Math.round(y)}px)`;
  };
  const set = (want, animate = true) => {
    open = want;
    bar().classList.toggle('open', open);
    bar().classList.remove('reveal');
    if (open) $('alert').classList.add('hidden'); // the alert card would sit on top of the menu
    place(open ? 0 : closedOffset(), animate);
  };

  function init() {
    justDragged = sheetGesture(bar(), {
      start: () => {
        from = open ? 0 : closedOffset();
        return true;
      },
      move: (dy) => {
        bar().classList.add('reveal'); // show the menu rows as the sheet is pulled up
        place(rubberBand(from + dy, 0, closedOffset()), false);
      },
      end: (dy, v) => set(settle(open, dy, v, closedOffset())),
    });
    new ResizeObserver(() => set(open, false)).observe($('eta-menu'));
  }

  return { init, set, isOpen: () => open, justDragged: () => justDragged() };
})();

// The sheet of stops while riding. Drag it down (or tap the grabber) to close it to one line, the next station;
// drag it up or tap that line to see the stops again.
const rideSheet = (() => {
  const sheet = () => $('ride-sheet');
  const set = (closed) => {
    const el = sheet();
    el.classList.remove('dragging');
    el.style.transform = '';
    el.classList.toggle('closed', closed);
    // Keep you in view above the sheet's new height.
    if (mode === 'ride' && follow && rideGlide.to) {
      map.easeTo({ center: rideGlide.at(performance.now())?.pos, padding: ridePadding(), duration: 300 });
    }
  };
  function init() {
    // The ride's buttons sit above the sheet (styles.css), so they follow its height.
    new ResizeObserver(() => document.body.style.setProperty('--ride-sheet', `${sheet().offsetHeight}px`)).observe(sheet());
    sheet().querySelector('.grabber').onclick = () => set(!sheet().classList.contains('closed'));
    $('ride-peek').onclick = () => set(false);
    sheetGesture(sheet(), {
      // Not from inside a scrolled list of stops, so it can still be scrolled back up.
      start: (e) => !(e.target.closest('#ride-stops') && sheet().scrollTop > 0),
      move: (dy) => {
        const el = sheet();
        el.classList.add('dragging');
        el.style.transform = `translateY(${Math.round(el.classList.contains('closed') ? Math.min(0, dy) / 3 : rubberBand(dy, 0, el.offsetHeight))}px)`;
      },
      end: (dy, v) => set(!settle(!sheet().classList.contains('closed'), dy, v, sheet().offsetHeight / 2)),
    });
  }
  return { init, set };
})();

boot();

async function boot() {
  loadLocalSettings();
  applyTheme(true);
  const last = local.get('lastPos');
  map = new maplibregl.Map({
    container: 'map',
    style: styleUrl(themeNow),
    center: last ?? [10, 25],
    zoom: last ? 15 : 1.6,
    attributionControl: { compact: true, customAttribution: 'Traffic © TomTom' },
    pixelRatio: Math.min(devicePixelRatio, 2), // 3x screens cost a lot of GPU (and heat) for little gain on a moving map
    maxPitch: 65,
  });
  map.touchPitch.disable();
  // Let a flick carry the map on and ease to a stop, instead of MapLibre's default quick brake.
  map.dragPan.enable({ linearity: 0.25, easing: (t) => 1 - (1 - t) ** 3, deceleration: 1400, maxSpeed: 2000 });
  // Start the attribution collapsed to its (i) button so it doesn't run under the report button on phones.
  map.once('load', () => {
    map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
    hideSplash();
  });
  setTimeout(hideSplash, 4000); // a slow map still shouldn't keep the app behind the splash
  map.on('style.load', () => {
    applyMapTheme(map, MAP_THEMES[mapThemeId()]);
    addMapLayers();
  });
  map.on('dragstart', (e) => {
    if (!e.originalEvent) return;
    stopFollowing();
    if (mode === 'preview') autoGo.stop(); // looking around the routes: wait for Go
  });
  map.on('zoomstart', (e) => e.originalEvent && (mode === 'drive' || mode === 'ride') && stopFollowing());
  map.on('rotate', () => $('btn-compass').classList.toggle('hidden', Math.abs(map.getBearing()) < 3 || mode === 'drive'));
  map.on('moveend', scheduleReportLoad);
  map.on('moveend', schedulePois);
  map.on('click', tapPlaceOnMap);
  map.on('mousemove', (e) => (map.getCanvas().style.cursor = mode !== 'drive' && placeAt(e.point) ? 'pointer' : ''));
  map.on('movestart', (e) => { if (e.originalEvent) userMoving = true; });
  map.on('move', (e) => { if (e.originalEvent) lastUserMove = Date.now(); });
  map.on('moveend', () => { userMoving = false; });
  // Moving the camera cancels any gesture in progress, so the follow camera holds still while the map is
  // being touched; otherwise a drag is cancelled every frame before it can begin.
  const canvas = map.getCanvasContainer();
  canvas.addEventListener('touchstart', () => (touching = true), { passive: true });
  canvas.addEventListener('mousedown', () => (touching = true));
  addEventListener('touchend', (e) => (touching = e.touches.length > 0), { passive: true });
  addEventListener('touchcancel', () => (touching = false), { passive: true });
  addEventListener('mouseup', () => (touching = false));
  setupLongPress();

  carMarker = new maplibregl.Marker({ element: el('div', 'car', CAR), rotationAlignment: 'map', pitchAlignment: 'map' });

  initPanels({ onUserChanged, applyTheme, openSearchFor, openPreview, refreshSound, setupVehicle, drawPois, setSimSpeed: (v) => sim && (sim.speedFactor = v) });
  wireUi();
  setupSheetDrag();
  refreshSound();
  // A shared-drive link goes straight to the drive; everyone else sees the welcome once, which then asks for location.
  if (/^\/drive\//.test(location.pathname)) startLocation();
  else welcome(startLocation);
  setInterval(() => loadReports(true), REPORT_REFRESH_MS);
  // Dead spots don't stop the drive: the loaded route keeps guiding, and everything needing the
  // network (rerouting, reports) resumes on its own when the signal is back.
  addEventListener('offline', () => { if (mode === 'drive') toast('No connection. The saved map and directions keep working; rerouting needs internet.', 4000); });
  addEventListener('online', () => {
    if (mode !== 'drive') return;
    toast('Back online.');
    loadReports(true);
    if (live?.offRoute && state.pos) reroute(state.pos);
  });
  setInterval(() => applyTheme(), 5 * 60_000);
  startProbeSender(); // opt-in traffic sharing batches; silent unless the driver said yes

  await refreshMe();
  loadConfig(); // in the background: only the sign-in screen and Settings read it, when they open
  await onUserChanged();

  // Deep links: /drive/<token> watches a shared drive; /?to=lat,lng&name= opens a destination.
  const m = location.pathname.match(/^\/drive\/([a-z0-9]+)$/i);
  if (m) return startWatching(m[1]); // watching a friend's drive doesn't take one of the spots
  startPresence({ driving: () => mode === 'drive', signUp: () => openAuth(null, 'signup') });
  const to = new URLSearchParams(location.search).get('to');
  if (to) {
    const [lat, lng] = to.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const name = new URLSearchParams(location.search).get('name') || 'Shared place';
      history.replaceState(null, '', '/');
      openPreview({ name, address: '', lat, lng });
    }
  } else setTimeout(offerResume, 600); // a trip the phone cut off (not over a link someone opened)
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  watchUpdates({
    // On the map with nothing open, so a refresh interrupts nothing.
    idle: () => mode === 'browse' && [...OVERLAYS, 'menu', 'watch', 'gate', 'welcome'].every((id) => $(id).classList.contains('hidden')),
    driving: () => mode === 'drive' || mode === 'ride',
  });
}

async function onUserChanged() {
  renderAvatar();
  if (state.presence && !state.presence.admitted) checkIn(); // an account may get in where a guest couldn't
  await loadPlaces();
  renderSearchHome();
}

function el(tag, cls, html = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.innerHTML = html;
  return e;
}

// ================= Theme =================
function nightNow() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  return h >= 19 || h < 6.5;
}

function applyTheme(initial = false) {
  const t = state.settings.theme === 'auto' ? (nightNow() ? 'night' : 'day') : state.settings.theme;
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]').content = t === 'night' ? '#161b22' : '#751b4f';
  if (themeNow !== t) {
    themeNow = t;
    // Day and night can share a base style. A diff against that same style quietly drops our recolouring and
    // route layers without a 'style.load' to put them back, so always load the style afresh.
    if (!initial && map) map.setStyle(styleUrl(t), { diff: false });
  }
}

// ================= Map layers =================
function addMapLayers() {
  if (!map.getSource('routes')) {
    map.addSource('routes', { type: 'geojson', data: emptyFc(), lineMetrics: true }); // lineMetrics: lets the driven part be hidden by a gradient
    map.addSource('watch-route', { type: 'geojson', data: emptyFc() });
    // Above every road (some styles put a few labels early), but below the labels drawn on top of roads.
    const layers = map.getStyle().layers;
    const lastShape = layers.findLastIndex((l) => l.type !== 'symbol');
    const before = layers.slice(lastShape + 1).find((l) => l.type === 'symbol')?.id;
    map.addLayer({ id: 'routes-alt-casing', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], false], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#5f6b76', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 16, 14] } }, before);
    map.addLayer({ id: 'routes-alt', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], false], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#a9b5c3', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4.5, 16, 10] } }, before);
    map.addSource('trail', { type: 'geojson', data: emptyFc() });
    map.addLayer({ id: 'trail-casing', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE[themeNow].drivenCasing, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 8, 16, 16] } }, before);
    map.addLayer({ id: 'trail-main', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE[themeNow].driven, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 11] } }, before);
    map.addLayer({ id: 'routes-casing', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], true], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE[themeNow].casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 8, 16, 16] } }, before);
    map.addLayer({ id: 'routes-main', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], true], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE[themeNow].main, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 11] } }, before);
    // A walk: the same route as dots (a line with a gradient can't be dotted), shown instead of the line above.
    map.addLayer({ id: 'routes-walk', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], true], layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' }, paint: { 'line-color': WALK_DOTS[themeNow], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 10], 'line-dasharray': [0.1, 2.4] } }, before);
    // Toll plazas on the route, as small amber "TOLL" tags.
    map.addSource('tolls', { type: 'geojson', data: emptyFc() });
    if (!map.hasImage('toll-tag')) map.addImage('toll-tag', tollTagImage(), { pixelRatio: 2 });
    map.addLayer({ id: 'tolls', type: 'symbol', source: 'tolls', layout: { 'icon-image': 'toll-tag', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.7, 15, 1] } });
    // The upcoming turn, drawn on the route as a white arrow, above the map's labels so it's never hidden.
    map.addSource('maneuver', { type: 'geojson', data: emptyFc() });
    if (!map.hasImage('turn-head')) map.addImage('turn-head', arrowHeadImage(), { pixelRatio: 2 });
    map.addLayer({ id: 'maneuver-casing', type: 'line', source: 'maneuver', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE[themeNow].casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4, 16, 8.5, 19, 17] } });
    map.addLayer({ id: 'maneuver-line', type: 'line', source: 'maneuver', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 5, 19, 10] } });
    map.addLayer({
      id: 'maneuver-head', type: 'symbol', source: 'maneuver', filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'icon-image': 'turn-head', 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
        'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.33, 16, 0.75, 19, 1.5],
      },
    });
    map.addLayer({ id: 'watch-route', type: 'line', source: 'watch-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE[themeNow].main, 'line-width': 6, 'line-opacity': 0.85 } }, before);
    // A trip by train (see drawTransit): walks dashed, rides in their line's colour.
    map.addSource('transit', { type: 'geojson', data: emptyFc() });
    map.addLayer({ id: 'transit-walk', type: 'line', source: 'transit', filter: ['==', ['get', 'mode'], 'walk'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': WALK_DOTS[themeNow], 'line-width': 6, 'line-dasharray': [0.1, 2] } }, before);
    map.addLayer({ id: 'transit-ride-casing', type: 'line', source: 'transit', filter: ['==', ['get', 'mode'], 'train'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 16, 13] } }, before);
    map.addLayer({ id: 'transit-ride', type: 'line', source: 'transit', filter: ['==', ['get', 'mode'], 'train'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9] } }, before);
    map.addLayer({ id: 'transit-stops', type: 'circle', source: 'transit', filter: ['==', ['get', 'mode'], 'stop'], paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 3 } });
    // Petrol stations, hospitals, clinics and convenience stores around the map (see drawPois). Under the base map's
    // own places, so a station or landmark keeps its spot and these fill the gaps around it.
    map.addSource('pois', { type: 'geojson', data: emptyFc() });
    const firstBasePlace = layers.find((l) => BASE_PLACE_LAYERS.has(l['source-layer']) && l.type === 'symbol')?.id;
    for (const type of POI_TYPES) if (!map.hasImage(`poi-${type}`)) map.addImage(`poi-${type}`, poiImage(type), { pixelRatio: 2 });
    const font = map.getStyle().layers.find((l) => l.layout?.['text-font'])?.layout['text-font'];
    map.addLayer({
      id: 'pois', type: 'symbol', source: 'pois', minzoom: POI_MIN_ZOOM,
      layout: {
        'icon-image': ['concat', 'poi-', ['get', 'type']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], POI_MIN_ZOOM, 0.8, 16, 1],
        'symbol-sort-key': ['match', ['get', 'type'], 'hospital', 0, 'fuel', 1, 'clinic', 2, 3], // hospitals win a crowded spot
        ...(font ? {
          'text-field': ['step', ['zoom'], '', 15, ['get', 'name']], 'text-font': font, 'text-size': 11, 'text-offset': [0, 1.3],
          'text-anchor': 'top', 'text-optional': true, 'text-max-width': 9,
        } : {}),
      },
      paint: { 'text-color': themeNow === 'night' ? '#e6edf3' : '#33404d', 'text-halo-color': themeNow === 'night' ? '#161b22' : '#ffffff', 'text-halo-width': 1.4 },
    }, firstBasePlace);
    for (const id of ['routes-alt', 'routes-alt-casing']) {
      map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
    }
  }
  drawTransit();
  basePlaceLayers = map.getStyle().layers.filter((l) => BASE_PLACE_LAYERS.has(l['source-layer']) && l.type === 'symbol').map((l) => l.id);
  drawPois();
  setupVehicle(); // a new style drops custom layers too
  arrowFor = null; // a new style starts with an empty arrow source
  lineFor = null; // and an empty driving line
  drawTrail();
  drawRoutes();
}

// The car as a 3D model (Settings › Vehicle). The flat arrow marker keeps the position either way and shows
// instead when 3D can't start (no WebGL, three.js didn't load).
// The 3D model: the vehicle from Settings, or while on the train part of a trip a train in the line's colour (see
// renderRide). On foot it's always the chevron: it shows which way you're facing, which a car doesn't. Run again
// after a style change, which drops custom layers.
let trainPose = null; // { pos, heading, color } while on a train
let vehicleShown = null; // which model the layer has now, e.g. 'car:#e23d9b' or 'train:#e4002b'
function wantedVehicle() {
  if (mode === 'ride' && trainPose) return ['train', trainPose.color];
  const kind = travel === 'walk' ? 'chevron' : markerFor({ mode: 'drive', vehicle: local.get('vehicle', 'chevron') });
  return [kind, local.get('vehicleColor', DEFAULT_COLOR)];
}
function syncVehicle() {
  if (vehicleShown !== wantedVehicle().join(':')) setupVehicle();
}
async function setupVehicle() {
  const [kind, color] = wantedVehicle();
  const onTrain = kind === 'train';
  vehicleShown = `${kind}:${color}`;
  const pose = onTrain ? () => (mode === 'ride' ? trainPose : null) : () => (mode === 'watch' || mode === 'ride' || !carMarker._map ? null : shown);
  vehicle3d = await startVehicle(map, kind, color, pose);
  carMarker.getElement().classList.toggle('as-3d', vehicle3d);
  map.triggerRepaint();
}

// fitBounds adds to whatever padding the camera already has (e.g. from driving), so clear it first.
function fitTo(bounds, opts) {
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  map.fitBounds(bounds, opts);
}

const emptyFc = () => ({ type: 'FeatureCollection', features: [] });

// A white triangle with rounded corners and a dark outline, pointing up (north) so 'icon-rotate' can turn it
// to the road's bearing.
function arrowHeadImage() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const pts = [[size / 2, 6], [size - 7, size - 6], [7, size - 6]];
  const r = 7; // corner radius
  g.beginPath();
  // Start half way along the last edge so every corner is drawn with arcTo.
  g.moveTo((pts[2][0] + pts[0][0]) / 2, (pts[2][1] + pts[0][1]) / 2);
  for (let i = 0; i < 3; i++) {
    const p = pts[i], q = pts[(i + 1) % 3];
    g.arcTo(p[0], p[1], q[0], q[1], r);
  }
  g.closePath();
  g.lineJoin = 'round';
  g.lineWidth = 6;
  g.strokeStyle = ROUTE[themeNow].casing;
  g.stroke();
  g.fillStyle = '#ffffff';
  g.fill();
  return g.getImageData(0, 0, size, size);
}

// A rounded amber tag reading TOLL, for toll plazas on the map.
// ---------- Places on the map you can tap to go ----------
// Petrol stations, EV chargers, hospitals, clinics and convenience stores come from this phone's Overture files
// (public/places.js; EV chargers also from the server's list), drawn by A2B when the map is zoomed in far enough to be useful, while browsing or choosing a
// route (not while driving). Stations (LRT, MRT, KTM, monorail, buses), landmarks and the airport are already on
// the base map from OpenStreetMap; tapping those works too. Either way, a tap shows the routes there.
// EV chargers: the server keeps OpenStreetMap's and Open Charge Map's (src/lib/chargers.js); Overture's few are in the files.
addTypeSource('ev', () => api('/api/chargers').then((r) => r.chargers ?? []));
const CHARGERS_ATTRIBUTION = 'EV chargers: © OpenStreetMap contributors, Open Charge Map';
const POI_TYPES = ['fuel', 'ev', 'hospital', 'clinic', 'convenience'];
const POI_MIN_ZOOM = 13;
const POI_STYLE = { fuel: { color: '#e8590c' }, ev: { color: '#0c8599' }, hospital: { color: '#e03131' }, clinic: { color: '#1c7ed6' }, convenience: { color: '#2f9e44' } };
const BASE_PLACE_LAYERS = new Set(['poi', 'aerodrome_label']); // the base map's own labelled places
const TAP_SLOP = 12; // px around a tap, for fingertips
let basePlaceLayers = []; // this style's layers drawing those, found when it loads

// The place drawn under a point on the screen, A2B's own first, or null.
function placeAt(point) {
  if (!map?.isStyleLoaded() || !['browse', 'preview'].includes(mode)) return null;
  const box = [[point.x - TAP_SLOP, point.y - TAP_SLOP], [point.x + TAP_SLOP, point.y + TAP_SLOP]];
  const ours = map.getLayer('pois') && map.queryRenderedFeatures(box, { layers: ['pois'] })[0];
  if (ours) return { name: ours.properties.name, address: ours.properties.address, lng: ours.geometry.coordinates[0], lat: ours.geometry.coordinates[1] };
  // Stops, stations and car parks count even unnamed (many bus stops and "P" signs are): see map-places.js.
  for (const f of basePlaceLayers.length ? map.queryRenderedFeatures(box, { layers: basePlaceLayers }) : []) {
    const place = f.geometry.type === 'Point' && mapPlace(f.properties);
    if (place) return { ...place, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
  }
  return null;
}

function tapPlaceOnMap(e) {
  const place = placeAt(e.point);
  if (!place) return;
  stopFollowing();
  openPreview(place);
}
let poiTimer = null, poiSeq = 0;

function schedulePois() {
  clearTimeout(poiTimer);
  poiTimer = setTimeout(drawPois, 250);
}

async function drawPois() {
  const src = map?.getSource('pois');
  if (!src) return;
  const show = state.settings.map_pois !== false && ['browse', 'preview'].includes(mode) && map.getZoom() >= POI_MIN_ZOOM;
  const seq = ++poiSeq;
  if (!show) return src.setData(emptyFc());
  const b = map.getBounds();
  const found = await placesOfTypesIn(POI_TYPES, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]).catch(() => []);
  if (seq !== poiSeq) return;
  const draw = () => src.setData({
    type: 'FeatureCollection',
    features: withoutBaseDuplicates(found, basePoisShown()).map((p) => ({ type: 'Feature', properties: { name: p.name, address: p.address || '', type: p.type }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })),
  });
  draw();
  // The base map may still be drawing this view's tiles: look again at what it shows once it has.
  map.once('idle', () => seq === poiSeq && draw());
}

// The base map's own places of our pins' kinds drawn on screen now, as { type, name, lng, lat }.
const BASE_POI_TYPES = { fuel: 'fuel', charging_station: 'ev', hospital: 'hospital', clinic: 'clinic', doctors: 'clinic', convenience: 'convenience' };
function basePoisShown() {
  if (!basePlaceLayers.length) return [];
  return map.queryRenderedFeatures({ layers: basePlaceLayers })
    .filter((f) => f.geometry.type === 'Point' && BASE_POI_TYPES[f.properties.subclass])
    .map((f) => ({ type: BASE_POI_TYPES[f.properties.subclass], name: f.properties['name:latin'] || f.properties.name || '', lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
}

// A round badge: a petrol pump, a lightning bolt for an EV charger, an H for a hospital, a cross for a clinic.
function poiImage(type) {
  const size = 52, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
  g.fillStyle = POI_STYLE[type].color;
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#ffffff';
  g.stroke();
  g.fillStyle = g.strokeStyle = '#ffffff';
  if (type === 'ev') {
    // A lightning bolt.
    g.beginPath();
    for (const [x, y] of [[29, 11], [17, 28], [25, 28], [22, 41], [35, 23], [27, 23], [31, 11]]) g.lineTo(x, y);
    g.closePath();
    g.fill();
  } else if (type === 'hospital') {
    g.font = '800 26px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('H', size / 2, size / 2 + 1);
  } else if (type === 'convenience') {
    // A shopping bag.
    g.fillRect(16, 21, 20, 16);
    g.lineWidth = 3;
    g.beginPath();
    g.arc(26, 21, 5.5, Math.PI, 0);
    g.stroke();
  } else if (type === 'clinic') {
    g.fillRect(size / 2 - 3.5, size / 2 - 12, 7, 24);
    g.fillRect(size / 2 - 12, size / 2 - 3.5, 24, 7);
  } else {
    // A pump: the body with its window, and the hose.
    g.fillRect(15, 14, 15, 24);
    g.fillStyle = POI_STYLE.fuel.color;
    g.fillRect(18, 17, 9, 7);
    g.lineWidth = 3;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(30, 20);
    g.lineTo(35, 24);
    g.lineTo(35, 33);
    g.quadraticCurveTo(35, 36, 37.5, 36);
    g.quadraticCurveTo(40, 36, 40, 33);
    g.lineTo(40, 22);
    g.lineTo(36, 17);
    g.stroke();
  }
  return g.getImageData(0, 0, size, size);
}

function tollTagImage() {
  const w = 84, h = 44, c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.beginPath();
  g.roundRect(3, 3, w - 6, h - 6, 10);
  g.fillStyle = '#f5a524';
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#ffffff';
  g.stroke();
  g.fillStyle = '#3b2400';
  g.font = '800 22px system-ui, -apple-system, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('TOLL', w / 2, h / 2 + 1);
  return g.getImageData(0, 0, w, h);
}

// Toll plazas to mark: the chosen route's in preview, the ones still ahead while driving.
function drawTolls() {
  const src = map?.getSource('tolls');
  if (!src) return;
  let pts = [];
  if (mode === 'preview' && routes[selected]) pts = (routes[selected].tolls ?? []).map((t) => routes[selected].coords[t.at]);
  else if (mode === 'drive' && nav) pts = (nav.route.tolls ?? []).filter((t) => nav.cum[t.at] > (live?.along ?? 0) - 30).map((t) => nav.coords[t.at]);
  src.setData({ type: 'FeatureCollection', features: pts.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } })) });
  drawCameras();
}

// Fixed speed cameras to mark, like toll plazas: the chosen route's in preview, the ones still ahead while driving.
function drawCameras() {
  let list = [];
  if (mode === 'preview' && routes[selected]) list = (routes[selected].cameras ?? []).map((c) => routes[selected].coords[c.at]);
  else if (mode === 'drive' && nav) list = (nav.route.cameras ?? []).filter((c) => nav.cum[c.at] > (live?.along ?? 0) - 30).map((c) => nav.coords[c.at]);
  const key = list.map((p) => p.join()).join(';');
  if (cameraPins.key === key) return;
  cameraPins.key = key;
  cameraPins.splice(0).forEach((m) => m.remove());
  for (const p of list) {
    const pin = el('div', 'report-pin cam-pin', `<div class="pin-ic" style="background:${REPORT_TYPES.camera.color}">${reportIcon('camera')}</div>`);
    cameraPins.push(new maplibregl.Marker({ element: pin }).setLngLat(p).addTo(map));
  }
}

// "RM 2.10" for a price from OpenStreetMap.
const money = ({ amount, currency }) => `${currency === 'MYR' ? 'RM' : currency} ${amount.toFixed(2)}`;

// "2 tolls · RM 4.20" for a route card: the total only when every plaza's car price is known.
function tollSummary(tolls) {
  const priced = tolls.filter((t) => t.price);
  const same = priced.length === tolls.length && priced.every((t) => t.price.currency === priced[0].price.currency);
  const total = same ? money({ amount: priced.reduce((a, t) => a + t.price.amount, 0), currency: priced[0].price.currency }) : '';
  return `${tolls.length} toll${tolls.length > 1 ? 's' : ''}${total ? ` · ${total}` : ''}`;
}

// While driving: a chip under the banner from 2 km before each plaza (name, car price, ways to pay), and a
// spoken heads-up at about 1 km so there's time to get the card ready.
function checkTolls() {
  const chip = $('toll-chip');
  const next = (nav?.route.tolls ?? []).map((t) => ({ ...t, ahead: nav.cum[t.at] - live.along })).find((t) => t.ahead > -20);
  if (!next || next.ahead > 2000) {
    if (!chip.classList.contains('hidden')) {
      chip.classList.add('hidden');
      drawTolls(); // a plaza was just passed: take its tag off the map
    }
    return;
  }
  const units = state.settings.units;
  const top = [next.ahead > 0 ? formatDistance(next.ahead, units) : 'Now', next.name].filter(Boolean).map(esc).join(' · ');
  const sub = [next.price && money(next.price), ...(next.pay ?? [])].filter(Boolean).map(esc).join(' · ');
  chip.innerHTML = `<b>TOLL</b><span>${top}${sub ? `<small>${sub}</small>` : ''}</span>`;
  chip.classList.remove('hidden');
  const key = `${nav.total}:${next.at}`;
  if (next.ahead > 0 && next.ahead <= 1000 && !tollsSpoken.has(key)) {
    tollsSpoken.add(key);
    speak(`Toll plaza in ${spokenDistance(next.ahead, units)}.`);
  }
}

// While driving: a spoken warning and a card at about 800 m before each fixed speed camera, with its limit.
function checkCameras() {
  if (!state.settings.alerts) return;
  const units = state.settings.units;
  const next = (nav?.route.cameras ?? []).map((c) => ({ ...c, ahead: nav.cum[c.at] - live.along })).find((c) => c.ahead > -20);
  if (!next) return;
  const key = `${nav.total}:${next.at}`;
  if (next.ahead <= 0) return drawCameras(); // just passed: take its pin off the map
  if (next.ahead > 800 || camerasWarned.has(key)) return;
  camerasWarned.add(key);
  const limit = next.limit ?? nav.limitAt(next.at);
  speak(`Speed camera in ${spokenDistance(next.ahead, units)}.${limit && units === 'metric' ? ` The limit is ${limit}.` : ''}`);
  if (tripSheet.isOpen()) return; // the trip menu is open; the voice is enough
  const card = $('alert');
  card.dataset.until = String(Date.now() + 10_000);
  const sub = [formatDistance(next.ahead, units), limit ? `limit ${limit} km/h` : '', next.name].filter(Boolean).map(esc).join(' · ');
  card.innerHTML = `<div class="alert-top"><span class="pin-ic" style="background:${REPORT_TYPES.camera.color}">${reportIcon('camera', 26)}</span><div><b>Speed camera ahead</b><small>${sub}</small></div></div>
    <div class="alert-actions"><button class="btn ghost" data-a="dismiss">OK</button></div><div class="alert-timer"><i style="animation-duration:10000ms"></i></div>`;
  card.classList.remove('hidden');
  card.querySelector('[data-a]').onclick = () => card.classList.add('hidden');
}

// Turn arrow on the map for the next maneuver: from just before the turn to just after it
// (for a roundabout, all the way round to the exit).
const NO_ARROW = new Set(['straight', 'depart', 'arrive', 'arrive_left', 'arrive_right', 'stop', 'ferry']);
let arrowFor = null;
function drawManeuverArrow() {
  const src = map?.getSource('maneuver');
  if (!src) return;
  const next = mode === 'drive' && nav && live ? nav.steps[live.nextIndex] : null;
  if (!next || NO_ARROW.has(next.type) || live.distToNext > 1500) {
    if (arrowFor !== null) src.setData(emptyFc());
    arrowFor = null;
    return;
  }
  const key = `${nav.total}:${live.nextIndex}`;
  if (arrowFor === key) return;
  arrowFor = key;
  const at = nav.cum[next.begin];
  const exit = next.type === 'roundabout' ? nav.steps[live.nextIndex + 1] : null;
  const end = Math.min(nav.total, exit ? nav.cum[exit.begin] + 15 : at + 17);
  const line = sliceAlong(nav.coords, nav.cum, Math.max(0, at - 26), end);
  const tip = line.at(-1);
  const prev = sliceAlong(nav.coords, nav.cum, end - 5, end)[0]; // last few metres give the head's direction
  src.setData({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } },
      { type: 'Feature', properties: { bearing: bearing(prev, tip) }, geometry: { type: 'Point', coordinates: tip } },
    ],
  });
}

function drawRoutes() {
  const src = map?.getSource('routes');
  if (!src) return;
  // On foot the selected route is dots; otherwise the solid line (see 'routes-walk').
  const walk = travel === 'walk';
  map.setLayoutProperty('routes-walk', 'visibility', walk ? 'visible' : 'none');
  for (const id of ['routes-main', 'routes-casing']) map.setLayoutProperty(id, 'visibility', walk ? 'none' : 'visible');
  drawTolls();
  if (mode === 'drive' && nav) {
    drawDriveLine();
    return drawManeuverArrow();
  }
  if (lineFor) {
    lineFor = null;
    map.setPaintProperty('routes-casing', 'line-gradient', null);
  }
  let features = [];
  if (mode === 'preview') {
    features = routes.map((r, i) => ({ type: 'Feature', properties: { idx: i, selected: i === selected }, geometry: { type: 'LineString', coordinates: r.coords } }));
    features.sort((a, b) => a.properties.selected - b.properties.selected);
  }
  src.setData({ type: 'FeatureCollection', features });
  map.setPaintProperty('routes-main', 'line-gradient', mode === 'preview' ? routeColours(routes[selected], 0) : null);
  drawManeuverArrow();
}

// While driving, the whole route is handed to the map once (and again after a reroute); the part already
// driven is shown in a muted colour by a gradient along the line that changes colour at the car. Moving that cut-off is
// a cheap paint change. Re-sending line data instead, many times a second, kept the map re-cutting tiles: on a
// warm phone it fell behind, so stretches of line went missing or lagged behind the car.
function drawDriveLine() {
  const src = map?.getSource('routes');
  if (!src || !nav) return;
  if (lineFor !== nav) {
    lineFor = nav;
    trimmedTo = -1;
    drawTolls();
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { idx: 0, selected: true }, geometry: { type: 'LineString', coordinates: nav.coords } }] });
  }
  const now = performance.now();
  if (now - trimmedAt < TRIM_EVERY_MS) return;
  // Measured along the route, so the line starts on the road even when the car is off it.
  const along = shown?.path === nav ? shown.along : live?.along ?? 0;
  const to = Math.min(1, Math.max(0, (along - TRIM_BEHIND_M) / (nav.total || 1)));
  if (Math.abs(to - trimmedTo) * nav.total < 1) return;
  trimmedAt = now;
  trimmedTo = to;
  const c = ROUTE[themeNow];
  map.setPaintProperty('routes-casing', 'line-gradient', ['step', ['line-progress'], c.drivenCasing, to, c.casing]);
  map.setPaintProperty('routes-main', 'line-gradient', routeColours(nav.route, to));
}

// The selected route's colours along its length: muted where already driven (up to `driven`, a fraction of the
// length), then the route colour, with live-traffic and driver-speed jams in amber to deep red.
function routeColours(route, driven) {
  const c = ROUTE[themeNow];
  const jams = [...(route?.traffic?.jams ?? []), ...(route?.probe_jams ?? [])];
  const cuts = [...new Set([0, driven, ...jams.flatMap((j) => [j.from, j.to])])].filter((x) => x >= 0 && x < 1).sort((x, y) => x - y);
  const levelAt = (x) => Math.max(0, ...jams.filter((j) => j.from <= x && x < j.to).map((j) => j.level));
  const colourAt = (x) => (x < driven ? c.driven : JAM_COLOURS[levelAt(x)] ?? c.main);
  const expr = ['step', ['line-progress'], colourAt(0)];
  cuts.forEach((at, i) => {
    const colour = colourAt((at + (cuts[i + 1] ?? 1)) / 2);
    if (at > 0 && colour !== expr.at(-1)) expr.push(at, colour);
  });
  if (expr.length === 3) expr.push(1, expr[2]); // one colour all along: a step needs at least one stop
  return expr;
}

function drawTrail() {
  map?.getSource('trail')?.setData({ type: 'FeatureCollection', features: trail.map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } })) });
}

// Before a reroute replaces the route, keep what was driven of it, and of the detour since, as trail.
function keepTrail(at) {
  if (nav && live) trail.push([...sliceAlong(nav.coords, nav.cum, 0, live.along), ...offTrail, at]);
  offTrail = [];
  drawTrail();
}

// ================= Location =================
function startLocation() {
  if (!('geolocation' in navigator)) return locationFailed();
  navigator.geolocation.watchPosition(onFix, locationFailed, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}

function locationFailed(err) {
  state.locationDenied = true;
  if (mode === 'browse' && !state.pos) $('loc-banner').classList.remove('hidden');
  if (err && err.code !== 1 && !state.pos) setTimeout(startLocation, 15000);
}

function onFix(p) {
  state.locationDenied = false;
  $('loc-banner').classList.add('hidden');
  const raw = [p.coords.longitude, p.coords.latitude];
  const prev = state.pos;
  const speed = p.coords.speed;
  // Standing still, GPS wanders by about its accuracy. Inside that wobble keep the car where it is,
  // so it doesn't shake or spin round; a real move or a speed reading lets it go.
  const wobble = Math.min(Math.max(p.coords.accuracy ?? 20, 5), 30);
  const moved = prev ? distance(prev.lngLat, raw) : Infinity;
  const still = moved < wobble && (speed == null || speed < STILL_SPEED);
  const lngLat = still ? prev.lngLat : raw;
  let heading = prev?.heading ?? null;
  if (p.coords.heading != null && !Number.isNaN(p.coords.heading) && (speed ?? 0) > 1) heading = p.coords.heading;
  else if (!still && prev && moved > Math.max(8, wobble)) heading = bearing(prev.lngLat, raw);
  const fix = {
    lngLat,
    heading,
    speed: speed ?? (still ? 0 : prev ? estSpeed(prev, raw, p.timestamp) : 0),
    accuracy: p.coords.accuracy,
    time: still ? prev.time : p.timestamp, // so the speed estimate spans the whole stop
  };
  if (sim || gpsBlocked) return; // a simulated drive owns the car right now (or a test is pretending the GPS is gone)
  handleFix(fix, !prev);
}

function estSpeed(prev, lngLat, t) {
  const dt = (t - prev.time) / 1000;
  return dt > 0 && dt < 10 ? distance(prev.lngLat, lngLat) / dt : 0;
}

function handleFix(fix, first = false) {
  if (mode === 'drive' && !sim) {
    tunnelFixAt = Date.now();
    lastFixAccuracy = fix.accuracy;
    // A vague fix in a tunnel would drag the car off its route: leave it to the estimate (see tunnelTick).
    if ((fix.accuracy ?? 0) > BAD_ACCURACY_M && (reckoner || tunnelAhead())) return;
    if (reckoner) stopReckoning();
    lastGoodSpeed = fix.speed ?? lastGoodSpeed;
  }
  state.pos = fix;
  // Traffic sharing only buffers real drives: walking, browsing the map, and demo drives never become traffic.
  if (mode === 'drive' && travel === 'drive' && !sim) noteProbeFix(fix); // walking speeds would look like a jam
  local.set('lastPos', fix.lngLat.map((v) => Math.round(v * 1e4) / 1e4));
  if (mode === 'watch') return; // the viewer's own position isn't part of someone else's drive
  lastFixAt = Date.now(); // a train trip reads state.pos each second (rideTick), while it's fresh
  if (mode === 'ride') return;
  if (!carMarker._map) carMarker.setLngLat(fix.lngLat).addTo(map);
  updateSpeedo(fix.speed);
  if (mode === 'drive') return driveTick(fix);
  moveCar({ pos: fix.lngLat, heading: fix.heading ?? 0 });
  if (first && mode === 'browse') map.jumpTo({ center: fix.lngLat, zoom: 15.5 });
  // Moving without a route after panning the map away: come back to the car after a while.
  else if (mode === 'browse' && !follow && (fix.speed ?? 0) > 2 && Date.now() - lastUserMove > BROWSE_RESUME_MS) recenter();
}

// Each fix sets where the car should be; every animation frame draws it part of the way there,
// and moves the camera and the route line with it, so nothing jumps once a second.
function moveCar(pose) {
  glide.set(pose, performance.now());
  if (!frameId) frameId = requestAnimationFrame(frame);
}

function frame(now) {
  frameId = 0;
  if (lastFrame && now - lastFrame < FRAME_MS - 4) {
    frameId = requestAnimationFrame(frame);
    return;
  }
  const dt = lastFrame ? Math.min(now - lastFrame, 100) : FRAME_MS;
  lastFrame = now;
  shown = glide.at(now);
  if (!shown || mode === 'watch') return;
  carMarker.setLngLat(shown.pos).setRotation(shown.heading);
  if (vehicle3d) map.triggerRepaint(); // the model is part of the map: redraw even when the camera stays put
  let settling = false;
  if (follow && !userMoving && !touching && !map.isEasing()) {
    if (mode === 'drive' && live) settling = followDrive(dt);
    else if (mode === 'browse') map.jumpTo({ center: shown.pos });
  } else camZoom = null;
  const done = glide.done(now);
  if (mode === 'drive') drawDriveLine();
  if (!done || settling) frameId = requestAnimationFrame(frame);
  else lastFrame = 0;
}

// Camera sits behind the car. Zoom drifts towards the speed-based level instead of stepping.
function followDrive(dt) {
  const target = driveZoom();
  camZoom = camZoom == null ? map.getZoom() : camZoom + (target - camZoom) * (1 - Math.exp(-dt / 700));
  map.jumpTo({ center: shown.pos, bearing: shown.heading, pitch: 55, zoom: camZoom, padding: drivePadding() });
  return Math.abs(target - camZoom) > 0.01;
}

function updateSpeedo(speed) {
  const k = state.settings.units === 'imperial' ? 2.23694 : 3.6;
  const v = Math.max(0, Math.round((speed ?? 0) * k));
  for (const id of ['speedo', 'speedo-browse']) {
    const s = $(id);
    s.querySelector('b').textContent = v;
    s.querySelector('small').textContent = state.settings.units === 'imperial' ? 'mph' : 'km/h';
  }
  $('speedo-browse').classList.toggle('hidden', v < 5);
}

function stopFollowing() {
  follow = false;
  $('btn-recenter').classList.remove('following');
  if (mode === 'ride') $('btn-recenter-ride').classList.remove('hidden');
  if (mode === 'drive') {
    $('btn-recenter-drive').classList.remove('hidden');
    clearTimeout(recenterTimer);
    recenterTimer = setTimeout(recenter, 12000); // like a co-driver: snap back after a while
  }
}

function recenter() {
  follow = true;
  clearTimeout(recenterTimer);
  $('btn-recenter').classList.add('following');
  $('btn-recenter-drive').classList.add('hidden');
  $('btn-recenter-ride').classList.add('hidden');
  if (mode === 'drive' && live) return driveCamera();
  if (mode === 'ride') {
    rideKind = null; // ease back into the ride view
    return rideTick();
  }
  if (state.pos) map.easeTo({ center: state.pos.lngLat, zoom: Math.max(map.getZoom(), 15), bearing: 0, pitch: 0, duration: 700 });
  else if (state.locationDenied) toast('Location is off. Allow location for this site in your browser settings.');
}

// ================= Long-press: drop a pin =================
function setupLongPress() {
  let timer = null, start = null;
  const cancel = () => clearTimeout(timer);
  map.on('touchstart', (e) => {
    if (e.points?.length !== 1 || mode === 'drive' || mode === 'ride' || mode === 'watch') return;
    start = e.point;
    timer = setTimeout(() => showContextMenu(e.lngLat, e.point), 550);
  });
  map.on('touchmove', (e) => start && Math.hypot(e.point.x - start.x, e.point.y - start.y) > 10 && cancel());
  map.on('touchend', cancel);
  map.on('touchcancel', cancel);
  map.on('contextmenu', (e) => !['drive', 'ride', 'watch'].includes(mode) && showContextMenu(e.lngLat, e.point));
  map.on('click', hideContextMenu);
  map.on('click', routeAtTap);
  map.on('click', () => tripSheet.set(false)); // a tap on the map closes the trip menu
}

async function showContextMenu(lngLat, point) {
  const box = $('ctx');
  const p = { name: 'Dropped pin', address: `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`, lat: lngLat.lat, lng: lngLat.lng };
  dropMarker?.remove();
  dropMarker = new maplibregl.Marker({ element: el('div', 'drop-pin', DROP_PIN), anchor: 'bottom' }).setLngLat(lngLat).addTo(map);
  box.innerHTML = `
    <button class="menu-row" data-act="go">Drive here</button>
    <button class="menu-row" data-act="save">Save place</button>
    <button class="menu-row" data-act="home">Set as Home</button>
    <button class="menu-row" data-act="work">Set as Work</button>`;
  box.style.left = `${Math.min(point.x, innerWidth - 220)}px`;
  box.style.top = `${Math.min(point.y + 8, innerHeight - 220)}px`;
  box.classList.remove('hidden');
  if (navigator.vibrate) navigator.vibrate(15);
  const named = api(`/api/reverse?lat=${lngLat.lat}&lng=${lngLat.lng}`).then((r) => ({ ...r.place, lat: lngLat.lat, lng: lngLat.lng })).catch(() => p);
  box.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    hideContextMenu();
    const place = await named;
    if (act === 'go') openPreview(place);
    if (act === 'save') saveAsFavourite(place);
    if (act === 'home' || act === 'work') {
      await setHomeWork(act, place);
      renderSearchHome();
      toast(`${act === 'home' ? 'Home' : 'Work'} set to ${place.name}`);
    }
  };
}

function hideContextMenu() {
  $('ctx').classList.add('hidden');
  if (mode !== 'preview') dropMarker?.remove();
}

// ================= UI wiring =================
function wireUi() {
  $('btn-where').onclick = () => openSearchFor(null);
  $('btn-menu').onclick = openMenu;
  $('btn-recenter').onclick = recenter;
  $('btn-recenter-drive').onclick = recenter;
  $('btn-recenter-ride').onclick = recenter;
  $('btn-ride-start').onclick = startRide;
  $('btn-ride-stop').onclick = () => endRide(false);
  $('btn-ride-here').onclick = () => rideHere();
  // On a ride, tap a station to say you're there. A sheet asks first: an accidental tap mustn't move you (tapping
  // your stop gets you off the train, with "Get off here" said and buzzed).
  $('ride-stops').onclick = (e) => {
    const li = e.target.closest('li[data-k]');
    if (li) askHere(Number(li.dataset.k));
  };
  $('btn-here-no').onclick = () => $('here-confirm').classList.add('hidden');
  rideSheet.init();
  $('btn-compass').onclick = () => map.easeTo({ bearing: 0, pitch: 0 });
  $('btn-loc-retry').onclick = () => {
    $('loc-banner').classList.add('hidden');
    startLocation();
  };
  $('btn-report').onclick = openReportMenu;
  $('btn-report-drive').onclick = openReportMenu;
  $('btn-sound').onclick = $('btn-sound-browse').onclick = $('btn-sound-ride').onclick = () => {
    saveSettings({ voice: !state.settings.voice });
    refreshSound();
    toast(state.settings.voice ? 'Sound on' : 'Sound off');
  };
  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => closeScreen(b.dataset.close)));

  // Search
  let t;
  $('search-input').oninput = () => {
    clearTimeout(t);
    const q = $('search-input').value.trim();
    $('search-clear').classList.toggle('hidden', !q);
    if (q.length < 2) return showSearchHome();
    showSearching(); // straight away, not after the pause: your recent places go, the results' placeholders come
    t = setTimeout(() => runSearch(q), 280);
  };
  $('search-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
      clearTimeout(t);
      const q = $('search-input').value.trim();
      if (q.length >= 2) runSearch(q, true);
    }
  };
  $('search-clear').onclick = () => {
    $('search-input').value = '';
    $('search-clear').classList.add('hidden');
    showSearchHome();
    $('search-input').focus();
  };
  $('tile-home').onclick = () => (state.home ? pickPlace({ ...state.home, name: 'Home' }) : openSearchFor('home'));
  $('tile-work').onclick = () => (state.work ? pickPlace({ ...state.work, name: 'Work' }) : openSearchFor('work'));

  // Preview
  $('btn-go').onclick = startDrive;
  $('btn-from').onclick = () => openSearchFor('from');
  $('btn-from-clear').onclick = () => {
    origin = null;
    openPreview(dest);
  };
  for (const b of $('travel-seg').querySelectorAll('button')) {
    b.onclick = () => {
      if (b.dataset.travel === travel || !dest) return;
      travel = b.dataset.travel;
      syncVehicle();
      openPreview(dest);
    };
  }
  $('btn-transit-maps').onclick = () => {
    const from = origin ? [origin.lng, origin.lat] : state.pos?.lngLat ?? map.getCenter().toArray();
    const q = `origin=${from[1]},${from[0]}&destination=${dest.lat},${dest.lng}&travelmode=transit`;
    window.open(`https://www.google.com/maps/dir/?api=1&${q}`, '_blank', 'noopener');
  };
  $('btn-save-place').onclick = () => dest && toggleSaved(dest);
  $('btn-leave-later').onclick = openLater;

  // Drive
  $('btn-eta').onclick = () => !tripSheet.justDragged() && tripSheet.set(!tripSheet.isOpen());
  $('trip-dest').onclick = () => !tripSheet.justDragged() && tripSheet.set(!tripSheet.isOpen()); // the destination row opens and closes it too
  $('btn-parking').onclick = openParking;
  tripSheet.init();
  $('btn-stop').onclick = () => endDrive(false);
  $('btn-overview').onclick = overview;
  $('btn-trip-settings').onclick = () => {
    tripSheet.set(false);
    openSettings(); // over the drive: navigation keeps running underneath
  };
  // Testing aid: during a demo drive, cycle its speed 1x -> 2x -> 4x -> 8x.
  $('btn-sim-speed').onclick = () => {
    const next = { 1: 2, 2: 4, 4: 8, 8: 1 }[local.get('simSpeed', 1)] ?? 1;
    local.set('simSpeed', next);
    if (sim) sim.speedFactor = next;
    renderSimSpeed();
  };
  $('btn-share-drive').onclick = shareDrive;
  $('btn-stop-share').onclick = stopSharing;
  $('btn-add-stop').onclick = () => {
    tripSheet.set(false);
    if (stops.length) return removeStop();
    openSearchFor('stop');
  };
  $('btn-arrived-done').onclick = () => {
    $('arrived').classList.add('hidden');
    backToBrowse();
  };

  // Reports
  $('btn-report-back').onclick = () => renderReportGrid();
  $('btn-report-send').onclick = sendReport;

  window.addEventListener('popstate', onBack);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTop();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (mode === 'drive' || mode === 'ride')) requestWakeLock();
  });
}

function refreshSound() {
  $('btn-sound').innerHTML = soundIcon(state.settings.voice);
  $('btn-sound-browse').innerHTML = soundIcon(state.settings.voice);
  $('btn-sound-ride').innerHTML = soundIcon(state.settings.voice);
}

function closeScreen(id) {
  $(id).classList.add('hidden');
  if (id === 'parking') closeParking();
  if (id === 'preview') backToBrowse();
  if (id === 'report-sheet') reportDraft = null;
}

const OVERLAYS = ['ctx', 'auth', 'panel', 'search', 'report-card', 'report-sheet', 'parking', 'later', 'arrived', 'resume', 'here-confirm', 'preview'];

// Closes the top-most screen; returns false when nothing was open.
function closeTop() {
  for (const id of OVERLAYS) {
    if ($(id).classList.contains('hidden')) continue;
    if (id === 'ctx') hideContextMenu();
    else if (id === 'arrived') $('btn-arrived-done').click();
    else closeScreen(id);
    return true;
  }
  if (!$('menu').classList.contains('hidden')) {
    $('menu').classList.add('hidden');
    $('menu-backdrop').classList.add('hidden');
    return true;
  }
  if (tripSheet.isOpen()) {
    tripSheet.set(false);
    return true;
  }
  return false;
}

function onBack() {
  const closed = closeTop();
  // Back while driving opens the trip options rather than dropping out of the app.
  if (!closed && mode === 'drive') tripSheet.set(true);
  const open = OVERLAYS.some((id) => !$(id).classList.contains('hidden')) || !$('menu').classList.contains('hidden');
  if (open || mode === 'drive' || mode === 'ride') armBack(); // back never drops out of a trip; Stop does
}

// ================= Search =================
let searchTarget = null; // null = navigate | 'home' | 'work' | 'save'
let searchSeq = 0;

function openSearchFor(target) {
  armBack();
  searchTarget = target;
  $('search').classList.remove('hidden');
  $('search-input').value = '';
  $('search-clear').classList.add('hidden');
  const label = { home: 'Set your Home address', work: 'Set your Work address', save: 'Search for a place to save', stop: 'Add a stop on your way', from: 'Where are you starting from?' }[target];
  $('search-target').textContent = label ?? '';
  $('search-target').classList.toggle('hidden', !label);
  $('search-input').placeholder = target ? 'Search for an address' : 'Where to?';
  showSearchHome();
  // Focus now, inside the tap: iPhones only bring the keyboard up for a focus made during the tap itself, and
  // ignored the old delayed one. The delayed one stays as a fallback for browsers that need a frame first.
  $('search-input').focus();
  setTimeout(() => document.activeElement !== $('search-input') && $('search-input').focus(), 50);
}

function showSearchHome() {
  $('results').classList.add('hidden');
  $('results').removeAttribute('aria-busy');
  $('search-status').classList.add('hidden');
  $('search-home').classList.remove('hidden');
  renderSearchHome();
}

function renderSearchHome() {
  $('home-sub').textContent = state.home ? state.home.address || state.home.name : 'Set location';
  $('work-sub').textContent = state.work ? state.work.address || state.work.name : 'Set location';
  const { saved, recent } = state.places;
  $('saved-head').classList.toggle('hidden', !saved.length);
  $('recent-head').classList.toggle('hidden', !recent.length);
  $('recent-clear').onclick = clearRecent;
  $('search-empty-hint').classList.toggle('hidden', saved.length + recent.length > 0);
  renderPlaceList($('saved-list'), saved, 'star', 'saved');
  renderPlaceList($('recent-list'), recent, 'recent', 'recent');
}

// Clear the search history (on this phone, or on the account when signed in).
async function clearRecent() {
  if (!confirm('Clear your search history?')) return;
  for (const p of [...state.places.recent]) await removePlace('recent', p.id).catch(() => {});
  renderSearchHome();
  toast('Search history cleared.');
}

function renderPlaceList(ul, list, icon, kind) {
  ul.innerHTML = '';
  for (const p of list) {
    const li = el('li');
    const d = state.pos ? formatDistance(distance(state.pos.lngLat, [p.lng, p.lat]), state.settings.units) : '';
    li.innerHTML = `<button class="place-row"><span class="p-ic">${PLACE_ICONS[icon]}</span><span class="p-text"><b>${esc(p.name)}</b><small>${esc(p.address || '')}</small></span><span class="p-dist">${d}</span></button>
      <button class="icon-btn" aria-label="More for ${esc(p.name)}">${PLACE_ICONS.more}</button>`;
    li.firstElementChild.onclick = () => pickPlace(p);
    li.lastElementChild.onclick = (e) => placeMenu(e.currentTarget, p, kind);
    ul.append(li);
  }
}

// The ⋯ on a saved or recent place: Rename (saved places) and Remove, in the small menu the map's long-press uses.
function placeMenu(button, p, kind) {
  const box = $('ctx');
  const saved = kind === 'saved';
  box.innerHTML = `${saved ? `<button class="menu-row" data-act="rename"><span class="ctx-ic">${PLACE_ICONS.edit}</span>Rename</button>` : ''}
    <button class="menu-row danger" data-act="remove"><span class="ctx-ic">${PLACE_ICONS.trash}</span>${saved ? 'Remove from saved' : 'Remove from recent'}</button>`;
  box.classList.remove('hidden');
  // Under the ⋯, its right edge lined up with it, kept on screen.
  const r = button.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(r.right - box.offsetWidth, innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${Math.min(r.bottom + 4, innerHeight - box.offsetHeight - 8)}px`;
  // A tap anywhere else closes it.
  const away = (e) => {
    if (box.contains(e.target)) return;
    hideContextMenu();
    removeEventListener('pointerdown', away, true);
  };
  setTimeout(() => addEventListener('pointerdown', away, true));
  box.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    removeEventListener('pointerdown', away, true);
    hideContextMenu();
    if (act === 'rename') {
      const name = prompt('Name', p.name);
      if (!name?.trim() || name.trim() === p.name) return;
      await renamePlace('saved', p.id, name.trim()).catch((err) => toast(err.message));
    } else {
      if (!confirm(`Remove "${p.name}" from ${saved ? 'saved places' : 'recent'}?`)) return;
      await removePlace(kind, p.id).catch((err) => toast(err.message));
    }
    renderSearchHome();
  };
}

// While a search runs: rows that shimmer where its results will be, in place of your recent places.
function showSearching() {
  $('search-home').classList.add('hidden');
  $('search-status').classList.add('hidden');
  const ul = $('results');
  ul.classList.remove('hidden');
  if (ul.getAttribute('aria-busy')) return; // already showing them: don't restart the shimmer on every key
  ul.setAttribute('aria-busy', 'true');
  ul.innerHTML = '<li class="place-skeleton" aria-hidden="true"><span class="p-ic"></span><span><i></i><i></i></span></li>'.repeat(5);
}

// Nothing to show, only a message ("No results", "busy", offline): in the middle of the screen.
function searchMessage(text) {
  const ul = $('results');
  ul.classList.add('hidden');
  ul.removeAttribute('aria-busy');
  ul.innerHTML = '';
  $('search-home').classList.add('hidden');
  $('search-status').textContent = text;
  $('search-status').classList.remove('hidden');
}

async function runSearch(q, enter = false) {
  const seq = ++searchSeq;
  showSearching();
  const near = state.pos?.lngLat ?? map.getCenter().toArray();
  try {
    const coord = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    // Pasted coordinates are only a place when they're on the earth ("999,999" goes to text search instead).
    const lat = Number(coord?.[1]), lng = Number(coord?.[2]);
    const pasted = coord && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    // "petrol", "klinik near bangsar": the nearest places of that kind (see searchByType), when there are any.
    const typed = !pasted && (await searchByType(q, near).catch(() => null));
    if (typed) {
      if (seq !== searchSeq) return;
      return showResults(q, near, typed.places, typed.note, true, enter);
    }
    // Two searches at once: the server's (OpenStreetMap) and this phone's own (Overture shops and places).
    const [server, local] = pasted
      ? [{ places: [{ name: 'Coordinates', address: q, lat, lng }] }, []]
      : await Promise.all([
          api(`/api/search?q=${encodeURIComponent(q)}&lat=${near[1]}&lng=${near[0]}&lang=${(navigator.language || 'en').slice(0, 2)}`),
          searchNearby(q, near).catch(() => []),
        ]);
    // A search for parking is answered with the car parks around the place (or you), nearest first: only those.
    const places = server.parking ? await withOvertureParking(server) : mergeResults(server.places, local, q, near);
    const from = server.parking?.from;
    const note = server.parking
      ? places.length ? `Car parks near ${from ?? 'you'}` : `No car parks mapped near ${from ?? 'you'}.`
      : local.length ? null : server.note; // "not in the map data" is moot once Overture found it
    if (seq !== searchSeq) return;
    showResults(q, near, places, note, places.some((p) => !server.places.includes(p)), enter);
  } catch (e) {
    if (seq !== searchSeq) return;
    searchMessage(e.message);
  }
}

function showResults(q, near, places, note, overture, enter) {
  $('search-home').classList.add('hidden');
  if (!places.length) return searchMessage(note || `No results for "${q}".`);
  const ul = $('results');
  ul.classList.remove('hidden');
  ul.removeAttribute('aria-busy');
  ul.innerHTML = '';
  $('search-status').classList.add('hidden');
  // e.g. "No "nandos" found near Eco Grandeur in the map data." above the nearest other matches
  if (note && places.length) ul.append(el('li', 'search-note', esc(note)));
  for (const p of places) {
    const li = el('li');
    const d = formatDistance(distance(near, [p.lng, p.lat]), state.settings.units);
    li.innerHTML = `<button class="place-row"><span class="p-ic">${PLACE_ICONS[p.category === 'parking' ? 'parking' : 'pin']}</span><span class="p-text"><b>${esc(p.name)}</b><small>${esc(p.address)}</small></span><span class="p-dist">${d}</span></button>`;
    li.firstElementChild.onclick = () => pickPlace(p);
    ul.append(li);
  }
  if (overture) ul.append(el('li', 'search-note', esc(places.some((p) => p.type === 'ev') ? `${placesAttribution} · ${CHARGERS_ATTRIBUTION}` : placesAttribution)));
  if (enter && places.length === 1) pickPlace(places[0]);
}

// A search naming a kind of place ("petrol", "hospital", "balai polis", "convenience store"): its nearest
// places, from this phone's Overture files. With more words, they're either a name ("shell petrol station",
// "kpj hospital": those places near you) or an area ("petrol near klcc": those places around KLCC, which the
// server finds). A place actually called what was typed ("Police Museum") still comes first. Returns null to
// fall back to the usual search (no data for that kind here, or the area isn't found).
async function searchByType(q, near) {
  const t = typeQuery(q);
  if (!t) return null;
  const label = TYPES[t.type].label;
  if (!t.area) {
    const places = await placesOfType(t.type, near);
    return places.length ? { places, note: `${label} near you` } : null;
  }
  const mine = (await placesOfType(t.type, near)).filter((p) => matchesWordStarts(`${p.name} ${p.address}`, t.area));
  if (mine.length) return { places: mine, note: `${label} near you matching "${t.area}"` };

  const lang = (navigator.language || 'en').slice(0, 2);
  const search = (text) => api(`/api/search?q=${encodeURIComponent(text)}&lat=${near[1]}&lng=${near[0]}&lang=${lang}`);
  const [whole, local, where] = await Promise.all([search(q).catch(() => ({ places: [] })), searchNearby(q, near).catch(() => []), search(t.area)]);
  const named = mergeResults(whole.places ?? [], local, q, near).filter((p) => matchesWordStarts(p.name, q)).slice(0, 3);
  // A mall or venue before a station of the same name, as the usual search ranks them.
  const anchor = ['place', 'area'].map((k) => where.places?.find((p) => p.landmark === k)).find(Boolean) ?? where.places?.[0];
  if (!anchor) return null;
  const at = [anchor.lng, anchor.lat];
  const around = (await placesOfType(t.type, at))
    .filter((p) => !named.some((n) => distance([n.lng, n.lat], [p.lng, p.lat]) < 80))
    .map((p) => ({ ...p, address: [`${formatDistance(distance(at, [p.lng, p.lat]), state.settings.units)} from ${anchor.name}`, p.address].filter(Boolean).join(' · ') }));
  if (!around.length && !named.length) return null;
  return { places: [...named, ...around], note: `${label} near ${anchor.name}` };
}

// The car parks the server found (OpenStreetMap) plus the parking in this phone's Overture listings, often a
// mall's own ("Parking, Entry C"), within 1.5 km of the same spot, nearest first.
async function withOvertureParking(server) {
  const at = [server.parking.lng, server.parking.lat];
  const from = server.parking.from;
  const extra = (await Promise.all(['parking', 'car park'].map((w) => searchNearby(w, at).catch(() => [])))).flat()
    .filter((p) => p.category === 'parking' && distance(at, [p.lng, p.lat]) <= 1500)
    .map((p) => ({ ...p, address: from ? `${formatDistance(distance(at, [p.lng, p.lat]))} from ${from}` : p.address, category: 'parking' }));
  const all = [...server.places];
  for (const p of extra) if (!all.some((x) => distance([x.lng, x.lat], [p.lng, p.lat]) < 40)) all.push(p);
  return all.sort((a, b) => distance(at, [a.lng, a.lat]) - distance(at, [b.lng, b.lat])).slice(0, 15);
}

async function pickPlace(p) {
  $('search-input').blur();
  if (searchTarget === 'home' || searchTarget === 'work') {
    const which = searchTarget;
    try {
      await setHomeWork(which, p);
      toast(`${which === 'home' ? 'Home' : 'Work'} saved`);
    } catch (e) {
      toast(e.message);
    }
    searchTarget = null;
    renderSearchHome();
    closeScreen('search');
    return;
  }
  if (searchTarget === 'save') {
    searchTarget = null;
    closeScreen('search');
    return saveAsFavourite(p);
  }
  if (searchTarget === 'stop') {
    searchTarget = null;
    closeScreen('search');
    return addStop(p);
  }
  if (searchTarget === 'from') {
    searchTarget = null;
    closeScreen('search');
    origin = p;
    return dest && openPreview(dest);
  }
  closeScreen('search');
  // Search history: kept on this phone without an account (and on the account with one), so it's there next time.
  addPlace('recent', p).then(renderSearchHome).catch(() => {});
  openPreview(p);
}

// ================= Saved places =================
async function saveAsFavourite(p) {
  try {
    await addPlace('saved', p);
    toast(`Saved "${p.name}"`);
    renderSearchHome();
    updateSaveStar();
  } catch (e) {
    toast(e.message);
  }
}

async function toggleSaved(p) {
  const existing = isSaved(p);
  if (existing) {
    await removePlace('saved', existing.id).catch((e) => toast(e.message));
    toast('Removed from saved places');
    renderSearchHome();
    updateSaveStar();
  } else saveAsFavourite(p);
}

function updateSaveStar() {
  $('btn-save-place').classList.toggle('saved', Boolean(dest && isSaved(dest)));
}

// ================= Preview: destination + route options =================
async function openPreview(place) {
  armBack();
  hideContextMenu();
  mode = 'preview';
  dest = place;
  routes = [];
  selected = 0;
  $('browse-ui').classList.add('hidden');
  $('preview').classList.remove('hidden', 'peek');
  $('peek-summary').textContent = '';
  $('dest-name').textContent = place.name;
  $('dest-addr').textContent = place.address || '';
  // Placeholder cards the shape of real ones, so the sheet doesn't jump when the routes arrive.
  renderTravel();
  $('route-list').innerHTML = '<div class="route-opt skeleton" aria-hidden="true"><i></i><i></i></div>'.repeat(2);
  $('btn-go').disabled = true;
  updateSaveStar();
  destMarker?.remove();
  dropMarker?.remove();
  destMarker = new maplibregl.Marker({ element: el('div', 'dest-pin', DEST_PIN), anchor: 'bottom' }).setLngLat([place.lng, place.lat]).addTo(map);
  map.easeTo({ center: [place.lng, place.lat], zoom: 15, pitch: 0, bearing: 0, padding: sheetPadding() });

  renderFrom();
  const from = origin ? [origin.lng, origin.lat] : state.pos?.lngLat;
  const status = origin
    ? `Finding routes from ${origin.name}… Leave later puts the trip in your calendar.`
    : !from
    ? state.locationDenied
      ? 'Location is off, so routes start from the middle of the map.'
      : 'Waiting for your location… routes start from the middle of the map for now.'
    : 'Finding the best routes…';
  $('route-status').innerHTML = `<span class="spinner" aria-hidden="true"></span>${status}`;
  transit = null;
  drawTransit();
  if (travel === 'transit') {
    autoGo.stop();
    routeLabels.splice(0).forEach((m) => m.remove());
    drawRoutes(); // no driving routes under the trip
    return showTransit(place, from ?? map.getCenter().toArray(), from ? '' : status);
  }
  const asked = travel;
  try {
    const found = await requestRoutes(from ?? map.getCenter().toArray(), [place.lng, place.lat]);
    // Gone, or switched to Walk or Train while these were on their way: they mustn't come back (or start a drive).
    if (mode !== 'preview' || dest !== place || travel !== asked) return;
    routes = found;
    $('route-status').textContent = [from ? '' : status, routeNote(routes)].filter(Boolean).join(' ');
    if (origin) $('route-status').textContent = `From ${origin.name}. Leave later puts the trip in your calendar.`;
    renderRouteOptions();
    renderPeekSummary();
    drawRoutes();
    fitRoutes();
    $('btn-go').disabled = false;
    if (resuming && !origin) return resumeStart(); // carrying on with a trip the phone cut off
    if (!origin) autoGo.restart(); // a drive from somewhere else doesn't start by itself
  } catch (e) {
    if (mode !== 'preview' || dest !== place || travel !== asked) return;
    $('route-list').innerHTML = '';
    $('route-status').textContent = e.message;
  }
}

// ---------- Trips by train ----------
// LRT, MRT, Monorail, BRT and KTM Komuter trips from the server (src/lib/transit.js): each as its walks and rides,
// with the lines' own colours, and the chosen one drawn on the map. There's no turn-by-turn for these; a link
// opens Google Maps for live departure times instead.
// The start of the routes: where you are, or a place picked with Change. From somewhere else there's nothing to
// start now: the trip goes in the calendar with Leave later instead.
function renderFrom() {
  $('from-label').textContent = origin ? `From ${origin.name}` : 'From your location';
  $('btn-from-clear').classList.toggle('hidden', !origin);
  $('preview').classList.toggle('elsewhere', Boolean(origin));
  $('btn-leave-later').classList.toggle('primary', Boolean(origin));
  $('btn-leave-later').classList.toggle('ghost', !origin);
  originMarker?.remove();
  originMarker = origin ? new maplibregl.Marker({ element: el('div', 'drop-pin', DROP_PIN), anchor: 'bottom' }).setLngLat([origin.lng, origin.lat]).addTo(map) : null;
}

function renderTravel() {
  for (const b of $('travel-seg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.travel === travel);
  $('preview').classList.toggle('transit', travel === 'transit');
}

async function showTransit(place, from, status) {
  try {
    const plan = await api('/api/transit', { method: 'POST', body: { from, to: [place.lng, place.lat], moving: origin ? null : movingNow() } });
    if (mode !== 'preview' || dest !== place || travel !== 'transit') return;
    transit = { place, trips: plan.trips, selected: 0 };
    const night = plan.night ? `${plan.note} The first trains leave around ${formatClock(new Date(plan.firstTrain))}.` : plan.note;
    const last = plan.trips[0]?.lastTrain ? 'Last train tonight: miss it and there’s no later one this way.' : '';
    const elsewhere = origin ? `From ${origin.name}. Leave later puts the trip in your calendar.` : '';
    $('route-status').textContent = [status, elsewhere, last, night, plan.trips.length ? 'Times are estimates from the official timetables.' : ''].filter(Boolean).join(' ');
    renderTransit();
    if (resuming && !origin && plan.trips.length) return resumeStart();
    const b = new maplibregl.LngLatBounds();
    for (const l of plan.trips[0]?.legs ?? []) for (const c of l.coords) b.extend(c);
    if (!b.isEmpty()) fitTo(b, { padding: sheetPadding(), duration: 700, maxZoom: 16 });
  } catch (e) {
    if (mode !== 'preview' || dest !== place) return;
    // Carrying on offline: the trip as it was when the phone cut it off.
    if (resuming?.trip && travel === 'transit') {
      transit = { place, trips: [resuming.trip], selected: 0 };
      renderTransit();
      return resumeStart();
    }
    $('route-list').innerHTML = '';
    $('route-status').textContent = e.message;
  }
}

// Speed and heading when moving at train speed, so a trip planned on a train starts on it (src/lib/transit.js).
function movingNow() {
  const p = state.pos;
  return p && Date.now() - lastFixAt < 10_000 && (p.speed ?? 0) >= 6 && Number.isFinite(p.heading) ? { speed: p.speed, heading: p.heading } : null;
}

const WALK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4" r="2" fill="currentColor"/><path d="m9 21 2.5-7 2.5 2.5V21M8 11l2-4 4 1 2 4M11.5 14 10 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const lineChip = (l) => `<span class="t-line" style="background:${esc(l.line.color)};color:${esc(l.line.text)}">${esc(l.line.short)}</span>`;
const mins = (s) => formatDuration(Math.max(60, s));

function renderTransit() {
  const box = $('route-list');
  box.innerHTML = '';
  if (!transit.trips.length) return drawTransit();
  transit.trips.forEach((trip, i) => {
    const b = el('button', `route-opt t-opt${i === transit.selected ? ' on' : ''}`);
    const legs = trip.legs
      .filter((l) => l.mode === 'train' || l.duration >= 60)
      .map((l) => (l.mode === 'walk' ? `<span class="t-walk">${WALK_ICON}${Math.round(l.duration / 60)}</span>` : lineChip(l)))
      .join('<span class="t-sep">›</span>');
    const facts = [`arrive ${formatClock(new Date(trip.arrive))}`, trip.changes ? `${trip.changes} change${trip.changes > 1 ? 's' : ''}` : 'no changes'];
    if (trip.lastTrain) facts.push('<span class="t-last">last train</span>');
    const steps = i === transit.selected ? `<ol class="t-steps">${trip.legs.map(stepHtml).join('')}</ol>` : '';
    b.innerHTML = `<span class="r-time">${formatDuration(trip.duration)}</span><span class="r-info"><b>${facts.join(' · ')}</b><br><span class="t-legs">${legs}</span></span>${steps}`;
    b.onclick = () => {
      transit.selected = i;
      renderTransit();
    };
    box.append(b);
  });
  drawTransit();
  renderPeekSummary();
}

function stepHtml(l) {
  const units = state.settings.units;
  if (l.mode === 'walk') {
    const to = l.to.name === 'Destination' ? (dest?.name ?? 'your destination') : `${l.to.name} station`;
    return `<li><span>Walk to ${esc(to)}<small>${mins(l.duration)} · ${formatDistance(l.distance, units)}</small></span></li>`;
  }
  const when = (l.last ? '<b class="t-last">Last train</b> · ' : '') + (l.aboard ? 'You’re on it' : l.every ? `Every ${l.every} min` : `Train at ${formatClock(new Date(l.depart))}`);
  return `<li class="ride" style="--dot:${esc(l.line.color)}"><span>${lineChip(l)} ${l.aboard ? 'Stay on the ' : ''}${esc(l.line.name)} towards ${esc(l.towards)}
    <small>${when} · ${l.stops} stop${l.stops > 1 ? 's' : ''} to ${esc(l.to.name)}, ${mins(l.duration)}</small></span></li>`;
}

// The chosen trip on the map: walks dashed, rides in their line's colour, a dot where you get on and off.
function drawTransit() {
  const src = map?.getSource('transit');
  if (!src) return;
  const trip = transit?.trips[transit.selected];
  const features = [];
  for (const l of trip?.legs ?? []) {
    features.push({ type: 'Feature', properties: { mode: l.mode, color: l.line?.color ?? '#5f6b76' }, geometry: { type: 'LineString', coordinates: l.coords } });
    if (l.mode === 'train') for (const s of [l.from, l.to]) features.push({ type: 'Feature', properties: { mode: 'stop', color: l.line.color, name: s.name }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } });
  }
  src.setData({ type: 'FeatureCollection', features });
}

// ---------- Picking a trip up again ----------
// iPhones close a page in the background to save memory, and a trip in progress goes with it. The trip is kept on
// this phone while it runs; opening A2B again within a few hours offers to carry on, planned again from where you
// are then (a train trip offline: as it was, from the leg it had reached).
const RESUME_MS = 3 * 3600_000;
let resuming = null, resumeLeg = 0, savedLeg = -1;

function saveTrip(kind) {
  savedLeg = kind === 'ride' && guide ? guide.i : -1;
  local.set('activeTrip', { kind, travel, dest, at: Date.now(), ...(kind === 'ride' && guide && { trip: guide.trip, leg: guide.i }) });
}

function forgetTrip() {
  local.set('activeTrip', null);
  savedLeg = -1;
}

function offerResume() {
  const t = local.get('activeTrip');
  if (!t?.dest || mode !== 'browse') return;
  if (Date.now() - t.at > RESUME_MS) return forgetTrip();
  const what = t.kind === 'ride' ? 'train trip' : t.travel === 'walk' ? 'walk' : 'drive';
  const mins = Math.round((Date.now() - t.at) / 60_000);
  $('resume-title').textContent = `Continue to ${t.dest.name}?`;
  $('resume-sub').textContent = `Your ${what} stopped ${mins < 2 ? 'just now' : `${formatDuration(mins * 60)} ago`} when the app closed. It picks up from where you are now.`;
  $('resume').classList.remove('hidden');
  $('btn-resume-no').onclick = () => {
    forgetTrip();
    $('resume').classList.add('hidden');
  };
  $('btn-resume-go').onclick = () => {
    $('resume').classList.add('hidden');
    speak(`Continuing to ${t.dest.name}.`); // inside the tap: phones only allow speech that a tap started
    resuming = t;
    resumeLeg = 0;
    travel = t.kind === 'ride' ? 'transit' : t.travel === 'walk' ? 'walk' : 'drive';
    syncVehicle();
    openPreview(t.dest);
  };
}

// The routes (or trains) are in: start, as Go or Start would.
function resumeStart() {
  const t = resuming;
  resuming = null;
  if (travel === 'transit') {
    if (transit?.trips[0] === t.trip) resumeLeg = t.leg ?? 0; // the saved trip (offline): from its leg
    return startRide();
  }
  startDrive();
}

// ---------- Riding a train trip ----------
// "Start" on a train trip follows it (train-guide.js): the walk to the station, which train, the next station as the
// train goes (estimated underground from the timetable), "get off at the next stop", any change, and the walk at the
// end. A train marker in the line's colour shows where you are on a ride, the chevron on foot. The trip line stays
// drawn. Nothing from a train trip is shared as traffic or as a live trip. Works while A2B is open on screen.
const TRAIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="2.5" width="12" height="15" rx="3.5" fill="currentColor"/><rect x="8" y="5.5" width="8" height="4.5" rx="1" fill="#000" fill-opacity=".35"/><circle cx="9.2" cy="14" r="1.3" fill="#000" fill-opacity=".45"/><circle cx="14.8" cy="14" r="1.3" fill="#000" fill-opacity=".45"/><path d="m8.5 21.5 2-3.5m5 3.5-2-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
let guide = null, rideTimer = null, riderMarker = null, rideGpsBlocked = false, rideTimeShift = 0, rideStarted = 0;
// The guide moves you once a second; between those, every animation frame slides the train along the track (or the
// walking dot) and the camera with it, as driving does, so nothing jumps.
const rideGlide = new Glide();
let rideFrameId = 0, rideKind = null; // 'train' | 'chevron', what the last update showed
let rideZoom = null, rideFrameAt = 0; // the train camera's zoom, drifting like driving's (followDrive)
const RIDE_ZOOM = 15.4; // trains are quick: about as far out as driving at speed (driveZoom)
let compass = null, compassAt = 0; // which way the phone faces (degrees from north), for the walking dot
const rideNow = () => Date.now() + rideTimeShift;

function startRide() {
  const trip = transit?.trips[transit.selected];
  if (!trip || mode !== 'preview') return;
  autoGo.stop();
  mode = 'ride';
  drawPois(); // off the map while riding
  guide = new TrainGuide(trip, { now: rideNow(), leg: resumeLeg });
  resumeLeg = 0;
  rideStarted = rideNow();
  saveTrip('ride');
  carMarker.remove(); // the train or walking marker instead (and the 3D vehicle hides itself in this mode)
  if (vehicle3d) map.triggerRepaint();
  riderMarker ??= new maplibregl.Marker({ element: el('div', 'rider'), rotationAlignment: 'map', pitchAlignment: 'map' });
  for (const id of ['preview', 'later']) $(id).classList.add('hidden');
  $('ride-ui').classList.remove('hidden');
  document.body.classList.add('riding');
  armBack();
  follow = true;
  requestWakeLock();
  startCompass(); // inside the tap on Start: iOS only asks for the compass from a tap
  rideTick(); // its first update says how the trip starts: the walk, the train, or that you're already on it
  clearInterval(rideTimer);
  rideTimer = setInterval(rideTick, 1000);
}

function rideTick(say = null) {
  if (mode !== 'ride' || !guide) return;
  // Fresh: the last few seconds. Starting, the fix the trip was planned from will do: a phone standing still on the
  // platform may not send another for a while, and without one the trip can't see you're already there.
  const fresh = state.pos && !rideGpsBlocked && Date.now() - lastFixAt < (guide.begun ? 4000 : 120_000);
  const { view, events } = guide.update({ now: rideNow(), fix: fresh ? state.pos : null });
  if (!sayRide(events, say)) return;
  if (guide.i !== savedLeg) saveTrip('ride'); // a new leg: pick up from here if the phone cuts the trip off
  $('ride-off').classList.toggle('hidden', !view.off);
  if (view.off) replanRide();
  else replanNoted = false;
  renderRide(view);
}

// What the guide says, as one sentence (each speak cuts off the one before). False once you've arrived.
function sayRide(events, before = null) {
  if (events.some((e) => e.type === 'arrived')) {
    endRide(true);
    return false;
  }
  speak([before, ...events.map((e) => e.text)].filter(Boolean).join(' '));
  if (events.some((e) => e.type === 'alert' || e.type === 'alight' || e.type === 'change')) navigator.vibrate?.([300, 150, 300]);
  return true;
}

// Off the trip (another way on foot, off the platform, on another train): plan it again from where you are, as
// driving reroutes. The marker follows you meanwhile. Needs signal; offline, "I'm already here" still works.
const REPLAN_MS = 20_000;
let replanning = false, replanAt = 0, replanNoted = false;
async function replanRide() {
  if (replanning || !state.pos || !dest || Date.now() - replanAt < REPLAN_MS) return;
  replanAt = Date.now();
  if (!navigator.onLine) return noteReplan("You're offline, so the trip can't be planned again. Tap “I'm already here” to say where you are.");
  replanning = true;
  const place = dest;
  try {
    const plan = await api('/api/transit', { method: 'POST', body: { from: state.pos.lngLat, to: [place.lng, place.lat], moving: movingNow() } });
    if (mode !== 'ride' || !guide || dest !== place) return;
    if (!plan.trips.length) return noteReplan(plan.note || 'No train trip from here. Stay on the highlighted route.');
    transit = { place, trips: plan.trips, selected: 0 };
    drawTransit();
    guide = new TrainGuide(plan.trips[0], { now: rideNow() });
    saveTrip('ride');
    rideTick('Route recalculated.');
  } catch (e) {
    noteReplan(!navigator.onLine || e.status === 0 ? "You're offline, so the trip can't be planned again. Tap “I'm already here” to say where you are." : e.message);
  } finally {
    replanning = false;
  }
}
// Said once while off, not every try.
function noteReplan(msg) {
  if (!replanNoted) toast(msg, 4000);
  replanNoted = true;
}

// "I'm already here": you say where you are when GPS can't (underground, inside a station, no signal).
function rideHere(station = null) {
  if (mode !== 'ride' || !guide) return;
  if (!sayRide(guide.here({ now: rideNow(), station }))) return;
  rideTick();
}

// A station tapped in the list: what saying you're there would do (board the train, move you on, get you off), and
// "I'm here" to do it. The big button needs no asking: its label already says where.
function askHere(k) {
  if (mode !== 'ride' || !guide || guide.leg.mode !== 'train') return;
  const leg = guide.leg, at = guide.i, last = leg.stations.length - 1;
  const name = leg.stations[k][0], after = guide.trip.legs[at + 1];
  const waiting = guide.phase === 'wait';
  $('here-title').textContent = waiting ? (k ? `On the train, at ${name}?` : 'On the train?') : `You’re at ${name}?`;
  $('here-sub').textContent = k === last
    ? after?.mode === 'train' ? `That’s where you change, to the ${after.line.name}.` : 'That’s your stop: you get off here.'
    : waiting && !k ? `Leaving ${name} now. ${last} stop${last > 1 ? 's' : ''} to ${leg.to.name}.`
    : `${last - k} stop${last - k > 1 ? 's' : ''} to ${leg.to.name} from there.`;
  $('btn-here-yes').onclick = () => {
    $('here-confirm').classList.add('hidden');
    if (guide?.i === at) rideHere(k); // still on that train: the trip hasn't moved on (or been planned again) meanwhile
  };
  $('here-confirm').classList.remove('hidden');
  armBack();
}

const sentence = (t) => t.replace(/\.$/, '');

function renderRide(view) {
  const leg = view.leg;
  const units = state.settings.units;
  $('ride-banner').classList.toggle('alert', Boolean(view.alerted));
  const icon = $('ride-icon');
  if (leg.mode === 'train') {
    icon.style.setProperty('--line', leg.line.color);
    icon.style.setProperty('--line-text', leg.line.text);
    icon.textContent = leg.line.short;
  } else {
    icon.style.removeProperty('--line');
    icon.innerHTML = WALK_ICON;
  }
  if (view.kind === 'walk') {
    $('ride-title').textContent = formatDistance(view.left, units);
    $('ride-sub').textContent = sentence(walkText(leg));
  } else if (view.kind === 'wait') {
    $('ride-title').textContent = leg.every ? `Every ${leg.every} min` : `Train at ${formatClock(new Date(leg.depart))}`;
    $('ride-sub').textContent = `${leg.line.name} towards ${leg.towards}`;
  } else {
    $('ride-title').textContent = view.alerted ? `Get off at ${leg.to.name}` : `Next: ${view.next}`;
    $('ride-sub').textContent = view.alerted ? 'It’s the next stop' : `${view.stopsToGo} stop${view.stopsToGo > 1 ? 's' : ''} to ${leg.to.name}`;
  }
  $('ride-est').classList.toggle('hidden', !view.estimating);
  // When you'll get there, as driving's arrival time: by the train you're on (or waiting for), then the rest.
  const arrive = view.arrive ? new Date(view.arrive) : null;
  $('ride-eta').textContent = arrive ? `Arrive ${formatClock(arrive)} · ${formatDuration(Math.max(60, (view.arrive - rideNow()) / 1000))}` : '';
  // The closed sheet's one line: where you're going next.
  const peek = $('ride-peek');
  peek.style.setProperty('--dot', leg.line?.color ?? '#1c7ed6');
  peek.textContent = (view.kind === 'ride'
    ? (view.alerted ? `Get off at ${leg.to.name}` : `Next: ${view.next}`)
    : view.kind === 'wait' ? `${leg.line.name} towards ${leg.towards}` : sentence(walkText(leg))) + (arrive ? ` · arrive ${formatClock(arrive)}` : '');
  // The list: this ride's stations, or on foot what's left of the trip.
  const list = $('ride-stops');
  if (leg.mode === 'train') {
    const last = leg.stations.length - 1;
    const states = view.stations ?? leg.stations.map(([name], k) => ({ name, state: k === last ? 'alight' : k === 0 ? 'next' : 'later' }));
    list.style.setProperty('--dot', leg.line.color);
    list.innerHTML = states.map((x, k) => `<li class="${x.state}" data-k="${k}" aria-label="I'm at ${esc(x.name)}">${esc(x.name)}${x.state === 'alight' ? ' · get off' : ''}</li>`).join('');
  } else {
    list.style.removeProperty('--dot');
    list.innerHTML = guide.trip.legs.slice(guide.i).map((l) => (l.mode === 'walk'
      ? `<li class="walk">${esc(sentence(walkText(l)))}</li>`
      : `<li style="--dot:${esc(l.line.color)}">${esc(l.line.name)} to ${esc(l.to.name)}</li>`)).join('');
  }
  $('btn-ride-here').textContent = guide.hereText() ?? '';
  // Where you are: a train on the track, or on foot the chevron, turned the way you're going (also off the line,
  // following GPS while the trip is planned again).
  const kind = markerFor({ mode, legMode: view.kind === 'ride' && !view.off ? 'train' : 'walk' });
  const at = view.kind === 'walk' ? view.pos ?? state.pos?.lngLat : view.pos;
  const node = riderMarker.getElement();
  const heading = kind === 'train' ? view.heading ?? 0 : walkHeading(view);
  // On a train, the 3D train (vehicle3d.js) in the line's colour; the flat badge only if 3D isn't available.
  // rideFrame keeps its position and heading moving between updates.
  trainPose = kind === 'train' && at ? { ...(trainPose ?? { pos: at, heading }), color: leg.line.color } : null;
  const want = trainPose ? `train:${trainPose.color}` : null;
  if (want ? vehicleShown !== want : vehicleShown?.startsWith('train:')) setupVehicle();
  const flatTrain = kind === 'train' && !vehicle3d;
  node.classList.toggle('train', flatTrain); // classList, not className: MapLibre keeps its own classes on it
  node.classList.toggle('walker', kind === 'chevron');
  node.style.setProperty('--rider', leg.line?.color ?? '#1c7ed6');
  node.style.color = kind === 'chevron' ? 'var(--car)' : leg.line?.text ?? '#fff'; // the chevron in your colour
  node.innerHTML = flatTrain ? TRAIN_ICON : kind === 'chevron' ? CAR : '';
  if (kind === 'chevron') node.style.setProperty('--car', local.get('vehicleColor', DEFAULT_COLOR)); // your colour, as when driving
  if (vehicle3d) map.triggerRepaint();
  if (!at) return;
  if (kind === 'train' && vehicle3d) riderMarker.remove();
  else if (!riderMarker._map) riderMarker.setLngLat(at).setRotation(heading).addTo(map);
  // On the train the glide follows the track; on foot it slides straight between fixes.
  rideGlide.set(kind === 'train' ? { pos: at, heading, along: guide.along, path: guide.track } : { pos: at, heading }, performance.now());
  // Getting on or off a train: ease into that view once; after that the frames keep the camera on you.
  if (kind !== rideKind && follow && !userMoving && !touching) {
    const riding = kind === 'train';
    rideZoom = null;
    map.easeTo({ center: at, zoom: riding ? RIDE_ZOOM : 17, bearing: riding ? heading : map.getBearing(), pitch: riding ? 55 : 30, padding: ridePadding(), duration: 900 });
  }
  rideKind = kind;
  if (!rideFrameId) rideFrameId = requestAnimationFrame(rideFrame);
}

function rideFrame(now) {
  rideFrameId = 0;
  if (mode !== 'ride') return;
  const dt = rideFrameAt ? Math.min(now - rideFrameAt, 100) : FRAME_MS;
  rideFrameAt = now;
  const s = rideGlide.at(now);
  if (!s) return;
  if (rideKind === 'train' && trainPose) {
    trainPose.pos = s.pos;
    trainPose.heading = s.heading;
    if (vehicle3d) map.triggerRepaint();
  }
  if (riderMarker._map) riderMarker.setLngLat(s.pos).setRotation(rideKind === 'chevron' && compassFresh() ? compass : s.heading);
  let settling = false;
  if (follow && !userMoving && !touching && !map.isEasing()) {
    if (rideKind === 'train') {
      // As driving does (followDrive): behind the train, heading up, tilted, the zoom drifting rather than stepping.
      rideZoom = rideZoom == null ? map.getZoom() : rideZoom + (RIDE_ZOOM - rideZoom) * (1 - Math.exp(-dt / 700));
      map.jumpTo({ center: s.pos, bearing: s.heading, pitch: 55, zoom: rideZoom, padding: ridePadding() });
      settling = Math.abs(RIDE_ZOOM - rideZoom) > 0.01;
    } else map.jumpTo({ center: s.pos });
  } else rideZoom = null;
  if (!rideGlide.done(now) || settling) rideFrameId = requestAnimationFrame(rideFrame);
  else rideFrameAt = 0;
}

// The map left above the sheet, with you low in it like the car when driving, so more of the line ahead shows.
function ridePadding() {
  const bottom = Math.min(Math.round(innerHeight * 0.6), $('ride-sheet').offsetHeight + 10);
  return { top: Math.round((innerHeight - bottom) * 0.42), bottom, left: 0, right: 0 };
}


// Which way you're heading on foot: the compass when the phone has one, else the way GPS says you're moving, else
// towards where you're walking to.
const compassFresh = () => compass != null && Date.now() - compassAt < 3000;
function walkHeading(view) {
  if (compassFresh()) return compass;
  const p = state.pos;
  if (p && (p.speed ?? 0) > 0.7 && Number.isFinite(p.heading)) return p.heading;
  return view.heading ?? 0;
}

function onCompass(e) {
  // iOS gives a compass heading; Android an absolute alpha, counter-clockwise from north.
  const h = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null);
  if (h == null || !Number.isFinite(h)) return;
  compass = (h + (screen.orientation?.angle ?? 0)) % 360;
  compassAt = Date.now();
  if (rideKind === 'chevron' && riderMarker?._map) riderMarker.setRotation(compass);
}

function startCompass() {
  const listen = () => {
    addEventListener('deviceorientationabsolute', onCompass);
    addEventListener('deviceorientation', onCompass);
  };
  const ask = globalThis.DeviceOrientationEvent?.requestPermission; // iOS asks once
  if (ask) ask.call(DeviceOrientationEvent).then((r) => r === 'granted' && listen()).catch(() => {});
  else listen();
}

function stopCompass() {
  removeEventListener('deviceorientationabsolute', onCompass);
  removeEventListener('deviceorientation', onCompass);
  compass = null;
}

function endRide(arrived) {
  forgetTrip();
  $('here-confirm').classList.add('hidden');
  clearInterval(rideTimer);
  rideTimer = null;
  const name = dest?.name ?? '';
  const took = rideNow() - rideStarted;
  guide = null;
  rideGpsBlocked = false;
  rideTimeShift = 0;
  riderMarker?.remove();
  trainPose = null;
  cancelAnimationFrame(rideFrameId);
  rideFrameId = 0;
  rideKind = null;
  rideZoom = null;
  rideGlide.from = rideGlide.to = null; // the next trip starts where you are, not sliding from here
  rideSheet.set(false); // the next trip opens with its stops showing
  stopCompass();
  $('ride-ui').classList.add('hidden');
  $('btn-recenter-ride').classList.add('hidden');
  document.body.classList.remove('riding');
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  mode = 'browse';
  if (vehicleShown?.startsWith('train:')) setupVehicle();
  $('ride-off').classList.add('hidden');
  replanning = false;
  replanNoted = false;
  // Back to the vehicle from Settings (the chevron, unless the car was picked), where you are now. The 3D model
  // draws where the car's glide says, and fixes didn't move that during the trip: start it afresh from here, or
  // it stays where the trip began (often off screen) and you see no chevron at all.
  if (state.pos) {
    carMarker.setLngLat(state.pos.lngLat).setRotation(state.pos.heading ?? 0).addTo(map);
    glide.from = glide.to = null;
    moveCar({ pos: state.pos.lngLat, heading: state.pos.heading ?? 0 });
  }
  updateSpeedo(state.pos?.speed); // still showing the speed from before the trip
  if (vehicle3d) map.triggerRepaint();
  if (!arrived) return backToBrowse();
  speak('You have arrived.');
  $('arrived-name').textContent = name;
  $('arrived-stats').textContent = `By train in ${formatDuration(took / 1000)}`;
  $('arrived').classList.remove('hidden');
  $('browse-ui').classList.add('hidden');
  map.easeTo({ pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
}

// For testing on a phone against a local server: the trip's state, time moved on, and GPS cut and restored.
if (typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.__trainTest = {
    state: () => guide && { leg: guide.i, phase: guide.phase, along: Math.round(guide.along), alerted: guide.alerted, done: guide.done, shift: rideTimeShift / 1000 },
    advance: (seconds) => {
      rideTimeShift += seconds * 1000;
      rideTick();
    },
    loseGps: () => (rideGpsBlocked = true),
    restore: () => (rideGpsBlocked = false),
    // A GPS fix from the console, as the phone would give it: gps(101.71, 3.15, { speed: 14, accuracy: 10 }).
    gps: (lng, lat, { speed = null, accuracy = 10, heading = null } = {}) =>
      onFix({ coords: { longitude: lng, latitude: lat, speed, accuracy, heading }, timestamp: Date.now() }),
  };
}

// What the server did about closures, worth a line under the route options.
function routeNote(rs) {
  if (rs.closuresIgnored) return "Couldn't find a way around a reported closure, so these routes may pass it.";
  if (rs.constructionAvoided) return 'Avoiding a road that looks to be under construction.';
  return '';
}

async function requestRoutes(from, to, heading, via = []) {
  const s = state.settings;
  const { routes: rs, closures_ignored: closuresIgnored, construction_avoided: constructionAvoided } = await api('/api/route', {
    method: 'POST',
    body: {
      from, to, heading, travel,
      via: via.map((p) => [p.lng, p.lat]),
      units: s.units,
      lang: navigator.language || 'en-US',
      avoid: { tolls: s.avoid_tolls, highways: s.avoid_highways, ferries: s.avoid_ferries },
    },
  });
  for (const r of rs) r.cum = cumulative(r.coords);
  return Object.assign(rs, { closuresIgnored, constructionAvoided });
}

// Room the map leaves for the route sheet: its real height on a phone, so a collapsed sheet shows more map.
function sheetPadding() {
  if (innerWidth >= 720) return { top: 60, bottom: 60, left: 460, right: 60 };
  const sheet = $('preview');
  const h = sheet.classList.contains('hidden') ? Math.min(innerHeight * 0.5, 380) : sheet.offsetHeight + 24;
  return { top: 60, bottom: Math.min(h, innerHeight - 160), left: 40, right: 40 };
}

// Tapping a route line picks it. Lines are thin, so look a fingertip around the tap, and prefer an alternative
// over the route already chosen where they run together.
function routeAtTap(e) {
  if (mode !== 'preview' || routes.length < 2) return;
  const r = 18;
  const hits = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ['routes-alt', 'routes-alt-casing', 'routes-main', 'routes-casing'] });
  const idx = hits.map((f) => f.properties.idx).find((i) => i !== selected) ?? hits[0]?.properties.idx;
  if (idx != null && idx !== selected) selectRoute(idx);
}

// The route sheet can be pulled down to a slim bar (destination, chosen route, Go) to see the routes on the
// map, and pushed back up. It follows the finger like an iPhone sheet: while dragging, its height tracks
// the finger (the route list shrinks, the header and Go stay put); a flick or a long enough drag settles it.
function setupSheetDrag() {
  collapsibleSheet($('preview'), $('route-list'), () => mode === 'preview' && routes.length && fitRoutes());
  collapsibleSheet($('parking'), $('parking-list'), fitParking);
}

// A sheet that can be pulled down to a slim bar to see the map, and pushed back up. It follows the finger
// like an iPhone sheet: while dragging, its height tracks the finger (the list shrinks, the header stays
// put); a flick or a long enough drag settles it. settled() runs once it has, e.g. to refit the map.
function collapsibleSheet(sheet, list, settled) {
  let fullH = 0, peekH = 0, startH = 0, timer = null;
  const peeked = () => sheet.classList.contains('peek');
  // Both heights, measured by flipping the layout for a moment (no paint happens in between).
  const measure = () => {
    const was = peeked();
    sheet.classList.remove('peek');
    fullH = sheet.offsetHeight;
    sheet.classList.add('peek');
    peekH = sheet.offsetHeight;
    sheet.classList.toggle('peek', was);
  };
  const set = (peek, animate = true) => {
    clearTimeout(timer);
    const done = () => {
      sheet.classList.remove('dragging', 'settling');
      sheet.style.height = '';
      sheet.classList.toggle('peek', peek);
      requestAnimationFrame(settled);
    };
    if (!animate || !sheet.classList.contains('dragging')) return done();
    sheet.classList.add('settling');
    sheet.style.height = `${peek ? peekH : fullH}px`;
    timer = setTimeout(done, 300);
  };
  sheet.querySelector('.grabber').onclick = () => set(!peeked());
  sheetGesture(sheet, {
    // Not from inside a list that scrolls: that drag scrolls it (the header still pulls the sheet). Taking it as a
    // pull let the sheet snap back on release and the list never moved.
    start: (e) => !(e.target.closest(`#${list.id}`) && (list.scrollTop > 0 || list.scrollHeight > list.clientHeight + 1)),
    move: (dy) => {
      if (!sheet.classList.contains('dragging')) {
        measure();
        startH = peeked() ? peekH : fullH;
        sheet.classList.remove('peek');
        sheet.classList.add('dragging');
      }
      sheet.style.height = `${Math.round(rubberBand(startH - dy, peekH, fullH))}px`;
    },
    end: (dy, v) => set(!settle(startH === fullH, dy, v, fullH - peekH)),
  });
}

// One line for the collapsed sheet: "44 min · 30 km · 3 tolls".
function renderPeekSummary() {
  const t = travel === 'transit' ? transit?.trips[transit.selected] : null;
  if (travel === 'transit') {
    $('peek-summary').textContent = t
      ? [formatDuration(t.duration), `arrive ${formatClock(new Date(t.arrive))}`, t.changes ? `${t.changes} change${t.changes > 1 ? 's' : ''}` : 'no changes'].join(' · ')
      : '';
    return;
  }
  const r = routes[selected];
  $('peek-summary').textContent = r
    ? [formatDuration(r.duration), formatDistance(r.distance, state.settings.units), r.tolls?.length ? tollSummary(r.tolls) : r.toll ? 'Toll' : ''].filter(Boolean).join(' · ')
    : '';
}

function fitRoutes() {
  const b = new maplibregl.LngLatBounds();
  for (const r of routes) for (const c of r.coords) b.extend(c);
  if (!b.isEmpty()) fitTo(b, { padding: sheetPadding(), duration: 700, maxZoom: 16 });
  drawRouteLabels();
}

function drawRouteLabels() {
  routeLabels.splice(0).forEach((m) => m.remove());
  if (mode !== 'preview') return;
  routes.forEach((r, i) => {
    // Put each label where this route differs from the others, roughly 40-60% of the way.
    const at = r.coords[Math.floor(r.coords.length * (0.4 + i * 0.1))] ?? r.coords[0];
    const label = el('div', `route-label${i === selected ? ' on' : ''}`, esc(formatDuration(r.duration)));
    label.onclick = (e) => {
      e.stopPropagation();
      selectRoute(i);
    };
    routeLabels.push(new maplibregl.Marker({ element: label }).setLngLat(at).addTo(map));
  });
}

function renderRouteOptions() {
  const box = $('route-list');
  box.innerHTML = '';
  const fastest = Math.min(...routes.map((r) => r.duration));
  routes.forEach((r, i) => {
    const b = el('button', `route-opt${i === selected ? ' on' : ''}`);
    const badges = [];
    if (r.duration === fastest && routes.length > 1) badges.push('<span class="badge best">Fastest</span>');
    if (r.tolls?.length) badges.push(`<span class="badge warn">${esc(tollSummary(r.tolls))}</span>`);
    else if (r.toll) badges.push('<span class="badge warn">Toll</span>');
    if (r.ferry) badges.push('<span class="badge warn">Ferry</span>');
    const reps = (r.reports ?? []).length;
    if (reps) badges.push(`<span class="badge">${reps} report${reps > 1 ? 's' : ''}</span>`);
    // Why slow, and whose word it is: live traffic, hand-reported jams, or other drivers' speeds.
    if ((r.traffic?.delay ?? 0) >= 60) badges.push(`<span class="badge warn">+${formatDuration(r.traffic.delay)} traffic</span>`);
    if ((r.delay ?? 0) >= 60) badges.push(`<span class="badge warn">+${formatDuration(r.delay)} slow (reports)</span>`);
    if ((r.probe_delay ?? 0) >= 60) badges.push(`<span class="badge warn">+${formatDuration(r.probe_delay)} slow (driver speeds)</span>`);
    if (r.warning === 'construction') badges.push('<span class="badge warn">May pass roadworks</span>');
    b.innerHTML = `<span class="r-time">${formatDuration(r.duration)}</span><span class="r-info"><b>${r.via ? `via ${esc(r.via)}` : 'Route'} </b>${formatDistance(r.distance, state.settings.units)} · arrive ${formatClock(new Date(Date.now() + r.duration * 1000))}<br>${badges.join('')}</span>`;
    b.onclick = () => selectRoute(i);
    box.append(b);
  });
}

// Like Waze, the route sheet sets off on the chosen route by itself after a short wait. Picking another route
// starts the wait again for that one; moving the map, Leave later or closing the sheet stops it.
const AUTO_GO_S = 8;
const autoGo = (() => {
  let timer = null, left = 0;
  const go = () => $('btn-go');
  const label = () => (go().innerHTML = timer ? `Go now <span class="go-count">${left}</span>` : 'Go now');
  const stop = () => {
    clearInterval(timer);
    timer = null;
    go().classList.remove('counting');
    label();
  };
  const blocked = () => !canAutoStartRoute({
    mode,
    travel,
    routeAvailable: Boolean(routes[selected]),
    hasLocation: Boolean(state.pos),
    buttonDisabled: go().disabled,
    pageHidden: document.hidden,
    blockingOverlayOpen: ['later', 'panel', 'search', 'auth'].some((id) => !$(id).classList.contains('hidden')),
    closuresIgnored: routes.closuresIgnored,
  });
  const restart = () => {
    stop();
    if (blocked()) return; // warnings need an explicit Go now; without a location the route starts from the map
    left = AUTO_GO_S;
    void go().offsetWidth; // restart the fill animation
    go().classList.add('counting');
    timer = setInterval(() => {
      if (blocked()) return stop();
      if (--left > 0) return label();
      stop();
      startDrive();
    }, 1000);
    label();
  };
  return { restart, stop };
})();

function selectRoute(i) {
  selected = Number(i);
  renderRouteOptions();
  renderPeekSummary();
  drawRoutes();
  drawRouteLabels();
  autoGo.restart();
}

// Back to Drive when the preview closes or the trip ends (see travel).
function resetTravel() {
  travel = 'drive';
  syncVehicle(); // back to your usual vehicle after a walk
}

function backToBrowse() {
  autoGo.stop();
  mode = 'browse';
  resetTravel();
  transit = null;
  drawTransit();
  schedulePois();
  routes = [];
  dest = null;
  origin = null; // the next trip starts where you are again
  originMarker?.remove();
  destMarker?.remove();
  dropMarker?.remove();
  routeLabels.splice(0).forEach((m) => m.remove());
  drawRoutes();
  for (const id of ['preview', 'later', 'drive-ui', 'arrived', 'report-card']) $(id).classList.add('hidden');
  $('browse-ui').classList.remove('hidden');
  document.body.classList.remove('driving', 'walking');
  follow = true;
  $('btn-recenter').classList.add('following');
  map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, ...(state.pos ? { center: state.pos.lngLat, zoom: 15.5 } : {}), duration: 700 });
  if (state.pos) carMarker.setLngLat(state.pos.lngLat).setRotation(state.pos.heading ?? 0);
}

// ================= Leave later =================
let laterMode = 'leave';

function openLater() {
  autoGo.stop();
  if (travel === 'transit' ? !transit?.trips.length : !routes[selected]) return toast(travel === 'transit' ? 'Wait for the trains first.' : 'Wait for the route first.');
  $('later').classList.remove('hidden');
  armBack();
  const input = $('later-time');
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  input.value = toLocalInput(d);
  document.querySelectorAll('[data-later]').forEach((b) => {
    b.onclick = () => {
      laterMode = b.dataset.later;
      document.querySelectorAll('[data-later]').forEach((x) => x.classList.toggle('on', x === b));
      updateLater();
    };
  });
  let t;
  input.oninput = () => {
    clearTimeout(t);
    t = setTimeout(updateLater, travel === 'transit' ? 400 : 0); // trains are asked of the server: not on every key
  };
  $('btn-later-remind').onclick = downloadCalendar;
  laterTrip = null;
  updateLater();
}

function laterTimes() {
  const r = routes[selected];
  const t = new Date($('later-time').value);
  const ms = r.duration * 1000;
  return laterMode === 'leave' ? { leave: t, arrive: new Date(+t + ms) } : { leave: new Date(+t - ms), arrive: t };
}

function updateLater() {
  if (travel === 'transit') return updateLaterTrains();
  if (!routes[selected] || Number.isNaN(+new Date($('later-time').value))) return;
  const { leave, arrive } = laterTimes();
  $('later-result').innerHTML = `Leave <b>${formatClock(leave)}</b>, arrive around <b>${formatClock(arrive)}</b>.<br><small class="hint">Based on today's typical drive time of ${formatDuration(routes[selected].duration)}.</small>`;
}

// By train, the trains that run then (the timetable changes through the day and at night), not today's trip moved.
// "Arrive by" asks for a time that early, then earlier by however late that trip gets in, so it's the last one in time.
let laterTrip = null, laterSeq = 0;
async function updateLaterTrains() {
  const want = +new Date($('later-time').value);
  if (Number.isNaN(want)) return;
  const seq = ++laterSeq;
  laterTrip = null;
  $('later-result').innerHTML = '<span class="spinner" aria-hidden="true"></span>Finding trains…';
  const from = origin ? [origin.lng, origin.lat] : state.pos?.lngLat ?? map.getCenter().toArray();
  const ask = (at) => api('/api/transit', { method: 'POST', body: { from, to: [dest.lng, dest.lat], at } });
  try {
    let plan = await ask(laterMode === 'leave' ? want : want - (transit.trips[0]?.duration ?? 1800) * 1000);
    for (let k = 0; laterMode === 'arrive' && plan.trips[0]?.arrive > want && k < 2; k++) {
      plan = await ask(plan.trips[0].depart - (plan.trips[0].arrive - want) - 60_000);
    }
    if (seq !== laterSeq) return;
    const trip = plan.trips[0];
    if (!trip) return void ($('later-result').textContent = plan.note || 'No trains then.');
    laterTrip = trip;
    const last = trip.lastTrain ? ' <b class="t-last">Last train</b>' : '';
    $('later-result').innerHTML = `Leave <b>${formatClock(new Date(trip.depart))}</b>, arrive around <b>${formatClock(new Date(trip.arrive))}</b>.${last}
      <ol class="t-steps">${trip.legs.map(stepHtml).join('')}</ol><small class="hint">From the official timetables.</small>`;
  } catch (e) {
    if (seq === laterSeq) $('later-result').textContent = e.message;
  }
}

function downloadCalendar() {
  if (travel === 'transit' && !laterTrip) return toast('Wait for the trains first.');
  const byTrain = travel === 'transit';
  const { leave, arrive } = byTrain ? { leave: new Date(laterTrip.depart), arrive: new Date(laterTrip.arrive) } : laterTimes();
  // By train, the steps go in the event: which line, which way, where to change.
  const steps = byTrain ? laterTrip.legs.map((l) => (l.mode === 'walk' ? sentence(walkText(l)) : `${l.line.name} towards ${l.towards} to ${l.to.name}`)).join('\n') : '';
  const ical = (t) => t.replace(/[,;\\]/g, (c) => `\\${c}`).replace(/\n/g, '\\n'); // calendar text: escaped, lines as \n
  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const link = `${location.origin}/?to=${dest.lat},${dest.lng}&name=${encodeURIComponent(dest.name)}`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//A2B//Leave later//EN', 'BEGIN:VEVENT',
    `UID:${Date.now()}@a2b`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(leave)}`, `DTEND:${stamp(arrive)}`,
    `SUMMARY:${byTrain ? 'Train' : 'Drive'} to ${dest.name.replace(/[,;\n]/g, ' ')}`, `DESCRIPTION:${steps ? `${ical(steps)}\\n` : ''}Open in A2B: ${link}`, `URL:${link}`,
    'BEGIN:VALARM', 'TRIGGER:-PT10M', 'ACTION:DISPLAY', 'DESCRIPTION:Time to leave soon', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = byTrain ? 'a2b-train.ics' : 'a2b-drive.ics';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Added: open the file to put it in your calendar.');
  $('later').classList.add('hidden');
}

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ================= Driving =================
function startDrive() {
  autoGo.stop();
  const route = routes[selected];
  if (!route) return;
  mode = 'drive';
  drawPois(); // off the map while driving
  trail = [];
  offTrail = [];
  drawTrail();
  tollsSpoken.clear();
  camerasWarned.clear();
  $('toll-chip').classList.add('hidden');
  startTunnelWatch();
  nav = new Navigator(route, { units: state.settings.units });
  nav.spoken.add('depart');
  live = null;
  stops = [];
  renderStopMenu();
  alerted.clear();
  driveStarted = Date.now();
  saveTrip('drive');
  routeLabels.splice(0).forEach((m) => m.remove());
  $('preview').classList.add('hidden');
  $('later').classList.add('hidden');
  $('drive-ui').classList.remove('hidden');
  tripSheet.set(false);
  $('alert').classList.add('hidden');
  document.body.classList.add('driving');
  document.body.classList.toggle('walking', travel === 'walk');
  armBack();
  follow = true;
  $('btn-recenter-drive').classList.add('hidden');
  // Speak inside the tap so mobile browsers allow audio for the rest of the drive.
  speak(route.steps[0]?.pre);
  addPlace('recent', dest).then(renderSearchHome).catch(() => {});
  computeOnRoute();
  loadReports(true);
  requestWakeLock();
  // Save the corridor's map tiles while still online, so dead spots show map, not blank.
  if (local.get('offlineMaps', true)) {
    prefetchRouteTiles(route.coords, () => map.getStyle())
      .then(({ fetched }) => { if (fetched > 50) toast('Map saved along this route — it keeps showing without signal.'); })
      .catch(() => {});
  }

  const useSim = state.simulate || (!state.pos && state.tester);
  if (useSim) {
    if (!state.simulate) toast('No GPS signal, so this is a demo drive.', 3500);
    startSimulation(route);
  } else if (state.pos) driveTick(state.pos);
  else toast('Waiting for GPS…', 3500); // directions start with the first fix
  driveCamera();
}

function renderSimSpeed() {
  $('btn-sim-speed').classList.toggle('hidden', !sim);
  $('sim-speed-label').textContent = `Demo speed: ${local.get('simSpeed', 1)}×`;
}

function startSimulation(route) {
  stopSimulation();
  sim = new Simulator(route, { speedFactor: local.get('simSpeed', 1) });
  renderSimSpeed();
  const step = () => {
    const f = sim.next();
    handleFix({ lngLat: f.position, heading: f.heading, speed: f.speed, accuracy: f.accuracy, time: Date.now() });
    if (f.done) stopSimulation();
  };
  step();
  simTimer = setInterval(step, 1000);
}

function stopSimulation() {
  clearInterval(simTimer);
  simTimer = null;
  sim = null;
  renderSimSpeed();
}

function driveTick(fix) {
  if (!nav) return;
  live = nav.update({ position: fix.lngLat, heading: fix.heading, speed: fix.speed, accuracy: fix.accuracy });
  const heading = (fix.speed ?? 0) > 1.5 && fix.heading != null ? fix.heading : live.routeBearing;
  moveCar({ pos: live.snapped, heading, along: live.along, path: nav });
  renderBanner();
  renderEta();
  if (travel !== 'walk') renderLimit(live.limit, fix.speed);
  drawDriveLine();
  drawManeuverArrow();
  if (live.prompt) speak(live.prompt);
  // Tolls, speed cameras and road reports ahead are for drivers.
  if (travel !== 'walk') {
    checkTolls();
    checkCameras();
    checkAlerts();
  }
  if (share && !fix.estimated) pushShare(); // viewers see the last real position, not a guess

  const stopStep = nav.steps.findIndex((st) => st.type === 'stop');
  if (stops.length && stopStep >= 0 && live.stepIndex >= stopStep) {
    toast(`Reached ${stops.shift().name}`);
    renderStopMenu();
  }

  $('offroute').classList.toggle('hidden', !live.offRoute);
  setOffrouteNote(live.offRoute);
  if (live.offRoute && (!offTrail.length || distance(offTrail.at(-1), fix.lngLat) > 5)) offTrail.push(fix.lngLat);
  if (live.offRoute) reroute(fix);
  if (live.arrived) arrive();
}

// ---------- Tunnel mode ----------
// When the GPS goes quiet in a tunnel (or anywhere, while moving), keep the car going along the route at its last
// speed, so the banner, distances and the turn after the tunnel keep coming. See dead-reckoning.js.
let reckoner = null, tunnelTimer = null, tunnelFixAt = 0, lastFixAccuracy = null, lastGoodSpeed = 0, gpsBlocked = false;

function tunnelAhead() {
  return Boolean(nav && live && nearTunnel(live.along, nav.cum, nav.route.tunnels));
}

function startTunnelWatch() {
  stopTunnelWatch();
  tunnelFixAt = Date.now();
  lastFixAccuracy = null;
  lastGoodSpeed = 0;
  tunnelTimer = setInterval(tunnelTick, 1000);
}

function stopTunnelWatch() {
  clearInterval(tunnelTimer);
  tunnelTimer = null;
  stopReckoning();
}

function stopReckoning() {
  reckoner = null;
  $('dr-chip')?.classList.add('hidden');
}

function tunnelTick() {
  if (mode !== 'drive' || sim || !nav || !live || live.offRoute) return;
  const now = Date.now();
  if (!reckoner) {
    if (!shouldEstimate({ sinceFixMs: now - tunnelFixAt, accuracy: lastFixAccuracy, speed: lastGoodSpeed, tunnel: tunnelAhead() })) return;
    reckoner = new DeadReckoner({ along: live.along, speed: lastGoodSpeed, now: now - 1000 });
    $('dr-chip').classList.remove('hidden');
  }
  const est = reckoner.advance(now, live.limit);
  if (est.done) return stopReckoning(); // too long without a fix to guess: the car waits where it is, as before
  const { point, bearing: heading } = pointAt(nav.coords, nav.cum, est.along);
  updateSpeedo(est.speed);
  driveTick({ lngLat: point, heading, speed: est.speed, accuracy: 5, time: now, estimated: true });
}

// For testing on a phone or the Simulator: pretend the GPS has gone, then bring it back.
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.__tunnelTest = {
    loseGps: () => (gpsBlocked = true),
    restore: () => (gpsBlocked = false),
    state: () => ({ estimating: Boolean(reckoner), along: live?.along, tunnels: nav?.route.tunnels ?? [] }),
  };
}

// Glide the camera into the driving view (start of a drive, Recenter); frames take over from there.
function driveCamera() {
  if (!live) return;
  const at = shown ?? { pos: live.snapped, heading: live.routeBearing };
  camZoom = null;
  map.easeTo({ center: at.pos, bearing: at.heading, pitch: 55, zoom: driveZoom(), padding: drivePadding(), duration: 600 });
}

function driveZoom() {
  const speed = state.pos?.speed ?? 0;
  return speed > 25 ? 15.3 : speed > 15 ? 16 : 16.8;
}

const drivePadding = () => ({ top: Math.round(innerHeight * 0.42), bottom: 110, left: 0, right: 0 });

// A step's arrow; roundabouts are drawn with their real exit direction (cached per step).
const roundaboutIcons = new WeakMap();
function stepIcon(step) {
  if (step.type !== 'roundabout' || !nav) return turnIcon(step.type);
  if (!roundaboutIcons.has(step)) {
    const turn = roundaboutTurn(nav.coords, nav.cum, nav.steps, nav.steps.indexOf(step));
    roundaboutIcons.set(step, turn ? roundaboutIcon(turn) : turnIcon(step.type));
  }
  return roundaboutIcons.get(step);
}

function renderBanner() {
  const { next, distToNext, then } = live;
  $('turn-icon').innerHTML = stepIcon(next);
  $('turn-dist').textContent = formatDistance(distToNext, state.settings.units);
  let street = next.street || next.instruction.replace(/\.$/, '');
  if (next.type === 'roundabout' && next.exit) street = `${ordinal(next.exit)} exit${next.street ? ` · ${next.street}` : ''}`;
  if (next.type.startsWith('arrive')) street = dest?.name || 'Destination';
  if (next.type === 'stop') street = stops[0]?.name || 'Your stop';
  $('turn-street').textContent = street;
  renderSign(next.sign);
  $('then').classList.toggle('hidden', !then);
  if (then) $('then-icon').innerHTML = stepIcon(then);
  renderLanes(next, distToNext);
}

// An exit's overhead sign, Malaysian style: a green panel with the exit number, the road it leads onto and where
// it goes ("EXIT 218 · 241 · Seremban / Labu"). It stands in for the street line when it names places.
function renderSign(sign) {
  const box = $('turn-sign');
  const places = signPlaces(sign);
  box.classList.toggle('hidden', !sign);
  $('turn-street').classList.toggle('hidden', Boolean(places));
  if (!sign) return;
  box.innerHTML = [
    sign.exit ? `<span class="sign-exit">EXIT ${esc(sign.exit)}</span>` : '',
    ...(sign.roads ?? []).map((r) => `<span class="sign-road">${esc(r)}</span>`),
    places ? `<span class="sign-to">${esc(places)}</span>` : '',
  ].join('');
}

// Which lanes to be in, shown as you get close to the turn.
let lanesFor = null;
function renderLanes(next, distToNext) {
  const box = $('lanes');
  const show = Boolean(next.lanes) && distToNext < 1000;
  box.classList.toggle('hidden', !show);
  if (!show || lanesFor === next) return;
  lanesFor = next;
  box.innerHTML = next.lanes.map((l) => `<span class="lane">${laneIcon(l)}</span>`).join('');
}

// Posted limit sign next to the speedometer; the speedometer goes red when clearly over it.
function renderLimit(kmh, speed) {
  const sign = $('limit');
  const imperial = state.settings.units === 'imperial';
  sign.classList.toggle('hidden', !kmh);
  $('speedo').classList.remove('fast');
  if (!kmh) return;
  const shown = imperial ? Math.round(kmh / 1.609344 / 5) * 5 : kmh;
  sign.querySelector('b').textContent = shown;
  sign.classList.toggle('us', imperial);
  const over = (speed ?? 0) * 3.6 > kmh * 1.05 + 3;
  $('speedo').classList.toggle('fast', over && state.settings.speed_warning !== false);
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function renderEta() {
  const { remaining, remainingTime } = live;
  $('eta-clock').textContent = formatClock(new Date(Date.now() + remainingTime * 1000));
  const mins = Math.max(1, Math.round(remainingTime / 60));
  if (mins >= 60) {
    $('eta-min').textContent = `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
    $('eta-min-unit').textContent = 'hr';
  } else {
    $('eta-min').textContent = mins;
    $('eta-min-unit').textContent = 'min';
  }
  const [n, u] = formatDistance(remaining, state.settings.units).split(' ');
  $('eta-dist').textContent = n;
  $('eta-dist-unit').textContent = u;
}

// Off route with no connection, "Recalculating…" is a lie: say what's actually wrong instead.
function setOffrouteNote(offRoute) {
  const el = $('offroute');
  const offline = offRoute && !navigator.onLine;
  if (offline && !el.dataset.offline) {
    el.dataset.offline = '1';
    el.textContent = 'No connection — rejoin the highlighted route.';
  } else if (!offline && el.dataset.offline) {
    delete el.dataset.offline;
    el.innerHTML = '<span class="spinner" aria-hidden="true"></span>Recalculating…';
  }
}

async function reroute(fix, { force = false, note } = {}) {
  if (rerouting || (!force && Date.now() - lastReroute < REROUTE_GAP_MS) || !dest) return;
  rerouting = true;
  lastReroute = Date.now();
  try {
    const rs = await requestRoutes(fix.lngLat, [dest.lng, dest.lat], fix.heading ?? undefined, stops);
    if (mode !== 'drive') return;
    keepTrail(fix.lngLat);
    nav = new Navigator(rs[0], { units: state.settings.units });
    nav.spoken.add('depart');
    computeOnRoute();
    loadReports(true);
    if (sim) startSimulation(rs[0]);
    speak(note ?? 'Route recalculated.');
    if (rs.closuresIgnored) toast("Couldn't find a way around a reported closure.");
    if (share) pushShare(true);
  } catch (e) {
    // The common mid-drive failure is a dead spot: say so, and keep guiding on the loaded route.
    if (!navigator.onLine || e.status === 0) toast("You're offline, so the route can't be recalculated. Stay on the highlighted route.", 4000);
    else toast(e.message);
  } finally {
    rerouting = false;
  }
}

async function addStop(place) {
  if (mode !== 'drive' || !state.pos) return;
  stops = [place];
  renderStopMenu();
  toast(`Adding a stop at ${place.name}…`);
  await reroute(state.pos, { force: true, note: `Stop added. Going via ${place.name}.` });
  if (stopMarker) stopMarker.remove();
  stopMarker = new maplibregl.Marker({ element: el('div', 'drop-pin', DROP_PIN), anchor: 'bottom' }).setLngLat([place.lng, place.lat]).addTo(map);
}

// ---------- Parking near the destination ----------
// Like Waze: from the trip menu, see the car parks around where you're going (or around the place itself)
// and drive to one instead. The place you were going to is kept, so you can switch back.
let parkingFor = null; // the original destination while heading for a car park
let parkingPins = [];
let parkingBounds = null; // the car parks and the destination, for framing the map

async function openParking() {
  tripSheet.set(false);
  const target = parkingFor ?? dest;
  if (!target) return;
  $('parking-for').textContent = `Around ${target.name}`;
  $('parking-list').innerHTML = '';
  $('parking-peek').textContent = '';
  $('parking-status').innerHTML = '<span class="spinner" aria-hidden="true"></span>Looking for car parks…';
  $('parking').classList.remove('hidden', 'peek');
  armBack();
  try {
    const { parking } = await api(`/api/parking?lat=${target.lat}&lng=${target.lng}`);
    if ($('parking').classList.contains('hidden')) return;
    renderParking(target, parking);
  } catch (e) {
    $('parking-status').textContent = e.message;
  }
}

function renderParking(target, list) {
  const box = $('parking-list');
  box.innerHTML = '';
  const row = (badge, cls, name, info, on, pick) => {
    const li = el('li', on ? 'on' : '');
    const b = el('button', '', `<span class="p-badge ${cls}">${badge}</span><span><b>${esc(name)}</b><small>${esc(info)}</small></span>`);
    b.onclick = pick;
    li.append(b);
    box.append(li);
  };
  if (parkingFor) row(DEST_PIN, 'dest', `Drive to ${parkingFor.name}`, 'Go back to your destination', false, () => chooseParking(null));
  for (const p of list) {
    const info = [p.distance < 60 ? 'At your destination' : `${formatDistance(p.distance, state.settings.units)} away`,
      p.kind, p.fee === true ? (p.charge ? `Paid · ${p.charge}` : 'Paid') : p.fee === false ? 'Free' : null,
      p.capacity ? `${p.capacity} spaces` : null, p.customers ? 'Customers only' : null].filter(Boolean).join(' · ');
    row('P', '', p.name, info, dest && dest.lat === p.lat && dest.lng === p.lng, () => chooseParking(p));
  }
  $('parking-status').textContent = list.length ? '' : `No car parks mapped within 1 km of ${target.name}.`;
  $('parking-peek').textContent = list.length ? `${list.length} car park${list.length === 1 ? '' : 's'} · tap a P on the map` : '';
  showParkingPins(target, list);
}

// P markers on the map while choosing, framed with the destination.
function showParkingPins(target, list) {
  clearParkingPins();
  if (!list.length) return;
  parkingBounds = new maplibregl.LngLatBounds([target.lng, target.lat], [target.lng, target.lat]);
  for (const p of list) {
    const pin = el('div', 'p-pin', 'P');
    pin.onclick = () => chooseParking(p);
    parkingPins.push(new maplibregl.Marker({ element: pin }).setLngLat([p.lng, p.lat]).addTo(map));
    parkingBounds.extend([p.lng, p.lat]);
  }
  fitParking();
}

// Frames the car parks above the sheet, whatever its height (pulled down, there's room for all of them).
function fitParking() {
  if (!parkingBounds || $('parking').classList.contains('hidden')) return;
  stopFollowing();
  clearTimeout(recenterTimer); // stay on the car parks until one is picked or the sheet is closed
  fitTo(parkingBounds, { padding: { top: 160, bottom: Math.min(innerHeight * 0.6, $('parking').offsetHeight + 40), left: 50, right: 50 }, pitch: 0, bearing: 0, duration: 600, maxZoom: 17 });
}

function clearParkingPins() {
  parkingBounds = null;
  parkingPins.splice(0).forEach((m) => m.remove());
}

function closeParking() {
  clearParkingPins();
  if (mode === 'drive') recenter();
}

async function chooseParking(p) {
  $('parking').classList.add('hidden');
  closeParking();
  if (p) {
    parkingFor ??= dest;
    dest = { name: p.name, address: `Parking for ${parkingFor.name}`, lat: p.lat, lng: p.lng, category: 'parking' };
  } else if (parkingFor) {
    dest = parkingFor;
    parkingFor = null;
  }
  destMarker?.setLngLat([dest.lng, dest.lat]);
  $('parking-label').textContent = parkingFor ? 'Change parking' : 'Parking nearby';
  renderStopMenu();
  if (state.pos) await reroute(state.pos, { force: true, note: p ? `Going to ${p.name}.` : `Going to ${dest.name}.` });
}

async function removeStop() {
  stops = [];
  stopMarker?.remove();
  stopMarker = null;
  renderStopMenu();
  if (state.pos) await reroute(state.pos, { force: true, note: 'Stop removed.' });
}

function renderStopMenu() {
  $('add-stop-label').textContent = stops.length ? `Remove stop (${stops[0].name})` : 'Add a stop';
  // Where this drive is going, so it's easy to check the right place was picked.
  $('trip-dest').innerHTML = dest
    ? `<span class="trip-pin">${DEST_PIN}</span><span><b>${esc(dest.name)}</b><small>${esc([stops[0] && `via ${stops[0].name}`, dest.address].filter(Boolean).join(' · '))}</small></span>`
    : '';
  if (!stops.length && stopMarker) {
    stopMarker.remove();
    stopMarker = null;
  }
}

function overview() {
  tripSheet.set(false);
  if (!nav) return;
  stopFollowing();
  const b = new maplibregl.LngLatBounds();
  for (const c of nav.coords) b.extend(c);
  fitTo(b, { padding: { top: 160, bottom: 140, left: 50, right: 50 }, pitch: 0, bearing: 0, duration: 800 });
}

async function arrive() {
  const name = dest?.name ?? '';
  const took = Date.now() - driveStarted;
  const dist = nav?.total ?? 0;
  speak(nav?.steps.at(-1)?.pre || 'You have arrived.');
  await endDrive(true);
  $('arrived-name').textContent = name;
  $('arrived-stats').textContent = `${formatDistance(dist, state.settings.units)} in ${formatDuration(took / 1000)}`;
  $('arrived').classList.remove('hidden');
  $('browse-ui').classList.add('hidden');
}

async function endDrive(arrived) {
  stopSimulation();
  stopTunnelWatch();
  discardProbeBuffer(); // fixes buffered on this drive must not leak into a later batch
  parkingFor = null;
  $('parking-label').textContent = 'Parking nearby';
  $('parking').classList.add('hidden');
  clearParkingPins();
  if (share) {
    api(`/api/trips/${share.token}`, { method: 'PATCH', body: { ended: arrived ? 'arrived' : 'stopped' } }).catch(() => {});
    share = null;
    renderShareMenu();
  }
  nav = null;
  live = null;
  forgetTrip();
  trail = [];
  offTrail = [];
  drawTrail();
  $('toll-chip').classList.add('hidden');
  onRoute = [];
  stops = [];
  renderStopMenu();
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  $('alert').classList.add('hidden');
  $('offroute').classList.add('hidden');
  $('limit').classList.add('hidden');
  $('speedo').classList.remove('fast');
  if (!arrived) backToBrowse();
  else {
    mode = 'browse';
    resetTravel();
    $('drive-ui').classList.add('hidden');
    document.body.classList.remove('driving', 'walking');
    drawRoutes();
    destMarker?.remove();
    map.easeTo({ pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
  }
  updateCheckpoint(); // an update that came out during the trip
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
}

// ================= Shared drive =================
async function shareDrive() {
  tripSheet.set(false);
  if (!state.user) return openAuth('share');
  try {
    if (!share) {
      const res = await api('/api/trips', {
        method: 'POST',
        body: { destination: dest, eta: Date.now() + (live?.remainingTime ?? 0) * 1000, route: nav?.coords ?? [] },
      });
      share = { ...res, last: null };
      pushShare(true);
      shareTimer = setInterval(() => pushShare(), 5000);
      renderShareMenu();
    }
    const text = `I'm driving to ${dest.name}. Follow my drive and ETA:`;
    if (navigator.share) await navigator.share({ title: 'My drive', text, url: share.url }).catch(() => {});
    else {
      await navigator.clipboard?.writeText(share.url);
      toast('Link copied. Anyone with it can follow this drive until you arrive.');
    }
  } catch (e) {
    toast(e.message);
  }
}

// Ends sharing but keeps the drive going; whoever has the link sees "stopped sharing" and no position.
async function stopSharing() {
  tripSheet.set(false);
  if (!share) return;
  const { token } = share;
  share = null;
  renderShareMenu();
  try {
    await api(`/api/trips/${token}`, { method: 'PATCH', body: { ended: 'stopped' } });
    toast('Stopped sharing. The link no longer shows where you are.');
  } catch (e) {
    toast(e.message);
  }
}

function renderShareMenu() {
  if (!share) {
    clearInterval(shareTimer);
    shareTimer = null;
  }
  $('share-label').textContent = share ? 'Send link again' : 'Share drive';
  $('btn-stop-share').classList.toggle('hidden', !share);
}

// Sends the driver's position only when it tells viewers something new (see shouldSend in follow.js);
// a new route (start, reroute) always goes out straight away.
function pushShare(withRoute = false) {
  if (!share || !live || !state.pos) return;
  const now = Date.now();
  const eta = now + live.remainingTime * 1000;
  if (!withRoute && !shouldSend(share.last, { now, pos: live.snapped, eta })) return;
  share.last = { at: now, pos: live.snapped, eta, count: (share.last?.count ?? 0) + 1 };
  api(`/api/trips/${share.token}`, {
    method: 'PATCH',
    body: {
      position: live.snapped,
      heading: state.pos.heading ?? live.routeBearing,
      eta,
      ...(withRoute ? { route: nav.coords } : {}),
    },
  }).catch(() => {});
}

// Someone opened a /drive/<token> link: show where that driver is.
// Asks every 10 s while the car moves, backs off to 30-60 s while it doesn't, pauses while the page is
// hidden, and keeps the car gliding along the route between updates.
function startWatching(token) {
  mode = 'watch';
  carMarker.remove();
  $('browse-ui').classList.add('hidden');
  const sheet = $('watch');
  sheet.classList.remove('hidden');
  sheet.innerHTML = '<div class="grabber"></div><p class="hint">Loading drive…</p>';
  const openLink = '<a class="btn ghost wide" style="display:grid;place-items:center;text-decoration:none" href="/">Open A2B</a>';
  let fitted = false;
  let driverMarker = null;
  let follow = null;
  let routeKey = '';
  let lastUpdate = 0;
  let stillPolls = 0;
  let pollTimer = null;
  let drawTimer = null;
  let finished = false;

  const draw = () => {
    const p = follow?.at(Date.now());
    if (!p || !driverMarker) return;
    driverMarker.setLngLat(p.pos).setRotation(p.heading);
    driverMarker.getElement().classList.toggle('stale', p.stale);
  };
  const schedule = (ms) => {
    clearTimeout(pollTimer);
    if (!finished && document.visibilityState === 'visible') pollTimer = setTimeout(tick, ms);
  };
  const finish = () => {
    finished = true;
    clearTimeout(pollTimer);
    clearInterval(drawTimer);
  };

  async function tick() {
    try {
      const t = await api(`/api/trips/${token}`);
      if (!map.getSource('watch-route')) return schedule(500);
      if (t.stopped) {
        finish();
        map.getSource('watch-route').setData(emptyFc());
        driverMarker?.remove();
        sheet.innerHTML = `<div class="grabber"></div>
          <div class="watch-head"><span class="avatar">${esc((t.driver || '?')[0])}</span><div><b>${esc(t.driver)} stopped sharing</b><small class="hint">their drive to ${esc(t.destination.name)}</small></div></div>
          ${openLink}`;
        return;
      }
      // Line the server's clock up with ours, so "when was this position recorded" is right on this device.
      const recordedAt = Date.now() - Math.max(0, (t.now ?? t.updated_at) - t.updated_at);
      const key = `${t.route.length}:${t.route[0]}:${t.route.at(-1)}`;
      if (key !== routeKey) {
        routeKey = key; // first load, or the driver was rerouted
        map.getSource('watch-route').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: t.route } });
        follow = new Follow(t.route);
        lastUpdate = 0;
      }
      if (!destMarker) destMarker = new maplibregl.Marker({ element: el('div', 'dest-pin', DEST_PIN), anchor: 'bottom' }).setLngLat([t.destination.lng, t.destination.lat]).addTo(map);
      if (t.position) {
        driverMarker ??= new maplibregl.Marker({ element: el('div', 'car', CAR), rotationAlignment: 'map' }).setLngLat([t.position.lng, t.position.lat]).addTo(map);
        if (t.updated_at !== lastUpdate) {
          lastUpdate = t.updated_at;
          stillPolls = 0;
          follow.update({ position: [t.position.lng, t.position.lat], heading: t.position.heading, eta: t.eta, at: recordedAt });
        } else stillPolls++;
        if (t.ended) driverMarker.setLngLat([t.position.lng, t.position.lat]).setRotation(t.position.heading ?? 0);
        else draw();
      }
      if (!fitted) {
        const b = new maplibregl.LngLatBounds();
        for (const c of t.route) b.extend(c);
        if (t.position) b.extend([t.position.lng, t.position.lat]);
        b.extend([t.destination.lng, t.destination.lat]);
        fitTo(b, { padding: sheetPadding(), duration: 0, maxZoom: 15 });
        fitted = true;
      }
      const left = t.eta ? Math.max(0, (t.eta - Date.now()) / 1000) : null;
      sheet.innerHTML = `<div class="grabber"></div>
        <div class="watch-head"><span class="avatar">${esc((t.driver || '?')[0])}</span><div><b>${esc(t.driver)} ${t.ended ? 'has arrived' : 'is driving'}</b><small class="hint">to ${esc(t.destination.name)}</small></div></div>
        ${t.ended ? '' : `<div class="watch-eta"><div><b>${t.eta ? formatClock(new Date(t.eta)) : '--'}</b><small>arrival</small></div><div><b>${left == null ? '--' : left < 30 ? 'Any minute' : formatDuration(left)}</b><small>left</small></div></div>`}
        <p class="hint">Updated ${timeAgo(Date.now() - (t.now ?? Date.now()) + t.updated_at)}</p>
        ${openLink}`;
      if (t.ended) return finish();
      schedule(nextPollDelay(stillPolls));
    } catch (e) {
      sheet.innerHTML = `<div class="grabber"></div><p class="hint">${esc(e.message)}</p>${openLink}`;
      if (e.status !== 404) schedule(30_000); // a dropped connection: try again later
    }
  }

  // Only spend requests (and battery) while someone is actually looking.
  const onVisibility = () => {
    clearInterval(drawTimer);
    if (finished) return;
    if (document.visibilityState === 'visible') {
      drawTimer = setInterval(draw, 250);
      tick();
    } else clearTimeout(pollTimer);
  };
  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();
}

// ================= Reports on the map =================
let reportLoadTimer;
let lastLoad = { at: 0, box: null };

// The camera moves every second while driving or following, so only refetch when the view leaves
// the area we already have, or the data is getting old.
function scheduleReportLoad() {
  if (mode === 'drive') return; // driving refreshes on its own timer, along the whole route
  clearTimeout(reportLoadTimer);
  reportLoadTimer = setTimeout(() => loadReports(), 350);
}

async function loadReports(force = false) {
  if (!navigator.onLine) return; // dead spot: reports refresh with the connection
  if (!map || map.getZoom() < 9 || mode === 'watch') {
    if (map && map.getZoom() < 9) for (const id of [...reportMarkers.keys()]) dropReport(id);
    return;
  }
  const b = map.getBounds();
  const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const had = lastLoad.box;
  const covered = had && view[0] >= had[0] && view[1] >= had[1] && view[2] <= had[2] && view[3] <= had[3];
  if (!force && covered && Date.now() - lastLoad.at < REPORT_REFRESH_MS - 1000) return;
  // Fetch a margin around the view so small pans don't need another request.
  const mx = (view[2] - view[0]) * 0.25, my = (view[3] - view[1]) * 0.25;
  const box = [view[0] - mx, view[1] - my, view[2] + mx, view[3] + my];
  if (mode === 'drive' && state.pos) {
    // While driving, also fetch ~30 km around the car so alerts work well beyond the screen.
    const [x, y] = state.pos.lngLat;
    box[0] = Math.min(box[0], x - 0.3); box[1] = Math.min(box[1], y - 0.25);
    box[2] = Math.max(box[2], x + 0.3); box[3] = Math.max(box[3], y + 0.25);
  }
  try {
    const { reports: list } = await api(`/api/reports?bbox=${box.map((v) => v.toFixed(5)).join(',')}`);
    lastLoad = { at: Date.now(), box };
    const seen = new Set();
    for (const r of list) {
      seen.add(r.id);
      upsertReport(r);
    }
    for (const id of [...reports.keys()]) {
      const r = reports.get(id);
      const inside = r.lng >= box[0] && r.lng <= box[2] && r.lat >= box[1] && r.lat <= box[3];
      if (inside && !seen.has(id)) dropReport(id);
    }
    computeOnRoute();
  } catch {}
}

function upsertReport(r) {
  reports.set(r.id, r);
  let m = reportMarkers.get(r.id);
  if (!m) {
    const e = el('div', 'report-pin', `<div class="pin-ic" style="background:${REPORT_TYPES[r.type]?.color}">${reportIcon(r.type)}</div>`);
    e.onclick = (ev) => {
      ev.stopPropagation();
      showReportCard(reports.get(r.id));
    };
    m = new maplibregl.Marker({ element: e }).setLngLat([r.lng, r.lat]).addTo(map);
    reportMarkers.set(r.id, m);
  }
  const e = m.getElement();
  e.classList.toggle('mine', r.mine);
  e.style.opacity = String(reportOpacity(r));
  e.title = reportLabel(r.type, r.subtype);
}

// Fresh and confirmed reports are solid; old, unconfirmed ones fade so drivers can tell at a glance.
function reportOpacity(r) {
  const life = r.expires_at - r.created_at || 1;
  const age = (Date.now() - r.created_at) / life;
  return Math.max(0.45, Math.min(1, 1 - age * 0.6 + r.still * 0.15));
}

function dropReport(id) {
  reportMarkers.get(id)?.remove();
  reportMarkers.delete(id);
  reports.delete(id);
}

function computeOnRoute() {
  onRoute = nav ? reportsAlong(nav, [...reports.values()]) : [];
}

function showReportCard(r) {
  if (!r) return;
  const card = $('report-card');
  const t = REPORT_TYPES[r.type];
  const d = state.pos ? ` · ${formatDistance(distance(state.pos.lngLat, [r.lng, r.lat]), state.settings.units)} away` : '';
  card.innerHTML = `<div class="grabber"></div>
    <div class="rc-head"><span class="pin-ic" style="background:${t.color}">${reportIcon(r.type, 28)}</span>
      <div style="flex:1;min-width:0"><b>${esc(reportLabel(r.type, r.subtype))}</b><small>${r.mine ? 'Your report' : `Reported by ${esc(r.by || 'a driver')}`} · ${timeAgo(r.created_at)}${d}</small></div>
      <button class="icon-btn" data-x aria-label="Close"><svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button></div>
    ${r.comment ? `<p class="rc-comment">${esc(r.comment)}</p>` : ''}
    <div class="rc-stats"><span>👍 ${r.thanks} thanks</span><span>✔ ${r.still} still there</span><span>✖ ${r.gone} not there</span></div>
    <div class="sheet-actions">
      ${r.mine ? '<button class="btn danger" data-vote="gone">Remove my report</button>' : '<button class="btn ghost" data-vote="gone">Not there</button><button class="btn primary" data-vote="thanks">👍 Thanks</button>'}
    </div>`;
  card.classList.remove('hidden');
  armBack();
  card.querySelector('[data-x]').onclick = () => card.classList.add('hidden');
  card.querySelectorAll('[data-vote]').forEach((b) => {
    b.onclick = () => vote(r, b.dataset.vote).then(() => card.classList.add('hidden'), () => {});
  });
}

async function vote(r, v) {
  if (!state.user) {
    openAuth('vote');
    throw new Error('sign in');
  }
  try {
    const res = await api(`/api/reports/${r.id}/vote`, { method: 'POST', body: { vote: v } });
    if (res.removed || v === 'gone') {
      if (res.removed) dropReport(r.id);
      toast(res.removed ? 'Thanks, it has been removed from the map.' : 'Thanks for letting us know.');
    } else {
      upsertReport(res.report);
      toast(v === 'thanks' ? `You thanked ${r.by || 'the reporter'}` : 'Thanks for confirming!');
    }
    if (res.points) bumpPoints(res.points);
  } catch (e) {
    toast(e.message);
  }
}

function bumpPoints(n) {
  if (!state.user) return;
  state.user.points += n;
  renderAvatar();
}

// Alert the driver about reports ahead on the route, then ask if they're still there once passed.
function checkAlerts() {
  if (!state.settings.alerts || !live) return;
  const card = $('alert');
  for (const r of onRoute) {
    const ahead = r.at - live.along;
    const status = alerted.get(r.id);
    if (!status && r.type === 'camera' && (nav.route.cameras ?? []).some((c) => Math.abs(nav.cum[c.at] - r.at) < 150)) continue; // a mapped camera, warned about already
    if (!status && ahead > 0 && ahead < alertRange(r.type)) {
      alerted.set(r.id, 'ahead');
      showAlert(r, ahead);
      speak(`${REPORT_TYPES[r.type].label} reported ahead.`);
      return;
    }
    if (status === 'ahead' && ahead < -25 && ahead > -400 && !r.mine) {
      alerted.set(r.id, 'asked');
      showAlert(r, null);
      return;
    }
  }
  if (!card.classList.contains('hidden') && card.dataset.until && Date.now() > Number(card.dataset.until)) card.classList.add('hidden');
}

function alertRange(type) {
  return type === 'police' || type === 'camera' ? 800 : type === 'closure' ? 1500 : 600;
}

function showAlert(r, ahead) {
  const card = $('alert');
  if (tripSheet.isOpen()) return; // trip menu is open; the voice alert is enough
  const t = REPORT_TYPES[r.type];
  const ms = ahead == null ? 10_000 : 12_000;
  card.dataset.until = String(Date.now() + ms);
  const title = ahead == null ? `${t.label} still there?` : `${reportLabel(r.type, r.subtype)} ahead`;
  const sub = ahead == null ? `Reported by ${esc(r.by || 'a driver')}` : `${formatDistance(ahead, state.settings.units)} · ${timeAgo(r.created_at)}${r.by ? ` by ${esc(r.by)}` : ''}`;
  const buttons = ahead == null
    ? '<button class="btn ghost" data-a="gone">Not there</button><button class="btn primary" data-a="still">Still there</button>'
    : `<button class="btn ghost" data-a="dismiss">OK</button>${r.mine ? '' : '<button class="btn primary" data-a="thanks">👍 Thanks</button>'}`;
  card.innerHTML = `<div class="alert-top"><span class="pin-ic" style="background:${t.color}">${reportIcon(r.type, 26)}</span><div><b>${esc(title)}</b><small>${sub}</small></div></div>
    <div class="alert-actions">${buttons}</div><div class="alert-timer"><i style="animation-duration:${ms}ms"></i></div>`;
  card.classList.remove('hidden');
  card.querySelectorAll('[data-a]').forEach((b) => {
    b.onclick = () => {
      card.classList.add('hidden');
      if (b.dataset.a !== 'dismiss') vote(r, b.dataset.a).catch(() => {});
    };
  });
}

// ================= Reporting =================
let reportDraft = null;

function openReportMenu() {
  if (!canReportFrom(mode)) return; // not from a train trip: see report-types.js
  hideContextMenu();
  if (!state.user) return openAuth('report');
  reportDraft = { at: state.pos?.lngLat ?? map.getCenter().toArray(), heading: state.pos?.heading ?? null };
  $('report-where').textContent = state.pos ? 'At your current location' : 'At the middle of the map (location is off)';
  renderReportGrid();
  $('report-sheet').classList.remove('hidden');
  armBack();
}

function renderReportGrid() {
  $('report-title').textContent = 'Report';
  $('report-sub').classList.add('hidden');
  const grid = $('report-grid');
  grid.classList.remove('hidden');
  grid.innerHTML = '';
  for (const [key, t] of Object.entries(REPORT_TYPES)) {
    const b = el('button', 'report-tile', `<span class="pin-ic" style="background:${t.color}">${reportIcon(key, 36)}</span>${esc(t.label)}`);
    b.onclick = () => pickReportType(key);
    grid.append(b);
  }
}

function pickReportType(key) {
  const t = REPORT_TYPES[key];
  reportDraft.type = key;
  reportDraft.subtype = null;
  $('report-title').textContent = t.label;
  $('report-grid').classList.add('hidden');
  $('report-sub').classList.remove('hidden');
  $('report-comment').value = '';
  const sub = $('report-sub-grid');
  sub.innerHTML = '';
  for (const [k, label] of Object.entries(t.subtypes)) {
    const b = el('button', '', esc(label));
    b.onclick = () => {
      reportDraft.subtype = reportDraft.subtype === k ? null : k;
      sub.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b && reportDraft.subtype === k));
    };
    sub.append(b);
  }
}

async function sendReport() {
  if (!reportDraft?.type) return;
  const btn = $('btn-report-send');
  btn.disabled = true;
  try {
    const [lng, lat] = reportDraft.at;
    const res = await api('/api/reports', {
      method: 'POST',
      body: { type: reportDraft.type, subtype: reportDraft.subtype, lat, lng, heading: reportDraft.heading, comment: $('report-comment').value },
    });
    $('report-sheet').classList.add('hidden');
    upsertReport(res.report);
    computeOnRoute();
    if (res.report) alerted.set(res.report.id, 'asked');
    bumpPoints(res.points || 0);
    toast(res.merged ? 'Thanks! You confirmed an existing report.' : `Report sent. Thanks! +${res.points} points`);
    reportDraft = null;
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}
