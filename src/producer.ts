/**
 * producer — the ONE Foundry-scene → ViewerScene shaping core, shared by BOTH the live Foundry plugin
 * (overlay-3d.js) and the stored/offline adapter (adapter-foundry.ts). Ported from the plugin's pure
 * ctx-driven builders (formerly cfg-foundry-plugin/.../overlay3d/scene-json.js — the "survivor") so
 * there is a single source of truth: fix a fidelity bug once, both hosts get it.
 *
 * SHAPE, NOT POLICY. This module owns the geometry/color/elevation MATH that turns Foundry documents
 * into the renderer's normalized `ViewerScene`. It owns NO Foundry runtime, NO three, NO DOM. Every
 * host-specific DECISION — which level is sliced, whether a placeable is visible to THIS viewer, the
 * live disposition palette, the environment colors, terrain sampling — arrives through a
 * `SceneProducerCtx` the host assembles. The live plugin fills the ctx from `canvas`; the stored
 * adapter fills it from a plain JSON doc (render-all, stored `hidden` flags, fallback constants).
 *
 * 2D-ALWAYS invariant: the producer is mode-agnostic. It emits ONE ViewerScene carrying the flat
 * baseline (levels/floor + tokens + walls + tiles + notes + grid) AND the optional 3D enhancement data
 * (terrain, regions, token.model, lights, elevation) together; the 2D-vs-3D choice lives entirely
 * downstream in the renderer + host, never here.
 */
import type {
  ViewerScene,
  ViewerToken,
  ViewerWall,
  ViewerWallKind,
  ViewerDoorState,
  ViewerLevel,
  ViewerLight,
  ViewerTile,
  ViewerNote,
  ViewerRegion,
  ViewerTerrain,
  ViewerAmbient,
  ViewerDrawing,
  ViewerTemplate,
} from './core.js'

// ── Pure color + flag helpers ────────────────────────────────────────────────

/** Parse a Foundry color (hex string "#rrggbb" or a number) to a 0xRRGGBB number, else `dflt`. */
export function parseHexColor(c: unknown, dflt?: number): number | undefined {
  if (c == null || c === '') return dflt
  if (typeof c === 'number') return c
  const n = parseInt(String(c).replace('#', ''), 16)
  return Number.isFinite(n) ? n : dflt
}

/** Foundry CONST.TOKEN_DISPOSITIONS → a tint. Mirrors Token#getDispositionColor exactly, including the
 * FRIENDLY/PARTY split by actor ownership. `colors` should be the live CONFIG.Canvas.dispositionColors;
 * the numbers below are its own defaults, used when a host can't read CONFIG (offline, headless). */
export function dispositionColor(disposition: number | undefined, hasPlayerOwner = false, colors?: Record<string, number>): number {
  const c = colors || {}
  switch (disposition) {
    case 1: // FRIENDLY
      return (hasPlayerOwner ? c.PARTY : c.FRIENDLY) ?? (hasPlayerOwner ? 0x33bc4e : 0x43dfdf)
    case -1: // HOSTILE
      return c.HOSTILE ?? 0xe72124
    case -2: // SECRET
      return c.SECRET ?? 0xa612d4
    case 0: // NEUTRAL
      return c.NEUTRAL ?? 0xf1d836
    default: // INACTIVE (out-of-range / no disposition)
      return c.INACTIVE ?? 0x555555
  }
}

/** CFG flag bag for a doc, migrating the namespace from the legacy `crit-fumble-core` to `playtable`:
 * read `playtable` first, fall back to `crit-fumble-core` per key so scenes authored under either
 * namespace keep rendering (a merge with `playtable` winning). New writes go to `playtable`. */
export function cfgFlags(flags: Record<string, unknown> | undefined | null): Record<string, unknown> {
  const legacy = (flags?.['crit-fumble-core'] as Record<string, unknown>) || {}
  const next = (flags?.['playtable'] as Record<string, unknown>) || {}
  return { ...legacy, ...next }
}

const num = (v: unknown, dflt = 0): number => (Number.isFinite(Number(v)) ? Number(v) : dflt)

// ── Level band math (mirrors Foundry v14 client/documents/level.mjs) ───────────

export interface ProducerLevel {
  id?: string
  _id?: string
  name?: string | null
  sort?: number
  elevation?: { base?: number | null; bottom?: number | null; top?: number | null }
  background?: { src?: string | null; alphaThreshold?: number; tint?: string | number }
  foreground?: { src?: string | null }
  textures?: { rotation?: number; offsetX?: number; offsetY?: number }
  /** Foundry `level.visibility.levels` — other Level-doc ids visible (see-through) from this level. */
  visibility?: { levels?: string[] }
}

/** A Level's base (floor) elevation in grid units: a finite derived `elevation.base` wins; else
 * `elevation.bottom`; else a NULL/open bottom = min(top, 0) (the schema's "null bottom = -Infinity"),
 * NOT a hard 0. `Number.isFinite` on the RAW value is deliberate: Number(null)===0 masks the open case. */
export function levelBase(level: ProducerLevel | undefined): number {
  const e = level?.elevation || {}
  if (Number.isFinite(e.base as number)) return e.base as number
  if (Number.isFinite(e.bottom as number)) return e.bottom as number
  return Number.isFinite(e.top as number) ? Math.min(e.top as number, 0) : 0
}

