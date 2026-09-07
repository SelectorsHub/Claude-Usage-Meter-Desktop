'use strict';

/**
 * Holds a logged-in Claude session in a hidden BrowserWindow and fetches usage.
 *
 * This replaces Playwright entirely. Electron already ships Chromium, the
 * session persists in a named partition, and the fetch runs inside the page so
 * cookies, headers and origin are all the real thing.
 */

const { BrowserWindow, session, shell } = require('electron');
const { hasUsageData } = require('./parse');

const ORIGIN = 'https://claude.ai';
const PARTITION = 'persist:claude';

// How many organizations we are willing to probe in one pass. Accounts with a
// long list of Team/Enterprise memberships exist; hammering /usage for every
// one of them on a failed poll is not worth it.
const MAX_PROBE_ORGS = 8;

// Capabilities that mark an org as a paid Claude.ai workspace. Anthropic has
// added tiers without warning before, so `/^claude_/` catches new ones too.
const PAID_CAPS = new Set([
  'claude_pro', 'claude_max', 'claude_team', 'claude_enterprise',
  'pro', 'max', 'team', 'enterprise', 'raven',
]);

// Console / developer-platform orgs. They answer /api/organizations but have
// no chat usage windows at all, so they must never be picked over a chat org.
const API_ONLY_CAPS = new Set(['api', 'developer_platform', 'console']);

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

function orgCaps(org) {
  const caps = Array.isArray(org.capabilities) ? org.capabilities : [];
  return caps.map((c) => String(c).toLowerCase());
}

/**
 * Rank the account's organizations, best candidate first.
 *
 * A Team member almost always belongs to at least TWO orgs: the personal one
 * created for them at signup, and the Team workspace. The old scoring gave
 * both +2 for the `chat` capability and then used `reduce` with a strict `>`,
 * which keeps the FIRST element on a tie — so whichever order the API happened
 * to return decided the account's plan. When the personal org came first we
 * queried its /usage, got an empty payload, and reported "Free plan" to
 * someone paying for Team.
 *
 * This ordering is a heuristic and deliberately never the final word. The
 * capability strings are undocumented and change; `poll()` treats this list as
 * a probe order and lets the org that actually returns usage data win.
 */
