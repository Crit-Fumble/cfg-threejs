import { computeTokenVisibility, segmentsIntersect, type VisionInput } from '@/vision'

// A lit scene with one source at origin, one wall, and a light. Tokens placed per-test.
const base = (over: Partial<VisionInput>): VisionInput => ({
  tokens: [],
  sources: [{ id: 's', x: 0, y: 0, range: 0 }],
  walls: [],
  lights: [{ x: 0, y: 0, radius: 500 }],
  gm: false,
  tokenVision: true,
  globalLight: false,
  ...over,
})

describe('segmentsIntersect', () => {
  it('detects a proper crossing and ignores non-crossings', () => {
    expect(segmentsIntersect(0, 0, 10, 0, 5, -5, 5, 5)).toBe(true) // vertical wall crosses horizontal ray
    expect(segmentsIntersect(0, 0, 10, 0, 5, 5, 5, 15)).toBe(false) // wall entirely above
    expect(segmentsIntersect(0, 0, 10, 0, 20, -5, 20, 5)).toBe(false) // wall beyond the ray's end
  })
})

describe('computeTokenVisibility — all-visible short-circuits', () => {
  const tokens = [{ id: 'a', x: 1000, y: 0 }] // far away, would normally be culled
  it('tokenVision === false → everything visible', () => {
    expect(computeTokenVisibility(base({ tokens, tokenVision: false })).get('a')).toBe(true)
  })
  it('GM → everything visible', () => {
    expect(computeTokenVisibility(base({ tokens, gm: true })).get('a')).toBe(true)
  })
  it('globalLight → everything visible', () => {
    expect(computeTokenVisibility(base({ tokens, globalLight: true })).get('a')).toBe(true)
  })
  it('no lights configured → everything visible (no lighting → whole scene)', () => {
    expect(computeTokenVisibility(base({ tokens, lights: [] })).get('a')).toBe(true)
  })
  it('no vision sources → everything visible (no POV to cull against)', () => {
    expect(computeTokenVisibility(base({ tokens, sources: [] })).get('a')).toBe(true)
  })
})

describe('computeTokenVisibility — line-of-sight culling (lit scene)', () => {
  it('a source always sees itself', () => {
    const r = computeTokenVisibility(base({ tokens: [{ id: 's', x: 0, y: 0 }] }))
    expect(r.get('s')).toBe(true)
  })
  it('a token in a light with clear LOS is visible', () => {
    const r = computeTokenVisibility(base({ tokens: [{ id: 'a', x: 100, y: 0 }] }))
    expect(r.get('a')).toBe(true)
  })
  it('a token behind a sight-blocking wall is hidden even inside a light', () => {
    const r = computeTokenVisibility(
      base({ tokens: [{ id: 'a', x: 100, y: 0 }], walls: [{ x1: 50, y1: -50, x2: 50, y2: 50, blocksSight: true }] }),
    )
    expect(r.get('a')).toBe(false)
  })
  it('a NON-sight-blocking wall (open door/glass) does not hide the token', () => {
    const r = computeTokenVisibility(
      base({ tokens: [{ id: 'a', x: 100, y: 0 }], walls: [{ x1: 50, y1: -50, x2: 50, y2: 50, blocksSight: false }] }),
    )
    expect(r.get('a')).toBe(true)
  })
  it('a token outside every light and outside sight range is hidden', () => {
    const r = computeTokenVisibility(base({ tokens: [{ id: 'a', x: 1000, y: 0 }], lights: [{ x: 0, y: 0, radius: 200 }] }))
    expect(r.get('a')).toBe(false)
  })
  it('darkvision range reveals a token outside any light', () => {
    const r = computeTokenVisibility(
      base({ tokens: [{ id: 'a', x: 300, y: 0 }], sources: [{ id: 's', x: 0, y: 0, range: 400 }], lights: [{ x: 0, y: 0, radius: 100 }] }),
    )
    expect(r.get('a')).toBe(true) // 300px < 400px range, LOS clear
  })
})