/** A Level's top elevation in grid units; +Infinity for an open (null/absent) top. */
export function levelTop(level: ProducerLevel | undefined): number {
  const t = level?.elevation?.top
  return Number.isFinite(t as number) ? (t as number) : Infinity
}

/** The Level whose half-open band [base, top) contains `elev` (grid units), or null. A token exactly
 * at a shared boundary belongs to the UPPER floor (bands are [b,t)). */
export function levelContainingElevation(levels: ProducerLevel[], elev: number, base = levelBase, top = levelTop): ProducerLevel | null {
  if (!Number.isFinite(elev)) return null
  let match: ProducerLevel | null = null
  for (const l of levels || []) {
    const b = base(l)
    const t = top(l)
    if (elev >= b - 0.01 && elev < t - 0.01) {
      if (!match || base(l) > base(match)) match = l // deepest-containing → prefer the higher floor
    }
  }
  return match
}

/** The Level a first-person viewer at `elev` treats as its floor for slicing: the containing band, else
 * the highest floor at or below (flown above the top / hovering in a gap), else the lowest (burrowed
 * below all). null only with no levels or a non-finite `elev`. */
export function levelForElevation(levels: ProducerLevel[], elev: number, base = levelBase, top = levelTop): ProducerLevel | null {
  const contained = levelContainingElevation(levels, elev, base, top)
  if (contained) return contained
  if (!Number.isFinite(elev)) return null
  let best: ProducerLevel | null = null
  let bestBase = -Infinity
  for (const l of levels || []) {
    const b = base(l)
    if (b <= elev + 0.01 && b > bestBase) {
      best = l
      bestBase = b
    }
  }
  if (best) return best
  let lowest: ProducerLevel | null = null
  let lowestBase = Infinity
  for (const l of levels || []) {
    const b = base(l)
    if (b < lowestBase) {
      lowest = l
      lowestBase = b
    }
  }
  return lowest
}

/** Pick the "active" (viewed) Level by camera mode. In firstperson the SUBJECT's floor wins outright;
 * every other mode: focus-follow → canvas.level → scene._view → topmost. Pure: the host supplies ids +
 * a `get(id)→level` resolver. (Used by the live plugin's camera modes; the stored adapter passes the
 * topmost level.) */
export function resolveActiveLevel(ctx: {
  mode?: string
  get?: (id: string | null | undefined) => ProducerLevel | null
  firstPersonLevelId?: string | null
  focusFollow?: boolean
  focusLevelId?: string | null
  canvasLevel?: ProducerLevel | null
  viewLevelId?: string | null
  allLevels?: ProducerLevel[]
  levelBase?: (l: ProducerLevel) => number
}): ProducerLevel | null {
  const get = ctx.get || (() => null)
  if (ctx.mode === 'firstperson') {
    const l = get(ctx.firstPersonLevelId)
    if (l) return l
  }
  if (ctx.focusFollow) {
    const l = get(ctx.focusLevelId)
    if (l) return l
  }
  if (ctx.canvasLevel) return ctx.canvasLevel
  const v = get(ctx.viewLevelId)
  if (v) return v
  const base = ctx.levelBase || levelBase
  let top: ProducerLevel | null = null
  for (const l of ctx.allLevels || []) if (!top || base(l) > base(top)) top = l
  return top
}

// ── Sub-builders (pure; exported for unit tests) ───────────────────────────────

/** Grid-helper config. Gridless (type 0) → off. Color is a hex STRING like "#999999". */
export function buildGridJson(grid: { type?: number; color?: unknown; alpha?: unknown; distance?: unknown; units?: unknown } | undefined, size: number): NonNullable<ViewerScene['grid']> {
  const out: NonNullable<ViewerScene['grid']> = {
    size: size || 100,
    showHelper: !(grid && grid.type === 0),
    color: parseHexColor(grid?.color, 0xcccccc),
    // Finite guard: a non-numeric alpha must fall back, not emit NaN opacity.
    opacity: Number.isFinite(Number(grid?.alpha)) ? Math.max(0.25, Number(grid?.alpha)) : 0.4,
  }
  // Game distance per cell + its unit label (Foundry grid.distance/units) — lets a host show measured
  // sizes (ruler / AoE templates) in real units instead of raw pixels.
  if (Number.isFinite(Number(grid?.distance))) out.distance = Number(grid?.distance)
  if (typeof grid?.units === 'string' && grid.units) out.units = grid.units
  return out
}

export interface ProducerTile {
  id?: string
  _id?: string
  x?: number
  y?: number
  width?: number
  height?: number
  elevation?: number
  alpha?: number
  hidden?: boolean
  texture?: { src?: string | null }
  levels?: string[]
  flags?: Record<string, unknown>
}

/** Effective floor elevation (grid units) for a doc: the Levels-module floor (flags.levels.rangeBottom)
 * when present, else the document's own elevation. */
export function levelsElevation(doc: { elevation?: number; flags?: { levels?: { rangeBottom?: number } } }): number {
  const rb = doc?.flags?.levels?.rangeBottom
  if (Number.isFinite(Number(rb))) return Number(rb)
  return num(doc?.elevation)
}

