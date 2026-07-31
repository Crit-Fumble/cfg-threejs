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
| `/render-host` | `createRenderHost` — persistent renderer + RAF loop + browser-environment handling |
| `/scene-module` | `SceneModule` / `SceneContext` — the pluggable-scene contract a render host displays |
| `/picking` | `createPicker`, `ndcFromClient` — screen px → ground point / nearest object |
| `/geometry` | `createPentagonalTrapezohedronGeometry` — the d10 solid three.js doesn't ship |

## The host layer (v0.4.0)

`/core` renders a **VTT scene**. `/render-host` + `/scene-module` are one level down: a persistent
`WebGLRenderer` that outlives the scenes shown in it, plus the contract those scenes implement.
That split is what lets a surface with no VTT semantics at all — GameBox, a title backdrop, a dice
tray — reuse the environment handling without dragging in the scene graph.

```ts
import { createRenderHost } from '@crit-fumble/threejs/render-host'
import type { SceneModule } from '@crit-fumble/threejs/scene-module'
import * as THREE from 'three'

const host = createRenderHost({
  element,
  THREE,
  quality: () => ({ maxPixelRatio: 1.5, fpsCap: 60 }),  // read live, per frame
  onFps: (fps) => hud.report(fps),
  onUnsupported: () => showCssFallback(),               // no-webgl AND context-lost
})
host.setModule(myScene)   // swap freely — the GL context is never torn down
```

The host owns the renderer, camera aspect/projection, the RAF loop, resize, reduced-motion,
visibility pausing and context-loss recovery. A module owns scene *contents* only. **A module with
no `tick` is static** — the host paints one frame and never starts a loop, which is how an ambient
backdrop costs nothing on battery.

Why it exists: this machinery had four independent implementations (cfg-core-browser's
`StageCanvas`, the `TitleScreenBackdrop` it came from, `core.ts`'s private `createRenderer`, and the
FoundryVTT plugin's ticker), each with a different fallback story. Same for `/picking`, which was
written three times.

## Tests

- `npm test` — Jest unit tests (`tests/unit`).
- `npm run test:viewer` — headless-browser tests that esbuild-bundle the render core + `three`
  and assert scene-graph behaviour in Chromium (needs Playwright's browser installed).
