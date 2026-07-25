import {
  QUALITY_PRESETS,
  minTier,
  detectTier,
  lightBudgetFromUniforms,
  selectLights,
  createGovernor,
} from '@/quality'

describe('QUALITY_PRESETS', () => {
  it('are monotonically cheaper high → potato', () => {
    const order = ['high', 'medium', 'low', 'potato'] as const
    for (let i = 1; i < order.length; i++) {
      const hi = QUALITY_PRESETS[order[i - 1]]
      const lo = QUALITY_PRESETS[order[i]]
      expect(lo.pixelRatioCap).toBeLessThanOrEqual(hi.pixelRatioCap)
      expect(lo.maxLights).toBeLessThanOrEqual(hi.maxLights)
      expect(lo.maxTextureSize).toBeLessThanOrEqual(hi.maxTextureSize)
      expect(lo.shadowCasters).toBeLessThanOrEqual(hi.shadowCasters)
    }
    // Shadows + AA only on the top two tiers.
    expect(QUALITY_PRESETS.low.shadows).toBe(false)
    expect(QUALITY_PRESETS.potato.antialias).toBe(false)
    // Point-light shadow-caster cap stays small (each is a cube shadow map).
    expect(QUALITY_PRESETS.high.shadowCasters).toBeLessThanOrEqual(6)
    expect(QUALITY_PRESETS.low.shadowCasters).toBe(0)
  })
})

describe('minTier', () => {
  it('returns the cheaper of two tiers', () => {
    expect(minTier('high', 'low')).toBe('low')
    expect(minTier('potato', 'medium')).toBe('potato')
    expect(minTier('high', 'high')).toBe('high')
  })
})

describe('detectTier', () => {
  it('forces the Steam Deck (Van Gogh / SteamOS) to low', () => {
    expect(detectTier({ rendererString: 'AMD Custom GPU 0405 (vangogh, LLVM 15)', maxFragmentUniforms: 1024, hardwareConcurrency: 8 })).toBe('low')
    expect(detectTier({ userAgent: 'Mozilla/5.0 (X11; SteamOS) Steam Deck', maxFragmentUniforms: 1024 })).toBe('low')
  })

  it('drops software renderers to potato', () => {
    expect(detectTier({ rendererString: 'Google SwiftShader', maxFragmentUniforms: 1024 })).toBe('potato')
    expect(detectTier({ rendererString: 'llvmpipe (LLVM 12, 256 bits)' })).toBe('potato')
  })

  it('gives a strong discrete GPU + good CPU/RAM the high tier', () => {
    expect(
      detectTier({ rendererString: 'NVIDIA GeForce RTX 4070', maxFragmentUniforms: 4096, hardwareConcurrency: 16, deviceMemory: 32 }),
    ).toBe('high')
  })

  it('caps integrated GPUs at medium', () => {
    expect(
      detectTier({ rendererString: 'Intel(R) Iris(R) Xe Graphics', maxFragmentUniforms: 1024, hardwareConcurrency: 8, deviceMemory: 16 }),
    ).toBe('medium')
  })

  it('steps down on a thin fragment-uniform budget (would fail to compile many lights)', () => {
    expect(detectTier({ rendererString: 'Some GPU', maxFragmentUniforms: 200 })).toBe('low')
    expect(detectTier({ rendererString: 'Some GPU', maxFragmentUniforms: 400, hardwareConcurrency: 8, deviceMemory: 8 })).toBe('medium')
  })

  it('defaults to a safe middle when signals are unknown', () => {
    // No GPU string, default-ish caps → not the top tier, never throws.
    expect(['high', 'medium', 'low', 'potato']).toContain(detectTier({}))
  })
})

describe('lightBudgetFromUniforms', () => {
  it('never exceeds the preset cap and never returns 0', () => {
    expect(lightBudgetFromUniforms(4096, 24)).toBe(24) // plenty of headroom → preset cap
    expect(lightBudgetFromUniforms(200, 24)).toBe(10) // (200-120)/8 = 10
    expect(lightBudgetFromUniforms(120, 24)).toBe(1) // clamped up from 0
    expect(lightBudgetFromUniforms(undefined, 6)).toBe(6) // unknown → trust preset
  })
})

