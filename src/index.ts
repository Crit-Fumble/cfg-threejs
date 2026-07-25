/**
 * @crit-fumble/threejs — framework-agnostic three.js render core shared across surfaces
 * (PlayTable in cfg-core-browser, the FoundryVTT plugin in cfg-foundry-plugin).
 *
 * THREE is INJECTED by the host — this package imports `three` type-only and never at runtime,
 * so bundling it alongside a host three.js adds no second copy. See README for the charter.
 *
 * Consumers normally import the subpaths (`@crit-fumble/threejs/core`, `/controls`, …); this
 * root barrel is a convenience surface. `dispositionColor` exists in both `producer` and
 * `adapter-foundry`; the root re-exports the `producer` one (the superset with a colors map) —
 * import `@crit-fumble/threejs/adapter-foundry` directly for the adapter's variant.
 */
export * from './core.js'
export * from './controls.js'
export * from './producer.js'
export * from './quality.js'
export * from './vision.js'
export * from './terrain-brush.js'
export * from './terrain-stamp.js'
export {
  dispositionColor as foundryDispositionColor,
  foundrySceneToViewer,
  convertFoundryScene,
} from './adapter-foundry.js'
export type {
  FoundryTokenLike,
  FoundryWallLike,
  FoundryLevelLike,
  FoundryLightLike,
  FoundryTileLike,
  FoundryNoteLike,
  FoundrySceneLike,
  FoundrySceneToViewerOptions,
  FoundrySceneConversion,
} from './adapter-foundry.js'
