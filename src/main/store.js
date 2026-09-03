'use strict';

/** Tiny JSON store in the app's userData dir. No dependency needed. */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SETTINGS_VERSION = 2;

const DEFAULTS = {
  pollSeconds: 120,
  show: ['session', 'weekly', 'fable'],
  // macOS only: 'colon' -> S:10% W:7% | 'labeled' -> S 10%  W 7% | 'short' -> S10 W7
  titleStyle: 'colon',
  // 'logo' shows the gauge glyph before the numbers, 'none' is text only.
  // Windows ignores this: its tray has no text, so it always needs an icon.
  macTrayIcon: 'logo',
  // Windows only. 'per-meter' gives each shown meter its own numbered badge,
  // closest to the macOS strip. 'single' shows one badge for whichever meter is
  // closest to its limit — clearer, since badges carry no letters at 16px.
  windowsTrayMode: 'per-meter',
  warnAt: 80,
  dangerAt: 95,
  forecastWindowMinutes: 120,
  orgUuid: null,
  startAtLogin: true,
  firstRunDone: false,
  freeNoticeShown: false,
  settingsVersion: SETTINGS_VERSION,
};

class Store {
  constructor(filename = 'config.json') {
    this.file = path.join(app.getPath('userData'), filename);
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.data = { ...DEFAULTS, ...raw };
        if (this.migrate(raw)) this.save();
      }
    } catch (err) {
      this.save();
    }
  }

  /**
   * Pull an existing config forward when a default changes.
   *
   * First run writes every default to disk, so a later change to DEFAULTS is
   * invisible to anyone who has already launched the app. The version marker
   * lets a change land exactly once, without overriding a choice the user makes
   * afterwards.
   */
  migrate(raw) {
    const version = raw.settingsVersion || 1;
    let changed = false;
    if (version < 2) {
      // v1 shipped the tray logo off by default. Turn it on for existing
      // installs; anyone who then switches it off keeps that, since this block
      // never runs again.
      if (raw.macTrayIcon === 'none' || raw.macTrayIcon === undefined) {
        this.data.macTrayIcon = 'logo';
      }
      changed = true;
    }
    if (changed) this.data.settingsVersion = SETTINGS_VERSION;
    return changed;
  }

  get(key) {
    return this.data[key] !== undefined ? this.data[key] : DEFAULTS[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Write-then-rename so a crash mid-write can't leave a truncated config.
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('config save failed', err);
    }
  }
}

module.exports = { Store, DEFAULTS };
