// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFloor, parseUnit, mallFromAddress, mallName, insideMall, shopName, compassWord } from '../public/indoor.js';

// Overture addresses as the place files have them (cut at 70 characters): [address, floor, unit, mall].
const SAMPLES = [
  ['Lot L2.53, Level 2, The Exchange TRX, Persiaran TRX, Bandar Kuala Lump', 'Level 2', 'L2.53', 'The Exchange TRX'],
  ['LG-82B, IOI City Mall, Lebuh IRC, Dengkil', 'Lower Ground (LG)', 'LG-82B', 'IOI City Mall'],
  ['G.74.0, Ground Level, The Exchange TRX Tun Razak Exchange, Bandar Kual', 'Ground Floor', 'G.74.0', 'The Exchange TRX'],
  ['L3.03.0, 3rd Floor, Park Level, The Exchange TRX, Persiaran TRX, Banda', '3rd Floor', 'L3.03.0', 'The Exchange TRX'],
  ['C.53, Level Concourse, Plaza The Exchange TRX, Persiaran TRX, Bandar K', 'Concourse', 'C.53', 'The Exchange TRX'],
  ['Lot 2-62, 2nd Floor, IOI City Mall, Lbh IRC, Dengkil', '2nd Floor', '2-62', 'IOI City Mall'],
  ['L1-12B, City, IOI City Mall, Lbh IRC, Dengkil', 'Level 1', 'L1-12B', 'IOI City Mall'],
  ['PL.08.0 Park Level, The Exchange TRX, Persiaran TRX, Tun Razak Exchang', 'Park Level', 'PL.08.0', 'The Exchange TRX'],
  ['Lot 207, 2nd Floor, Bandar Kuala Lumpur', '2nd Floor', '207', null],
  ['Lot GS.03, Ground Floor, The Exchange TRX, Persiaran TRX, Bandar Kuala', 'Ground Floor', 'GS.03', 'The Exchange TRX'],
  ['Unit No. L1.81.0 & L1.82.0, Plaza The Exchange TRX, Tun Razak Exchange', 'Level 1', 'L1.81.0', 'The Exchange TRX'],
  ['NakNak 낙낙 IOI City Mall: City, LG-248&249, Lower Ground Floor IOI City Mall, 2, Lbh IRC, Dengki', 'Lower Ground (LG)', 'LG-248', 'IOI City Mall'],
  ['L2-53 SECOND FLOOR IOI CITY MALL IOI RESORT CITY, Dengkil', '2nd Floor', 'L2-53', 'IOI City Mall'],
  ['Tingkat 6, Kompleks Pernas Sogo L6-R8, R8A & L2-K2', 'Level 6', 'L6-R8', 'Kompleks Pernas Sogo'],
  ['F215, Level 1, 1 Utama Shopping Centre Bandar Utam', 'Level 1', 'F215', '1 Utama'],
  ['Lot No. L1-219, First Floor, IOI City Mall 2, Lebuh IRC, IOI Resort Ci', '1st Floor', 'L1-219', 'IOI City Mall'],
  ['Jalan BK 5/6, Puchong', null, null, null],
  ['5 Jalan BK 5/6, Puchong', null, null, null],
];

test('floor, lot and mall from the address, in the mall’s own words', () => {
  for (const [address, floor, unit, mall] of SAMPLES) {
    const f = parseFloor(address);
    assert.equal(f?.label ?? null, floor, address);
    assert.equal(parseUnit(address), unit, address);
    assert.equal(mallFromAddress(address, { maybe: Boolean(f) }), mall, address);
  }
});

test('more ways addresses write a floor', () => {
  const label = (a) => parseFloor(a)?.label ?? null;
  assert.equal(label('Lot 6.39.00, Level Six, Pavilion Kuala Lumpur'), 'Level 6');
  assert.equal(label('Lot 6.11 Sixth Floor, 168, Jalan Bukit Bintang'), '6th Floor');
  assert.equal(label('Lot 4B, LG Floor, Great Eastern Mall, Jalan Ampang'), 'Lower Ground (LG)');
  assert.equal(label('LG2.01, Mid Valley Megamall'), 'Lower Ground 2 (LG2)');
  assert.equal(label('Lot UG-12, Upper Ground Floor, Sunway Velocity Mall'), 'Upper Ground (UG)');
  assert.equal(label('Block D Lot Grd Floor, Kl Plaza 179'), 'Ground Floor');
  assert.equal(label('Level G, Batu'), 'Ground Floor');
  assert.equal(label('Basement 1, Suria KLCC'), 'Basement 1 (B1)');
  assert.equal(label('Lot 2.15, Shaw Parade, Jln Changkat Thambi Dollah'), null); // a lot with no floor letters
  // Never from a house number, a postcode, or a road's numbers.
  for (const a of ['12, Jalan SS 2/75, Petaling Jaya', '7b Lorong PJS 7B, Petaling Jaya', 'First Floor 68000, Ampang', 'SS15, Subang Jaya', 'Level Up Studio, 47100 Puchong']) {
    assert.ok(['1st Floor', null].includes(label(a)), a);
  }
  assert.equal(label('12, Jalan SS 2/75, Petaling Jaya'), null);
  assert.equal(label('Level Up Studio, 47100 Puchong'), null);
  // When it says a floor twice, the first.
  assert.equal(parseFloor('L3.03.0, 3rd Floor, Park Level').say, 'the 3rd floor');
  assert.equal(parseFloor('Lot L2.53, Level 2').say, 'Level 2');
});