/** Native Foundry per-placeable Level membership (`document.levels`) → the level-doc ids, or undefined
 * when empty/absent (empty = "all levels", the host's elevation fallback). Undefined is deliberate so
 * the emitted payload omits `levelIds` in the common case (byte-identical to pre-membership output). */
export function levelMembership(levels: unknown): string[] | undefined {
  if (!Array.isArray(levels) || levels.length === 0) return undefined
  const ids = levels.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return ids.length ? ids : undefined
}

/** Tiles → textured quads at their floor elevation, riding any heightmap terrain (so a ground tile
 * isn't buried under raised land). ctx: { pxPerUnit, docInSlice, assetUrl, terrainAt? }. */
export function buildTilesJson(docs: ProducerTile[] | undefined, ctx: { pxPerUnit: number; docInSlice: (d: ProducerTile) => boolean; assetUrl: (s: string) => string | null; terrainAt?: ((x: number, y: number) => number | null) | null }): ViewerTile[] {
  const out: ViewerTile[] = []
  for (const d of docs || []) {
    try {
      if (!d || d.hidden || !ctx.docInSlice(d)) continue
      const w = num(d.width)
      const h = num(d.height)
      if (w < 1 || h < 1) continue
      const elev = levelsElevation(d)
      const src = d.texture?.src
      const ground = ctx.terrainAt ? ctx.terrainAt(num(d.x) + w / 2, num(d.y) + h / 2) : null
      const lift = ground != null ? ground * ctx.pxPerUnit + 2 : 0 // +2px avoids z-fighting with the surface
      const tile: ViewerTile = {
        id: d.id ?? d._id,
        x: num(d.x),
        y: num(d.y),
        width: w,
        height: h,
        elevation: elev * ctx.pxPerUnit + lift,
        texture: src ? ctx.assetUrl(src) : null,
        alpha: Number.isFinite(Number(d.alpha)) ? Number(d.alpha) : 1,
        color: elev > 0 ? 0x7a6a52 : 0x515b6b, // no texture → tint by elevation
      }
      const levelIds = levelMembership(d.levels)
      if (levelIds) tile.levelIds = levelIds
      out.push(tile)
    } catch {
      /* skip a malformed tile */
    }
  }
  return out
}

export interface ProducerNote {
  document?: { id?: string; _id?: string; x?: number; y?: number; iconSize?: number; texture?: { src?: string | null }; levels?: string[]; entryId?: string; text?: string }
  center?: { x?: number; y?: number }
  // stored path passes the doc directly (no placeable wrapper)
  id?: string
  _id?: string
  x?: number
  y?: number
  iconSize?: number
  texture?: { src?: string | null }
  levels?: string[]
  entryId?: string
  text?: string
}

/** Map note pins → flat billboard markers. Accepts either a live Note placeable ({center, document})
 * or a bare note doc (stored). */
export function buildNotesJson(notes: ProducerNote[] | undefined, assetUrl: (s: string) => string | null): ViewerNote[] {
  const out: ViewerNote[] = []
  for (const note of notes || []) {
    try {
      const doc = note.document ?? note
      const x = note.center?.x ?? doc.x ?? 0
      const y = note.center?.y ?? doc.y ?? 0
      const src = doc.texture?.src
      const marker: ViewerNote = { id: doc.id ?? doc._id, x, y, size: doc.iconSize || 50, texture: src ? assetUrl(src) : null }
      if (doc.entryId) marker.entryId = doc.entryId
      if (doc.text) marker.text = doc.text
      const levelIds = levelMembership(doc.levels)
      if (levelIds) marker.levelIds = levelIds
      out.push(marker)
    } catch {
      /* skip a malformed note */
    }
  }
  return out
}

type ProducerDrawingDoc = {
  id?: string
  _id?: string
  x?: number
  y?: number
  shape?: { type?: string; width?: number; height?: number; points?: number[] }
  strokeColor?: unknown
  strokeAlpha?: number
  strokeWidth?: number
  rotation?: number
  fillType?: number
  fillColor?: unknown
  fillAlpha?: number
  text?: string
  fontSize?: number
  textColor?: unknown
  hidden?: boolean
  levels?: string[]
}
export interface ProducerDrawing extends ProducerDrawingDoc {
  document?: ProducerDrawingDoc
}

/** FoundryVTT Drawing docs → ground-plane annotations. Foundry `shape.type` r/e/p → rect/ellipse/polygon;
 * freehand is stored as a polygon (many points). `fillType` 0 = none. Accepts a live placeable ({document})
 * or a bare stored doc. `docInSlice` strips hidden drawings for non-GM viewers. */
