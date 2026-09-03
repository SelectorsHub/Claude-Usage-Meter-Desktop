'use strict';

/**
 * Update check without electron-updater.
 *
 * electron-updater needs latest.yml and .blockmap files published alongside the
 * installers, plus a .zip target on macOS. That's five extra artifacts on the
 * release page for a tool people download once — and the macOS half never
 * worked anyway, because only a dmg target was configured.
 *
 * So instead: ask the GitHub API what the newest tag is, and if it's newer,
 * offer to open the release page. No extra artifacts, works identically on both
 * platforms, and the download stays a deliberate act by the user.
 *
 * The trade-off is real: this notifies, it does not install. If silent
 * background updates matter later, bring back electron-updater and accept the
 * extra files.
 */

const { app, shell, Notification } = require('electron');

const RELEASES_API =
  'https://api.github.com/repos/SelectorsHub/Claude-Usage-Meter-Desktop/releases/latest';
const RELEASES_PAGE =
  'https://github.com/SelectorsHub/Claude-Usage-Meter-Desktop/releases/latest';

/** Compare dotted versions numerically. Returns true when b is newer than a. */
function isNewer(current, candidate) {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(current);
  const b = parse(candidate);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

/**
 * Returns the newer version string, or null. Never throws — a failed update
 * check must not disturb an app whose actual job is unrelated.
 */
async function checkForUpdate() {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const latest = String(data.tag_name || '').replace(/^v/, '');
    if (!latest || !isNewer(app.getVersion(), latest)) return null;
    return latest;
  } catch (err) {
    return null;
  }
}

function openReleasesPage() {
  shell.openExternal(RELEASES_PAGE);
}

function notifyUpdate(version) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: 'Claude Usage Meter',
    body: `Version ${version} is available. Click to download.`,
  });
  n.on('click', openReleasesPage);
  n.show();
}

module.exports = { checkForUpdate, notifyUpdate, openReleasesPage, isNewer, RELEASES_PAGE };
