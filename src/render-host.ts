/**
 * createRenderHost — one persistent WebGLRenderer + canvas that outlives the scenes shown in it.
 *
 * This is the environment machinery every CFG 3D surface needs and, until now, each one
 * reimplemented: cfg-core-browser's `StageCanvas` (PlayTableStage), the retired
 * `TitleScreenBackdrop` it was lifted from, the private `createRenderer` inside this package's
 * `core.ts`, and the FoundryVTT plugin's own ticker path — four implementations, four different
 * fallback stories. Consolidating it here is what lets a new surface (GameBox) get correct
 * behaviour for free instead of writing a fifth.
 *
 * Swapping a module disposes the outgoing scene contents and inits the incoming one; the
 * renderer, canvas element and GL context are never torn down for a swap. That is the whole
 * point — no context churn, no WebGL re-init cost, no black flash between views.
 *
 * Every defensive behaviour below is live-verified, not speculative:
 *   - WebGLRenderer construction in try/catch → render nothing and report `no-webgl`. jsdom and
 *     WebGL-less browsers both land here; a host's CSS fallback IS the answer, not an error state.
 *   - `webglcontextlost` → preventDefault, dispose everything, report `context-lost` (GPU resets,
 *     low-memory tab eviction). ⛔ preventDefault is mandatory: without it the browser will not
 *     re-issue a context and recovery is impossible.
 *   - `prefers-reduced-motion: reduce` → init and render exactly ONE frame, never start the loop.
 *   - `visibilitychange` → pause/resume the loop.
 *   - devicePixelRatio capped (default 1.5); `powerPreference: 'low-power'` by default.
 *   - Resize is ResizeObserver-driven (the host element is often not the window); the window
 *     `resize` listener remains only as a jsdom-safe fallback.
 *   - `forceContextLoss()` on dispose. `dispose()` frees caches and programs but does NOT release
 *     the GL context — three only reclaims it when the detached canvas is GC'd. A surface that
 *     mounts/unmounts per view transition leaks one context per cycle and can trip the browser's
 *     live-context cap on mobile.
 *
 * The RAF loop runs ONLY while the current module declares `tick` AND motion is not reduced AND
 * the page is visible — a module without `tick` is static per the SceneModule contract: one frame
 * at init, one per resize, zero per-frame cost.
 *
 * Framework-free and app-free: quality settings and FPS reporting are INJECTED (`quality`,
 * `onFps`) rather than imported, because cfg-core-browser reads them from its own graphics-settings
 * store and a different surface will not have one.
 */

import type * as ThreeNS from 'three'
import type { SceneModule } from './scene-module.js'

export interface RenderHostQuality {
  /** Upper bound on devicePixelRatio. Default 1.5. */
  maxPixelRatio?: number
  /** Frames per second ceiling; 0 (default) = uncapped. */
  fpsCap?: number
}

/** Why the host stopped being able to render. Hosts typically reveal a CSS fallback on either. */
export type RenderHostUnsupportedReason = 'no-webgl' | 'context-lost'

export interface CreateRenderHostOptions {
  /** The element the canvas is appended to. Its client box drives sizing. */
  element: HTMLElement
  /** The host's three build. Required — this package never imports three at runtime. */
  THREE: typeof ThreeNS
  /**
   * Read on every pixel-ratio apply and on every frame (for the FPS cap), so a host can change
   * quality live without recreating anything. Omit for the defaults.
   */
  quality?: () => RenderHostQuality
  /** Called ~2x/second with measured FPS, and once with 0 on dispose so a HUD can clear. */
  onFps?: (fps: number) => void
  /** Called when rendering becomes impossible. The host should reveal its fallback. */
  onUnsupported?: (reason: RenderHostUnsupportedReason, err?: unknown) => void
  /** PerspectiveCamera params. Defaults 50 / 0.1 / 100. */
  fov?: number
  near?: number
  far?: number
  /** WebGLRenderer params. Defaults: antialias true, alpha false, powerPreference 'low-power'. */
  antialias?: boolean
  alpha?: boolean
  powerPreference?: 'default' | 'high-performance' | 'low-power'
}

