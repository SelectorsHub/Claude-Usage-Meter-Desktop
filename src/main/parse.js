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

/**
 * Anthropic ships model limits under names we have never seen — "nimbus_quill"
 * turned up in the usage payload with no announcement and no documentation.
 * Rather than drop those or print a raw key, title-case whatever arrives so an
 * unrecognised model still reads like a name.
 */
function prettyLabel(path) {
  return path
    .split('.')
    .pop()
    .replace(/\[\d+\]/g, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

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

/**
 * Collect the strings that identify a limit.
 *
 * The model name is often nested — `scope.model.display_name` — and the old
 * version only read top-level string fields, so it never saw it. Every
 * `weekly_scoped` entry then matched the generic "weekly" hint and they all
 * collapsed into one meter, with the last one winning. That is why a Fable
 * limit could vanish the moment another scoped model appeared beside it.
 */
function identifyingStrings(node) {
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v) out.push(v.toLowerCase()); };

  for (const field of ['type', 'name', 'key', 'limit_type', 'id', 'display_name']) {
    push(node[field]);
  }
  const scope = node.scope;
  if (scope && typeof scope === 'object') {
    push(scope.type);
    push(scope.name);
    const model = scope.model;
    if (typeof model === 'string') push(model);
    else if (model && typeof model === 'object') {
      push(model.display_name);
      push(model.name);
      push(model.id);
    }
  }
  const model = node.model;
  if (typeof model === 'string') push(model);
  else if (model && typeof model === 'object') {
    push(model.display_name);
    push(model.name);
  }
  return out;
}

/** The model this limit is scoped to, if it names one. */
function modelName(node) {
  if (typeof node.display_name === 'string') return node.display_name.trim();
  const fromScope = node.scope && node.scope.model;
  if (typeof fromScope === 'string') return fromScope.trim();
  if (fromScope && typeof fromScope === 'object') {
    if (typeof fromScope.display_name === 'string') return fromScope.display_name.trim();
    if (typeof fromScope.name === 'string') return fromScope.name.trim();
  }
  if (node.model && typeof node.model === 'object'
      && typeof node.model.display_name === 'string') {
    return node.model.display_name.trim();
  }
  if (typeof node.model === 'string') return node.model.trim();
  return null;
}

