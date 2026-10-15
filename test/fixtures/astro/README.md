# Astro fixture (story 052)

Astro 7 site for `e2e/astro.spec.ts`. The spec runs it in-process with `zeoAstro()` and finds
elements by `id`, computing expected lines by searching these files, so lines may move freely.

- `src/layouts/Base.astro` — the layout: its own elements are named `Base`.
- `src/pages/index.astro` — the page: its own elements are named `index`.
- `src/components/Card.astro` — rendered twice from one source line (`card-a`, `card-b`).
- `src/components/Hero.astro` — multi-byte text (ç, →, an emoji) before its elements, and a
  `{items.map(...)}` expression.
- `src/pages/broken.astro` — standalone page (no layout, so no tagged ancestor) carrying the
  marker `zeo-e2e:unparseable`. The spec gives the fixture a `@astrojs/compiler-rs` of its own
  under `node_modules/` at run time, wrapping the real one so `parse()` reports an error for that
  marker; Astro keeps compiling with its own copy, so the page still renders (R2.8).