export function buildDrawingsJson(docs: ProducerDrawing[] | undefined, ctx: { docInSlice?: (d: ProducerDrawingDoc) => boolean } = {}): ViewerDrawing[] {
  const out: ViewerDrawing[] = []
  const inSlice = ctx.docInSlice ?? (() => true)
  for (const raw of docs || []) {
    try {
      const doc = raw.document ?? raw
      if (!inSlice(doc)) continue
      const id = doc.id ?? doc._id
      if (!id) continue
      const st = doc.shape?.type
      const hasPoints = Array.isArray(doc.shape?.points) && (doc.shape?.points as number[]).length >= 4
      const type: ViewerDrawing['type'] = st === 'r' ? 'rect' : st === 'e' ? 'ellipse' : st === 'p' ? 'polygon' : hasPoints ? 'polygon' : 'rect'
      const d: ViewerDrawing = { id, type, x: doc.x ?? 0, y: doc.y ?? 0 }
      if (doc.shape?.width != null) d.width = doc.shape.width
      if (doc.shape?.height != null) d.height = doc.shape.height
      if (hasPoints) d.points = (doc.shape?.points as number[]).map(Number)
      if (doc.rotation != null && Number.isFinite(Number(doc.rotation))) d.rotation = Number(doc.rotation)
      const sc = parseHexColor(doc.strokeColor, 0xffdd55)
      if (sc != null) d.strokeColor = sc
      if (doc.strokeAlpha != null) d.strokeAlpha = doc.strokeAlpha
      if (doc.strokeWidth != null && Number.isFinite(Number(doc.strokeWidth))) d.strokeWidth = Number(doc.strokeWidth)
      if ((doc.fillType ?? 0) > 0) {
        const fc = parseHexColor(doc.fillColor, undefined)
        if (fc != null) d.fillColor = fc
        d.fillAlpha = doc.fillAlpha != null ? doc.fillAlpha : 0.25
      }
      if (doc.text) {
        d.text = String(doc.text).slice(0, 200)
        if (doc.fontSize != null) d.fontSize = doc.fontSize
        const tc = parseHexColor(doc.textColor, undefined)
        if (tc != null) d.textColor = tc
      }
      out.push(d)
    } catch {
      /* skip a malformed drawing */
    }
  }
  return out
}

type ProducerTemplateDoc = {
  id?: string
  _id?: string
  t?: string
  x?: number
  y?: number
  distance?: number
  direction?: number
  angle?: number
  width?: number
  borderColor?: unknown
  fillColor?: unknown
  hidden?: boolean
}
export interface ProducerTemplate extends ProducerTemplateDoc {
  document?: ProducerTemplateDoc
}

/** FoundryVTT MeasuredTemplate docs → ground-plane AoE shapes. Foundry `distance`/`width` are in grid
 * DISTANCE units → converted to px via pxPerUnit; `t` circle/cone/ray/rect. `docInSlice` strips hidden
 * templates for non-GM viewers. Accepts a live placeable ({document}) or a bare stored doc. */
export function buildTemplatesJson(docs: ProducerTemplate[] | undefined, ctx: { pxPerUnit: number; docInSlice?: (d: ProducerTemplateDoc) => boolean }): ViewerTemplate[] {
  const out: ViewerTemplate[] = []
  const inSlice = ctx.docInSlice ?? (() => true)
  for (const raw of docs || []) {
    try {
      const doc = raw.document ?? raw
      if (!inSlice(doc)) continue
      const id = doc.id ?? doc._id
      if (!id) continue
      const t = doc.t
      const type: ViewerTemplate['type'] = t === 'cone' ? 'cone' : t === 'ray' ? 'ray' : t === 'rect' ? 'rect' : 'circle'
      const tpl: ViewerTemplate = { id, type, x: Number(doc.x) || 0, y: Number(doc.y) || 0, size: (Number(doc.distance) || 0) * ctx.pxPerUnit }
      if (doc.direction != null) tpl.direction = Number(doc.direction)
      if (doc.angle != null) tpl.angle = Number(doc.angle)
      if (type === 'ray') tpl.width = (Number(doc.width) || 1) * ctx.pxPerUnit
      const bc = parseHexColor(doc.borderColor, 0xff3355)
      if (bc != null) tpl.borderColor = bc
      const fc = parseHexColor(doc.fillColor, bc)
      if (fc != null) tpl.fillColor = fc
      tpl.fillAlpha = 0.2
      out.push(tpl)
    } catch {
      /* skip a malformed template */
    }
  }
  return out
}

export interface ProducerRegion {
  id?: string
  surface?: number
  base?: number
  vertices?: number[]
  indices?: number[]
  rings?: number[][]
  src?: string
  color?: number
  opacity?: number
}

/** Native Foundry Regions (already resolved by the host to Foundry geometry) → extruded terrain tiers.
 * Live plugin resolves from canvas; the stored adapter has no triangulation yet → passes []. */
export function buildRegionsJson(regions: ProducerRegion[] | undefined, ctx: { pxPerUnit: number }): ViewerRegion[] {
  const out: ViewerRegion[] = []
  const px = ctx.pxPerUnit
  for (const r of regions || []) {
    if (!r || !Number.isFinite(r.surface as number)) continue
    if (!r.vertices?.length || !r.indices?.length) continue
    out.push({
      id: r.id,
      elevation: (r.surface as number) * px,
      base: (Number.isFinite(r.base as number) ? (r.base as number) : 0) * px,
      vertices: r.vertices,
      indices: r.indices,
      rings: r.rings || [],
      src: r.src,
      color: r.color,
      opacity: r.opacity,
    })
  }
  return out
}