test('lots: not a house number or an area code', () => {
  assert.equal(parseUnit('Lot 7 . 01 . 06, 168, Jln Bukit Bintang'), '7.01.06');
  assert.equal(parseUnit('Lot ET12C, 3rd Floor, IOI Mall Puchong'), 'ET12C');
  assert.equal(parseUnit('2.69.00 Level 2 Pavallion Kuala Lumpur'), '2.69.00');
  assert.equal(parseUnit('Pavilion KL (Lot 4.02.01, Level 4), Jalan Bukit Bintang'), '4.02.01');
  for (const a of ['5 Jalan BK 5/6, Puchong', '168, Jln Bukit Bintang', 'SS15, Subang Jaya', '7b Lorong PJS 7B', 'No. 12, Jalan Telawi', '47100 Puchong', 'Lots of Love, Jalan Telawi']) {
    assert.equal(parseUnit(a), null, a);
  }
});

test('mall names from the address, tidied', () => {
  assert.equal(mallFromAddress('Lot 2.75.00, Level 2, Pavilion Mall, Jalan Bukit Bintang'), 'Pavilion Mall');
  assert.equal(mallFromAddress('Lot 4 .09.00A Level 4, Pavilion Kuala Lumpur Shopping Mall, 168, Jln B'), 'Pavilion Kuala Lumpur');
  assert.equal(mallFromAddress('Lot S2A, 2nd Floor , Bangsar Shopping Centre, Jalan Maarof'), 'Bangsar Shopping Centre');
  assert.equal(mallFromAddress('LOT FS25, First Floor, IOI Mall, Jalan Puchong, Puchong'), 'IOI Mall Puchong');
  assert.equal(mallFromAddress('Lot 238, Ground Floor, The Gardens, Lingkaran Syed Putra'), 'The Gardens Mall');
  assert.equal(mallFromAddress('L5-03, Level 5, BREM MALL, Kuala Lumpur'), 'Brem Mall');
  // "Plaza" alone may be offices and shops: only with a floor.
  assert.equal(mallFromAddress('Plaza Damas, Jalan Sri Hartamas 1'), null);
  assert.equal(mallFromAddress('G-12, Ground Floor, Plaza Damas, Jalan Sri Hartamas 1', { maybe: true }), 'Plaza Damas');
  // A bare "Shopping Centre" names nothing.
  assert.equal(mallFromAddress('Lot 12, Shopping Centre, Kuala Lumpur'), null);
  assert.equal(mallFromAddress('Lot 10 Shopping Centre (Ground Floor), Jalan Bukit Bintang'), 'Lot 10');
  assert.equal(mallFromAddress('Jalan Mall 3, Taman Mall'), null);
});

test('mall names from the list of malls: shops and check-ins left out', () => {
  assert.equal(mallName('1 Utama Shopping Centre,Bandar Utama'), '1 Utama');
  assert.equal(mallName('SuNwaY pYramiD shOoping centRe,bandar sUnwaY,seL'), 'Sunway Pyramid');
  assert.equal(mallName('Pot Lepak@1 Shamelin Shopping Mall'), '1 Shamelin Shopping Mall');
  assert.equal(mallName('Melawati Mall'), 'Melawati Mall');
  assert.equal(mallName('CROCS KLCC'), null);
  assert.equal(mallName('Atrium , Sunway'), null);
});

const at = { lng: 101.7167, lat: 3.1433 };
const TRX_PIN = { name: 'The Exchange TRX', lng: 101.7175, lat: 3.1425 }; // ~120 m away
const shop = (name, address, extra = {}) => ({ name, address, ...at, category: 'restaurant', ...extra });

