/**
 * vision.ts — offline, static line-of-sight visibility for the platform viewer.
 *
 * The LIVE Foundry plugin defers to `canvas.visibility` (a runtime sight engine). OFFLINE
 * there is no Foundry runtime, so this computes — purely from the stored scene — which tokens
 * a set of viewer-owned "vision source" tokens can see. Pure + framework-free (no three.js,
 * no DOM), so it unit-tests in milliseconds and runs equally on the server or in the browser.
 *
 * Product rule ("no lighting → whole scene; lighting → only what the viewer's tokens can
 * see"), evaluated as short-circuits IN ORDER:
 *   1. token vision disabled (`tokenVision === false`) → all visible
 *   2. viewer is a GM                                  → all visible
 *   3. scene is globally illuminated (`globalLight`)   → all visible
 *   4. scene has NO light sources                      → all visible (nothing constrains sight)
 *   5. viewer has NO vision sources                    → all visible (no POV to cull against)
 *   6. otherwise: a token is visible iff SOME source has an unobstructed line of sight to its
 *      centre (segment not crossing a sight-blocking wall) AND the centre is within that
 *      source's sight RANGE, or inside a LIGHT the source can also see. A source always sees
 *      itself.
 *
 * All coordinates are world pixels (the same space the ViewerScene uses). Ranges are pixels.
 */

export interface VisionWall {
  x1: number
  y1: number
  x2: number
  y2: number
  /** Default true. `false` (a sight-transparent wall / open door / window) never blocks. */
  blocksSight?: boolean
}

export interface VisionLight {
  x: number
  y: number
  /** Illumination radius in px. */
  radius: number
}

export interface VisionSource {
  id?: string
  /** Source centre, px. */
  x: number
  y: number
  /** Sight range in px. <= 0 means "no innate range" — the source only sees lit areas. */
  range: number
}

export interface VisionToken {
  id: string
  /** Token centre, px. */
  x: number
  y: number
}

export interface VisionInput {
  tokens: VisionToken[]
  sources: VisionSource[]
  walls?: VisionWall[]
  lights?: VisionLight[]
  /** Viewer is a GM → sees everything. */
  gm?: boolean
  /** Foundry scene `tokenVision`. `false` disables the sight limit → everything visible. */
  tokenVision?: boolean
  /** Scene global illumination on → the whole scene is lit → everything visible. */
  globalLight?: boolean
}

const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

/** Signed area of triangle (a,b,c) — >0 CCW, <0 CW, 0 collinear. */
const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)

/**
 * Proper segment intersection (segments AB and CD cross at an interior point). Collinear /
 * endpoint-touch cases return false: a sight ray that merely grazes a wall's endpoint is
 * treated as NOT blocked, which avoids false occlusion at shared wall corners.
 */
export function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o1 = orient(ax, ay, bx, by, cx, cy)
  const o2 = orient(ax, ay, bx, by, dx, dy)
  const o3 = orient(cx, cy, dx, dy, ax, ay)
  const o4 = orient(cx, cy, dx, dy, bx, by)
  return o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0
}

/**
 * Which of `input.tokens` are visible to the viewer. Returns Map<tokenId, boolean> covering
 * every input token. See the module header for the rule order.
 */
export function computeTokenVisibility(input: VisionInput): Map<string, boolean> {
  const vis = new Map<string, boolean>()
  const setAll = (v: boolean): Map<string, boolean> => {
    for (const t of input.tokens) vis.set(t.id, v)
    return vis
  }
  if (input.tokenVision === false) return setAll(true)
  if (input.gm) return setAll(true)
  if (input.globalLight) return setAll(true)
  const lights = input.lights || []
  if (!lights.length) return setAll(true) // no lighting configured → whole scene visible
  const sources = input.sources || []
  if (!sources.length) return setAll(true) // no POV → don't hide anything

  const walls = (input.walls || []).filter((w) => w.blocksSight !== false)
  const sourceIds = new Set(sources.map((s) => s.id).filter((id): id is string => !!id))
  const inAnyLight = (x: number, y: number): boolean => lights.some((l) => dist2(x, y, l.x, l.y) <= l.radius * l.radius)
  const losClear = (ax: number, ay: number, bx: number, by: number): boolean => !walls.some((w) => segmentsIntersect(ax, ay, bx, by, w.x1, w.y1, w.x2, w.y2))

  for (const t of input.tokens) {
    if (t.id && sourceIds.has(t.id)) {
      vis.set(t.id, true) // a source always sees itself
      continue
    }
    let seen = false
    for (const s of sources) {
      if (!losClear(s.x, s.y, t.x, t.y)) continue
      const withinRange = s.range > 0 && dist2(s.x, s.y, t.x, t.y) <= s.range * s.range
      if (withinRange || inAnyLight(t.x, t.y)) {
        seen = true
        break
      }
    }
    vis.set(t.id, seen)
  }
  return vis
}