function rankOrgs(orgs) {
  if (!Array.isArray(orgs)) return [];

  return orgs
    .filter((o) => o && typeof o === 'object' && (o.uuid || o.id))
    .map((org, index) => {
      const caps = orgCaps(org);
      // No capabilities field at all is old-shape, not disqualifying.
      const chat = caps.length === 0 || caps.includes('chat');
      const apiOnly = caps.length > 0 && !chat && caps.some((c) => API_ONLY_CAPS.has(c));
      const type = String(
        org.organization_type || org.billing_type || org.raw_type || ''
      ).toLowerCase();

      let score = 0;
      if (chat) score += 4;
      if (apiOnly) score -= 8;
      if (caps.some((c) => PAID_CAPS.has(c) || /^claude_(pro|max|team|enterprise)/.test(c))) {
        score += 6;
      }
      if (/team|enterprise|business/.test(type)) score += 5;
      // A personal org has one seat; a Team workspace has more. Only counts
      // when the field is actually present.
      if (Number(org.member_count) > 1) score += 3;

      return {
        uuid: org.uuid || org.id,
        name: typeof org.name === 'string' && org.name ? org.name : '(unnamed)',
        caps,
        score,
        index,
      };
    })
    // Stable: equal scores keep API order, so behaviour stays predictable.
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

class Fetcher {
  constructor(store) {
    this.store = store;
    this.window = null;
    this.orgUuid = store.get('orgUuid') || null;
    this.candidates = null;
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

  /** Every organization this session can see, ranked as a probe order. */
  async resolveCandidates(win) {
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

    const ranked = rankOrgs(orgs);
    if (!ranked.length) {
      throw new AuthError('No usable organizations returned — session looks signed out.');
    }
    this.candidates = ranked;
    this.lastDiagnostic.orgChoices = ranked.map((o) => ({
      name: o.name, uuid: o.uuid, caps: o.caps, score: o.score,
    }));
    return ranked;
  }

  /** The org list for the account switcher, fetched if we don't have one yet. */
  async listOrgs() {
    if (this.candidates) return this.candidates;
    const win = await this.ensureWindow();
    return this.resolveCandidates(win);
  }

  /** Pin an org the user chose explicitly, and stop second-guessing it. */
  setOrg(uuid, name) {
    this.orgUuid = uuid || null;
    this.store.set('orgUuid', this.orgUuid);
    this.store.set('orgName', name || null);
    this.store.set('orgPinnedByUser', Boolean(uuid));
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

  /**
   * One full poll. Throws AuthError when the session is genuinely rejected.
   *
   * The steady-state path is one request: the org we already know reports
   * usage. Only when that org comes back empty do we spend requests looking at
   * the others — which is what makes a Team account self-correct instead of
   * sitting on "Free plan" forever.
   *
   * `probed: true` means every org this account can see was checked and none
   * of them reported a usage window. That, and only that, is grounds for the
   * caller to say "free plan".
   */
  async poll() {
    const win = await this.ensureWindow();
    if (!win.webContents.getURL().startsWith(ORIGIN)) {
      await win.loadURL(ORIGIN + '/');
    }

    const pinned = this.store.get('orgUuid') || this.orgUuid;
    let fallback = null;

    if (pinned) {
      const raw = await this.fetchUsage(win, pinned);
      if (hasUsageData(raw)) {
        this.orgUuid = pinned;
        return { raw, orgUuid: pinned, probed: false };
      }
      // A choice the user made by hand is theirs to keep. Report it empty
      // rather than silently wandering off to a different workspace.
      if (this.store.get('orgPinnedByUser')) {
        return { raw, orgUuid: pinned, probed: true, userPinned: true };
      }
      fallback = { raw, orgUuid: pinned };
    }

    // Either nothing pinned, or the pinned org went quiet — re-read the list
    // rather than trusting a cache that may predate joining a Team.
    const candidates = await this.resolveCandidates(win);
    let lastError = null;

    for (const cand of candidates.slice(0, MAX_PROBE_ORGS)) {
      if (cand.uuid === pinned) continue;   // already tried above
      let raw;
      try {
        raw = await this.fetchUsage(win, cand.uuid);
      } catch (err) {
        // One org 403ing (a Console org, or one we lack a seat on) must not
        // sink the whole poll — the next candidate may be the right one.
        lastError = err;
        continue;
      }
      if (hasUsageData(raw)) {
        this.orgUuid = cand.uuid;
        this.store.set('orgUuid', cand.uuid);
        this.store.set('orgName', cand.name);
        return { raw, orgUuid: cand.uuid, orgName: cand.name, probed: true };
      }
      if (!fallback) fallback = { raw, orgUuid: cand.uuid };
    }

    if (fallback) return { ...fallback, probed: true };
    throw lastError || new AuthError('No organization returned usage data.');
  }

  /**
   * Show a real window for sign-in, and verify it end to end before closing —
   * accepting a cached org as proof would let us close the only window the user
   * can fix anything in, without ever testing the new session.
   */
  async signIn(onDone) {
    this.orgUuid = null;
    this.candidates = null;
    this.store.set('orgUuid', null);
    this.store.set('orgName', null);
    this.store.set('orgPinnedByUser', false);
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
        // Validate end to end through the same path a real poll takes, so a
        // session that only half works never closes the sign-in window.
        await this.poll();
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
    this.candidates = null;
    this.store.set('orgUuid', null);
    this.store.set('orgName', null);
    this.store.set('orgPinnedByUser', false);
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

module.exports = {
  Fetcher, AuthError, ORIGIN, PARTITION, hostAllowed, AUTH_HOSTS, rankOrgs,
};
