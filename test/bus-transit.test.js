import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTransit } from '../src/lib/bus-transit.js';
import { planTransitCombined } from '../src/lib/transit.js';

test('combined smoke', () => {
  const at = Date.parse('2026-10-28T09:00:00+08:00');
  const c = planTransitCombined([101.7108,3.1428],[101.7116,3.1579],at);
  assert.ok(Array.isArray(c.options) && c.options.length > 0);
});
