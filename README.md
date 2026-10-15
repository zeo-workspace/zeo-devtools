# @lucascouts/vite-plugin-zeo

A Vite dev-server plugin for Zeo, the Zed editor build of the `zeo-workspace` chain, for Vite
apps and Astro sites. Turn on the picker in the page you are developing, click an element, and
Zeo's agent composer receives it as a mention: the JSX or `.astro` source lines that rendered
it, a short DOM summary and, where the browser allows, a screenshot of the element.

Nothing is sent to the agent automatically. The mentions wait in the composer until you send
the message yourself.

It works in `vite dev` and `astro dev` only. All of its plugins are `apply: "serve"`, and
`zeoAstro()` adds nothing outside `astro dev`, so `vite build` and `astro build` output contain
no `data-zeo-*` attribute and no picker code.

## How it works

1. **Tagger.** In dev, every intrinsic JSX element (`<div>`, `<button>`, …) in a `.jsx`/`.tsx`
   file inside the Vite root gets `data-zeo-src="src/App.tsx:12:7-14"` and the name of its
   enclosing component in `data-zeo-c`. Components, fragments and the names in `exclude` are
   left alone. In an Astro site, every intrinsic HTML element of an `.astro` template gets the
   same pair, with the file name (`Header` for `src/components/Header.astro`) as the component;
   see [Astro](#astro) for what is left alone there.
2. **Picker.** A page module, injected by the plugin, draws the overlay inside a shadow root,
   so page CSS cannot reach it and its CSS cannot reach the page.
3. **Relay.** The picker sends the selection over Vite's own HMR WebSocket. The dev server
   validates it, turns each project-relative path into an absolute one, and writes it as one
   JSON line to Zeo's devtools bridge socket, `$XDG_RUNTIME_DIR/zeo/devtools.sock`.
4. **Zeo** (patch `0052`, crate `devtools_bridge`) finds the window whose project holds the
   files and inserts one mention per element into the composer of the active thread. With no
   active thread, it opens a new one. It then raises the window and focuses the composer.

## Requirements

|        |                                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node   | `>= 24`                                                                                                                                                     |
| Vite   | `>= 6.0.9` (peer dependency). Older Vite has no Origin and token check on its HMR socket (CVE-2025-24010), so the relay refuses to start there and logs why |
| Source | React-style JSX in `.jsx`/`.tsx` files, or `.astro` templates (see [Astro](#astro))                                                                         |
| Astro  | Astro 7, with `@astrojs/compiler-rs` `>= 0.4.1` reachable from the app (optional peer dependency; Astro 7 brings its own copy)                              |
| Zeo    | a build that carries the devtools bridge, with `devtools_bridge.enabled` left on (the default)                                                              |
| OS     | Linux, with `XDG_RUNTIME_DIR` set to an absolute path, in the same user session as Zeo                                                                      |

## Install

```bash
npm i -D @lucascouts/vite-plugin-zeo
```

To try a build that is not on npm yet, see [Development](#development).

## Configure

```js
// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { zeo } from "@lucascouts/vite-plugin-zeo";

export default defineConfig({
  // zeo() before react(), so the tagger sees JSX before it is compiled away.
  plugins: [zeo(), react()],
});
```

`zeo()` must come before `react()` when `react()` enables the React Compiler. Otherwise no
element is tagged, and the dev server warns with
`zeo-devtools event=warning reason=react_compiler_first`.

### Options

All are optional, for `zeo()` and `zeoAstro()` alike. Invalid options throw at config load, in
`dev` and `build` alike.

| Option       | Type       | Default                                                           | Meaning                                                                                                                                                                                                                                           |
| ------------ | ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `socketPath` | `string`   | `$ZEO_DEVTOOLS_SOCKET`, else `$XDG_RUNTIME_DIR/zeo/devtools.sock` | Zeo's socket. It must be an absolute path.                                                                                                                                                                                                        |
| `shortcut`   | `string`   | `"Alt+Shift+Z"`                                                   | Toggles the picker. Modifiers are `Alt`, `Shift`, `Ctrl` (or `Control`) and `Meta` (or `Cmd`), and the last part is the key. Modifiers must match exactly. A letter matches the physical key, so the shortcut is the same on any keyboard layout. |
| `exclude`    | `string[]` | `[]`                                                              | More intrinsic tag names never to tag, added to the built-in react-three-fiber list (`mesh`, `group`, …), whose elements cannot take unknown props.                                                                                               |
| `screenshot` | `boolean`  | `true`                                                            | With `false`, the page never asks to share the screen and selections go without an image.                                                                                                                                                         |

The `ZEO_DEVTOOLS_SOCKET` environment variable overrides the default path without touching
the config. It is read by the dev server, not by Zeo.

## Astro

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import { zeoAstro } from "@lucascouts/vite-plugin-zeo";

export default defineConfig({
  integrations: [zeoAstro()],
});
```

`zeoAstro(options)` takes the same [options](#options) as `zeo()`. Under `astro dev` it adds
`zeo(options)` to Astro's Vite plugins and loads the picker on every page through a page script
(Astro never runs Vite's `transformIndexHtml`, which is how `zeo()` loads it in a plain Vite
app). Under `astro build`, `astro preview` and `astro sync` it adds nothing.

Use `zeoAstro()` instead of `zeo()`, never both. A `zeo()` left in `vite.plugins` next to
`zeoAstro()` registers a second relay. Only the first one listens, so each pick still reaches
Zeo once, and the dev server warns with `reason=duplicate_plugin`.

**Scope.** Astro 7. The `.astro` tagger parses templates with `@astrojs/compiler-rs`, an
optional peer dependency (`>= 0.4.1`) the plugin never bundles. It uses the app's copy: first
the one the app root resolves, then the one the app's `astro` resolves. Astro 7 depends on its
own copy, so an Astro 7 app needs nothing more. A copy that reports positions in UTF-8 bytes
(compiler-rs before 0.4, which some packages still pull in and hoist to the app root) would tag
elements at wrong columns, so it is skipped and the next one is tried.

**What is tagged.** Every intrinsic HTML element of an `.astro` template inside the Vite root,
including elements inside template expressions such as `{items.map((i) => <li>{i}</li>)}`.
Its line and column are the ones the editor shows, multi-byte characters included, and the
transform returns a source map, so Astro's error overlay keeps pointing at the right line.

**What stays untagged.**

|                                                      |                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Components                                           | a capitalised or dotted tag name (`<Card>`, `<Foo.Bar>`, `<ui.button>`). An `.astro` component's elements are tagged in its own file.                                                                                               |
| `Fragment`, `slot`                                   | they render no element of their own. Their children are tagged.                                                                                                                                                                     |
| `script`, `style`                                    | neither the element nor its content, which is JavaScript or CSS. An attribute would change how Astro processes them.                                                                                                                |
| Raw-text containers                                  | the contents of `textarea`, `title`, `xmp`, `iframe`, `noscript`, `noembed`, `noframes` and `plaintext`. The browser shows their content as text, so an attribute inside would become visible text. The container itself is tagged. |
| Excluded names                                       | the built-in list and the names in the `exclude` option, as for JSX                                                                                                                                                                 |
| Modules that fail to parse                           | the module is left unchanged and Astro reports the error itself. The dev server logs `reason=astro_parse_failed` once per file.                                                                                                     |
| Every `.astro` module                                | when no usable `@astrojs/compiler-rs` is found (`reason=astro_compiler_missing` or `reason=astro_compiler_incompatible`, once per dev-server start)                                                                                 |
| Files under `node_modules` and outside the Vite root | as for JSX                                                                                                                                                                                                                          |

Picking an element with no tagged element on its path, for example on a page whose modules were
all left untagged, shows the usual "This element has no source in this project" toast and sends
nothing.

**Dev-server warnings.** Each is one `key=value` line,
`zeo-devtools event=warning reason=<reason> …`:

| Reason                        | Meaning                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `astro_compiler_missing`      | No `@astrojs/compiler-rs` loads from the app root or from the app's `astro` (`error=` gives the short cause, `hint=` the fix). No `.astro` element is tagged.                               |
| `astro_compiler_incompatible` | A copy loads but reports UTF-8 byte offsets (compiler-rs before 0.4), and no other usable copy was found. No `.astro` element is tagged. Install `@astrojs/compiler-rs@>=0.4.1` in the app. |
| `astro_parse_failed`          | The compiler reported a parse error for `file=`. That module is left unchanged.                                                                                                             |
| `duplicate_plugin`            | `zeo()` is registered more than once, for example `zeo()` in `vite.plugins` next to `zeoAstro()`. The extra copy registers no listener.                                                     |

**Hot reload.** A tagged `.astro` file loses Astro's style-only hot update: an edit that only
touches its `<style>` reloads the component instead of swapping the CSS in place.

## Use

| Action                                | Effect                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Alt+Shift+Z`, or the floating button | Picker on or off                                                                                                             |
| Hover                                 | Highlights the element and shows `<Component> · src/x.tsx:12`                                                                |
| Click                                 | Sends that element at once. The page's own click handler does not fire.                                                      |
| Shift+click                           | Adds the element to the selection, or removes it if it is already there (up to 20 elements). **Send (N)** delivers them all. |
| Esc                                   | Turns the picker off and drops the pending selection                                                                         |
| Drag the floating button              | Docks it to the nearest corner                                                                                               |
| **Stop sharing**                      | Ends the tab capture (shown while a capture is live)                                                                         |

Each send ends with a toast in the page, for example "Sent to Zeo", "Sent to Zeo without an
image: …" or an error. Common errors:

| Toast                                             | Meaning                                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Zeo is not running, or its devtools bridge is off | No socket answered: Zeo is closed, `devtools_bridge.enabled` is `false`, or the dev server cannot reach the socket (see _ai-jail_ below) |
| Zeo did not answer within 10 seconds              | The socket accepted but no answer came in time                                                                                           |
| No Zeo window has this project open               | No open Zeo window has a worktree containing the Vite root. Zeo opens nothing on its own.                                                |
| This element has no source in this project        | Nothing under the click carries `data-zeo-src`, for example an element rendered by a library in `node_modules`. Nothing is sent.         |
| Selection limit reached: 20 elements              | The 21st Shift+click is refused                                                                                                          |

### Turning the bridge off in Zeo

The setting lives in `settings.json` only, and is not in the settings UI:

```json
{ "devtools_bridge": { "enabled": false } }
```

Turning it off closes the listener and removes the socket. The page then shows the
_unreachable_ message.

## Browser support

| Browser                                                                    | Picker | Screenshot                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium, Chrome and other Chromium-based browsers                         | yes    | Yes. The first send in a tab asks to share **this tab**. The stream is kept while the tab lives, so later sends do not ask again, and **Stop sharing** ends it. If you share a window or the whole screen instead, the selection goes without an image and the toast says to share the tab. |
| Firefox                                                                    | yes    | No. Firefox cannot share a single tab, so the page never asks. Selections go without an image, and the toast says "this browser cannot capture the page".                                                                                                                                   |
| Any browser without `getDisplayMedia`, or that refuses it as not supported | yes    | No. Reported as _unsupported_, sent without an image, and not asked again.                                                                                                                                                                                                                  |

A refused share prompt sends the selection without an image ("screen sharing was refused").
The end-to-end suite runs on Chromium and Firefox. Other browsers are untested.

## Security model

- **Only the dev page can talk to the relay.** The picker uses Vite's HMR WebSocket. Since
  Vite 6.0.9, that socket checks the Origin and needs a per-server token embedded in Vite's own
  client, so a website in another tab cannot open it. The E2E suite proves this with a page
  from a foreign origin, which reaches nothing.
- **Scripts on the dev page can place mentions, but never send.** Any script the dev page
  loads, third-party code included, runs at the page's trust level and can call
  `import.meta.hot.send`. The most it can do is put mentions into the composer. Nothing reaches
  the agent until you send the message yourself, and every path is confined to the project.
  This is accepted by design.
- **The dev server reaches Zeo over a unix socket, not a TCP port.** The socket is mode 0600 in
  a 0700 directory under the per-user `$XDG_RUNTIME_DIR`. Zeo also checks the peer's uid
  (`SO_PEERCRED`) in case the runtime directory is mis-set. A relative socket path is refused,
  and so is a Linux abstract-namespace socket, which has no file permissions.
- **Paths are confined.** The relay refuses a path outside the Vite root. Zeo canonicalises
  every file again and refuses the whole request if one path leaves the project root (`..`, a
  symlink, an absolute path), names a directory or names a missing file. The project root must
  lie inside a worktree open in Zeo.
- **Page content is untrusted data.** DOM text can be user-generated, so Zeo wraps the DOM
  summary in `<untrusted-page-content>` with a note that it is page data, not instructions. The
  size limits below bound it.
- **Screen sharing is limited to the current tab.** The frame is cropped to the selected
  elements and downsized in the page. It leaves the machine only as the PNG inside the mention.
- **Logs carry no page content.** The relay logs one line per request, as `key=value`:
  `zeo-devtools event=select items=2 screenshot_bytes=48211 outcome=inserted ms=34`. It never
  logs DOM text, attributes or image bytes.
- **ai-jail.** A dev server started inside ai-jail cannot reach the socket, because the jail
  exposes only selected sockets of `$XDG_RUNTIME_DIR`. The page then shows the _unreachable_
  message.

## Limits

|                         |                                                           |
| ----------------------- | --------------------------------------------------------- |
| Elements per send       | 1–20                                                      |
| DOM summary per element | 4 KiB, truncated in the page first                        |
| Screenshot              | PNG, ≤ 4 MiB, long edge ≤ 1568 px (downsized in the page) |
| Request                 | one JSON line of at most 8 MiB                            |
| Relay wait for Zeo      | 10 s                                                      |

The page (zod) and Zeo (Rust) validate the same wire contract. Both must give the same verdict
on the 17 shared fixtures in `test/contract/`.

## Known limitations

- **A stale socket after a crash.** If Zeo is killed (SIGTERM, logout, crash), it leaves
  `devtools.sock` behind. This is harmless: the next Zeo finds nothing listening and replaces
  it.
- **One Zeo owns the socket.** A second Zeo, for example one started with `--user-data-dir`,
  finds the socket taken and does not listen. It does not take over when the first one quits
  until its `devtools_bridge.enabled` setting is toggled off and on.
- **A `.tsx` file with decorators** fails to parse without Babel's decorators plugin and is
  left untagged.
- **Vite with `server.ws: false`** has no HMR socket, so the relay is disabled and logs
  `reason=ws_off`.
- **Vitest.** Nothing is tagged when Vite runs in `test` mode, so your snapshots stay clean.
- **Astro style-only HMR.** A CSS-only edit to a tagged `.astro` file reloads the component.
  See [Astro](#astro).

## Development

```bash
npm ci              # install from the lockfile (.npmrc sets min-release-age=7)
npm test            # vitest: tagger, contract, relay against a fake socket, build output
npm run e2e         # Playwright: Chromium and Firefox against test/fixtures/{app,astro}
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run format:check
npm run build       # dist/
```

`npm run e2e` runs the Vite suite against `test/fixtures/app` and the Astro suite against a
real `astro dev` and `astro build` of `test/fixtures/astro`. It uses the Playwright browsers
already in `~/.cache/ms-playwright`. On a machine
without them, run `npx playwright install chromium firefox` first. Chromium runs as the full
browser (`channel: "chromium"`), because the headless shell rejects `getDisplayMedia`.

### Trying an unpublished build

To install a build of this repository into an app, pack a tarball and install the tarball:

```bash
cd /path/to/zeo-devtools
npm ci
npm pack                      # runs the build; writes lucascouts-vite-plugin-zeo-<version>.tgz

cd /path/to/your-app
npm i -D /path/to/zeo-devtools/lucascouts-vite-plugin-zeo-<version>.tgz
```

Use the tarball, not `npm i -D /path/to/zeo-devtools`. A directory install is a symlink, so
the plugin would import `vite` from this repository's `node_modules` instead of your app's.
Its Vite version check would then read the wrong Vite. A directory install also needs `dist/`
built by hand.

## License

Apache-2.0. See [LICENSE](LICENSE).
