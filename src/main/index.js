'use strict';

const path = require('path');
const {
  app, Tray, Menu, nativeImage, shell, dialog, clipboard, Notification,
} = require('electron');

const { Store } = require('./store');
const { Fetcher, AuthError, ORIGIN } = require('./fetcher');
const { extractMeters, looksLikeFreePlan, LABELS, CANONICAL_ORDER } = require('./parse');
const { History, forecast, untilReset } = require('./forecast');
const { macTitle, tooltip, iconState, severity, chosenMeters, STYLE_PREVIEWS } = require('./format');
const { checkForUpdate, notifyUpdate, openReleasesPage } = require('./update');
const { renderBadge } = require('./trayicon');

const IS_MAC = process.platform === 'darwin';

// The extension reads the free-plan numbers out of the chat page itself, which
// is the one place they exist. Worth pointing at whenever this app cannot help.
const CHROME_STORE_URL =
  'https://chromewebstore.google.com/detail/claude-usage-tracker/kgpahkcgadpnklinijdojapiadnfelae';
const EDGE_STORE_URL =
  'https://microsoftedge.microsoft.com/addons/detail/claude-usage-meter/anhdhmpfpgbohohjlbgnggnmcmkmmcbn';
const STALE_AFTER = 15 * 60 * 1000;
const ASSETS = path.join(__dirname, '..', '..', 'assets', 'tray');

// Only one instance may own the tray icon, or the user gets duplicates.
if (!app.requestSingleInstanceLock()) app.quit();

// macOS: no Dock icon. Windows/Linux have no equivalent — the tray is enough.
if (IS_MAC && app.dock) app.dock.hide();

let tray = null;
const meterTrays = new Map();   // Windows: one tray per meter
let store = null;
let fetcher = null;
let pollTimer = null;

const state = {
  meters: [],
  histories: new Map(),
  lastOkAt: null,
  lastError: null,
  needsLogin: false,
  updateAvailable: null,
  lastRaw: null,
};

const isStale = () => !state.lastOkAt || Date.now() - state.lastOkAt > STALE_AFTER;

function trayImage(name) {
  if (IS_MAC) {
    // The menu bar already shows "S:42% W:18%". An icon in front of that is
    // clutter for most people, so it's opt-in.
    if (store && store.get('macTrayIcon') !== 'logo') return nativeImage.createEmpty();
    const file = path.join(ASSETS, 'trayTemplate.png');
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) {
      // Silently showing nothing here is what makes "no icon" hard to diagnose.
      console.error(`Tray icon missing or unreadable: ${file}`);
      return nativeImage.createEmpty();
    }
    // Template = black + alpha; macOS recolours it for light/dark/highlighted.
    img.setTemplateImage(true);
    return img;
  }

  // Windows has no text in the tray, so the icon is the entire reading and
  // must never be empty — an empty image means an invisible tray entry.
  const img = nativeImage.createFromPath(path.join(ASSETS, `${name}.png`));
  return img.isEmpty() ? nativeImage.createFromPath(path.join(ASSETS, 'normal.png')) : img;
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

// --------------------------------------------------------------- polling

async function poll() {
  try {
    const { raw } = await fetcher.poll();
    applyResult(raw);
  } catch (err) {
    if (err instanceof AuthError) {
      state.needsLogin = true;
      state.lastError = err.message;
      // Don't sit there showing "sign in" and hope the tray gets clicked. Open
      // the window — once per run, so a persistent failure can't spawn a stack
      // of windows.
      if (!state.loginPrompted) {
        state.loginPrompted = true;
        setTimeout(signIn, 400);
      }
    } else {
      // A transient failure must not be reported as "signed out" — that flag is
      // only ever set by an actual server rejection.
      state.lastError = err.message;
    }
    render();
  }
}

function applyResult(raw) {
  state.lastRaw = raw;
  const meters = extractMeters(raw);
  const windowMinutes = store.get('forecastWindowMinutes');
  const now = Date.now() / 1000;

  for (const meter of meters) {
    let history = state.histories.get(meter.key);
    if (!history) {
      history = new History();
      state.histories.set(meter.key, history);
    }
    if (history.add(meter.pct, meter.resetsAt, windowMinutes, now)) {
      notify('Claude Usage Meter', `${meter.label} window reset — allowance refreshed.`);
    }
  }

  state.meters = meters;
  state.lastOkAt = Date.now();
  state.needsLogin = false;
  state.loginPrompted = false;

  if (meters.length) {
    state.freePlan = false;
    state.lastError = null;
  } else if (looksLikeFreePlan(raw)) {
    state.freePlan = true;
    state.lastError = null;
    showFreePlanNotice();
  } else {
    // Empty but unfamiliar — that's us failing to parse, not the user's plan.
    state.freePlan = false;
    state.lastError = 'Signed in, but no usage windows were recognised. '
      + 'Use "Copy raw usage JSON" and report it.';
  }
  render();
}