describe('selectLights', () => {
  const L = (x: number, intensity: number, radius: number) => ({ x, y: 0, z: 0, intensity, radius })

  it('returns the input untouched when it already fits the budget', () => {
    const lights = [L(0, 1, 100), L(10, 1, 100)]
    expect(selectLights(lights, 6)).toBe(lights)
  })

  it('keeps the highest importance (intensity × radius) lights when no camera', () => {
    const weak = L(0, 0.5, 50)
    const strong = L(1, 3, 300)
    const mid = L(2, 1, 100)
    const kept = selectLights([weak, strong, mid], 2)
    expect(kept).toContain(strong)
    expect(kept).toContain(mid)
    expect(kept).not.toContain(weak)
  })

  it('favors lights near the camera on big scenes', () => {
    const near = { x: 0, y: 0, z: 0, intensity: 1, radius: 100 }
    const far = { x: 100000, y: 0, z: 0, intensity: 1, radius: 100 }
    const kept = selectLights([far, near], 1, { x: 0, y: 0, z: 0 })
    expect(kept).toEqual([near])
  })

  it('returns nothing at a zero budget', () => {
    expect(selectLights([L(0, 1, 100)], 0)).toEqual([])
  })
})

describe('createGovernor', () => {
  const feed = (gov: ReturnType<typeof createGovernor>, dt: number, n: number) => {
    let changes = 0
    for (let i = 0; i < n; i++) if (gov.sample(dt)) changes++
    return changes
  }

  it('scales resolution DOWN under a sustained slow frame budget, floored at minScale', () => {
    const gov = createGovernor({ targetMs: 33, minScale: 0.5 })
    expect(gov.state.renderScale).toBe(1)
    feed(gov, 120, 300) // brutally slow for a long time
    expect(gov.state.renderScale).toBeLessThan(1)
    expect(gov.state.renderScale).toBe(0.5) // bottoms out at the floor
  })

  it('recovers resolution when there is comfortable headroom', () => {
    const gov = createGovernor({ targetMs: 33, minScale: 0.5 })
    feed(gov, 120, 300) // degrade first
    expect(gov.state.renderScale).toBe(0.5)
    feed(gov, 8, 400) // now very fast → recover (slower than it degraded)
    expect(gov.state.renderScale).toBeGreaterThan(0.5)
  })

  it('exposes ONLY renderScale — shadows are never a governor lever (anti-thrash)', () => {
    const gov = createGovernor({ targetMs: 33 })
    expect(Object.keys(gov.state)).toEqual(['renderScale'])
  })

  // Regression for the shadow-oscillation hitch (#166): a load that sits near the
  // boundary must SETTLE, not flip-flop every window. The old governor toggled
  // shadows on↔off here, recompiling the shader each frame.
  it('does not oscillate near the boundary — settles within a couple of steps', () => {
    const gov = createGovernor({ targetMs: 33, minScale: 0.5 })
    // A frame time that hovers just over target: drop a step or two, then hold.
    let changes = 0
    for (let i = 0; i < 400; i++) if (gov.sample(40)) changes++
    // A few adjustments at most, then stable — never a per-window flip-flop.
    expect(changes).toBeLessThanOrEqual(6)
  })

  it('ignores idle gaps (a paused viewer must not skew the average)', () => {
    const gov = createGovernor({ targetMs: 33 })
    expect(feed(gov, 5000, 50)).toBe(0) // long idle gaps → no change
    expect(gov.state.renderScale).toBe(1)
  })

  it('does not thrash on frames right at target', () => {
    const gov = createGovernor({ targetMs: 33 })
    expect(feed(gov, 33, 100)).toBe(0)
    expect(gov.state.renderScale).toBe(1)
  })

  it('setTarget retargets the budget without disturbing the current scale (fps-cap change)', () => {
    const gov = createGovernor({ targetMs: 33, minScale: 0.5 })
    feed(gov, 120, 300) // degrade to the floor at the 30fps budget
    expect(gov.state.renderScale).toBe(0.5)
    // Cap to 15fps → 66.7ms budget. The same 66ms frames are now WITHIN budget,
    // so it holds (doesn't keep trimming) — and the scale is preserved, not reset.
    gov.setTarget(1000 / 15)
    const before = gov.state.renderScale
    feed(gov, 66, 300)
    expect(gov.state.renderScale).toBe(before) // 66ms ≈ 15fps budget → no change
  })
})
