/**
 * TerrainStampController — the Level Stamp behaviour, framework-free so BOTH the PlayTable browser
 * (React/WorldSceneViewer) and the FoundryVTT plugin (plain-JS overlay-3d) drive the identical stamp:
 * a keyboard-driven reticle that SETS every sample of the grid square(s) under it to an exact
 * elevation (flat plateau; untouched neighbour squares auto-slope from the shared edge). WASD slides
 * it a grid square at a time (seat-relative — W is always "away across the table"), Q/E lower/raise the
 * target elevation by a grid step, the wheel resizes the footprint, and each move continuously paints.
 *
 * It owns NO rendering, NO input wiring, and imports neither three nor any framework. The host supplies
 * a small viewer interface + the ground-flattened camera forward, calls moveTo/placeAt/key/setSize on
 * its own pointer/keyboard events, and persists via onCommit. Heights are carried in GAME UNITS (feet);
 * the host renders in px, so we convert with pxPerUnit at the viewer boundary.
 */

/**
 * How a heightfield lattice relates to the scene's grid squares. The stamp REQUIRES an aligned
 * lattice — an integer number of samples per square — because it paints whole squares by index
 * arithmetic (`gx * sppX`). Fields created by older builds (e.g. a capped square 80×80 on a 59×55
 * scene) are OFF-lattice: the rounded spp drifts the painted region further off target the further
 * the square is from the origin. Hosts must gate the stamp on `aligned` and offer a rebuild
 * (resampleHeightfield) instead of arming a tool that edits the wrong tiles.
 */
export function latticeAlignment(cols: number, rows: number, squaresW: number, squaresH: number): { sppX: number; sppY: number; aligned: boolean } {
  const sppX = Math.max(1, Math.round((cols - 1) / Math.max(1, squaresW)))
  const sppY = Math.max(1, Math.round((rows - 1) / Math.max(1, squaresH)))
  const aligned = cols - 1 === sppX * squaresW && rows - 1 === sppY * squaresH
  return { sppX, sppY, aligned }
}

/**
 * Bilinearly resample a heightfield onto a new lattice (same world span — the field always covers
 * the scene rect, so only the sample density changes). Preserves sculpted terrain when rebuilding an
 * off-lattice or differently-dense field; heights stay in the caller's units.
 */
export function resampleHeightfield(src: { cols: number; rows: number; heights: number[] }, cols: number, rows: number): number[] {
  const sc = Math.max(2, Math.floor(src.cols))
  const sr = Math.max(2, Math.floor(src.rows))
  const out = new Array(cols * rows)
  for (let j = 0; j < rows; j++) {
    const v = rows > 1 ? (j / (rows - 1)) * (sr - 1) : 0
    const j0 = Math.min(sr - 2, Math.floor(v))
    const fv = v - j0
    for (let i = 0; i < cols; i++) {
      const u = cols > 1 ? (i / (cols - 1)) * (sc - 1) : 0
      const i0 = Math.min(sc - 2, Math.floor(u))
      const fu = u - i0
      const h00 = Number(src.heights[j0 * sc + i0]) || 0
      const h10 = Number(src.heights[j0 * sc + i0 + 1]) || 0
      const h01 = Number(src.heights[(j0 + 1) * sc + i0]) || 0
      const h11 = Number(src.heights[(j0 + 1) * sc + i0 + 1]) || 0
      out[j * cols + i] = h00 * (1 - fu) * (1 - fv) + h10 * fu * (1 - fv) + h01 * (1 - fu) * fv + h11 * fu * fv
    }
  }
  return out
}

/** The subset of a 3D viewer the stamp needs. Both hosts already expose these (shared core methods). */
export interface TerrainStampHost {
  /** Current terrain sample heights in PX (world units), or null if there's no field. */
  getTerrainHeights(): number[] | null
  /** Displace the terrain mesh to these PX heights (row-major, length cols*rows). */
  updateTerrainHeights(heightsPx: number[]): void
  /** World position of a terrain sample (corner-lattice cell index). */
  terrainCellToWorld(i: number, j: number): { x: number; z: number } | null | undefined
  /** Draw the stamp reticle. worldY is the target plane height (px); placed tints it amber vs cyan. */
  showReticle(worldX: number, worldZ: number, radiusFrac: number, shape: 'circle' | 'square', worldY: number, placed: boolean): void
  hideReticle(): void
  /** Ground-flattened camera forward (x,z) — for seat-relative WASD. Any magnitude; only sign/ratio used. */
  getCameraForward(): { x: number; z: number }
}

