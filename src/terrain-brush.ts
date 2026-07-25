/**
 * Pure sculpt-brush math for the heightmap terrain — no THREE, no Foundry, no framework, so it is
 * unit-testable and shared by BOTH the FoundryVTT plugin (overlay-3d.js) and the core-browser
 * PlayTable scene editor. A host raycasts the cursor onto the terrain to get a normalized brush
 * centre (u, v) in [0,1], calls applyTerrainBrush to get the new height field, re-displaces the mesh
 * in place, and commits the field to the scene. Heights are row-major (cols*rows), in grid units.
 *
 * Source of truth lives here (cfg-shared); the plugin vendors a copy alongside its other bundled
 * shared code, the browser imports it directly as @crit-fumble/shared/vtt-viewer/terrain-brush.
 */

export type TerrainBrushMode = 'raise' | 'lower' | 'level' | 'smooth'
export type TerrainBrushShape = 'circle' | 'square'

export interface TerrainBrushOptions {
  /** raise | lower | level | smooth. Default 'raise'. */
  mode?: TerrainBrushMode
  /** brush centre over the field, each in [0,1]. */
  u: number
  v: number
  /** brush radius as a FRACTION of the larger field dimension (0..1). */
  radius?: number
  /** per-dab amount (grid units for raise/lower; blend 0..1 for level/smooth). */
  strength?: number
  /** target height for 'level' (grid units). */
  level?: number
  /** 'circle' (Euclidean footprint, default) | 'square' (Chebyshev — lines up with a square grid). */
  shape?: TerrainBrushShape
  /** Height PROFILE across the footprint. 'peak' (default) = linear cone to a point (a hill/peak).
   *  'flat' = a flat-topped plateau: full height across the interior, ramp only at the rim, so tokens
   *  get a flat area to land on (the tabletop-tile look). */
  profile?: TerrainBrushProfile
}

export type TerrainBrushProfile = 'peak' | 'flat' | 'plateau'

/** Fraction of the radius that stays at FULL height for a 'flat' plateau before the rim ramps down. */
const FLAT_INNER = 0.7

/** Weight at normalized distance t∈[0,1] from the brush centre, per profile. */
function profileFalloff(t: number, profile: TerrainBrushProfile): number {
  if (profile === 'plateau') return 1 // hard flat: EVERY cell in the footprint is set fully (tile stamp)
  if (profile === 'flat') return t <= FLAT_INNER ? 1 : Math.max(0, (1 - t) / (1 - FLAT_INNER))
  return 1 - t // peak: linear cone
}

/**
 * Cells within `radiusCells` of (ci, cj), with a linear centre→edge falloff weight. `shape` 'circle'
 * (Euclidean distance — round brush) or 'square' (Chebyshev distance — an axis-aligned box, which
 * lines up with a square grid for tile-accurate heightmapping).
 */
function forEachInRadius(
  cols: number,
  rows: number,
  ci: number,
  cj: number,
  radiusCells: number,
  shape: TerrainBrushShape,
  profile: TerrainBrushProfile,
  fn: (i: number, j: number, falloff: number) => void,
): void {
  const r = Math.max(0.5, radiusCells)
  const iMin = Math.max(0, Math.floor(ci - r))
  const iMax = Math.min(cols - 1, Math.ceil(ci + r))
  const jMin = Math.max(0, Math.floor(cj - r))
  const jMax = Math.min(rows - 1, Math.ceil(cj + r))
  const square = shape === 'square'
  for (let j = jMin; j <= jMax; j++) {
    for (let i = iMin; i <= iMax; i++) {
      const dist = square ? Math.max(Math.abs(i - ci), Math.abs(j - cj)) : Math.hypot(i - ci, j - cj)
      if (dist > r) continue
      fn(i, j, profileFalloff(dist / r, profile)) // 1 at centre; peak ramps linearly, flat holds then ramps at the rim
    }
  }
}

/** Apply one brush dab and return a NEW heights array (the input is untouched). */
export function applyTerrainBrush(heights: number[], cols: number, rows: number, opts: TerrainBrushOptions): number[] {
  const out = heights.slice()
  if (!(cols >= 2) || !(rows >= 2) || heights.length < cols * rows) return out
  const mode = opts?.mode || 'raise'
  const u = Math.min(1, Math.max(0, Number(opts?.u)))
  const v = Math.min(1, Math.max(0, Number(opts?.v)))
  if (!Number.isFinite(u) || !Number.isFinite(v)) return out
  // Corner-lattice (smooth heightmap): samples sit at the tile corners (i/(cols-1)), so the brush
  // centre in sample coordinates is u*(cols-1) — u=0.5 lands on the middle sample.
  const ci = u * (cols - 1)
  const cj = v * (rows - 1)
  const radiusCells = Math.max(0.5, (Number(opts?.radius) || 0.08) * Math.max(cols, rows))
  const strength = Number.isFinite(Number(opts?.strength)) ? Number(opts.strength) : 1
  const level = Number(opts?.level) || 0
  const shape: TerrainBrushShape = opts?.shape === 'square' ? 'square' : 'circle'
  const profile: TerrainBrushProfile = opts?.profile === 'flat' ? 'flat' : opts?.profile === 'plateau' ? 'plateau' : 'peak'

  forEachInRadius(cols, rows, ci, cj, radiusCells, shape, profile, (i, j, falloff) => {
    const k = j * cols + i
    const w = falloff * strength
    if (mode === 'raise') out[k] = heights[k] + w
    else if (mode === 'lower') out[k] = heights[k] - w
    else if (mode === 'level') out[k] = heights[k] + (level - heights[k]) * Math.min(1, Math.max(0, w))
    else if (mode === 'smooth') {
      let s = 0
      let n = 0
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di
          const jj = j + dj
          if (ii >= 0 && ii < cols && jj >= 0 && jj < rows) {
            s += heights[jj * cols + ii]
            n++
          }
        }
      }
      out[k] = heights[k] + (s / n - heights[k]) * Math.min(1, Math.max(0, w))
    }
  })
  return out
}
