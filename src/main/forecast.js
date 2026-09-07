'use strict';

/**
 * Rolling-window reset detection and burn-rate forecasting.
 *
 * Two things make this less obvious than it looks:
 *
 * 1. `resets_at` on the 5-hour session window creeps forward by a few seconds
 *    on almost every poll, so "the value changed" is useless as a reset signal.
 *    A real reset is a large forward jump or a collapse in the percentage.
 *
 * 2. Utilization is sampled, not streamed, so the burn rate has to come from a
 *    regression over recent samples rather than a single delta.
 */

const RESET_JUMP_SECONDS = 30 * 60;
const COLLAPSE_RATIO = 0.4;
const COLLAPSE_FLOOR = 5;
const MIN_SAMPLES = 3;
const MIN_SPAN_SECONDS = 8 * 60;
const MAX_SAMPLES = 120;

class History {
  constructor(data = {}) {
    this.samples = Array.isArray(data.samples) ? data.samples.slice(-MAX_SAMPLES) : [];
    this.lastResetsAt = data.lastResetsAt ?? null;
  }

  toJSON() {
    return { samples: this.samples.slice(-MAX_SAMPLES), lastResetsAt: this.lastResetsAt };
  }

  isReset(pct, resetsAt) {
    if (this.lastResetsAt && resetsAt && resetsAt - this.lastResetsAt >= RESET_JUMP_SECONDS) {
      return true;
    }
    if (this.samples.length) {
      const prev = this.samples[this.samples.length - 1][1];
      if (prev >= COLLAPSE_FLOOR && pct <= prev * COLLAPSE_RATIO) return true;
    }
    return false;
  }

  /** Record a sample. Returns true when a window reset was detected. */
  add(pct, resetsAt, windowMinutes, now = Date.now() / 1000) {
    const wasReset = this.isReset(pct, resetsAt);
    if (wasReset) this.samples = [];
    this.samples.push([now, pct]);
    this.lastResetsAt = resetsAt;
    const cutoff = now - windowMinutes * 60;
    this.samples = this.samples.filter(([t]) => t >= cutoff).slice(-MAX_SAMPLES);
    return wasReset;
  }

  /** Least-squares slope of pct over time, in percent per hour. */
  ratePerHour() {
    if (this.samples.length < MIN_SAMPLES) return null;
    const span = this.samples[this.samples.length - 1][0] - this.samples[0][0];
    if (span < MIN_SPAN_SECONDS) return null;

    const n = this.samples.length;
    const meanT = this.samples.reduce((a, [t]) => a + t, 0) / n;
    const meanP = this.samples.reduce((a, [, p]) => a + p, 0) / n;
    let num = 0;
    let den = 0;
    for (const [t, p] of this.samples) {
      num += (t - meanT) * (p - meanP);
      den += (t - meanT) ** 2;
    }
    if (den <= 0) return null;
    return (num / den) * 3600;
  }
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  // The weekly window runs to ~168 hours. "161h 4m" is technically correct and
  // completely unreadable — nobody converts that to days in their head.
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function forecast(pct, history, resetsAt, now = Date.now() / 1000) {
  if (pct >= 99.5) return 'limit reached';
  const rate = history.ratePerHour();
  if (rate === null) return 'measuring pace…';
  if (rate <= 0.5) return 'steady — no drain';

  const hoursLeft = (100 - pct) / rate;
  const exhaustedAt = now + hoursLeft * 3600;
  if (resetsAt && resetsAt <= exhaustedAt) {
    return `resets first (in ${formatDuration(resetsAt - now)})`;
  }
  return `~${formatDuration(hoursLeft * 3600)} at current pace`;
}

function untilReset(resetsAt, now = Date.now() / 1000) {
  if (!resetsAt) return 'unknown';
  if (resetsAt <= now) return 'due now';
  return `in ${formatDuration(resetsAt - now)}`;
}

module.exports = { History, forecast, untilReset, formatDuration };
