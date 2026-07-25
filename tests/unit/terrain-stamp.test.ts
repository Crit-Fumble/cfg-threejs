/**
 * TerrainStampController — the framework-free Level Stamp both PlayTable and the FoundryVTT plugin
 * drive. Verifies the flat-plateau imprint, Q/E elevation (floored at 0), seat-relative WASD, and the
 * debounced commit, with a mock viewer host (no three, no DOM).
 */
import { TerrainStampController, type TerrainStampHost } from '@/terrain-stamp'

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