/** Heightmap flag → viewer terrain. `field` = { cols, rows, heights:number[] } with heights in grid
 * UNITS (row-major, cols×rows). Scales to px. null when absent/degenerate so the core keeps its flat
 * floor. A short/mismatched heights array bails the core to a FLOORLESS scene, so the length guard is
 * load-bearing. */
export function buildTerrainJson(field: { cols?: number; rows?: number; heights?: unknown[] } | null | undefined, ctx: { pxPerUnit: number; src?: string; color?: number }): ViewerTerrain | null {
  if (!field) return null
  const cols = Math.floor(num(field.cols))
  const rows = Math.floor(num(field.rows))
  if (!(cols >= 2) || !(rows >= 2)) return null
  const data = field.heights
  if (!Array.isArray(data) || data.length < cols * rows) return null
  const px = ctx.pxPerUnit
  const heights = data.map((h) => (Number.isFinite(Number(h)) ? Number(h) * px : 0))
  return { cols, rows, heights, src: ctx.src, color: ctx.color }
}

export interface ProducerLevelsCtx {
  levelElevPx: (level: ProducerLevel, which: 'bottom' | 'top') => number
  assetUrl: (s: string) => string | null
  sliceCut: () => number
  levelBase: (level: ProducerLevel) => number
  activeLevel: () => ProducerLevel | null
  userCanSeeLevel: (level: ProducerLevel) => boolean
  backgroundSrc: () => string | null | undefined
  firstPerson?: boolean
  levelVisibleFromActive?: (level: ProducerLevel) => boolean
  /** Offline/stored policy: emit EVERY level's background AND foreground with no cutaway or active-roof
   * culling, so the host's own level PICKER can slice client-side (the live plugin slices server-side
   * and passes false). */
  renderAll?: boolean
}

/** Native v14 Level maps → textured quads (one per level background/foreground). Floors sorted for
 * stable stacking, clipped to the slice cut, filtered by per-player visibility; a roof renders only for
 * floors strictly below the active one. Falls back to a single scene-background floor quad. */
export function buildLevelsJson(levels: ProducerLevel[] | undefined, ctx: ProducerLevelsCtx): ViewerLevel[] {
  const out: ViewerLevel[] = []
  const addQuad = (level: ProducerLevel, texData: { src?: string | null; alphaThreshold?: number; tint?: string | number } | undefined, which: 'bottom' | 'top') => {
    const src = texData?.src
    if (!src) return
    if (/\.(webm|mp4|m4v|ogv)$/i.test(src)) return // video src: image-only for now
    const t = level?.textures || {}
    const at = Number(texData.alphaThreshold)
    const tint = Number(texData.tint)
    const rot = Number(t.rotation)
    const resolved = ctx.assetUrl(src)
    if (!resolved) return
    // Native Level see-through ids (`level.visibility.levels`) — omitted unless authored, so scenes
    // with no inter-level visibility config stay byte-identical.
    const seeThrough = level?.visibility?.levels
    const quad: ViewerLevel = {
      elevation: ctx.levelElevPx(level, which),
      which,
      src: resolved,
      alphaTest: Number.isFinite(at) ? at : 0.75,
      tint: Number.isFinite(tint) && tint !== 0xffffff ? tint : undefined,
      rotation: Number.isFinite(rot) && rot !== 0 ? -(rot * Math.PI) / 180 : undefined,
      offsetX: num(t.offsetX),
      offsetY: num(t.offsetY),
    }
    const levelId = level?.id ?? level?._id
    if (levelId) quad.id = levelId
    if (Array.isArray(seeThrough) && seeThrough.length) quad.visibleLevelIds = seeThrough
    out.push(quad)
  }
  if (levels?.length) {
    const sorted = [...levels].sort((a, b) => num(a.sort) - num(b.sort))
    const cut = ctx.sliceCut()
    const active = ctx.activeLevel() || sorted[sorted.length - 1]
    const activeBase = ctx.levelBase(active)
    const fp = ctx.firstPerson === true
    const activeCeilinged = fp && Number.isFinite(levelTop(active))
    for (const level of sorted) {
      if (!ctx.userCanSeeLevel(level)) continue
      const isActive = level === active
      if (ctx.renderAll) {
        // no cutaway, no active-roof cull — every floor + its roof (client-side picker slices later)
      } else if (fp) {
        if (!isActive && !(ctx.levelVisibleFromActive?.(level) ?? false)) continue
      } else if (ctx.levelBase(level) > cut + 0.01) {
        continue
      }
      addQuad(level, level.background, 'bottom')
      if (ctx.renderAll || ctx.levelBase(level) < activeBase - 0.01 || (activeCeilinged && isActive)) addQuad(level, level.foreground, 'top')
    }
  }
  if (!out.length) {
    const src = ctx.backgroundSrc()
    const resolved = src ? ctx.assetUrl(src) : null
    if (resolved) out.push({ elevation: 0, which: 'bottom', src: resolved, alphaTest: 0 })
  }
  return out
}

