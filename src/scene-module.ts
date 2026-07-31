/**
 * SceneModule — the contract between a render host and the pluggable three.js scenes it displays.
 *
 * Ownership split, and why it exists: the HOST owns the *machinery* — the WebGLRenderer, the
 * camera's lifecycle (creation, aspect/projection updates on resize, disposal), the
 * requestAnimationFrame loop, and the browser-environment concerns (WebGL-unsupported fallback,
 * context-loss recovery, `prefers-reduced-motion`, visibilitychange pausing). A MODULE owns the
 * scene *contents* only: what meshes/lights/fog go in, how they animate, and how they are torn
 * down. Modules never create or dispose the renderer, and never touch RAF — that is what makes
 * them swappable without re-running any of the environment plumbing. Framing the camera
 * (position/lookAt) in `init` is fine — composition is content — but aspect/projection stay with
 * the host.
 *
 * **Static-scene contract:** a module with no `tick` declares itself static. The host renders
 * exactly one frame (plus one per resize) and never starts the RAF loop at all — zero per-frame
 * cost, which is how ambient backdrops stay free on battery and low-power devices.
 * `prefers-reduced-motion` gets the same treatment: the host simply does not call `tick`.
 *
 * Framework-free on purpose. This originated as `StageSceneModule` in cfg-core-browser's
 * PlayTableStage, whose spec union carried a React `ReactNode` variant; that variant is app
 * routing, not a scene contract, and stays in the host app. Keeping this module React-free is
 * what lets GameBox, PlayTable and the FoundryVTT plugin share one contract.
 */

import type * as THREE from 'three'

export interface SceneContext {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** Canvas CSS width in px at init time — for layout decisions (e.g. narrow-viewport spread scaling). */
  width: number
  /** Canvas CSS height in px at init time. */
  height: number
}

export interface SceneModule {
  /** Populate the scene: meshes, lights, fog, background, camera framing. Called once, before the first frame. */
  init(ctx: SceneContext): void
  /**
   * Advance animation. Omit entirely for a static scene — the host then renders one frame and
   * never runs a RAF loop. `delta` is seconds since the previous tick, `elapsed` is seconds since
   * the loop started.
   */
  tick?(delta: number, elapsed: number): void
  /** React to a canvas size change (relayout scene contents). Camera aspect/projection is already handled by the host. */
  resize?(width: number, height: number): void
  /** Tear down everything `init` created: remove objects from the scene and dispose geometries/materials. Must be idempotent. */
  dispose(): void
}
