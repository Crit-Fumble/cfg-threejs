import { applyTerrainBrush } from '@/terrain-brush'

const flat = (cols: number, rows: number, h = 0) => new Array(cols * rows).fill(h)
const at = (arr: number[], cols: number, i: number, j: number) => arr[j * cols + i]

describe('applyTerrainBrush', () => {
  const C = 21
  const R = 21
  const centre = { u: 0.5, v: 0.5 }

  it('raise: centre rises most, falls off with distance, outside the radius is untouched', () => {
    const out = applyTerrainBrush(flat(C, R), C, R, { mode: 'raise', ...centre, radius: 0.15, strength: 4 })
    const mid = at(out, C, 10, 10)
    const near = at(out, C, 11, 10)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeGreaterThan(near) // falloff
    expect(near).toBeGreaterThan(0)
    expect(at(out, C, 0, 0)).toBe(0) // a far corner is outside the brush
  })

  it('lower: centre drops most (mirror of raise)', () => {
    const out = applyTerrainBrush(flat(C, R, 5), C, R, { mode: 'lower', ...centre, radius: 0.15, strength: 4 })
    expect(at(out, C, 10, 10)).toBeLessThan(5)
    expect(at(out, C, 0, 0)).toBe(5)
  })

  it('level: cells blend toward the target height; outside the radius stays put', () => {
    const out = applyTerrainBrush(flat(C, R, 2), C, R, { mode: 'level', ...centre, radius: 0.15, strength: 1, level: 8 })
    expect(at(out, C, 10, 10)).toBeGreaterThan(2)
    expect(at(out, C, 10, 10)).toBeLessThanOrEqual(8)
    expect(at(out, C, 0, 0)).toBe(2)
  })

  it('smooth: a spike is pulled toward its neighbours', () => {
    const h = flat(C, R)
    h[10 * C + 10] = 10 // spike
    const out = applyTerrainBrush(h, C, R, { mode: 'smooth', ...centre, radius: 0.15, strength: 1 })
    expect(at(out, C, 10, 10)).toBeLessThan(10)
  })

  it('flat profile: interior is a flat plateau (equal height), only the rim ramps down', () => {
    const out = applyTerrainBrush(flat(C, R), C, R, { mode: 'raise', ...centre, radius: 0.2, strength: 4, profile: 'flat' })
    const centreH = at(out, C, 10, 10)
    expect(centreH).toBeGreaterThan(0)
    // Interior cells (well inside the radius) all reach the SAME height — a flat top tokens can land on.
    expect(at(out, C, 11, 10)).toBe(centreH)
    expect(at(out, C, 10, 11)).toBe(centreH)
    expect(at(out, C, 9, 9)).toBe(centreH)
    // A rim cell (near the edge of the ~4-cell radius) is raised but LESS than the plateau.
    const rim = at(out, C, 14, 10)
    expect(rim).toBeGreaterThan(0)
    expect(rim).toBeLessThan(centreH)
  })

  it('plateau profile + level: EVERY cell in the footprint reaches the target (hard flat, for the stamp)', () => {
    const out = applyTerrainBrush(flat(C, R, 3), C, R, { mode: 'level', ...centre, radius: 0.2, strength: 1, level: 9, profile: 'plateau' })
    const centreH = at(out, C, 10, 10)
    expect(centreH).toBe(9)
    // Cells near the rim of the radius are ALSO fully set (no ramp) — the whole tile block is level.
    expect(at(out, C, 13, 10)).toBe(9)
    expect(at(out, C, 10, 13)).toBe(9)
    // Outside the radius is untouched.
    expect(at(out, C, 0, 0)).toBe(3)
  })

  it('peak profile (default) still rises to a point — centre strictly above its neighbour', () => {
    const out = applyTerrainBrush(flat(C, R), C, R, { mode: 'raise', ...centre, radius: 0.2, strength: 4, profile: 'peak' })
    expect(at(out, C, 10, 10)).toBeGreaterThan(at(out, C, 11, 10))
  })

  it('square shape reaches box corners a round brush of the same radius cannot', () => {
    const opts = { mode: 'raise' as const, ...centre, radius: 0.2, strength: 1 }
    const round = applyTerrainBrush(flat(C, R), C, R, { ...opts, shape: 'circle' }).filter((x) => x > 0).length
    const square = applyTerrainBrush(flat(C, R), C, R, { ...opts, shape: 'square' }).filter((x) => x > 0).length
    expect(square).toBeGreaterThan(round)
  })

  it('guards: degenerate inputs return an untouched copy', () => {
    expect(applyTerrainBrush([1, 2, 3], 1, 1, { mode: 'raise', u: 0.5, v: 0.5 })).toEqual([1, 2, 3])
    const short = [0, 0]
    expect(applyTerrainBrush(short, 5, 5, { mode: 'raise', u: 0.5, v: 0.5 })).toEqual(short)
    expect(applyTerrainBrush(flat(4, 4), 4, 4, { mode: 'raise', u: NaN, v: 0.5 })).toEqual(flat(4, 4))
  })
})
