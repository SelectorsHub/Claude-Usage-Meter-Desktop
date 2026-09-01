'use strict';
/* Verifies the logic that was ported from the Python build. */

const assert = require('assert');
const { extractMeters, looksLikeFreePlan } = require('../src/main/parse');
const { History, forecast, untilReset } = require('../src/main/forecast');

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
  // limits[] covers fable/opus; session and weekly are rescued from the top level.
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

test('reads the real payload: Session, Weekly and Fable — no codenames', () => {
  // Captured from a live account. Two traps here:
  //  1. limits[] entries use `percent`, not `utilization`.
  //  2. the top level carries internal codenames (nimbus_quill, tangelo,
  //     cinder_cove...) that must never reach the menu.
  const raw = require('./fixtures/usage.json');
  const meters = extractMeters(raw);
  assert.deepStrictEqual(meters.map((m) => m.label), ['Session', 'Weekly', 'Fable']);
  assert.strictEqual(meters[0].pct, 6);
  assert.strictEqual(meters.find((m) => m.label === 'Fable').pct, 0);
});

test('internal codenames never surface as meters', () => {
  const raw = require('./fixtures/usage.json');
  const labels = extractMeters(raw).map((m) => m.label.toLowerCase());
  for (const codename of ['nimbus quill', 'tangelo', 'iguana necktie', 'cinder cove',
                          'amber ladder', 'juniper tide', 'spend'])
    assert.ok(!labels.includes(codename), codename + ' leaked into the menu');
});

test('inactive windows are flagged, not hidden', () => {
  const raw = require('./fixtures/usage.json');
  const fable = extractMeters(raw).find((m) => m.label === 'Fable');
  assert.strictEqual(fable.isActive, false);
});

test('limits[] wins over the top-level block for the same window', () => {
  const meters = extractMeters({
    five_hour: { utilization: 99 },
    limits: [{ kind: 'session', percent: 6, is_active: true }],
  });
  assert.strictEqual(meters.length, 1);
  assert.strictEqual(meters[0].pct, 6, 'limits[] value must win, not 99');
});

test('a window limits[] omits is still rescued from the top level', () => {
  const meters = extractMeters({
    five_hour: { utilization: 42 },
    nimbus_quill: { utilization: 3 },
    limits: [{ kind: 'weekly_all', percent: 8 }],
  });
  const byKey = Object.fromEntries(meters.map((m) => [m.key, m.pct]));
  assert.strictEqual(byKey.weekly, 8);
  assert.strictEqual(byKey.session, 42, 'session must not be lost');
  assert.ok(!meters.some((m) => /nimbus/i.test(m.label)), 'codename must stay out');
});

test('falls back to the tree-walk when limits[] is absent', () => {
  const meters = extractMeters({ five_hour: { utilization: 42 } });
  assert.strictEqual(meters[0].key, 'session');
  assert.strictEqual(meters[0].pct, 42);
});

test('spend and extra_usage are not usage windows', () => {
  const meters = extractMeters({
    five_hour: { utilization: 5 },
    spend: { percent: 80 },
    extra_usage: { utilization: 50 },
  });
  assert.deepStrictEqual(meters.map((m) => m.key), ['session']);
});

test('scoped model limits do not collapse into one another', () => {
  // Regression: scope.model.display_name was never read, so every
  // `weekly_scoped` entry matched the generic "weekly" hint and overwrote the
  // previous one — Fable disappeared whenever another scoped model appeared.
  const meters = extractMeters({
    five_hour: { utilization: 5 },
    seven_day: { utilization: 18 },
    limits: [
      { type: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, utilization: 7 },
      { type: 'weekly_scoped', scope: { model: { display_name: 'Nimbus Quill' } }, utilization: 3 },
    ],
  });
  const byLabel = Object.fromEntries(meters.map((m) => [m.label, m.pct]));
  assert.strictEqual(byLabel['Fable'], 7, 'Fable must survive');
  assert.strictEqual(byLabel['Nimbus Quill'], 3, 'unknown model must survive');
  assert.strictEqual(byLabel['Weekly'], 18, 'overall weekly must not be overwritten');
});