function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  const seconds = Math.max(20, Number(store.get('pollSeconds')) || 120);
  pollTimer = setInterval(poll, seconds * 1000);
}

// ------------------------------------------------------------------ menu

function meterSubmenu(meter) {
  const history = state.histories.get(meter.key) || new History();
  const items = [
    {
      label: meter.resetsAt
        ? `Resets ${untilReset(meter.resetsAt)}`
        : 'No reset scheduled — this limit has not started',
      enabled: false,
    },
    { label: forecast(meter.pct, history, meter.resetsAt), enabled: false },
  ];
  if (meter.resetsAt) {
    items.push({
      label: new Date(meter.resetsAt * 1000).toLocaleString(),
      enabled: false,
    });
  }
  items.push({ type: 'separator' }, { label: `source: ${meter.path}`, enabled: false });
  return items;
}

function chosenForTray() {
  const chosen = chosenMeters(state.meters, store);
  if (store.get('windowsTrayMode') === 'single') {
    // Whichever is closest to running out is the one worth a badge.
    return chosen.length
      ? [chosen.reduce((a, b) => (b.pct > a.pct ? b : a))]
      : [];
  }
  return chosen.slice(0, 3);
}

function buildMenu() {
  const items = [];

  if (state.needsLogin) {
    items.push(
      { label: 'Not signed in', enabled: false },
      { label: 'Sign in to Claude…', click: signIn },
      { type: 'separator' },
    );
  } else if (state.freePlan) {
    items.push(
      { label: 'Free plan — no usage data available', enabled: false },
      { label: 'Claude publishes usage figures for paid plans only.', enabled: false },
      { type: 'separator' },
      {
        label: 'Free plan? Use the browser extension',
        submenu: [
          { label: 'It reads your usage inside the Claude page,', enabled: false },
          { label: 'where the free-plan numbers actually exist.', enabled: false },
          { type: 'separator' },
          { label: 'Add to Chrome…', click: () => shell.openExternal(CHROME_STORE_URL) },
          { label: 'Add to Edge…', click: () => shell.openExternal(EDGE_STORE_URL) },
        ],
      },
      { label: 'Upgrade your Claude plan…', click: () => shell.openExternal(ORIGIN + '/settings/billing') },
      { label: 'Sign in with another account', click: signOut },
      { type: 'separator' },
    );
  } else if (!state.meters.length) {
    items.push({ label: 'Waiting for first reading…', enabled: false }, { type: 'separator' });
  } else {
    for (const meter of state.meters) {
      items.push({
        label: `${meter.label}   ${Math.round(meter.pct)}%`,
        submenu: meterSubmenu(meter),
      });
    }
    items.push({ type: 'separator' });
  }

  items.push({
    label: state.lastOkAt
      ? `Updated ${new Date(state.lastOkAt).toLocaleTimeString()}`
      : 'Updated never',
    enabled: false,
  });
  if (state.lastError) {
    items.push({ label: `⚠ ${state.lastError.slice(0, 60)}`, enabled: false });
  }
  items.push({ label: 'Refresh now', click: poll }, { type: 'separator' });

  const display = [];
  if (IS_MAC) {
    display.push({
      label: 'Title style',
      submenu: Object.entries(STYLE_PREVIEWS).map(([key, preview]) => ({
        label: preview,
        type: 'radio',
        checked: store.get('titleStyle') === key,
        click: () => { store.set('titleStyle', key); render(); },
      })),
    });
  }
  if (IS_MAC) {
    display.push({
      label: 'Show logo in menu bar',
      type: 'checkbox',
      checked: store.get('macTrayIcon') === 'logo',
      click: (item) => {
        store.set('macTrayIcon', item.checked ? 'logo' : 'none');
        render();
      },
    });
    display.push({ type: 'separator' });
  }
  if (!IS_MAC) {
    display.push({
      label: 'Taskbar badges',
      submenu: [
        {
          label: 'One badge per meter',
          type: 'radio',
          checked: store.get('windowsTrayMode') !== 'single',
          click: () => { store.set('windowsTrayMode', 'per-meter'); destroyMeterTrays(); render(); },
        },
        {
          label: 'Single badge (closest to limit)',
          type: 'radio',
          checked: store.get('windowsTrayMode') === 'single',
          click: () => { store.set('windowsTrayMode', 'single'); destroyMeterTrays(); render(); },
        },
        { type: 'separator' },
        { label: 'Hover a badge to see which meter it is.', enabled: false },
      ],
    });
    display.push({ type: 'separator' });
  }
  for (const key of CANONICAL_ORDER) {
    display.push({
      label: `Show ${LABELS[key]}`,
      type: 'checkbox',
      checked: (store.get('show') || []).includes(key),
      click: () => toggleShow(key),
    });
  }
  items.push({ label: 'Display', submenu: display });

  if (state.updateAvailable) {
    items.push(
      { label: `Update to ${state.updateAvailable}…`, click: openReleasesPage },
      { type: 'separator' },
    );
  }

  items.push(
    { label: 'Open claude.ai', click: () => shell.openExternal(ORIGIN) },
    { label: 'Sign in again…', click: signIn },
    { label: 'Sign out', click: signOut },
    { label: 'Copy raw usage JSON', click: copyRawUsage },
    { label: 'Copy diagnostics', click: copyDiagnostics },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => setLoginItem(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  );

  return Menu.buildFromTemplate(items);
}

/**
 * Windows: give every shown meter its own tray icon, numbers drawn in.
 *
 * The notification area has no text API — an app gets a small image and a
 * tooltip. So the only way to show numbers "outside" the way macOS does is to
 * draw them into the icon, and the only way to show more than one at a time is
 * more than one icon. Three sit side by side and read like the macOS strip.
 *
 * Two digits is the ceiling: the notification area renders at 16 logical pixels
 * regardless of DPI, so "S42" would be mush. The letter lives in the tooltip
 * and the menu instead.
 */
function renderWindowsTrays(stale) {
  const chosen = chosenForTray();
  const wanted = new Set(chosen.map((m) => m.key));

  for (const [key, t] of meterTrays) {
    if (!wanted.has(key)) {
      t.destroy();
      meterTrays.delete(key);
    }
  }

  for (const meter of chosen) {
    const role = stale ? 'stale' : severity(meter.pct, store.get('warnAt'), store.get('dangerAt'));
    const { buffer, width, height } = renderBadge(meter.pct, role, 32);
    const img = nativeImage.createFromBitmap(buffer, { width, height, scaleFactor: 2 });

    let t = meterTrays.get(meter.key);
    if (!t) {
      t = new Tray(img);
      t.on('click', () => t.popUpContextMenu());
      meterTrays.set(meter.key, t);
    } else {
      t.setImage(img);
    }
    t.setToolTip(`${meter.label} — ${Math.round(meter.pct)}%`
      + (meter.resetsAt ? `, resets ${untilReset(meter.resetsAt)}` : ''));
    t.setContextMenu(buildMenu());
  }
}

function destroyMeterTrays() {
  for (const [, t] of meterTrays) t.destroy();
  meterTrays.clear();
}

function render() {
  if (!tray) return;
  const stale = isStale();

  if (IS_MAC) {
    let title;
    if (state.needsLogin) title = 'Claude — sign in';
    else if (state.freePlan) title = 'Claude — free plan';
    else title = macTitle(state.meters, store);
    tray.setTitle(title);
  }
  tray.setImage(trayImage(iconState(state.meters, store, stale)));

  if (!IS_MAC) {
    // The primary tray becomes the plain logo; the per-meter badges carry the
    // numbers. Without data there is nothing to badge, so show nothing extra.
    if (state.meters.length && !state.needsLogin && !state.freePlan) {
      renderWindowsTrays(stale);
    } else {
      destroyMeterTrays();
    }
  }
  tray.setToolTip(
    state.needsLogin
      ? 'Claude Usage Meter — click to sign in'
      : state.freePlan
        ? 'Claude Usage Meter — free plans have no usage data'
        : tooltip(state.meters, store, stale),
  );
  tray.setContextMenu(buildMenu());
}

// ------------------------------------------------------------- callbacks

function toggleShow(key) {
  const show = [...(store.get('show') || [])];
  const index = show.indexOf(key);
  if (index >= 0) show.splice(index, 1);
  else show.push(key);
  show.sort((a, b) => CANONICAL_ORDER.indexOf(a) - CANONICAL_ORDER.indexOf(b));
  store.set('show', show);
  render();
}

function setLoginItem(enabled) {
  store.set('startAtLogin', enabled);
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    // Windows: start minimised to tray rather than flashing a window.
    args: IS_MAC ? [] : ['--hidden'],
  });
}

