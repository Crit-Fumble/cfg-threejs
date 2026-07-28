/**
 * TerrainStampController — the framework-free Level Stamp both PlayTable and the FoundryVTT plugin
 * drive. Verifies the flat-plateau imprint, Q/E elevation (floored at 0), seat-relative WASD, and the
 * debounced commit, with a mock viewer host (no three, no DOM).
 */
import { TerrainStampController, latticeAlignment, resampleHeightfield, type TerrainStampHost } from '@/terrain-stamp'

const COLS = 25 // 24 grid squares, corner-per-square (1 sample/square)
const ROWS = 25

function makeHost(camForward = { x: 0, z: 1 }) {
  let heightsPx: number[] = new Array(COLS * ROWS).fill(0)
  const reticles: Array<{ wx: number; wz: number; wy: number; placed: boolean }> = []
  const host: TerrainStampHost = {
    getTerrainHeights: () => heightsPx.slice(),
    updateTerrainHeights: (h) => { heightsPx = h.slice() },
    terrainCellToWorld: (i, j) => ({ x: i, z: j }),
    showReticle: (wx, wz, _r, _s, wy, placed) => { reticles.push({ wx, wz, wy, placed }) },
    hideReticle: () => {},
    getCameraForward: () => camForward,
  }
  return { host, heights: () => heightsPx, reticles }
}

const cfg = { cols: COLS, rows: ROWS, gridSize: 100, boundsWidth: 2400, boundsHeight: 2400, pxPerUnit: 20, step: 5, shape: 'square' as const, radiusFrac: 0.02 }

describe('TerrainStampController', () => {
  it('placeAt imprints the covered grid square FLAT to the target elevation (px = level × pxPerUnit)', () => {
    const { host, heights } = makeHost()
    const ctrl = new TerrainStampController(host, { ...cfg }, { onCommit: () => {} })
    ctrl.key('e') // ethereal: level 0 → 5 (refresh only, no terrain change)
    ctrl.key('e') // → 10
    expect(ctrl.currentLevel).toBe(10)
    ctrl.placeAt(0.5, 0.5) // centre square = index 12; corner-per-square → samples (12..13)×(12..13)
    const hp = heights()
    for (const j of [12, 13]) for (const i of [12, 13]) expect(hp[j * COLS + i]).toBe(200) // 10 ft × 20 px/ft
    expect(ctrl.isPlaced).toBe(true)
    // a sample well outside the 1-square footprint is untouched
    expect(hp[0]).toBe(0)
  })

  it('Q/E step the target by grid units; Q floors at 0', () => {
    const { host } = makeHost()
    const ctrl = new TerrainStampController(host, { ...cfg }, { onCommit: () => {} })
    ctrl.key('e'); ctrl.key('e'); ctrl.key('e') // 0→5→10→15
    expect(ctrl.currentLevel).toBe(15)
    ctrl.key('q'); ctrl.key('q') // 15→10→5
    expect(ctrl.currentLevel).toBe(5)
    ctrl.key('q'); ctrl.key('q') // 5→0→0 (floored, never negative)
    expect(ctrl.currentLevel).toBe(0)
  })

  it('WASD is handled (seat-relative) and unknown keys are not', () => {
    const { host } = makeHost({ x: 0, z: 1 })
    const ctrl = new TerrainStampController(host, { ...cfg }, { onCommit: () => {} })
    for (const k of ['w', 'a', 's', 'd', 'ArrowUp', 'Q', 'E']) expect(ctrl.key(k)).toBe(true)
    expect(ctrl.key('x')).toBe(false)
    expect(ctrl.key(' ')).toBe(false)
  })

  it('commits the field (game units) debounced after a paint', () => {
    jest.useFakeTimers()
    try {
      const { host } = makeHost()
      const commits: number[][] = []
      const ctrl = new TerrainStampController(host, { ...cfg }, { onCommit: (h) => commits.push(h) })
      ctrl.key('e') // level 5
      ctrl.placeAt(0.5, 0.5)
      expect(commits.length).toBe(0) // debounced, not yet
      jest.advanceTimersByTime(300)
      expect(commits.length).toBe(1)
      expect(commits[0][12 * COLS + 12]).toBe(5) // GAME UNITS, not px
    } finally {
      jest.useRealTimers()
    }
  })

  it('onLevelChange / onPlacedChange fire so a host can drive its elevation readout', () => {
    const { host } = makeHost()
    const levels: number[] = []
    const placedFlags: boolean[] = []
    const ctrl = new TerrainStampController(host, { ...cfg }, { onCommit: () => {}, onLevelChange: (l) => levels.push(l), onPlacedChange: (p) => placedFlags.push(p) })
    ctrl.key('e')
    ctrl.placeAt(0.5, 0.5)
    expect(levels).toContain(5)
    expect(placedFlags).toContain(true)
  })
})

describe('latticeAlignment', () => {
  it('flags the legacy square 80×80 field on a 59×55-square scene as OFF-lattice', () => {
    const a = latticeAlignment(80, 80, 59, 55)
    expect(a.aligned).toBe(false) // rounds to 1 spp but 79 ≠ 59 — the stamp would drift
  })
  it('accepts grid-aligned lattices at any density', () => {
    expect(latticeAlignment(60, 56, 59, 55)).toEqual({ sppX: 1, sppY: 1, aligned: true })
    expect(latticeAlignment(119, 111, 59, 55)).toEqual({ sppX: 2, sppY: 2, aligned: true })
    expect(latticeAlignment(237, 221, 59, 55)).toEqual({ sppX: 4, sppY: 4, aligned: true })
  })
})

describe('resampleHeightfield', () => {
  it('preserves a constant field at any target density', () => {
    const out = resampleHeightfield({ cols: 80, rows: 80, heights: new Array(80 * 80).fill(3) }, 119, 111)
    expect(out).toHaveLength(119 * 111)
    expect(out.every((h) => Math.abs(h - 3) < 1e-9)).toBe(true)
  })
  it('bilinearly interpolates between source samples', () => {
    // 2×2 source: corners 0,10 / 20,30 — the centre of a 3×3 resample is the average.
    const out = resampleHeightfield({ cols: 2, rows: 2, heights: [0, 10, 20, 30] }, 3, 3)
    expect(out[4]).toBeCloseTo(15) // centre
    expect(out[1]).toBeCloseTo(5) // top edge midpoint
    expect(out[0]).toBe(0)
    expect(out[8]).toBe(30) // far corner exact
  })
  it('keeps a sculpted plateau roughly in place across a rebuild (drift-fix path)', () => {
    // Plateau on the right half of an 80-wide legacy field must stay on the right half at 119.
    const src = new Array(80 * 80).fill(0)
    for (let j = 0; j < 80; j++) for (let i = 40; i < 80; i++) src[j * 80 + i] = 5
    const out = resampleHeightfield({ cols: 80, rows: 80, heights: src }, 119, 111)
    expect(out[55 * 119 + 20]).toBeCloseTo(0) // left quarter untouched
    expect(out[55 * 119 + 100]).toBeCloseTo(5) // right quarter keeps the plateau
  })
})
