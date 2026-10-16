# Changelog

All notable changes to `@lucascouts/zeo-devtools` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The devtools panel: the running app beside a chat with Zeo's agent, on devtools threads of its own. It needs a Zeo built with USE `devtools-panel`.

### Added

- A devtools panel served by the dev server on the app's host at another port, its URL printed under Vite's own as `Zeo panel:`. The app runs in a sandboxed frame on the right; the left side lists the project's devtools threads, creates a new one, and chats on it: send, stream, Stop, permission answers, and the app's current address above the frame. Its divider resizes by pointer or keyboard.
- Options `panelPort` (a fixed port, 1024–65535; a free port when unset) and `panel` (`false` serves no panel and announces nothing).
- The dev server announces itself to Zeo (root, app URL and panel URL) over a long-lived session on the devtools socket, retrying after 1, 2, 4, 8 and 16 seconds and then every 30 seconds. Zeo's `devtools: start` and `devtools: open in browser` actions use it to find the running project.
- The panel follows the project's state in Zeo: closing the project disables it with "Open this project in Zeo to continue", and reopening it restores the panel without a reload.
- Dev-server lines `panel_server_open`, `panel_server_closed`, `panel_refused`, `panel_limit`, `panel_closed`, `panel_error`, `panel_disabled`, `session_open`, `session_closed`, `session_unreachable`, `session_refused` and `zeo_too_old`, as `key=value` with the project root and never message text.

### Changed

- The dev server opens a session to Zeo when it starts, even if no page uses the picker. `panel: false` turns that off.
- Panel and session log lines name the project root. Picker relay lines still do not.
- `npm run e2e` builds first, since the panel suites load the page from `dist/panel/`; the E2E suite now includes the panel in Chromium and Firefox and an axe accessibility check.

### Security

- The panel API answers only the panel page itself: an exact `Host`, the panel's own `Origin` and `Sec-Fetch-Site: same-origin`, a JSON content type and an 8 MiB body cap; anything else is refused with 403. Every response carries a strict Content-Security-Policy with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff` and `no-referrer`.
- The app's frame has no top navigation, and the app can tell the panel only its address and title; no message from it can send, cancel, answer or create anything in a thread. A panel opened by another page refuses to connect, and at most four panels are open at once.
- Known residual: an app can open the panel URL as a `noopener` popup on a click. It starts as a normal panel the app cannot reach, and holds one of the four slots until it is closed.

## [0.2.0] — 2026-10-15

Astro support, and the first version published to npm.

### Added

- `.astro` templates are tagged in `astro dev`: every intrinsic HTML element gets `data-zeo-src` with the line and column the editor shows, multi-byte characters included, and `data-zeo-c` with the file name as the component. Components, `Fragment`, `slot`, `script`, `style`, the contents of raw-text containers and excluded names stay untagged, and the transform returns a source map.
- `zeoAstro(options)`, an Astro integration for `integrations`: under `astro dev` it adds `zeo(options)` to Astro's Vite plugins and loads the picker on every page; under any other command it adds nothing, so `astro build` output carries no `data-zeo-*` attribute and no picker code.
- `@astrojs/compiler-rs` `>= 0.4.1` as an optional peer dependency, resolved from the app root first, then from the app's `astro`. A copy that reports UTF-8 byte offsets (before 0.4) is skipped.
- Dev-server warnings `astro_compiler_missing`, `astro_compiler_incompatible` and `astro_parse_failed`: the module, or every `.astro` module, is left unchanged and the line says why.
- The package is published to npm with provenance (`publishConfig.provenance`), and declares its repository, homepage and issue tracker.

### Changed

- `zeo()` returns three plugins instead of two: the `.astro` tagger runs as its own `order: "pre"` transform, so it sees templates before Astro compiles them while the JSX tagger keeps its original order.
- Install from npm with `npm i -D @lucascouts/zeo-devtools`. The tarball route is now a development note in the README.
- The npm name is `@lucascouts/zeo-devtools`, matching the repository. A first upload as `@lucascouts/vite-plugin-zeo` on 2026-10-15 was withdrawn the same day; option errors now start with `zeo-devtools:`.

### Fixed

- `zeo()` registered more than once, for example next to `zeoAstro()`, no longer relays every pick once per copy: only the first relay listens, and the others log `reason=duplicate_plugin`.

## [0.1.0] — 2026-10-10

The element picker, shipped with Zeo's devtools bridge (patch `0052`). Not published to npm; installed from a tarball.

### Added

- In `vite dev`, every intrinsic JSX element of a `.jsx`/`.tsx` file inside the Vite root gets `data-zeo-src` (root-relative path and lines) and `data-zeo-c` (its enclosing component). Components, fragments and an `exclude` list (react-three-fiber names built in) stay untagged; nothing is tagged in `build` or `test` mode.
- An in-page picker in a shadow root, toggled by `Alt+Shift+Z` or a floating button: hover highlight with `<Component> · path:line`, click to send, Shift+click to select up to 20 elements, Esc to cancel, and a toast for each outcome.
- Tab screenshots on Chromium through `getDisplayMedia`, cropped to the selection and downsized in the page; Firefox and other browsers send without an image.
- A relay over Vite's HMR WebSocket that validates each selection against a shared wire contract, confines paths to the Vite root and writes one JSON line to `$XDG_RUNTIME_DIR/zeo/devtools.sock` (`ZEO_DEVTOOLS_SOCKET` or `socketPath` override it). It refuses to start on Vite older than 6.0.9 or with `server.ws: false`.
- Options `socketPath`, `shortcut`, `exclude` and `screenshot`, validated at config load.