function classify(path, node) {
  const parts = [path.toLowerCase(), ...identifyingStrings(node)];
  const hay = parts.join(' ');
  const has = (hints) => hints.some((h) => hay.includes(h));

  if (has(FABLE_HINTS)) return 'fable';
  if (has(OPUS_HINTS)) return 'weekly_opus';
  if (has(SESSION_HINTS)) return 'session';

  // A model-scoped limit gets its own key. Without this, every scoped entry
  // matches "weekly" and they overwrite each other.
  const model = modelName(node);
  if (model) {
    const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (slug && !['claude', 'default', 'all'].includes(slug)) return 'model:' + slug;
  }

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
/**
 * Read the `limits[]` array — the API's own display list.
 *
 * This is the authoritative source and should always win. Each entry carries a
 * `kind` ("session", "weekly_all", "weekly_scoped"), a `percent`, and for
 * scoped limits a `scope.model.display_name` naming the model. Note it uses
 * `percent`, NOT `utilization` — the top-level blocks use `utilization`. Mixing
 * those up is how the whole array got skipped and Fable went missing.
 *
 * Reading this array also sidesteps the top-level codenames Anthropic ships
 * here — tangelo, iguana_necktie, cinder_cove, amber_ladder, juniper_tide,
 * nimbus_quill. Those are internal flags, usually null, and are not usage the
 * user can act on. A generic tree-walk surfaces whichever happens to be
 * non-null that week, which is exactly how "Nimbus Quill" appeared unbidden.
 */
function fromLimitsArray(raw) {
  if (!Array.isArray(raw.limits) || raw.limits.length === 0) return null;

  const found = [];
  for (let i = 0; i < raw.limits.length; i++) {
    const entry = raw.limits[i];
    if (!entry || typeof entry !== 'object') continue;

    const pct = toPct(entry.percent !== undefined ? entry.percent : entry.utilization);
    if (pct === null) continue;

    const kind = String(entry.kind || entry.group || '').toLowerCase();
    const model = modelName(entry);

    let key;
    let label;
    if (kind === 'session' || kind.includes('five_hour')) {
      key = 'session';
      label = LABELS.session;
    } else if (kind === 'weekly_all') {
      key = 'weekly';
      label = LABELS.weekly;
    } else if (model) {
      const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (slug === 'fable') { key = 'fable'; label = LABELS.fable; }
      else if (slug === 'opus') { key = 'weekly_opus'; label = LABELS.weekly_opus; }
      else { key = 'model:' + slug; label = model; }
    } else if (kind.startsWith('weekly')) {
      key = 'weekly';
      label = LABELS.weekly;
    } else {
      key = 'raw:' + (kind || 'limit');
      label = prettyLabel(kind || 'limit');
    }

    found.push({
      key,
      label,
      short: SHORT[key] || label.charAt(0).toUpperCase(),
      pct,
      resetsAt: parseTimestamp(entry.resets_at),
      // `is_active: false` means the window exists but isn't currently in
      // force. Still worth showing at 0% — it tells you the limit is there.
      isActive: entry.is_active !== false,
      severity: typeof entry.severity === 'string' ? entry.severity : null,
      path: `limits[${i}]`,
      known: key in LABELS,
    });
  }
  return found.length ? found : null;
}

// Blocks that carry a percentage but are not usage windows.
const IGNORED_ROOTS = new Set(['spend', 'extra_usage']);

/**
 * Turn a /usage response into meters.
 *
 * Prefer `limits[]`. Fall back to walking the tree only when it is absent, for
 * older responses and for accounts the array does not cover.
 */
function extractMeters(raw) {
  if (!raw || typeof raw !== 'object') return [];

  const fromArray = fromLimitsArray(raw) || [];
  const covered = new Set(fromArray.map((m) => m.key));

  const found = new Map();
  for (const [path, node] of walk(raw)) {
    if (IGNORED_ROOTS.has(path.split(/[.[]/)[0])) continue;
    const pct = nodePct(node);
    if (pct === null) continue;

    const key = classify(path, node);
    let resetsAt = null;
    for (const field of ['resets_at', 'reset_at', 'resets', 'expires_at', 'window_end']) {
      resetsAt = parseTimestamp(node[field]);
      if (resetsAt !== null) break;
    }

    const named = modelName(node);
    const label = LABELS[key] || (named || prettyLabel(path));
    const meter = {
      key, label,
      short: SHORT[key] || label.charAt(0).toUpperCase(),
      pct, resetsAt,
      isActive: node.is_active !== false,
      severity: null,
      path,
      known: key in LABELS,
    };

    const existing = found.get(key);
    const depth = (str) => (str.match(/\./g) || []).length;
    if (!existing || depth(path) < depth(existing.path)) found.set(key, meter);
  }

  // When limits[] is present it is authoritative, but it may not cover every
  // window. Fill gaps from the top level with RECOGNISED meters only — this is
  // the line that keeps nimbus_quill, tangelo and the rest of the internal
  // codenames out of the menu, while still rescuing a real window that limits[]
  // happened to omit.
  const extras = [...found.values()].filter(
    (m) => !covered.has(m.key) && (fromArray.length === 0 || m.known)
  );
  return sortMeters([...fromArray, ...extras]);
}

function sortMeters(meters) {
  return meters.sort((a, b) => {
    const ai = CANONICAL_ORDER.indexOf(a.key);
    const bi = CANONICAL_ORDER.indexOf(b.key);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

/**
 * Did the server answer normally, but with nothing in it?
 *
 * Free plans get HTTP 200 with every window null and no `limits` entries. Their
 * real numbers live in the SSE `message_limit` event inside the completion
 * stream, which only fires when the user sends a message in their own tab — a
 * background window never sees it, and the only way to trigger one would be to
 * send messages on their behalf, spending the quota we are trying to report.
 *
 * Distinguishing this from a schema change matters: one is "your plan doesn't
 * expose this", the other is "we're broken". Only call it free when the shape
 * is familiar AND every window is empty.
 */
function looksLikeFreePlan(raw) {
  if (!raw || typeof raw !== 'object') return false;

  // A response we don't recognise at all is a parser problem, not a free plan.
  const KNOWN = ['five_hour', 'seven_day', 'limits'];
  if (!KNOWN.some((k) => k in raw)) return false;

  if (Array.isArray(raw.limits) && raw.limits.length > 0) return false;
  for (const key of ['five_hour', 'seven_day']) {
    const block = raw[key];
    if (block && typeof block === 'object' && toPct(block.utilization) !== null) return false;
  }
  return true;
}

module.exports = {
  extractMeters, fromLimitsArray, looksLikeFreePlan,
  CANONICAL_ORDER, LABELS, SHORT, prettyLabel, classify,
};