export interface ProducerLight {
  id?: string
  _id?: string
  x?: number
  y?: number
  elevation?: number
  hidden?: boolean
  levels?: string[]
  config?: { dim?: number; bright?: number; color?: string | number; luminosity?: number }
}
export interface ProducerTokenLight {
  x?: number
  y?: number
  elevation?: number
  width?: number
  height?: number
  light?: { dim?: number; bright?: number; color?: string | number; luminosity?: number }
}

export interface ProducerLightsCtx {
  env: { daylight: number; darkCol: number; brightest: number; darkness: number; globalLightOn: boolean }
  size: number
  shadows: boolean
  pxPerUnit: number
  /** One slice predicate for BOTH light docs and token docs (matches the plugin's call site). Given the
   * hidden/disposition fields too, so a host can drop hidden + (for non-GM) secret token lights here. */
  docInSlice: (doc: { elevation?: number; hidden?: boolean; disposition?: number; flags?: Record<string, unknown> }) => boolean
  tokenSizePx: (doc: ProducerTokenLight) => { w: number; h: number }
  /** Ambient intensity coefficients (intensity = base + lit·`lit`). Defaults are the live plugin's,
   * paired with real canvas.environment colors; the stored adapter, working from grey fallback
   * colors, passes its own tuned (dimmer) values so the offline look is unchanged. Genuine per-host
   * visual tuning, parameterized rather than forked. */
  ambientCoeffs?: { hemiBase?: number; hemiLit?: number; sunBase?: number; sunLit?: number }
}

/** Ambient + point lights. Ambient mirrors Foundry's effective brightness; the floor is drawn
 * emissively at floorBrightness so the MAP matches Foundry's 2D. Point lights come from AmbientLight
 * placeables + token-emitted light; a shadow budget of the first few cast shadows (walls block them).
 * NOTE: does NOT cap the total light count — the host applies capLights() afterward (both hosts want a
 * biggest-first cap; a forward renderer fails past a few dozen lights). */
export function buildLightsJson(lightDocs: ProducerLight[] | undefined, tokenDocs: ProducerTokenLight[] | undefined, ctx: ProducerLightsCtx): { ambient: ViewerAmbient; lights: ViewerLight[] } {
  const { daylight, darkCol, brightest, darkness, globalLightOn } = ctx.env
  const day = Math.max(0, Math.min(1, 1 - darkness))
  const lit = globalLightOn ? 1 : day
  const size = ctx.size
  const shadows = ctx.shadows
  const co = ctx.ambientCoeffs || {}
  const hemiBase = co.hemiBase ?? 0.6
  const hemiLit = co.hemiLit ?? 0.9
  const sunBase = co.sunBase ?? 0.4
  const sunLit = co.sunLit ?? 0.9
  const ambient: ViewerAmbient = {
    hemisphere: { sky: daylight, ground: darkCol, intensity: hemiBase + hemiLit * lit },
    sun: { color: brightest, intensity: sunBase + sunLit * lit, castShadow: shadows, shadowNormalBias: size * 0.04 },
    floorBrightness: +(0.55 + 0.4 * lit).toFixed(3),
  }
  const pxPerUnit = ctx.pxPerUnit
  const lights: ViewerLight[] = []
  // Inline shadow assignment matches scene-json.js EXACTLY (first few emitted lights cast, in doc order)
  // so the plugin's call site keeps its shadows with no capLights step. A host that DOES call capLights
  // (the stored adapter) has these re-assigned biggest-first — capLights overrides this.
  let shadowBudget = shadows ? 4 : 0
  const addPointLight = (cfg: ProducerLight['config'], x: number, y: number, elevPx: number, meta?: { id?: string; levelIds?: string[] }) => {
    if (!cfg) return
    const dim = num(cfg.dim)
    const bright = num(cfg.bright)
    if (dim <= 0 && bright <= 0) return
    const color = cfg.color != null ? (parseHexColor(cfg.color, 0xffffff) as number) : 0xffffff
    const radius = Math.max(dim, bright) * pxPerUnit || size * 4
    const castShadow = shadowBudget > 0
    if (castShadow) shadowBudget--
    const light: ViewerLight = {
      x,
      y,
      elevation: elevPx + size * 0.6,
      color,
      radius,
      intensity: 1.3 + num(cfg.luminosity),
      castShadow,
      shadowNear: size * 0.2,
      shadowNormalBias: size * 0.05,
    }
    // id + native Level membership (scene lights only — token lights are positional and slice with
    // their token's elevation). Both omitted unless present, keeping the common output byte-identical.
    if (meta?.id) light.id = meta.id
    if (meta?.levelIds) light.levelIds = meta.levelIds
    lights.push(light)
  }
  for (const d of lightDocs || []) {
    try {
      if (d?.hidden || !ctx.docInSlice(d)) continue
      addPointLight(d.config, num(d.x), num(d.y), num(d.elevation) * pxPerUnit, { id: d.id ?? d._id, levelIds: levelMembership(d.levels) })
    } catch {
      /* skip */
    }
  }
  for (const d of tokenDocs || []) {
    try {
      if (!ctx.docInSlice(d)) continue
      const { w, h } = ctx.tokenSizePx(d)
      addPointLight(d?.light, num(d.x) + w / 2, num(d.y) + h / 2, num(d.elevation) * pxPerUnit)
    } catch {
      /* skip */
    }
  }
  return { ambient, lights }
}