export interface TerrainStampConfig {
  cols: number
  rows: number
  /** px per grid square (scene.grid.size). */
  gridSize: number
  /** scene bounds in px. */
  boundsWidth: number
  boundsHeight: number
  /** px per game unit (grid.size / grid.distance). */
  pxPerUnit: number
  /** elevation step in GAME UNITS for Q/E (typically grid.distance). */
  step: number
  shape: 'circle' | 'square'
  /** brush radius as a fraction of the scene span (wheel-controlled). */
  radiusFrac: number
}

export interface TerrainStampCallbacks {
  /** Persist the committed field (heights in GAME UNITS, length cols*rows). Debounced by the controller. */
  onCommit(heights: number[]): void
  /** Target elevation changed (game units) — drives the host's elevation readout. */
  onLevelChange?(level: number): void
  /** placed (resting/imprinted) vs ethereal (ghost) changed. */
  onPlacedChange?(placed: boolean): void
}

export class TerrainStampController {
  private host: TerrainStampHost
  private cfg: TerrainStampConfig
  private cb: TerrainStampCallbacks

  private squaresW: number
  private squaresH: number
  private sppX: number
  private sppY: number
  private span: number

  private i: number // grid-SQUARE index (not sample)
  private j: number
  private level: number // GAME UNITS
  private heights: number[] // GAME UNITS
  private placed = false

  private commitTimer: ReturnType<typeof setTimeout> | null = null

  constructor(host: TerrainStampHost, cfg: TerrainStampConfig, cb: TerrainStampCallbacks) {
    this.host = host
    this.cfg = cfg
    this.cb = cb
    const { cols, rows, gridSize, boundsWidth, boundsHeight, pxPerUnit } = cfg
    this.squaresW = Math.max(1, Math.round(boundsWidth / gridSize))
    this.squaresH = Math.max(1, Math.round(boundsHeight / gridSize))
    this.sppX = Math.max(1, Math.round((cols - 1) / this.squaresW)) // samples per grid square
    this.sppY = Math.max(1, Math.round((rows - 1) / this.squaresH))
    this.span = Math.max(boundsWidth, boundsHeight)

    const livePx = host.getTerrainHeights()
    const basePx = livePx && livePx.length === cols * rows ? livePx : new Array(cols * rows).fill(0)
    this.heights = basePx.map((h) => h / pxPerUnit)

    this.i = Math.floor(this.squaresW / 2)
    this.j = Math.floor(this.squaresH / 2)
    const c = this.squareCenterSample(this.i, this.j)
    this.level = Math.round((this.heights[c.j * cols + c.i] || 0) / cfg.step) * cfg.step
    this.placed = false
  }

  /** Sample index at a grid square's centre (for the level lookup + reticle placement). */
  private squareCenterSample(gx: number, gy: number): { i: number; j: number } {
    return {
      i: Math.min(this.cfg.cols - 1, gx * this.sppX + Math.floor(this.sppX / 2)),
      j: Math.min(this.cfg.rows - 1, gy * this.sppY + Math.floor(this.sppY / 2)),
    }
  }

  /** Brush size in whole grid squares (≥1), from the wheel radius. */
  private sizeSquares(): number {
    return Math.max(1, Math.round(this.cfg.radiusFrac * this.squaresW * 2))
  }

  get currentLevel(): number {
    return this.level
  }
  get isPlaced(): boolean {
    return this.placed
  }

  setShape(shape: 'circle' | 'square'): void {
    this.cfg.shape = shape
    this.refresh()
  }
  setRadiusFrac(radiusFrac: number): void {
    this.cfg.radiusFrac = radiusFrac
    if (this.placed) this.paint()
    else this.refresh()
  }

