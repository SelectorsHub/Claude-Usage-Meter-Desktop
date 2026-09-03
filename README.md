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

Windows has no text API for the notification area — an app gets a small image
and a tooltip, and that is the whole contract. So the numbers ARE the icons:
`src/main/trayicon.js` draws them into a raw BGRA bitmap by hand (no canvas in
the main process, no image library, no 300 pre-rendered PNGs) and each shown
meter gets its own tray entry, so three badges sit side by side.

Two digits is the ceiling. The notification area renders at 16 logical pixels
whatever the DPI, so `S42` would be mush — the letter lives in the tooltip
instead, and 100%+ shows as `!!`. Badges are filled with the severity colour and
the digits are white, because the taskbar can be light or dark and an outlined
icon would vanish for half of users.

**Display → Taskbar badges** switches between one badge per meter and a single
badge for whichever meter is closest to its limit. The single badge is clearer,
since badges carry no letters; the three-badge view is closer to macOS.


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

## Parsing notes

`limits[]` is the source of truth — it is Claude's own display list, carrying
`kind`, `percent`, `severity` and `is_active`. Two traps:

- Entries there use **`percent`**; the top-level blocks use **`utilization`**.
  Reading only the latter skips the array entirely, which is how the Fable meter
  went missing.
- Model-scoped limits name their model at `scope.model.display_name`. Classify
  without reading it and every `weekly_scoped` entry matches the generic
  "weekly" hint and they overwrite each other.

Recognised top-level windows fill any gap `limits[]` leaves; unrecognised ones
are dropped, which is what keeps the codenames out.

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

- **Free plans are not supported.** Claude's `/usage` endpoint returns nulls for
  unmetered accounts. The only free-plan figures live in the SSE `message_limit`
  event inside the completion stream, which fires when *you* send a message in
  *your* tab — a background window never sees it. The app detects this, says so
  plainly, and points at the browser extension, which reads those numbers from
  the page itself.
- **~150MB installed.** That is Chromium. It is also what removes the separate
  browser dependency.

## Troubleshooting

**It never asks me to sign in.** Uninstalling does not remove the app's data
directory, so a reinstall finds the old session. To get a true first run:

```bash
rm -rf ~/Library/Application\ Support/Claude\ Usage\ Meter   # macOS
```

Or use **Sign out** in the tray menu, or launch with `--force-login`.

**A meter is missing, or one I don't recognise appears.** Claude ships internal
codenames in this payload (`nimbus_quill`, `tangelo`, `cinder_cove`…) alongside
the real windows. The parser reads the `limits[]` array, which is Claude's own
display list, so those never surface. If something still looks wrong, use **Copy
raw usage JSON** in the tray menu and compare against `test/fixtures/usage.json`.

**Google sign-in does nothing.** `setWindowOpenHandler` in `src/main/fetcher.js`
allows the OAuth popup. Without it Electron drops the `window.open` call
silently and the button appears dead.

