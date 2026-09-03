'use strict';

/**
 * Title and icon state.
 *
 * macOS can draw text in the menu bar, so it gets `S:10% W:7%`. Windows cannot —
 * a tray entry is a 16x16 image plus a tooltip, full stop. So on Windows the
 * colour carries the reading and the numbers go in the tooltip. That asymmetry
 * is the OS, not the framework; no amount of tooling changes it.
 */

const STYLES = {
  // A space after the colon: "S: 14%" reads as a label and a value, where
  // "S:14%" reads as one token. The wider gap keeps the pairs separate.
  colon: { joiner: ': ', gap: '  ', pct: true },
  labeled: { joiner: ' ', gap: '  ', pct: true },
  short: { joiner: '', gap: ' ', pct: false },
};

const STYLE_PREVIEWS = {
  colon: 'S: 10%  W: 7%',
  labeled: 'S 10%  W 7%',
  short: 'S10 W7',
};

function severity(pct, warnAt, dangerAt) {
  if (pct >= dangerAt) return 'danger';
  if (pct >= warnAt) return 'warn';
  return 'normal';
}

function chosenMeters(meters, store) {
  const show = store.get('show') || [];
  const byKey = new Map(meters.map((m) => [m.key, m]));
  const picked = show.map((k) => byKey.get(k)).filter(Boolean);
  if (picked.length) return picked;
  const known = meters.filter((m) => m.known);
  return known.length ? known : meters;
}

/** macOS menu bar text. Every style keeps the letter — bare digits mean nothing. */
function macTitle(meters, store) {
  const picked = chosenMeters(meters, store);
  if (!picked.length) return 'Claude —';
  const style = STYLES[store.get('titleStyle')] || STYLES.colon;
  return picked
    .map((m) => `${m.short}${style.joiner}${Math.round(m.pct)}${style.pct ? '%' : ''}`)
    .join(style.gap);
}

/** Windows tooltip. Multi-line is fine here and far more readable than the icon. */
function tooltip(meters, store, stale) {
  const picked = chosenMeters(meters, store);
  if (!picked.length) return 'Claude Usage Meter — no data yet';
  const lines = picked.map((m) => `${m.label}: ${Math.round(m.pct)}%`);
  if (stale) lines.push('(last reading is stale)');
  return ['Claude Usage Meter', ...lines].join('\n');
}

/** Which tray icon to show: the worst meter decides. */
function iconState(meters, store, stale) {
  if (stale || !meters.length) return 'stale';
  const warnAt = store.get('warnAt');
  const dangerAt = store.get('dangerAt');
  const worst = Math.max(...chosenMeters(meters, store).map((m) => m.pct), 0);
  return severity(worst, warnAt, dangerAt);
}

module.exports = { macTitle, tooltip, iconState, severity, chosenMeters, STYLES, STYLE_PREVIEWS };