  /** Redraw the reticle over the covered square span at the target level. No terrain change. */
  refresh(): void {
    const { cols, rows, gridSize, pxPerUnit, shape } = this.cfg
    const half = Math.floor(this.sizeSquares() / 2)
    const a = this.host.terrainCellToWorld(Math.max(0, (this.i - half) * this.sppX), Math.max(0, (this.j - half) * this.sppY))
    const b = this.host.terrainCellToWorld(Math.min(cols - 1, (this.i + half + 1) * this.sppX), Math.min(rows - 1, (this.j + half + 1) * this.sppY))
    const rFrac = (this.sizeSquares() * gridSize) / 2 / this.span
    if (a && b) this.host.showReticle((a.x + b.x) / 2, (a.z + b.z) / 2, rFrac, shape, this.level * pxPerUnit, this.placed)
    this.cb.onLevelChange?.(this.level)
    this.cb.onPlacedChange?.(this.placed)
  }

  /** Snap the ghost to the grid square under (u,v) in [0,1] scene space + redraw. No terrain change. */
  moveTo(u: number, v: number): void {
    this.i = Math.max(0, Math.min(this.squaresW - 1, Math.floor(u * this.squaresW)))
    this.j = Math.max(0, Math.min(this.squaresH - 1, Math.floor(v * this.squaresH)))
    this.refresh()
  }

  /** Drop the stamp at (u,v): imprint + mark resting (the only thing that changes terrain via pointer). */
  placeAt(u: number, v: number): void {
    this.i = Math.max(0, Math.min(this.squaresW - 1, Math.floor(u * this.squaresW)))
    this.j = Math.max(0, Math.min(this.squaresH - 1, Math.floor(v * this.squaresH)))
    this.placed = true
    this.paint()
  }

  /** Keyboard: WASD/arrows walk the ghost a grid square (seat-relative); Q/E lower/raise the target. */
  key(rawKey: string): boolean {
    const k = rawKey.toLowerCase()
    let di = 0
    let dj = 0
    let dLevel = 0
    if (k === 'w' || k === 'arrowup' || k === 's' || k === 'arrowdown' || k === 'a' || k === 'arrowleft' || k === 'd' || k === 'arrowright') {
      const f = this.host.getCameraForward()
      let wx = 0
      let wz = 0
      if (k === 'w' || k === 'arrowup') { wx = f.x; wz = f.z } // away across the table
      else if (k === 's' || k === 'arrowdown') { wx = -f.x; wz = -f.z } // toward you
      else if (k === 'd' || k === 'arrowright') { wx = -f.z; wz = f.x } // your right
      else { wx = f.z; wz = -f.x } // your left
      if (Math.abs(wx) >= Math.abs(wz)) di = Math.sign(wx)
      else dj = Math.sign(wz)
    } else if (k === 'e') dLevel = this.cfg.step
    else if (k === 'q') dLevel = -this.cfg.step
    else return false

    if (di || dj) {
      this.i = Math.max(0, Math.min(this.squaresW - 1, this.i + di))
      this.j = Math.max(0, Math.min(this.squaresH - 1, this.j + dj))
    } else if (dLevel) {
      this.level = Math.max(0, this.level + dLevel)
    }
    // Ethereal: keys just steer the ghost. Placed: nudging keeps laying tiles.
    if (this.placed) this.paint()
    else this.refresh()
    return true
  }

  /** Imprint every covered grid square flat to the target level, re-displace the mesh, debounce a commit. */
  private paint(): void {
    const { cols, rows } = this.cfg
    const half = Math.floor(this.sizeSquares() / 2)
    for (let gy = this.j - half; gy <= this.j + half; gy++) {
      for (let gx = this.i - half; gx <= this.i + half; gx++) {
        if (gx < 0 || gy < 0 || gx >= this.squaresW || gy >= this.squaresH) continue
        const i0 = gx * this.sppX
        const j0 = gy * this.sppY
        for (let jj = j0; jj <= Math.min(rows - 1, j0 + this.sppY); jj++) {
          for (let ii = i0; ii <= Math.min(cols - 1, i0 + this.sppX); ii++) this.heights[jj * cols + ii] = this.level
        }
      }
    }
    this.host.updateTerrainHeights(this.heights.map((h) => h * this.cfg.pxPerUnit))
    this.refresh()
    if (this.commitTimer) clearTimeout(this.commitTimer)
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null
      this.cb.onCommit(this.heights.slice())
    }, 300)
  }

  /** Disarm: flush any pending commit + hide the reticle. */
  end(): void {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer)
      this.commitTimer = null
    }
    this.host.hideReticle()
    this.cb.onCommit(this.heights.slice())
  }
}
