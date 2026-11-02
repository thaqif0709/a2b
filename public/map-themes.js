// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Map looks. Each theme starts from one of OpenFreeMap's styles and recolours or hides layers by id.

export const BASE_STYLES = {
  liberty: 'https://tiles.openfreemap.org/styles/liberty',
  bright: 'https://tiles.openfreemap.org/styles/bright',
  positron: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
  fiord: 'https://tiles.openfreemap.org/styles/fiord',
};

// rules: [layer id pattern, { paint property: value }]; hide: layer id pattern to switch off.
export const MAP_THEMES = {
  classic: { label: 'Classic', base: 'liberty', night: false },

  plum: {
    label: 'Plum',
    base: 'liberty',
    night: false,
    hide: /^poi_r(1|7|20)$/,
    rules: [
      [/^background$/, { 'background-color': '#f7f2f5' }],
      [/^landuse_residential$/, { 'fill-color': '#f1e8ee' }],
      [/^(park|landcover_wood|landcover_grass|landuse_cemetery|landuse_pitch)$/, { 'fill-color': '#e2ecdc' }],
      [/^water$/, { 'fill-color': '#c4d9ea' }],
      [/^waterway/, { 'line-color': '#c4d9ea' }],
      [/^building$/, { 'fill-color': '#eadfe6' }],
      [/^building-3d$/, { 'fill-extrusion-color': '#e6d7e0' }],
      [/(road|bridge|tunnel)_(minor|street|service_track|link)$/, { 'line-color': '#ffffff' }],
      [/(road|bridge|tunnel)_(minor|street|service_track|link)_casing$/, { 'line-color': '#e2d3dc' }],
      [/(road|bridge|tunnel)_secondary_tertiary$/, { 'line-color': '#fdf3f8' }],
      [/(road|bridge|tunnel)_secondary_tertiary_casing$/, { 'line-color': '#dcb6cb' }],
      [/(road|bridge|tunnel)_trunk_primary$/, { 'line-color': '#f8dceb' }],
      [/(road|bridge|tunnel)_trunk_primary_casing$/, { 'line-color': '#c98aab' }],
      [/(road|bridge|tunnel)_motorway(_link)?$/, { 'line-color': '#eeb6d2' }],
      [/(road|bridge|tunnel)_motorway(_link)?_casing$/, { 'line-color': '#a8306d' }],
      [/^label_|^highway-name/, { 'text-color': '#4a2a3c' }],
    ],
  },

  clean: {
    label: 'Clean',
    base: 'liberty',
    night: false,
    flat: true,
    hide: /^poi_|^road_one_way_arrow/,
    rules: [
      [/^background$/, { 'background-color': '#f3f1ec' }],
      [/^landuse_residential$/, { 'fill-color': '#efece6' }],
      [/^(park|landcover_wood|landcover_grass|landuse_cemetery|landuse_pitch)$/, { 'fill-color': '#d9ecd0' }],
      [/^water$/, { 'fill-color': '#a9d3f0' }],
      [/^waterway/, { 'line-color': '#a9d3f0' }],
      [/^building$/, { 'fill-color': '#e5e2db' }],
      [/(road|bridge|tunnel)_(minor|street|service_track|link|secondary_tertiary)$/, { 'line-color': '#ffffff' }],
      [/(road|bridge|tunnel)_(minor|street|service_track|link|secondary_tertiary)_casing$/, { 'line-color': '#d6d2ca' }],
      [/(road|bridge|tunnel)_trunk_primary$/, { 'line-color': '#fff0b8' }],
      [/(road|bridge|tunnel)_trunk_primary_casing$/, { 'line-color': '#e2c36d' }],
      [/(road|bridge|tunnel)_motorway(_link)?$/, { 'line-color': '#ffd77a' }],
      [/(road|bridge|tunnel)_motorway(_link)?_casing$/, { 'line-color': '#d6a23c' }],
    ],
  },

  bright: { label: 'Bright', base: 'bright', night: false },

  bright_plum: { label: 'Bright plum', base: 'bright', night: false, rules: brightPlum('soft') },

  bright_plum_strong: { label: 'Bright plum (strong)', base: 'bright', night: false, rules: brightPlum('strong') },

  minimal: { label: 'Minimal', base: 'positron', night: false },

  dark: { label: 'Dark', base: 'dark', night: true },

  // Bright (the day map) recoloured dark, so night shows the same shops, places and road numbers as day.
  plum_night: { label: 'Plum night', base: 'bright', night: true, rules: brightPlumNight() },

  fiord: { label: 'Fiord', base: 'fiord', night: true },
};

