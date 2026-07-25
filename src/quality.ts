/**
 * Adaptive render-quality for the VTT viewer core (cfg-core-dev-tools #166).
 *
 * Pure, framework-agnostic logic (no THREE, no DOM) so it unit-tests cleanly and
 * keeps core.ts small. The core wires these into the renderer/camera/lights:
 *
 *   - QUALITY_PRESETS  — cost knobs per tier (pixel ratio, AA, shadows, light cap…)
 *   - detectTier()     — pick a starting tier from GPU + device signals (Steam
 *                        Deck / integrated / software all step down)
 *   - lightBudgetFromUniforms() — a hard ceiling from the GPU's fragment-uniform
 *                        budget, so we never emit a shader that fails to COMPILE
 *                        (the "won't load at all" failure on weak GPUs)
 *   - selectLights()   — keep the most important / nearest N lights, drop the rest
 *   - createGovernor() — runtime frame-time governor: hold a target frame budget by
 *                        scaling render resolution (then shadows) up/down
 *
 * Design bias (owner directive): "fast at 15fps beats laggy at 60fps" — degrade
 * resolution/shadows/lights aggressively to keep interaction responsive.
 */

export type QualityTier = 'high' | 'medium' | 'low' | 'potato'

export interface QualityPreset {
  /** Hard cap on the device-pixel-ratio we render at (1 = CSS pixels). The single
   * biggest fragment-cost lever: a retina 2× DPR is 4× the work. */
  pixelRatioCap: number
  /** MSAA on the WebGL context. Costs with resolution; off below `medium`. */
  antialias: boolean
  /** Real-time shadow maps (each shadow-casting light is an extra scene pass). */
  shadows: boolean
  /** Max shadow-casting POINT lights. Each is a cube shadow map (6 faces + a
   * texture unit); too many blow past the GPU's texture-unit limit and the whole
   * render fails. Hard-capped regardless of how many lights request shadows. */
  shadowCasters: number
  /** Shadow map resolution when shadows are on. */
  shadowMapSize: number
  /** Max simultaneous real-time point lights (the forward renderer bakes every
   * light into the fragment shader). Further capped by the GPU uniform budget. */
  maxLights: number
  /** Cap on uploaded texture dimension — bounds VRAM (weak GPUs OOM otherwise). */
  maxTextureSize: number
  /** Floor the governor won't scale render resolution below. */
  minRenderScale: number
}

export const QUALITY_PRESETS: Record<QualityTier, QualityPreset> = {
  high: { pixelRatioCap: 2, antialias: true, shadows: true, shadowCasters: 4, shadowMapSize: 1024, maxLights: 24, maxTextureSize: 4096, minRenderScale: 0.6 },
  medium: { pixelRatioCap: 1.5, antialias: true, shadows: true, shadowCasters: 2, shadowMapSize: 512, maxLights: 12, maxTextureSize: 2048, minRenderScale: 0.5 },
  low: { pixelRatioCap: 1, antialias: false, shadows: false, shadowCasters: 0, shadowMapSize: 0, maxLights: 6, maxTextureSize: 1024, minRenderScale: 0.45 },
  potato: { pixelRatioCap: 0.75, antialias: false, shadows: false, shadowCasters: 0, shadowMapSize: 0, maxLights: 3, maxTextureSize: 512, minRenderScale: 0.4 },
}

const TIER_ORDER: QualityTier[] = ['high', 'medium', 'low', 'potato']

/** The lower (cheaper) of two tiers. */
export function minTier(a: QualityTier, b: QualityTier): QualityTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b
}

export interface DetectEnv {
  /** gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) — predicts the light ceiling. */
  maxFragmentUniforms?: number
  /** UNMASKED_RENDERER_WEBGL string (GPU name), when available. */
  rendererString?: string
  hardwareConcurrency?: number
  /** navigator.deviceMemory (GiB), when available. */
  deviceMemory?: number
  devicePixelRatio?: number
  userAgent?: string
}

/**
 * Pick a starting quality tier from GPU + device signals. Conservative: unknown
 * signals default to a middle ground, and any weak signal steps the tier down.
 */
export function detectTier(env: DetectEnv): QualityTier {
  const gpu = (env.rendererString || '').toLowerCase()
  const ua = (env.userAgent || '').toLowerCase()
  const hay = `${gpu} ${ua}`

  // Steam Deck: AMD "Van Gogh" APU / SteamOS. Explicit low tier (also the
  // device that "won't load at all" today).
  if (/van ?gogh|galileo|steam ?deck|steamos|holoiso/.test(hay)) return 'low'
  // Software/reference rasterizers — no real GPU. Bottom tier.
  if (/swiftshader|llvmpipe|software|basic render|microsoft basic/.test(gpu)) return 'potato'

  const cores = env.hardwareConcurrency ?? 8
  const mem = env.deviceMemory ?? 8
  const uni = env.maxFragmentUniforms ?? 1024

  let tier: QualityTier = 'high'
  if (uni < 256 || cores <= 2 || mem <= 2) tier = 'low'
  else if (uni < 512 || cores <= 4 || mem <= 4) tier = 'medium'

  // Integrated / mobile GPUs cap at medium even with decent CPU/RAM.
  if (tier === 'high' && /intel|uhd|iris|mali|adreno|powervr|\bapple\b/.test(gpu)) tier = 'medium'

  return tier
}

