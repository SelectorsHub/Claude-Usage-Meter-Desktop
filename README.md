# Claude Usage Meter — Desktop

Claude.ai usage in the macOS menu bar and the Windows system tray.

```
macOS     S: 42%  W: 18%  F: 7%      (text in the menu bar)
Windows   ◕ coloured tray icon  (numbers in the tooltip + menu)
```

## Run it

```bash
npm install
npm start
```

Sign in when the window opens. It hides itself and polls from then on.

## Build

```bash
npm test          # 12 tests over the parse + forecast logic
npm run dist:mac  # DMG (arm64 + x64)
npm run dist:win  # NSIS installer (x64 + arm64)
```

Tag a release and GitHub Actions builds both on their native runners:

```bash
git tag v1.0.0 && git push --tags
```

## Signing secrets

Set these in the repo's Settings → Secrets → Actions. All optional — unset just
means unsigned builds with OS warnings.

| Secret | Purpose |
|---|---|
| `MAC_CERT_P12`, `MAC_CERT_PASSWORD` | Developer ID cert, base64-encoded |
| `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID` | Notarization |
| `WIN_CERT_PFX`, `WIN_CERT_PASSWORD` | Windows code signing |

Notarization is not the Mac App Store — no review, no listing, no 30% cut. Just
an automated scan that takes a few minutes.

## Icons

All tray icons are committed in `assets/tray/`, generated from `assets/logo.svg`.
After changing the logo:

```bash
npm install --save-dev sharp
npm run icons
```

The tray glyph is the **gauge and needle only** — the sun disc and Claude burst
are dropped. In a macOS template image the white burst has to be knocked out of
the coral disc, which leaves a sliver that vanishes below about 48px; at 16 and
32 it added nothing but mud. The full logo with disc and burst is still used for
the app icon (`build/icon.png` → Dock, installer, taskbar).

Windows recolours the gauge itself — coral, amber, red, grey — rather than
adding a status badge, because a badge big enough to see at 16px covers the
logo completely.

The macOS menu bar shows the gauge glyph before the numbers by default. Turn it
off with Display → Show logo in menu bar, or `"macTrayIcon": "none"` for text
only.

## Why the platforms differ

macOS lets an app draw text in the menu bar, so you get `S: 42%  W: 18%`.

Windows tray entries are a 16×16 image plus a tooltip. There is no text API. So
Windows gets a ring icon that fills and changes colour (blue → amber → red),
with the numbers in the tooltip and the right-click menu. Rendering digits into
16×16 was tried and is unreadable.

That difference is the OS, not the framework. Electron, Tauri and native code
all hit it.

## Architecture

```
src/main/index.js    tray, menu, polling loop, auto-launch
src/main/fetcher.js  hidden BrowserWindow holding the session
src/main/parse.js    tolerant tree-walk over the /usage payload
src/main/forecast.js reset detection + burn-rate regression
src/main/format.js   mac title text / windows icon state + tooltip
src/main/store.js    JSON config in userData
```

No Playwright. Electron already ships Chromium, so a hidden `BrowserWindow` with
a `persist:claude` partition is the browser — and the fetch runs inside the page,
so cookies, headers and origin are all real.

## Carried over from the extension

- **The pickPct rule.** REST `utilization` is 0..100; `utilization: 1` means one
  percent. SSE `message_limit` values are 0..1 fractions. `parse.js` never
  rescales, and a test asserts `1 → 1%`.
- **Reset detection by discontinuity.** `resets_at` creeps forward seconds on
  every poll, so a reset is only a ≥30min jump or a collapse to ≤40%.
- **UA hygiene.** Electron's default UA contains `Electron/x.y.z`, which trips
  the bot filter and returns 403 on `/api/*` even with a valid cookie. It is
  stripped in `fetcher.js`.
- **Auth state is not sticky.** Only a real 401/403 sets "signed out"; transient
  failures show an error instead.

## Known limits

- **Free plans don't work.** `/usage` returns null for unmetered accounts. The
  extension reads the SSE `message_limit` event instead, but that only fires
  when *you* send a message in *your* tab — a background window never sees it.
- **~150MB installed.** That's Chromium. It's also what removes the separate
  browser dependency.
