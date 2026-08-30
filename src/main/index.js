'use strict';

const path = require('path');
const {
  app, Tray, Menu, nativeImage, shell, dialog, clipboard, Notification,
} = require('electron');

const { Store } = require('./store');
const { Fetcher, AuthError, ORIGIN } = require('./fetcher');
const { extractMeters, LABELS, CANONICAL_ORDER } = require('./parse');
const { History, forecast, untilReset } = require('./forecast');
const { macTitle, tooltip, iconState, STYLE_PREVIEWS } = require('./format');
const { checkForUpdate, notifyUpdate, openReleasesPage } = require('./update');

const IS_MAC = process.platform === 'darwin';
const STALE_AFTER = 15 * 60 * 1000;
const ASSETS = path.join(__dirname, '..', '..', 'assets', 'tray');

// Only one instance may own the tray icon, or the user gets duplicates.
if (!app.requestSingleInstanceLock()) app.quit();

// macOS: no Dock icon. Windows/Linux have no equivalent — the tray is enough.
if (IS_MAC && app.dock) app.dock.hide();

let tray = null;
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
    } else {
      // A transient failure must not be reported as "signed out" — that flag is
      // only ever set by an actual server rejection.
      state.lastError = err.message;
    }
    render();
  }
}

function applyResult(raw) {
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
  state.lastError = meters.length
    ? null
    : 'No usage windows in the response. Free plans do not expose /usage.';
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
    { label: `Resets ${untilReset(meter.resetsAt)}`, enabled: false },
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

function buildMenu() {
  const items = [];

  if (state.needsLogin) {
    items.push(
      { label: 'Not signed in', enabled: false },
      { label: 'Sign in to Claude…', click: signIn },
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

function render() {
  if (!tray) return;
  const stale = isStale();

  if (IS_MAC) {
    tray.setTitle(state.needsLogin ? 'Claude — sign in' : macTitle(state.meters, store));
  }
  tray.setImage(trayImage(iconState(state.meters, store, stale)));
  tray.setToolTip(
    state.needsLogin
      ? 'Claude Usage Meter — click to sign in'
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
      'A window will open once so you can sign in to Claude. After that the '
      + 'meter runs in the background and you will not see it again.\n\n'
      + (IS_MAC
        ? 'Your usage appears in the menu bar.'
        : 'Your usage appears in the system tray — hover the icon for the numbers.'),
    buttons: ['Sign in'],
  }).then(signIn);
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

  firstRun();
  if (store.get('firstRunDone') && !state.needsLogin) poll();
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
app.on('before-quit', () => fetcher && fetcher.destroy());