export interface RenderHost {
  /** Persist across module swaps — modules add and remove their own contents. */
  readonly scene: ThreeNS.Scene
  readonly camera: ThreeNS.PerspectiveCamera
  /** Null when WebGL was unavailable or the context was lost. */
  readonly renderer: ThreeNS.WebGLRenderer | null
  /** Swap the displayed scene. `null` clears and hides the canvas (see the header on 'none'). */
  setModule(next: SceneModule | null): void
  /** Re-read the element's box and re-render. Called automatically by ResizeObserver. */
  resize(): void
  /** Idempotent. Disposes the module, the timer, the renderer, and releases the GL context. */
  dispose(): void
  /**
   * Re-read `quality()` and re-apply what is not read per-frame (currently the pixel ratio; the
   * FPS cap is consulted inside the loop, so a host only needs to call this after a settings
   * change). Cheap and idempotent.
   */
  refreshQuality(): void
  readonly disposed: boolean
}

const DEFAULT_MAX_PIXEL_RATIO = 1.5

export function createRenderHost(opts: CreateRenderHostOptions): RenderHost {
  const {
    element,
    THREE,
    quality,
    onFps,
    onUnsupported,
    fov = 50,
    near = 0.1,
    far = 100,
    antialias = true,
    alpha = false,
    powerPreference = 'low-power',
  } = opts

  if (!THREE) throw new Error('createRenderHost: inject `THREE` (the host provides its three build)')
  if (!element) throw new Error('createRenderHost: `element` is required')

  const readQuality = (): Required<RenderHostQuality> => {
    const q = quality?.() ?? {}
    return {
      maxPixelRatio: q.maxPixelRatio ?? DEFAULT_MAX_PIXEL_RATIO,
      fpsCap: q.fpsCap ?? 0,
    }
  }

  let renderer: ThreeNS.WebGLRenderer | null = null
  try {
    renderer = new THREE.WebGLRenderer({ antialias, alpha, powerPreference })
  } catch (err) {
    // jsdom (unit tests) and real browsers without WebGL both land here. Expected fallback path,
    // not a real error — the host's CSS layer is the answer.
    onUnsupported?.('no-webgl', err)
  }

  let width = element.clientWidth || 1
  let height = element.clientHeight || 1

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(fov, width / height, near, far)

  // THREE.Timer (r165+) where available, else a manual delta — the peer floor allows older three.
  const timer: { update(t: number): void; getDelta(): number; getElapsed(): number; dispose?(): void } =
    typeof (THREE as unknown as { Timer?: unknown }).Timer === 'function'
      ? new (THREE as unknown as { Timer: new () => never }).Timer()
      : createFallbackTimer()

  let mod: SceneModule | null = null
  let rafId = 0
  let running = false
  let disposed = false
  let lastRenderTs = 0
  let fpsFrames = 0
  let fpsWindowStart = 0

  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  function applyPixelRatio() {
    if (!renderer) return
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    renderer.setPixelRatio(Math.min(dpr, readQuality().maxPixelRatio))
  }

  if (renderer) {
    applyPixelRatio()
    renderer.setSize(width, height)
    element.appendChild(renderer.domElement)
  }

  function renderFrame() {
    renderer?.render(scene, camera)
  }

  function tick(timestamp: number) {
    if (!running) return
    // Reschedule FIRST so a capped/skipped frame still keeps the loop alive.
    rafId = requestAnimationFrame(tick)

    // FPS cap: render at most once per (1000/fpsCap) ms. The timer only advances on rendered
    // frames, so animation speed stays correct — delta is real time since the last painted frame.
    const { fpsCap } = readQuality()
    const minFrameMs = fpsCap > 0 ? 1000 / fpsCap : 0
    if (minFrameMs > 0 && lastRenderTs && timestamp - lastRenderTs < minFrameMs - 0.5) return
    lastRenderTs = timestamp

    timer.update(timestamp)
    mod?.tick?.(timer.getDelta(), timer.getElapsed())
    renderFrame()

    fpsFrames += 1
    if (!fpsWindowStart) fpsWindowStart = timestamp
    const elapsed = timestamp - fpsWindowStart
    if (elapsed >= 500) {
      onFps?.((fpsFrames * 1000) / elapsed)
      fpsFrames = 0
      fpsWindowStart = timestamp
    }
  }

  // Single gate for the loop's run conditions (animated module + motion allowed + page visible),
  // called after every event that can change one — so start/stop logic lives in exactly one place.
  function syncLoop() {
    const hidden = typeof document !== 'undefined' && document.hidden
    const shouldRun = !disposed && !!renderer && !!mod?.tick && !reduceMotion && !hidden
    if (shouldRun && !running) {
      running = true
      rafId = requestAnimationFrame(tick)
    } else if (!shouldRun && running) {
      running = false
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
    }
  }

  function setModule(next: SceneModule | null) {
    if (disposed) return
    mod?.dispose()
    mod = next
    if (mod && renderer) {
      renderer.domElement.style.removeProperty('display')
      mod.init({ scene, camera, width, height })
      // Always paint one frame — this IS the static frame for tick-less modules and under reduced
      // motion, and the first frame otherwise (syncLoop takes over when animation is allowed).
      renderFrame()
    } else if (renderer) {
      // Hide rather than render an emptied scene: with alpha:false an empty scene clears to
      // opaque black, but "no module" means "let the host's own fallback show through".
      renderer.domElement.style.display = 'none'
    }
    syncLoop()
  }

  function resize() {
    if (disposed || !renderer) return
    const w = element.clientWidth
    const h = element.clientHeight
    if (!w || !h) return
    width = w
    height = h
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
    mod?.resize?.(w, h)
    renderFrame()
  }

  function handleVisibility() {
    syncLoop()
  }

  function handleContextLost(e: Event) {
    // ⛔ preventDefault is mandatory — without it the browser will not re-issue a context.
    e.preventDefault()
    dispose()
    onUnsupported?.('context-lost')
  }

  let resizeObserver: ResizeObserver | null = null
  if (renderer) {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => resize())
      resizeObserver.observe(element)
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', resize)
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVisibility)
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    running = false
    onFps?.(0) // stopped → a HUD should not show a stale rate
    if (rafId) cancelAnimationFrame(rafId)
    resizeObserver?.disconnect()
    if (typeof window !== 'undefined') window.removeEventListener('resize', resize)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibility)
    mod?.dispose()
    mod = null
    timer.dispose?.()
    if (renderer) {
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost)
      // See the header: dispose() alone does not release the GL context.
      renderer.forceContextLoss()
      renderer.dispose()
      if (renderer.domElement.parentElement === element) element.removeChild(renderer.domElement)
    }
  }

  /** Applied when the host's quality source changes (e.g. a settings window). */
  function refreshQuality() {
    applyPixelRatio()
  }

  return {
    scene,
    camera,
    get renderer() {
      return renderer
    },
    get disposed() {
      return disposed
    },
    setModule,
    resize,
    dispose,
    refreshQuality,
  }
}

/** Minimal THREE.Timer stand-in for peer three builds older than r165. */
function createFallbackTimer() {
  let prev = 0
  let start = 0
  let delta = 0
  let elapsed = 0
  return {
    update(t: number) {
      if (!start) start = t
      delta = prev ? (t - prev) / 1000 : 0
      prev = t
      elapsed = (t - start) / 1000
    },
    getDelta: () => delta,
    getElapsed: () => elapsed,
    dispose() {
      prev = 0
      start = 0
    },
  }
}