function signIn() {
  state.lastError = 'Sign-in window open…';
  render();
  fetcher.signIn((ok) => {
    state.needsLogin = !ok;
    state.lastError = ok ? null : 'Sign-in was not confirmed. Try again.';
    render();
    if (ok) poll();
  });
}

/**
 * Told once, clearly, then never nagged again. Someone on a free plan needs to
 * know why the meter is empty — but they only need telling once.
 */
function showFreePlanNotice() {
  if (store.get('freeNoticeShown')) return;
  store.set('freeNoticeShown', true);
  dialog.showMessageBox({
    type: 'warning',
    title: 'Claude Usage Meter',
    message: 'This account is on the free Claude plan',
    detail:
      'Claude only publishes usage figures for paid plans (Pro, Max and Team). '
      + 'On a free account the API returns no numbers, so this app has nothing '
      + 'to display.\n\n'
      + 'Use the free browser extension instead. The only free-plan figures '
      + 'exist inside the Claude chat page while you are sending a message, and '
      + 'the extension reads them there \u2014 something a background app '
      + 'cannot do.\n\n'
      + 'If you upgrade later, choose Refresh now and this app starts working '
      + 'straight away.',
    buttons: ['Get the browser extension', 'Sign in with another account', 'OK'],
    defaultId: 0,
    cancelId: 2,
  }).then(({ response }) => {
    // Chrome's listing covers Chrome, Brave and the other Chromium browsers.
    // Edge users get their own entry in the tray menu.
    if (response === 0) shell.openExternal(CHROME_STORE_URL);
    else if (response === 1) signOut();
  });
}