/** Cap + prioritize lights: keep the biggest coverage (radius·intensity) first, and only the top
 * `shadowBudget` cast shadows (each caster = a full shadow-map pass; unbounded lights can fail a
 * forward-renderer shader compile). Mutates castShadow on the returned set. */
export function capLights(lights: ViewerLight[], opts: { maxLights?: number; shadowBudget?: number }): ViewerLight[] {
  const maxLights = Math.max(0, opts.maxLights ?? 24)
  const shadowBudget = Math.max(0, opts.shadowBudget ?? 4)
  const kept = [...lights].sort((a, b) => (b.radius ?? 0) * (b.intensity ?? 1) - (a.radius ?? 0) * (a.intensity ?? 1)).slice(0, maxLights)
  kept.forEach((l, i) => {
    l.castShadow = i < shadowBudget
  })
  return kept
}

export interface ProducerToken {
  id?: string
  _id?: string
  x?: number
  y?: number
  elevation?: number
  disposition?: number
  lockRotation?: boolean
  rotation?: number
  /** Native Foundry Level-doc id the token stands on (`token.level`). */
  level?: string | null
  texture?: { src?: string | null; fit?: 'contain' | 'cover' | 'fill' | 'width' | 'height' }
  ring?: { enabled?: boolean; colors?: { ring?: string | number | null; background?: string | number | null }; subject?: { texture?: string | null; scale?: number } }
  flags?: Record<string, unknown>
}

export interface ProducerTokenCtx {
  pxPerUnit: number
  sizePx: { w: number; h: number }
  floorElevation: number
  groundOffsetUnits?: number
  assetUrl: (s: string) => string | null
  dispositionColors?: Record<string, number>
  hasPlayerOwner?: boolean
  isSecretFromViewer?: boolean
  // host-computed appearance (undefined → the core's defaults)
  tint?: number
  alpha?: number
  textureScaleX?: number
  textureScaleY?: number
  selected?: boolean
  targeted?: boolean
  targetColor?: number
}

/** A token document → viewer token JSON (pure shaping; the caller does the Foundry gating — slice +
 * per-player visibility — and passes resolved size/floor/appearance). */
export function buildTokenJson(doc: ProducerToken, ctx: ProducerTokenCtx): ViewerToken {
  const flags = cfgFlags(doc.flags)
  const modelSrc = (flags.modelSrc as string) || (flags.model3d as string)
  // Mirrors TokenDocument#isSecret: a SECRET token this viewer can't observe gets none of its
  // informational chrome — substitute the neutral/INACTIVE color instead of leaking "secret".
  const color = ctx.isSecretFromViewer
    ? dispositionColor(undefined, false, ctx.dispositionColors)
    : dispositionColor(doc.disposition, ctx.hasPlayerOwner, ctx.dispositionColors)
  const ring = doc.ring?.enabled ? doc.ring : null
  const artSrc = (ring && ring.subject?.texture) || doc.texture?.src
  const token: ViewerToken = {
    id: (doc.id ?? doc._id) as string,
    x: num(doc.x),
    y: num(doc.y),
    width: ctx.sizePx.w,
    height: ctx.sizePx.h,
    elevation: (num(doc.elevation) + num(ctx.groundOffsetUnits)) * ctx.pxPerUnit,
    floorElevation: ctx.floorElevation,
    color,
    texture: artSrc ? ctx.assetUrl(artSrc) : null,
    model: modelSrc ? ctx.assetUrl(modelSrc) : null,
    modelScale: Number.isFinite(Number(flags.modelScale)) ? Number(flags.modelScale) : undefined,
    modelRotation: Number.isFinite(Number(flags.modelRotation)) ? Number(flags.modelRotation) : undefined,
    tint: ctx.tint,
    alpha: ctx.alpha,
    textureScaleX: ctx.textureScaleX,
    textureScaleY: ctx.textureScaleY,
    artScale: ring && Number.isFinite(Number(ring.subject?.scale)) ? Number(ring.subject?.scale) : undefined,
    ringColor: ring ? parseHexColor(ring.colors?.ring, undefined) : undefined,
    ringBackground: ring ? parseHexColor(ring.colors?.background, undefined) : undefined,
    rotation: doc.lockRotation ? 0 : Number.isFinite(Number(doc.rotation)) ? Number(doc.rotation) : undefined,
    fit: doc.texture?.fit || 'contain',
    selected: !!ctx.selected,
    targeted: !!ctx.targeted,
    targetColor: ctx.targetColor,
  }
  // Native singular level id — lets the host slice keep the token on its own (+ see-through) level by
  // id; omitted when absent so the common (no-levels) token payload stays byte-identical.
  if (typeof doc.level === 'string' && doc.level) token.levelId = doc.level
  return token
}

export interface ProducerWall {
  id?: string
  _id?: string
  c?: number[]
  door?: number
  ds?: number
  dir?: number
  sight?: number
  move?: number
  light?: number
  levels?: string[]
  animation?: { texture?: string; flip?: boolean; double?: boolean; direction?: number; type?: string }
  flags?: Record<string, unknown>
}

