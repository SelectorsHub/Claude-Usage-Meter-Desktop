'use strict';

/**
 * Parse Claude.ai's /api/organizations/{id}/usage payload into meters.
 *
 * THE pickPct RULE
 * ----------------
 * The REST /usage endpoint reports `utilization` as an integer percentage,
 * 0..100. `utilization: 1` means ONE PERCENT, not 100%.
 *
 * The SSE `message_limit` event reports 0..1 fractions instead. The two scales
 * must never meet. Nothing in this file scales — if you wire in an SSE source
 * later, convert at that boundary and keep it out of here.
 */

const SESSION_HINTS = ['five_hour', '5_hour', 'fivehour', 'session'];
const WEEKLY_HINTS = ['seven_day', '7_day', 'sevenday', 'weekly', 'week'];
const OPUS_HINTS = ['opus'];
const FABLE_HINTS = ['fable'];

const LABELS = {
  session: 'Session',
  weekly: 'Weekly',
  weekly_opus: 'Weekly (Opus)',
  fable: 'Fable',
};

const SHORT = { session: 'S', weekly: 'W', weekly_opus: 'O', fable: 'F' };

const CANONICAL_ORDER = ['session', 'weekly', 'weekly_opus', 'fable'];

function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value > 1e11 ? value / 1000 : value;
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

function toPct(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, num));
}

function classify(path, node) {
  let hay = path.toLowerCase();
  for (const field of ['type', 'name', 'key', 'scope', 'model', 'limit_type', 'id']) {
    if (typeof node[field] === 'string') hay += ' ' + node[field].toLowerCase();
  }
  const has = (hints) => hints.some((h) => hay.includes(h));
  if (has(FABLE_HINTS)) return 'fable';
  if (has(OPUS_HINTS)) return 'weekly_opus';
  if (has(SESSION_HINTS)) return 'session';
  if (has(WEEKLY_HINTS)) return 'weekly';
  return 'raw:' + path.replace(/\[\d+\]/g, '[]');
}

function* walk(node, path = '') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* walk(node[i], `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('utilization' in node || 'used' in node || 'remaining' in node) {
      yield [path || '$', node];
    }
    for (const [key, value] of Object.entries(node)) {
      yield* walk(value, path ? `${path}.${key}` : key);
    }
  }
}

function nodePct(node) {
  const direct = toPct(node.utilization);
  if (direct !== null) return direct;
  const limit = Number(node.limit ?? node.total);
  if (Number.isFinite(limit) && limit > 0) {
    const used = Number(node.used);
    if (Number.isFinite(used)) return Math.max(0, Math.min(100, (used / limit) * 100));
    const remaining = Number(node.remaining);
    if (Number.isFinite(remaining)) {
      return Math.max(0, Math.min(100, (1 - remaining / limit) * 100));
    }
  }
  return null;
}

/**
 * Turn a /usage response into meters, tolerating schema drift.
 *
 * The endpoint's shape has changed more than once, so this walks the whole tree
 * instead of reaching for fixed keys. Each meter carries the JSON path it came
 * from, which is what the Diagnostics menu item reports.
 */
function extractMeters(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const found = new Map();

  for (const [path, node] of walk(raw)) {
    const pct = nodePct(node);
    if (pct === null) continue;

    const key = classify(path, node);
    let resetsAt = null;
    for (const field of ['resets_at', 'reset_at', 'resets', 'expires_at', 'window_end']) {
      resetsAt = parseTimestamp(node[field]);
      if (resetsAt !== null) break;
    }

    const label = LABELS[key] || path.split('.').pop().replace(/_/g, ' ');
    const meter = {
      key,
      label,
      short: SHORT[key] || label.charAt(0).toUpperCase(),
      pct,
      resetsAt,
      path,
      known: key in LABELS,
    };

    // A shallower path wins: top-level fields beat nested duplicates.
    const existing = found.get(key);
    const depth = (s) => (s.match(/\./g) || []).length;
    if (!existing || depth(path) < depth(existing.path)) found.set(key, meter);
  }

  return [...found.values()].sort((a, b) => {
    const ai = CANONICAL_ORDER.indexOf(a.key);
    const bi = CANONICAL_ORDER.indexOf(b.key);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

module.exports = { extractMeters, CANONICAL_ORDER, LABELS, SHORT };
