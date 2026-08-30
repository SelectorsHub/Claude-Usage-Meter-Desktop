'use strict';
/* Verifies the logic that was ported from the Python build. */

const assert = require('assert');
const { extractMeters } = require('../src/main/parse');
const { History, forecast } = require('../src/main/forecast');

let passed = 0;
const test = (name, fn) => { fn(); console.log('  ✓ ' + name); passed++; };

console.log('parse');

test('extracts session, weekly, opus and fable from a nested payload', () => {
  const meters = extractMeters({
    five_hour: { utilization: 42, resets_at: '2026-08-30T18:00:00+00:00' },
    seven_day: { utilization: 18, resets_at: '2026-09-02T09:00:00+00:00' },
    seven_day_opus: { utilization: 3, resets_at: '2026-09-02T09:00:00+00:00' },
    limits: [
      { type: 'weekly_scoped', model: 'fable', utilization: 7 },
      { type: 'weekly_scoped', model: 'opus', utilization: 3 },
    ],
  });
  const keys = meters.map((m) => m.key);
  assert.deepStrictEqual(keys, ['session', 'weekly', 'weekly_opus', 'fable']);
  assert.strictEqual(meters[0].short, 'S');
  assert.strictEqual(meters[3].pct, 7);
});

test('pickPct rule: utilization 1 stays 1%, never 100%', () => {
  assert.strictEqual(extractMeters({ five_hour: { utilization: 1 } })[0].pct, 1);
});

test('derives a percentage from used/limit counts', () => {
  const [m] = extractMeters({ five_hour: { used: 25, limit: 200 } });
  assert.strictEqual(m.pct, 12.5);
});

test('a shallower path beats a nested duplicate', () => {
  const meters = extractMeters({
    five_hour: { utilization: 40 },
    nested: { deep: { five_hour: { utilization: 99 } } },
  });
  assert.strictEqual(meters.find((m) => m.key === 'session').pct, 40);
});

test('unknown shapes survive as raw meters instead of vanishing', () => {
  const meters = extractMeters({ mystery_window: { utilization: 5 } });
  assert.strictEqual(meters.length, 1);
  assert.strictEqual(meters[0].known, false);
});

test('empty and malformed payloads return nothing rather than throwing', () => {
  assert.deepStrictEqual(extractMeters(null), []);
  assert.deepStrictEqual(extractMeters({}), []);
  assert.deepStrictEqual(extractMeters({ five_hour: { utilization: 'x' } }), []);
});

console.log('forecast');

const now = 1750000000;

test('creeping resets_at is not treated as a reset', () => {
  const h = new History();
  h.add(50, now, 120, now);
  assert.strictEqual(h.add(51, now + 7, 120, now + 60), false);
});

test('a large forward jump in resets_at is a reset', () => {
  const h = new History();
  h.add(50, now, 120, now);
  assert.strictEqual(h.add(48, now + 5 * 3600, 120, now + 120), true);
});

test('a collapse in percentage is a reset', () => {
  const h = new History();
  h.add(80, now, 120, now);
  assert.strictEqual(h.add(2, now + 10, 120, now + 60), true);
});

test('rate needs enough samples over enough time', () => {
  const h = new History();
  h.add(10, now, 120, now);
  h.add(12, now, 120, now + 60);
  assert.strictEqual(h.ratePerHour(), null);
});

test('regression recovers a known slope', () => {
  const h = new History();
  for (let i = 0; i < 6; i++) h.add(10 + i * 4, now, 120, now - 3600 + i * 600);
  assert.strictEqual(Math.round(h.ratePerHour()), 24);
});

test('forecast defers to the reset when it lands first', () => {
  const h = new History();
  for (let i = 0; i < 6; i++) h.add(10 + i * 4, now, 120, now - 3600 + i * 600);
  assert.match(forecast(30, h, now + 900, now), /resets first/);
  assert.match(forecast(30, h, now + 4 * 3600, now), /at current pace/);
});

console.log(`\n${passed} passed`);