test('an unannounced model is title-cased, not shown as a raw key', () => {
  const [m] = extractMeters({ nimbus_quill: { utilization: 12 } });
  assert.strictEqual(m.label, 'Nimbus Quill');
});

test('Fable is still found when named at the top level', () => {
  const meters = extractMeters({ fable_weekly: { utilization: 9 } });
  assert.strictEqual(meters[0].key, 'fable');
});

test('long windows read in days, not three-digit hours', () => {
  const now = 1750000000;
  assert.strictEqual(untilReset(now + 161 * 3600 + 240, now), 'in 6d 17h');
  assert.strictEqual(untilReset(now + 4 * 3600 + 34 * 60, now), 'in 4h 34m');
  assert.strictEqual(untilReset(now + 45 * 60, now), 'in 45m');
  assert.strictEqual(untilReset(now + 48 * 3600, now), 'in 2d');
});

test('a paid payload is never mistaken for a free plan', () => {
  assert.strictEqual(looksLikeFreePlan(require('./fixtures/usage.json')), false);
});

test('an all-null response is recognised as a free plan', () => {
  assert.ok(looksLikeFreePlan({ five_hour: null, seven_day: null, limits: [] }));
  assert.ok(looksLikeFreePlan({ five_hour: null, seven_day: null }));
});

test('zero usage on a paid plan is not a free plan', () => {
  // 0% is a real reading. Treating it as "free" would blank out a paid user
  // who simply has not sent anything yet this window.
  assert.strictEqual(looksLikeFreePlan({ five_hour: { utilization: 0 }, limits: [] }), false);
  assert.strictEqual(looksLikeFreePlan({ limits: [{ kind: 'session', percent: 0 }] }), false);
});

test('an unrecognised response is a parser failure, not a free plan', () => {
  // These must surface as "report this", never as "upgrade your plan".
  assert.strictEqual(looksLikeFreePlan({ something_new: { pct: 5 } }), false);
  assert.strictEqual(looksLikeFreePlan({}), false);
  assert.strictEqual(looksLikeFreePlan(null), false);
});

console.log('oauth');

// fetcher.js requires 'electron', which does not exist under plain node. Serve
// a stub straight from memory rather than writing one to disk — the previous
// version hardcoded /tmp, which on Windows resolves to a D:\tmp that is not
// there, and the whole suite died on the CI runner.
const Module = require('module');
const electronStub = {
  BrowserWindow: class {},
  session: { fromPartition: () => ({ getUserAgent: () => 'Chrome/128' }) },
  shell: { openExternal() {} },
};
const _load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? electronStub : _load.call(this, request, ...rest);
};
const { hostAllowed } = require('../src/main/fetcher');
Module._load = _load;

test('Google OAuth popups are allowed to open in-app', () => {
  assert.ok(hostAllowed('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'));
  assert.ok(hostAllowed('https://accounts.youtube.com/accounts/SetSID'));
});

test('Claude and other sign-in providers allowed', () => {
  for (const u of ['https://claude.ai/login', 'https://appleid.apple.com/auth',
                   'https://login.microsoftonline.com/common'])
    assert.ok(hostAllowed(u), u);
});

test('unrelated links are pushed out to the real browser', () => {
  for (const u of ['https://example.com', 'https://github.com/x'])
    assert.ok(!hostAllowed(u), u);
});

test('lookalike domains and non-http schemes are rejected', () => {
  for (const u of ['https://accounts.google.com.evil.tld/x', 'https://fakeclaude.ai.co/x',
                   'javascript:alert(1)', 'file:///etc/passwd'])
    assert.ok(!hostAllowed(u), u);
});

console.log(`\n${passed} passed`);
