# @crit-fumble/threejs

Framework-agnostic **three.js render core** shared across surfaces:

- **PlayTable** (`cfg-core-browser`, Next.js) — imports the render core directly.
- **JS-only surfaces** (the FoundryVTT plugin, `cfg-foundry-plugin`) — bundles `three` + this
  package with esbuild into a committed artifact loaded lazily on first 3D toggle.

## Charter

This is the **rendering half** of the shared VTT viewer — the code that builds and drives the
three.js scene graph (scene core, camera controls, the Foundry→viewer producer/adapter, quality
governor, vision, and the terrain brush/stamp logic). It was extracted from `@crit-fumble/shared`
so the three.js-coupled surface stands on its own; `@crit-fumble/shared` re-exports it under its
existing `vtt-viewer/*` subpaths for now, so no consumer import changed.

## Rules that keep the plugin bundle sane

- **THREE is host-injected.** Modules import `three` **type-only** (`import type * as ThreeNS`)
  and never at runtime. The host passes its own `THREE` (and `OrbitControls`/`GLTFLoader`) in.
  This keeps zero extra three.js copies in the plugin bundle. `three` is an **optional peer
  dependency** — declared, not bundled.
- **No `@crit-fumble/shared` runtime dep.** This package is self-contained; it pulls nothing back
  from `shared` (that would be a dependency cycle while `shared` re-exports it).
- **Pure logic.** Functions take plain data + injected constructors and return scene descriptions
  or apply transforms. No DOM ownership beyond the canvas the host hands in, no framework.

## Layout

| Subpath | What |
| --- | --- |
| `/core` | `createViewer` — the scene-graph render core |
| `/controls` | `createViewerControls` — camera modes over injected OrbitControls |
| `/producer` | `build*Json` — Foundry docs → viewer JSON |
| `/adapter-foundry` | `foundrySceneToViewer` / `convertFoundryScene` |
| `/quality` | quality tiers + the frame governor |
| `/vision` | token visibility |
| `/terrain-brush` | `applyTerrainBrush` — heightfield sculpt |
| `/terrain-stamp` | `TerrainStampController` — framework-free Level Stamp |

## Tests

- `npm test` — Jest unit tests (`tests/unit`).
- `npm run test:viewer` — headless-browser tests that esbuild-bundle the render core + `three`
  and assert scene-graph behaviour in Chromium (needs Playwright's browser installed).