/**
 * Hard light ceiling from the fragment-uniform budget. A forward renderer packs
 * every light into the fragment shader; exceed the GPU's `MAX_FRAGMENT_UNIFORM_
 * VECTORS` and the shader fails to COMPILE (the whole 3D view dies). Reserve
 * headroom for engine + material uniforms; budget ~8 vectors per point light
 * (position/color/params + a shadow slot). Never returns 0.
 */
export function lightBudgetFromUniforms(maxFragmentUniforms: number | undefined, presetMax: number): number {
  if (!maxFragmentUniforms || maxFragmentUniforms <= 0) return presetMax
  const safe = Math.floor((maxFragmentUniforms - 120) / 8)
  return Math.max(1, Math.min(presetMax, safe))
}

export interface LightSpec {
  x: number
  y: number
  z: number
  intensity?: number
  radius?: number
}

/**
 * Keep the `budget` most useful lights, drop the rest. Importance = intensity ×
 * reach; when a camera position is given (big scenes), nearer lights are favored
 * so the view around the camera stays lit while distant lights fall away.
 * Returns the input untouched when it already fits.
 */
export function selectLights<T extends LightSpec>(lights: T[], budget: number, cam?: { x: number; y: number; z: number }): T[] {
  if (budget <= 0) return []
  if (lights.length <= budget) return lights
  const scored = lights.map((l) => {
    const importance = (l.intensity ?? 1) * Math.max(1, l.radius ?? 1)
    if (!cam) return { l, score: importance }
    const d = Math.hypot(l.x - cam.x, l.y - cam.y, l.z - cam.z)
    const proximity = 1 / (1 + d / Math.max(1, l.radius ?? 1))
    return { l, score: importance * (0.4 + 0.6 * proximity) }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, budget).map((s) => s.l)
}

export interface GovernorState {
  renderScale: number
}

export interface GovernorOptions {
  /** Target per-frame budget in ms (33 ≈ 30fps). Frames slower than 1.3× this
   * scale resolution down; comfortably faster (<0.6×) scale it back up. */
  targetMs?: number
  minScale?: number
  maxScale?: number
}

/**
 * Runtime frame-budget governor. Feed it the interval between renders during
 * active interaction; it holds the target budget by scaling ONLY the render
 * resolution — a cheap, continuous, smooth lever with no shader recompile.
 *
 * It deliberately does NOT touch shadows or the light count: toggling those is
 * expensive (shader recompile + light rebuild) and, as a per-frame lever, sets
 * up a control-loop oscillation (drop shadows → fast → restore → slow → drop …)
 * that hitches every flip. Shadows/lights are coarse, per-tier settings; the
 * governor's job is fine resolution trimming only. (#166)
 *
 * Anti-oscillation: a wide dead-band (1.3× degrade / 0.6× recover), a real
 * debounce, asymmetric steps (recover slower than degrade), and it keeps the
 * EMA measuring true load after a change instead of resetting to neutral.
 */
export function createGovernor(opts: GovernorOptions = {}) {
  let targetMs = opts.targetMs ?? 33
  const minScale = opts.minScale ?? 0.5
  const maxScale = opts.maxScale ?? 1
  // Long debounce + slow EMA + a wide dead-band so the governor stays QUIET in
  // steady operation: a resolution change re-allocates the framebuffer (a visible
  // blip), so it must be rare — only genuine, sustained load shifts move it. In
  // the normal band (~22–55fps) it never touches anything.
  const DEBOUNCE = 24

  let ema = targetMs
  let scale = maxScale
  let sinceChange = 0

  return {
    get state(): GovernorState {
      return { renderScale: scale }
    },
    /** Retarget the frame budget (e.g. when the fps cap changes) without losing
     * the current renderScale. */
    setTarget(ms: number): void {
      targetMs = ms > 0 ? ms : 33
    },
    /** Feed a measured inter-render interval (ms). Returns true if renderScale changed. */
    sample(dtMs: number): boolean {
      // Ignore idle gaps / one-off spikes — only smoothed sustained load counts.
      if (!(dtMs > 0) || dtMs > 200) return false
      ema = ema * 0.9 + dtMs * 0.1
      if (++sinceChange < DEBOUNCE) return false

      let changed = false
      if (ema > targetMs * 1.4 && scale > minScale) {
        // Sustained below ~22fps → trim resolution a notch.
        scale = Math.max(minScale, +(scale - 0.1).toFixed(3))
        changed = true
      } else if (ema < targetMs * 0.55 && scale < maxScale) {
        // Sustained above ~55fps of headroom → recover, in smaller steps than we
        // degrade so it biases toward staying put (no up/down hunting).
        scale = Math.min(maxScale, +(scale + 0.05).toFixed(3))
        changed = true
      }
      if (changed) sinceChange = 0 // keep the EMA — it reflects real load post-change
      return changed
    },
  }
}

export type Governor = ReturnType<typeof createGovernor>