test('a shop in a mall: from its address, its name, or a mall listed nearby', () => {
  assert.deepEqual(insideMall(shop('Kanada-Ya - The Exchange TRX', 'Lot L2.53, Level 2, The Exchange TRX, Persiaran TRX, Bandar Kuala Lump')), {
    mall: 'The Exchange TRX', floor: { label: 'Level 2', say: 'Level 2', n: 2 }, unit: 'L2.53', name: 'Kanada-Ya',
  });
  // No floor: the card says to check the directory.
  const venchi = insideMall(shop('Venchi Pavilion KL', 'Kuala Lumpur'));
  assert.equal(venchi.mall, 'Pavilion Kuala Lumpur');
  assert.equal(venchi.floor, null);
  // A floor and no mall in the address: the mall listed nearby.
  const lot = insideMall(shop('Shop', 'Lot 207, 2nd Floor, Bandar Kuala Lumpur'), [TRX_PIN]);
  assert.equal(lot.mall, 'The Exchange TRX');
  assert.equal(lot.floor.label, '2nd Floor');
  // …preferring one known by name over a nearer shop listed as a mall.
  const listed = [{ name: 'KFC Giant Mall', lng: 101.7168, lat: 3.1433 }, TRX_PIN];
  assert.equal(insideMall(shop('Shop', 'Lot L1.20, Bandar Kuala Lumpur'), listed).mall, 'The Exchange TRX');
});

test('not in a mall: be conservative', () => {
  const malls = [TRX_PIN];
  // Nothing in the address that says it's inside.
  assert.equal(insideMall(shop('Kedai', 'Jalan BK 5/6, Puchong'), malls), null);
  assert.equal(insideMall(shop('Kedai', '5 Jalan BK 5/6, Puchong'), malls), null);
  assert.equal(insideMall(shop('Kedai', 'Lot 1234, Kuala Lumpur'), malls), null); // a land lot, not a mall's
  // A floor, but no mall within reach.
  assert.equal(insideMall(shop('Shop', 'Lot 207, 2nd Floor, Bandar Kuala Lumpur'), [{ ...TRX_PIN, lat: 3.15 }]), null);
  // Upstairs in a shophouse, an office in a tower, or a high floor next to a mall.
  assert.equal(insideMall(shop('Klinik', 'No. 9 - 3, Third Floor, Jalan Medan Tuanku 1, Kuala Lumpur'), malls), null);
  assert.equal(insideMall(shop('Salon', '8, Ground Floor, Kuala, Lorong Rahim Kajai 14'), malls), null);
  assert.equal(insideMall(shop('Firm', 'L2-03, Level 2, TSLAW Tower, Jalan Kamuning'), malls), null);
  assert.equal(insideMall(shop('Firm', 'Level 16, Bandar Kuala Lumpur'), malls), null);
  // The mall itself, and a name that only mentions one.
  assert.equal(insideMall(shop('The Exchange TRX', 'Persiaran TRX, Kuala Lumpur', { category: 'shopping_mall' })), null);
  assert.equal(insideMall(shop('Pavilion KL', 'Jalan Bukit Bintang', { category: 'mall' })), null);
  assert.equal(insideMall(shop('Pavilion Kuala Lumpur MRT Station', 'Jalan Bukit Bintang', { category: 'train_station' })), null);
  assert.equal(insideMall(shop('Anello 1utama', '327 Jalan Desa Utama, Kuala Lumpur')), null);
  // A shop the list calls a mall, with its lot: still a shop.
  assert.equal(insideMall(shop('ASUS Mid Valley Megamall', 'LOT S-094, 2ND FLOOR, Mid Valley Megamall', { category: 'shopping_mall' })).unit, 'S-094');
});

test('the shop’s name without the mall tacked on', () => {
  assert.equal(shopName('Kanada-Ya - The Exchange TRX', 'The Exchange TRX'), 'Kanada-Ya');
  assert.equal(shopName('Boost Juice @ Pavilion KL (Level 1)', 'Pavilion Kuala Lumpur'), 'Boost Juice');
  assert.equal(shopName('Kanada-Ya', 'The Exchange TRX'), 'Kanada-Ya');
  assert.equal(shopName("Nando's - Mid Valley", 'The Exchange TRX'), "Nando's - Mid Valley");
});

test('directions in words, for a phone with no compass', () => {
  assert.equal(compassWord(0), 'north');
  assert.equal(compassWord(44), 'north-east');
  assert.equal(compassWord(181), 'south');
  assert.equal(compassWord(-90), 'west');
  assert.equal(compassWord(350), 'north');
});
