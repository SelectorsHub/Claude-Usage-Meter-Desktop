'use strict';

/**
 * Holds a logged-in Claude session in a hidden BrowserWindow and fetches usage.
 *
 * This replaces Playwright entirely. Electron already ships Chromium, the
 * session persists in a named partition, and the fetch runs inside the page so
 * cookies, headers and origin are all the real thing.
 */

const { BrowserWindow, session, shell } = require('electron');

const ORIGIN = 'https://claude.ai';
const PARTITION = 'persist:claude';

// Sign-in providers whose pages must open INSIDE the app, sharing our cookie
// jar. "Continue with Google" opens a popup via window.open; with no handler
// registered Electron drops it, so the user clicks the button and nothing at
// all happens — which reads exactly like "Google login doesn't work here".
const AUTH_HOSTS = [
  'claude.ai',
  'anthropic.com',
  'accounts.google.com',
  'accounts.youtube.com',
  'google.com',
  'gstatic.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
];

function hostAllowed(url) {
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    host = parsed.hostname.toLowerCase();
  } catch (err) {
    return false;
  }
  return AUTH_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

// Electron's default User-Agent contains "Electron/x.y.z", which bot filters
// flag. That produces a 403 on /api/* even with a perfectly valid cookie —
// indistinguishable from being signed out. Strip it to a plain Chrome UA.
function cleanUserAgent() {
  const raw = session.fromPartition(PARTITION).getUserAgent();
  return raw
    .replace(/ Electron\/[\d.]+/, '')
    .replace(/ ClaudeUsageMeter\/[\d.]+/, '');
}

const JS_ORGS = `
(async () => {
  const r = await fetch('/api/organizations', {
    credentials: 'include', headers: { Accept: 'application/json' }
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) {}
  return { status: r.status, body, sample: text.slice(0, 300) };
})()`;

const JS_USAGE = (orgId) => `
(async () => {
  const r = await fetch('/api/organizations/${orgId}/usage', {
    credentials: 'include', headers: { Accept: 'application/json' }
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) {}
  return { status: r.status, body, sample: text.slice(0, 300) };
})()`;

class AuthError extends Error {}

class Fetcher {
  constructor(store) {
    this.store = store;
    this.window = null;
    this.orgUuid = store.get('orgUuid') || null;
    this.lastDiagnostic = {};
  }

  createWindow({ show = false } = {}) {
    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      show,
      skipTaskbar: !show,
      title: 'Claude Usage Meter',
      webPreferences: {
        partition: PARTITION,
        // The page is claude.ai, not our code. No node, no preload, isolated.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    win.webContents.setUserAgent(cleanUserAgent());
    this.attachWindowOpenHandler(win);
    // A sign-in window the user closes shouldn't kill the app's only session.
    win.on('closed', () => {
      if (this.window === win) this.window = null;
    });
    return win;
  }

  /**
   * Let OAuth popups open as real child windows, inside our session.
   *
   * Without this the Google flow simply dies. With it, the popup shares
   * `persist:claude`, so the cookie Google sets lands in the same jar Claude
   * then reads. Anything that isn't a sign-in provider is pushed out to the
   * user's real browser instead of opening a browser inside our app.
   */
  attachWindowOpenHandler(win) {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (!hostAllowed(url)) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          show: true,
          modal: false,
          autoHideMenuBar: true,
          title: 'Sign in',
          webPreferences: {
            // Same partition or the popup writes its cookies somewhere we
            // will never read.
            partition: PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    });

    // The override above cannot set a User-Agent, so do it the moment the
    // child exists — before it has navigated anywhere.
    win.webContents.on('did-create-window', (child) => {
      try {
        child.webContents.setUserAgent(cleanUserAgent());
        child.setMenuBarVisibility(false);
        this.attachWindowOpenHandler(child);   // Google can chain a second popup
      } catch (err) {
        /* window already gone */
      }
    });
  }

  async ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    this.window = this.createWindow({ show: false });
    await this.window.loadURL(ORIGIN + '/');
    return this.window;
  }

  async run(win, script) {
    return win.webContents.executeJavaScript(script, true);
  }

  async resolveOrg(win, { force = false } = {}) {
    if (!force) {
      const pinned = this.store.get('orgUuid');
      if (pinned) return pinned;
      if (this.orgUuid) return this.orgUuid;
    }

    const res = await this.run(win, JS_ORGS);
    this.lastDiagnostic.organizations = { status: res.status, sample: res.sample };

    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`Session rejected by /api/organizations (HTTP ${res.status}).`);
    }
    if (res.status !== 200) {
      throw new Error(`/api/organizations returned HTTP ${res.status}.`);
    }
    const orgs = res.body;
    if (!Array.isArray(orgs) || orgs.length === 0) {
      throw new AuthError('No organizations returned — session looks signed out.');
    }

    const score = (org) => {
      const caps = (org.capabilities || []).map((c) => String(c).toLowerCase());
      return (caps.includes('chat') ? 2 : 0) - (caps.includes('api') ? 1 : 0);
    };
    const best = orgs.reduce((a, b) => (score(b) > score(a) ? b : a));
    this.orgUuid = best.uuid || best.id;
    this.store.set('orgUuid', this.orgUuid);
    return this.orgUuid;
  }

  async fetchUsage(win, orgId) {
    const res = await this.run(win, JS_USAGE(orgId));
    this.lastDiagnostic.usage = { status: res.status, sample: res.sample };
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`Session rejected by /usage (HTTP ${res.status}).`);
    }
    if (res.status !== 200) throw new Error(`Usage API returned HTTP ${res.status}.`);
    return res.body;
  }

  /** One full poll. Throws AuthError when the session is genuinely rejected. */
  async poll() {
    const win = await this.ensureWindow();
    if (!win.webContents.getURL().startsWith(ORIGIN)) {
      await win.loadURL(ORIGIN + '/');
    }
    const org = await this.resolveOrg(win);
    return { raw: await this.fetchUsage(win, org), orgUuid: org };
  }

  /**
   * Show a real window for sign-in, and verify it end to end before closing —
   * accepting a cached org as proof would let us close the only window the user
   * can fix anything in, without ever testing the new session.
   */
  async signIn(onDone) {
    this.orgUuid = null;
    this.store.set('orgUuid', null);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();

    const win = this.createWindow({ show: true });
    this.window = win;
    await win.loadURL(ORIGIN + '/login');
    win.focus();

    const deadline = Date.now() + 5 * 60 * 1000;
    const check = async () => {
      if (win.isDestroyed()) return onDone(false);
      if (Date.now() > deadline) {
        win.destroy();
        return onDone(false);
      }
      try {
        const org = await this.resolveOrg(win, { force: true });
        await this.fetchUsage(win, org);
        win.hide();
        win.setSkipTaskbar(true);
        return onDone(true);
      } catch (err) {
        setTimeout(check, 2000);
      }
    };
    setTimeout(check, 2500);
  }

  /**
   * Clear the cookie jar so the next poll requires a fresh login.
   *
   * Uninstalling the app leaves ~/Library/Application Support/Claude Usage
   * Meter behind, so a "fresh install" still finds a valid session and never
   * shows the login window. This is how you actually get back to first-run.
   */
  async signOut() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.orgUuid = null;
    this.store.set('orgUuid', null);
    try {
      await session.fromPartition(PARTITION).clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'],
      });
    } catch (err) {
      /* nothing to clear */
    }
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = { Fetcher, AuthError, ORIGIN, PARTITION, hostAllowed, AUTH_HOSTS };