// OpenFreeMap "bright" recoloured with the app's plum (#751B4F); parks stay green and water stays blue.
function brightPlum(strength) {
  const c = {
    // Roads in quiet neutrals, so the plum route line is the one thing that stands out.
    soft: {
      bg: '#faf4f7', res: 'hsla(328,30%,90%,0.45)', building: '#f2e4eb', buildingZ: '#e6d4de', minorCasing: '#ddd5da',
      main: '#ffffff', mainCasing: '#d3c9cf', motorway: '#f3eff1', motorwayCasing: '#bcb0b7', label: '#3d1f30',
    },
    strong: {
      bg: '#f6eaf0', res: 'hsla(328,35%,86%,0.5)', building: '#ecd6e1', buildingZ: '#dfc3d2', minorCasing: '#d4b6c6',
      main: '#f9cde2', mainCasing: '#b84d84', motorway: '#ea92be', motorwayCasing: '#8e2462', label: '#3a1229',
    },
  }[strength];
  return [
    [/^background$|^road_area_pier$/, { 'background-color': c.bg, 'fill-color': c.bg }],
    [/^road_pier$/, { 'line-color': c.bg }],
    [/^landuse-(residential|suburb|railway)$/, { 'fill-color': c.res }],
    [/^building$/, { 'fill-color': ['interpolate', ['linear'], ['zoom'], 15.5, c.building, 16, c.buildingZ] }],
    [/^building-top$/, { 'fill-color': c.building }],
    [/-(minor|service-track)-casing$/, { 'line-color': c.minorCasing }],
    [/-(link|secondary-tertiary|primary|trunk|trunk-primary)-casing$/, { 'line-color': c.mainCasing }],
    [/-(link|secondary-tertiary|primary|trunk|trunk-primary)$/, { 'line-color': c.main }],
    [/-motorway(-link)?-casing$/, { 'line-color': c.motorwayCasing }],
    [/-motorway(-link)?$/, { 'line-color': c.motorway }],
    [/^label_|^highway-name-(minor|major)$/, { 'text-color': c.label }],
  ];
}

// Road number shields (E35, 287…) repeat along a road every `symbol-spacing` screen pixels; the base styles
// use 200-350, which strings them along a highway. Wider spacing keeps one or two in view at any zoom.
const SHIELD_LAYER = /shield|^highway_name_motorway$/;
const SHIELD_SPACING = 700;

// OpenFreeMap "bright", recoloured for night with plum roads and soft, light labels. Kept darker than the
// route line (#ffbade) so the route still stands out the most.
function brightPlumNight() {
  const bg = '#17131a';
  return [
    [/^background$|^road_area_pier$|^landcover-(glacier|ice-shelf)$/, { 'background-color': bg, 'fill-color': bg }],
    [/^road_pier$/, { 'line-color': bg }],
    [/^landuse-(residential|suburb|railway)$/, { 'fill-color': 'hsla(320,18%,16%,0.6)' }],
    [/^landuse-(commercial|industrial)$/, { 'fill-color': 'hsla(320,22%,20%,0.45)' }],
    [/^landuse-(cemetery|hospital|school)$/, { 'fill-color': '#211a22' }],
    [/^(park|landcover-grass|landcover-grass-park)$/, { 'fill-color': '#18261b' }],
    [/^landcover-wood$/, { 'fill-color': '#1b2c1e' }],
    [/^landcover-sand$/, { 'fill-color': '#2a2620' }],
    [/^water(-intermittent)?$/, { 'fill-color': '#132133' }],
    [/^waterway/, { 'line-color': '#1a2d44' }],
    [/^building$/, { 'fill-color': '#251d25' }],
    [/^building-top$/, { 'fill-color': '#2c222b' }],
    [/^aeroway-area$/, { 'fill-color': '#221c23' }],
    [/^aeroway-(taxiway|runway)$/, { 'line-color': '#3a3039' }],
    [/^highway-area$/, { 'fill-color': 'hsla(320,10%,22%,0.5)' }],
    [/-path$/, { 'line-color': '#4a3e48' }],
    [/-(minor|service-track)-casing$/, { 'line-color': '#3d313b' }],
    [/-(minor|service-track)$/, { 'line-color': '#2d242c' }],
    [/-(link|secondary-tertiary|primary|trunk|trunk-primary)-casing$/, { 'line-color': '#6e3a5c' }],
    [/-(link|secondary-tertiary|primary|trunk|trunk-primary)$/, { 'line-color': '#3f2638' }],
    [/-motorway(-link)?-casing$/, { 'line-color': '#8a3d6c' }],
    [/-motorway(-link)?$/, { 'line-color': '#552443' }],
    [/railway|cablecar/, { 'line-color': '#3b343b' }],
    [/^boundary/, { 'line-color': '#4d434c' }],
    [/^label_|^highway-name/, { 'text-color': '#eadbe4', 'text-halo-color': bg }],
    [/^poi_/, { 'text-color': '#cdb9c7', 'text-halo-color': bg }],
    [/^water|^waterway.*label/, { 'text-color': '#7f9cc0', 'text-halo-color': bg }],
  ];
}

const PAINT_PREFIX = { fill: 'fill-', line: 'line-', 'fill-extrusion': 'fill-extrusion-', background: 'background-', symbol: 'text-' };

// Applies a theme's recolouring to the style that just loaded.
export function applyMapTheme(map, theme) {
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'symbol' && SHIELD_LAYER.test(layer.id)) map.setLayoutProperty(layer.id, 'symbol-spacing', SHIELD_SPACING);
    if ((theme.hide && theme.hide.test(layer.id)) || (theme.flat && layer.type === 'fill-extrusion')) {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
      continue;
    }
    for (const [pattern, paint] of theme.rules ?? []) {
      if (!pattern.test(layer.id)) continue;
      for (const [key, value] of Object.entries(paint)) {
        const prefix = PAINT_PREFIX[layer.type];
        if (prefix && key.startsWith(prefix) && !(layer.type === 'fill' && key.startsWith('fill-extrusion'))) {
          map.setPaintProperty(layer.id, key, value);
        }
      }
    }
  }
}