export interface ProducerWallsCtx {
  pxPerUnit: number
  gridSize?: number
  ceilUnits: number | null
  docInSlice: (doc: ProducerWall) => boolean
  wallBand: (doc: ProducerWall) => { bottom: number; top: number }
  assetUrl: (s: string) => string | null
  wallOpacity?: number
  wall3dDefaults?: (doc: ProducerWall) => { texture?: string; color?: string | number; tileScale?: number } | undefined
  /** Reveal closed/locked SECRET doors as a distinct `secretDoor` (purple) — only meaningful when the
   * viewer is a GM. Default false = the plugin's live behaviour (a closed secret door is an
   * indistinguishable wall for EVERYONE, managed in 2D). The stored/world viewer opts a GM in. */
  revealSecretDoors?: boolean
  viewerIsGm?: boolean
}

/** Extruded wall segments. door 0/1/2 = none/door/SECRET, ds 0/1/2 = closed/open/locked. A closed
 * SECRET door is drawn as an ordinary WALL for EVERYONE (players can't spot hidden passages; the GM by
 * request — secret doors are managed in the 2D view); it reads as a door only once OPENED. Window:
 * blocks movement, not sight. */
export function buildWallsJson(docs: ProducerWall[] | undefined, ctx: ProducerWallsCtx): ViewerWall[] {
  const out: ViewerWall[] = []
  for (const doc of docs || []) {
    try {
      if (!doc || !ctx.docInSlice(doc)) continue
      const c = doc.c
      if (!Array.isArray(c) || c.length < 4) continue
      const [x1, y1, x2, y2] = c
      const band = ctx.wallBand(doc)
      let wbottom = band.bottom
      let wtop = band.top
      if (ctx.ceilUnits != null && Number.isFinite(ctx.ceilUnits)) wtop = Math.min(wtop, ctx.ceilUnits)
      if (wtop - wbottom < 0.01) continue
      const len = Math.hypot(x2 - x1, y2 - y1)
      if (len < 1) continue
      const ds: ViewerDoorState = doc.ds === 1 ? 'open' : doc.ds === 2 ? 'locked' : 'closed'
      let kind: ViewerWallKind = 'wall'
      let doorState: ViewerDoorState | undefined
      if (doc.door === 1) {
        kind = 'door'
        doorState = ds
      } else if (doc.door === 2 && ctx.revealSecretDoors && ctx.viewerIsGm) {
        kind = 'secretDoor' // GM-only, opt-in (world viewer): the secret door is shown purple in every state
        doorState = ds
      } else if (doc.door === 2 && ds === 'open') {
        kind = 'door' // an opened secret door is revealed as an ordinary open door (players / plugin)
        doorState = 'open'
      } else if (doc.door !== 2 && (doc.move ?? 0) > 0 && (doc.sight === 0 || doc.sight === 30)) {
        kind = 'window'
      }
      const bottomPx = wbottom * ctx.pxPerUnit
      const topPx = wtop * ctx.pxPerUnit
      const wall: ViewerWall = { id: (doc.id ?? doc._id) as string, x1, y1, x2, y2, bottom: bottomPx, top: topPx, kind }
      if (kind === 'wall') wall.opacity = ctx.wallOpacity ?? 0.85 // door/window style opacity is the core's business
      if (doorState) wall.doorState = doorState
      wall.blocksSight = doorState !== 'open' && (doc.sight ?? 20) !== 0
      // Native restriction nodes (parity with scene-json.js; the current renderer ignores them): `dir`
      // one-sided (0 both/1 left/2 right); only light-blocking walls should cast shadows.
      wall.dir = doc.dir ?? 0
      wall.blocksLight = (doc.light ?? 20) !== 0
      // Base 3D texture: OUR OWN flag drives any segment; native `animation.texture` is a fallback; then
      // the scene/level 3D default (host-resolved). No texture → an optional flat color.
      const a = doc.animation || {}
      const cfg = cfgFlags(doc.flags)
      const dflt = ctx.wall3dDefaults ? ctx.wall3dDefaults(doc) || {} : {}
      const texSrc = (cfg.texture as string) || a.texture || dflt.texture
      if (texSrc) {
        const resolved = ctx.assetUrl(texSrc)
        if (resolved) wall.texture = resolved
        if ((cfg.flip as boolean) ?? a.flip) wall.flip = true
        const rawScale = (cfg.tileScale as number) || dflt.tileScale
        const scale = Number(rawScale) > 0 ? Number(rawScale) : 1
        const grid = ctx.gridSize || 100
        wall.tileX = +((len / grid) * scale).toFixed(3)
        wall.tileY = +(((topPx - bottomPx) / grid) * scale).toFixed(3)
      } else {
        const col = parseHexColor((cfg.color as string) || dflt.color, undefined)
        if (col != null) wall.color = col
      }
      if (kind === 'door') {
        if (a.double) wall.double = true
        if (a.direction != null) wall.swingDir = a.direction // -1 | 1
        if (a.type) wall.animType = a.type // 'swing' | 'slide' | …
      }
      const levelIds = levelMembership(doc.levels)
      if (levelIds) wall.levelIds = levelIds
      out.push(wall)
    } catch {
      /* skip a malformed wall */
    }
  }
  return out
}
