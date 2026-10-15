# Changelog

All notable changes to `@lucascouts/vite-plugin-zeo` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Install from npm with `npm i -D @lucascouts/vite-plugin-zeo`. The tarball route is now a development note in the README.

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