function signOut() {
  fetcher.signOut().then(() => {
    state.meters = [];
    state.histories.clear();
    state.lastOkAt = null;
    state.lastRaw = null;
    state.needsLogin = true;
    state.lastError = null;
    state.loginPrompted = true;
    render();
    signIn();
  });
}

/**
 * The API's shape changes without warning — a model can appear under a name we
 * have never seen. Rather than guess at a mapping, make the payload one click
 * away so it can be read directly.
 */
function copyRawUsage() {
  if (!state.lastRaw) {
    notify('Claude Usage Meter', 'No usage data yet — try Refresh first.');
    return;
  }
  clipboard.writeText(JSON.stringify(state.lastRaw, null, 2));
  notify('Claude Usage Meter', 'Raw usage JSON copied to clipboard.');
}

function copyDiagnostics() {
  clipboard.writeText(JSON.stringify({
    version: app.getVersion(),
    platform: `${process.platform} ${process.arch}`,
    electron: process.versions.electron,
    needsLogin: state.needsLogin,
    lastError: state.lastError,
    meters: state.meters.map((m) => [m.key, m.pct, m.path]),
    lastFetch: fetcher.lastDiagnostic,
  }, null, 2));
  notify('Claude Usage Meter', 'Diagnostics copied to clipboard.');
}

function firstRun() {
  if (store.get('firstRunDone')) return;
  store.set('firstRunDone', true);
  setLoginItem(true);
  dialog.showMessageBox({
    type: 'info',
    title: 'Claude Usage Meter',
    message: 'Welcome',
    detail:
      'Requires a paid Claude plan (Pro, Max or Team). Claude does not publish '
      + 'usage figures for free accounts \u2014 if you are on the free plan, '
      + 'use our browser extension instead, which reads them from the Claude '
      + 'page directly.\n\n'
      + 'A window will open once so you can sign in to Claude. After that the '
      + 'meter runs in the background and you will not see it again.\n\n'
      + (IS_MAC
        ? 'Your usage appears in the menu bar.'
        : 'Your usage appears in the system tray — hover the icon for the numbers.'),
    buttons: ['Sign in', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => { if (response === 0) signIn(); });
}

// ------------------------------------------------------------------ boot

app.whenReady().then(() => {
  store = new Store();
  fetcher = new Fetcher(store);

  // store must exist first: trayImage() reads macTrayIcon from it.
  tray = new Tray(trayImage('stale'));
  tray.setToolTip('Claude Usage Meter');
  // Windows convention: left-click opens the menu too, since there's no title
  // to click and users won't guess that right-click is the only way in.
  if (!IS_MAC) tray.on('click', () => tray.popUpContextMenu());
  render();

  // `--force-login` (or CUM_FORCE_LOGIN=1) wipes the session at boot so the
  // login window always appears. Uninstalling does not remove the app's data
  // directory, so a reinstall otherwise finds a live session and skips login.
  const forceLogin = process.argv.includes('--force-login')
    || process.env.CUM_FORCE_LOGIN === '1';

  if (forceLogin) {
    store.set('firstRunDone', false);
    fetcher.signOut().then(() => {
      state.needsLogin = true;
      render();
      firstRun();
    });
  } else {
    firstRun();
    if (store.get('firstRunDone') && !state.needsLogin) poll();
  }
  schedulePolling();

  // Keeps the clock-relative labels ("resets in 2h 10m") honest between polls.
  setInterval(render, 30000);

  const runUpdateCheck = async () => {
    const version = await checkForUpdate();
    if (version && version !== state.updateAvailable) {
      state.updateAvailable = version;
      notifyUpdate(version);
      render();
    }
  };
  runUpdateCheck();
  setInterval(runUpdateCheck, 6 * 60 * 60 * 1000);
});

app.on('second-instance', () => tray && tray.popUpContextMenu());
// The tray app has no windows by design; closing them must not quit it.
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { destroyMeterTrays(); if (fetcher) fetcher.destroy(); });
