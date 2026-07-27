import type { ViewerLight, ViewerScene } from './core.js'
import { computeTokenVisibility } from './vision.js'
import {
  buildGridJson,
  buildLevelsJson,
  buildLightsJson,
  buildTokenJson,
  buildWallsJson,
  buildTilesJson,
  buildNotesJson,
  buildDrawingsJson,
  type ProducerDrawing,
  buildTemplatesJson,
  type ProducerTemplate,
  buildTerrainJson,
  capLights,
  cfgFlags,
  levelBase as sharedLevelBase,
  levelTop as sharedLevelTop,
  dispositionColor as sharedDispositionColor,
  type ProducerLevel,
  type ProducerTokenCtx,
} from './producer.js'

/**
 * adapter-foundry — convert a FoundryVTT Scene (doc or plain stored JSON) into the viewer core's
 * normalized scene JSON. PURE: no Foundry runtime, no three, no DOM. This is the STORED-documents
 * ctx-provider: it assembles a small, render-all context and delegates ALL shaping to the ONE shared
 * producer (./producer.ts) — the same builders the live Foundry plugin calls — so the platform scene
 * view and the plugin render the exact same doc through the exact same code.
 *
 * Live vs stored, expressed as ctx policy (NOT forked logic): the live plugin reads the runtime slice,
 * per-player placeable visibility, and canvas.environment colors; this adapter renders ALL levels
 * (renderAll — the host's own level picker slices client-side), gates visibility via stored `hidden` +
 * `viewerIsGm`, uses fallback ambient colors with its own tuned coefficients, and (GM only) reveals
 * secret doors. Terrain-ride (tokens/tiles following a heightmap) is deferred to the scene-view slice
 * (needs the core's terrain coordinate mapping to sample correctly) → terrainAt is null here for now.
 *
 * Foundry conventions handled: grid.size px/cell + grid.distance units/cell → pxPerUnit; scene.padding
 * → bounds.x/y; token x/y top-left px, width/height grid-units → px, elevation distance-units → px,
 * floor = Level base / flags.levels.rangeBottom / 0; wall band from flags["wall-height"] else the union
 * of the scene's Level bands. CFG flags read via the shared `playtable`→`crit-fumble-core` fallback.
 */

export interface FoundryTokenLike {
  id?: string
  _id?: string
  x?: number
  y?: number
  width?: number
  height?: number
  elevation?: number
  disposition?: number
  hidden?: boolean
  /** Whole-token opacity (Foundry `document.alpha`). Default 1. */
  alpha?: number
  /** Token facing in degrees (Foundry `rotation`). Emitted as 0 when `lockRotation`. */
  rotation?: number
  lockRotation?: boolean
  /** Vision (Foundry `sight`) — a source's line-of-sight config for the offline vision cull. */
  sight?: { enabled?: boolean; range?: number; angle?: number }
  /** Whether the token's actor has a player owner — drives the FRIENDLY→PARTY color split.
   * The offline snapshot rarely carries ownership, so this is optional; absent → FRIENDLY. */
  hasPlayerOwner?: boolean
  texture?: { src?: string | null; tint?: string | number; scaleX?: number; scaleY?: number; fit?: 'contain' | 'cover' | 'fill' | 'width' | 'height' }
  /** Dynamic Token Ring (Foundry `ring`). When enabled, the ring's subject texture replaces
   * the raw art and its own colors/subject-scale drive the base ring + portrait sizing. */
  ring?: {
    enabled?: boolean
    colors?: { ring?: string | number | null; background?: string | number | null }
    subject?: { texture?: string | null; scale?: number }
  }
  /** Level doc id this token belongs to (native v14 levels). */
  level?: string | null
  light?: { dim?: number; bright?: number; color?: string | number; luminosity?: number; alpha?: number }
  flags?: {
    'crit-fumble-core'?: { modelSrc?: string | null; model3d?: string | null; modelScale?: number; modelRotation?: number }
    levels?: { rangeBottom?: number }
  }
}

export interface FoundryWallLike {
  id?: string
  _id?: string
  c?: number[]
  /** CONST.WALL_DOOR_TYPES: 0 none, 1 door, 2 secret. */
  door?: number
  /** CONST.WALL_DOOR_STATES: 0 closed, 1 open, 2 locked. */
  ds?: number
  /** CONST.WALL_SENSE_TYPES: 0 none, 10 limited, 20 normal, 30 proximity, 40 distance. */
  sight?: number
  move?: number
  /** Native per-placeable Level membership (`document.levels`); empty = all levels. */
  levels?: string[]
  flags?: { 'wall-height'?: { bottom?: number; top?: number } }
}

export interface FoundryLevelLike {
  id?: string
  _id?: string
  name?: string | null
  sort?: number
  elevation?: { bottom?: number | null; top?: number | null }
  background?: { src?: string | null; alphaThreshold?: number; tint?: string | number }
  foreground?: { src?: string | null }
  textures?: { rotation?: number; offsetX?: number; offsetY?: number }
  /** Foundry `level.visibility.levels` — other Level ids visible (see-through) from this level. */
  visibility?: { levels?: string[] }
}

export interface FoundryLightLike {
  id?: string
  _id?: string
  x?: number
  y?: number
  elevation?: number
  hidden?: boolean
  /** Cone direction in document degrees (0 = canvas-south) — meaningful when config.angle < 360. */
  rotation?: number
  /** Native per-placeable Level membership (`document.levels`); empty = all levels. */
  levels?: string[]
  config?: { dim?: number; bright?: number; color?: string | number; luminosity?: number; angle?: number; alpha?: number }
}

export interface FoundryTileLike {
  id?: string
  _id?: string
  x?: number
  y?: number
  width?: number
  height?: number
  elevation?: number
  alpha?: number
  /** In-plane rotation in document degrees (clockwise on the canvas). */
  rotation?: number
  hidden?: boolean
  texture?: { src?: string | null }
  /** Native per-placeable Level membership (`document.levels`); empty = all levels. */
  levels?: string[]
  flags?: { levels?: { rangeBottom?: number } }
}

export interface FoundryNoteLike {
  id?: string
  _id?: string
  x?: number
  y?: number
  /** Pin elevation in grid units (Foundry `note.elevation`). */
  elevation?: number
  iconSize?: number
  texture?: { src?: string | null }
  /** Linked JournalEntry id (Foundry `note.entryId`) — the pin opens this entry. */
  entryId?: string
  /** Label text (Foundry `note.text`). */
  text?: string
  /** Native per-placeable Level membership (`document.levels`); empty = all levels. */
  levels?: string[]
}

export interface FoundrySceneLike {
  grid?: { size?: number; distance?: number; type?: number; color?: string | number; alpha?: number }
  width?: number
  height?: number
  padding?: number
  dimensions?: { width?: number; height?: number }
  backgroundColor?: string | number
  /** Scene-root background image. Foundry stores the primary map here; the native
   * levels model also surfaces it as the first Level's background. Used as the
   * fallback drape texture for heightmap terrain when no Level carries a background. */
  background?: { src?: string | null }
  environment?: { darknessLevel?: number; globalLight?: { enabled?: boolean } }
  /** Legacy (pre-v12) scene-level global illumination flag. */
  globalLight?: boolean | { enabled?: boolean }
  /** Foundry scene `tokenVision`. When false the scene imposes no sight limit (all visible). */
  tokenVision?: boolean
  /** CFG scene-scoped flags. `heightfield` is the sculpted continuous-terrain field
   * (cols×rows grid-UNIT heights, row-major) the plugin renders live via
   * flags['crit-fumble-core'].heightfield — mirrored here for the offline viewer. */
  flags?: { 'crit-fumble-core'?: { heightfield?: { cols?: number; rows?: number; heights?: number[] } } }
  tokens?: FoundryTokenLike[] | { contents: FoundryTokenLike[] }
  walls?: FoundryWallLike[] | { contents: FoundryWallLike[] }
  levels?: FoundryLevelLike[] | { contents: FoundryLevelLike[] }
  lights?: FoundryLightLike[] | { contents: FoundryLightLike[] }
  tiles?: FoundryTileLike[] | { contents: FoundryTileLike[] }
  notes?: FoundryNoteLike[] | { contents: FoundryNoteLike[] }
  drawings?: ProducerDrawing[] | { contents: ProducerDrawing[] }
  templates?: ProducerTemplate[] | { contents: ProducerTemplate[] }
}

export interface FoundrySceneToViewerOptions {
  /** Resolve a Foundry-relative asset path ("worlds/x/y.png") to a URL the viewing
   * host can load. Return null to drop the asset (color/plain fallbacks apply).
   * Absolute http(s)/data URLs are passed through without calling this. */
  resolveUrl?: (path: string) => string | null
  /** When false (a player is viewing), stored-`hidden` tokens/tiles/lights and
   * secret-disposition tokens are DROPPED from the payload — hidden GM content
   * must never reach a player's browser. Default true (unfiltered). */
  viewerIsGm?: boolean
  /** Wall translucency the host wants (the plugin uses 0.85). Default 1. */
  wallOpacity?: number
  /** Hard cap on point lights in the payload (biggest-radius first). A forward
   * renderer degrades fast — and can fail shader compilation outright — past a
   * few dozen lights; big dungeon scenes can carry hundreds. Default 24. */
  maxLights?: number
  /** How many of those lights get castShadow (each one is a whole shadow-map
   * pass per frame). Matches the Foundry plugin's budget. Default 4. */
  shadowBudget?: number
  /** Token ids that are the VIEWER's vision sources (their owned tokens in the scene). When
   * provided for a non-GM viewer, offline line-of-sight (vision.ts) runs and tokens NO source
   * can see are dropped from the payload — mirroring the live sight cull. Omit (or empty) to
   * skip culling (render every permission-visible token, e.g. for a GM or a lit/unlit scene).
   * The lighting rule still applies: an unlit or globally-lit scene shows everything. */
  visionSources?: string[]
}

export interface FoundrySceneConversion {
  scene: ViewerScene
  /** Display names for level pickers, elevation in px (sorted by elevation). `id` is the Foundry
   * Level-doc id (so the host slice can match placeables' `levelIds` by id); `visibleLevelIds` is the
   * level's authored see-through set (`level.visibility.levels`). Both omitted when absent. */
  levelNames: { name: string | null; elevation: number; id?: string; visibleLevelIds?: string[] }[]
}

/** Foundry disposition → token tint (the shared palette; offline can't read CONFIG so defaults apply).
 * Re-exported for back-compat with callers/tests that imported it from the adapter. */
export function dispositionColor(d: number | undefined, hasPlayerOwner = false): number {
  return sharedDispositionColor(d, hasPlayerOwner)
}

/** Parse a Foundry color ("#223044" or a number) to a numeric color, or null. */
function parseColor(c: unknown): number | null {
  if (typeof c === 'number') return c
  if (typeof c === 'string' && c[0] === '#') return parseInt(c.slice(1), 16)
  return null
}

/** Foundry texture.tint → a numeric tint, or undefined when white/absent (i.e. no tint). */
function tintOf(c: unknown): number | undefined {
  const n = parseColor(c)
  return n != null && n !== 0xffffff ? n : undefined
}

function toArray<T>(v: T[] | { contents: T[] } | undefined): T[] {
  if (Array.isArray(v)) return v
  return v?.contents || []
}

const num = (v: unknown, dflt = 0): number => (Number.isFinite(Number(v)) ? Number(v) : dflt)

/**
 * Convert a stored FoundryVTT Scene document to the viewer core's scene JSON plus
 * level-picker names. See FoundrySceneToViewerOptions for host hooks.
 */
export function foundrySceneToViewer(scene: FoundrySceneLike = {}, opts: FoundrySceneToViewerOptions = {}): ViewerScene {
  return convertFoundryScene(scene, opts).scene
}

export function convertFoundryScene(scene: FoundrySceneLike = {}, opts: FoundrySceneToViewerOptions = {}): FoundrySceneConversion {
  const isGm = opts.viewerIsGm !== false
  const resolveUrl = (src: string | null | undefined): string | null => {
    if (!src) return null
    if (/^(https?:|data:|blob:)/i.test(src)) return src
    return opts.resolveUrl ? opts.resolveUrl(src) : src
  }
  const assetUrl = (s: string): string | null => resolveUrl(s)

  const grid = scene.grid || {}
  const gridSize = num(grid.size, 100) || 100
  const distance = num(grid.distance, 5) || 5
  const pxPerUnit = gridSize / distance
  const width = num(scene.width ?? scene.dimensions?.width, 2000) || 2000
  const height = num(scene.height ?? scene.dimensions?.height, 2000) || 2000
  // Foundry pads the canvas around the playable rect; the rect origin is padding rounded UP to a whole
  // grid square (matches canvas.dimensions.sceneRect).
  const padding = Number.isFinite(Number(scene.padding)) ? Number(scene.padding) : 0.25
  const boundsX = Math.ceil((padding * width) / gridSize) * gridSize
  const boundsY = Math.ceil((padding * height) / gridSize) * gridSize

  const levelDocs = [...toArray(scene.levels)].sort((a, b) => num(a.sort) - num(b.sort)) as ProducerLevel[]
  const levelById = new Map<string, ProducerLevel>()
  for (const l of levelDocs) {
    const id = (l.id ?? l._id) as string | undefined
    if (id) levelById.set(id, l)
  }

  // ── Levels (render-all; the host's level picker slices client-side) ──
  // A roof/foreground on an OPEN-TOP (null/absent top) band would land at Infinity px here (this ctx's
  // levelElevPx = levelTop·pxPerUnit); drop those quads. The live plugin's own levelElevPx clamps, so
  // the guard is adapter-specific and lives here, not in the shared builder.
  const levels = buildLevelsJson(levelDocs, {
    levelElevPx: (l, which) => (which === 'bottom' ? sharedLevelBase(l) : sharedLevelTop(l)) * pxPerUnit,
    assetUrl,
    sliceCut: () => Number.POSITIVE_INFINITY,
    levelBase: sharedLevelBase,
    activeLevel: () => null,
    userCanSeeLevel: () => true,
    backgroundSrc: () => scene.background?.src ?? null,
    renderAll: true,
  }).filter((q) => Number.isFinite(q.elevation))

  // ── Ambient + lights (fallback env colors + the adapter's tuned dimmer coefficients) ──
  const darkness = Math.max(0, Math.min(1, num(scene.environment?.darknessLevel)))
  const gl = scene.environment?.globalLight ?? scene.globalLight
  const globalLightOn = typeof gl === 'object' && gl !== null ? gl.enabled === true : gl === true
  const allTokens = toArray(scene.tokens)
  const { ambient, lights: rawLights } = buildLightsJson(toArray(scene.lights), allTokens as never, {
    env: { daylight: 0xeeeeee, darkCol: 0x303030, brightest: 0xffffff, darkness, globalLightOn },
    size: gridSize,
    shadows: true,
    pxPerUnit,
    // Drop hidden lights + hidden token lights, and (for non-GM) secret token lights (position leak).
    docInSlice: (d) => !d.hidden && (isGm || d.disposition !== -2),
    tokenSizePx: (t) => ({ w: (num(t.width) || 1) * gridSize, h: (num(t.height) || 1) * gridSize }),
    ambientCoeffs: { hemiBase: 0.1, hemiLit: 0.6, sunBase: 0.35, sunLit: 0.7 },
  })
  const lights = capLights(rawLights as ViewerLight[], { maxLights: opts.maxLights ?? 24, shadowBudget: opts.shadowBudget ?? 4 })

  // ── Tokens (per-token stored ctx → shared buildTokenJson) ──
  const tokenFloorUnits = (t: FoundryTokenLike): number => {
    if (t.level && levelById.has(t.level)) return sharedLevelBase(levelById.get(t.level))
    const rb = t.flags?.levels?.rangeBottom
    if (Number.isFinite(Number(rb))) return Number(rb)
    return 0
  }
  const tokens = []
  for (const t of allTokens) {
    if (!isGm && (t.hidden || t.disposition === -2)) continue // hidden/secret never reach players
    const tokenCtx: ProducerTokenCtx = {
      pxPerUnit,
      sizePx: { w: (num(t.width) || 1) * gridSize, h: (num(t.height) || 1) * gridSize },
      floorElevation: tokenFloorUnits(t) * pxPerUnit,
      groundOffsetUnits: 0, // terrain-ride deferred to the scene-view slice
      assetUrl,
      dispositionColors: undefined, // offline → default palette
      hasPlayerOwner: t.hasPlayerOwner,
      isSecretFromViewer: false, // secret+non-GM tokens are dropped above; a GM observes all
      tint: tintOf(t.texture?.tint),
      // Whole-token opacity: doc.alpha, dimmed for a hidden token (GM-only — non-GM hidden dropped above).
      alpha: t.hidden ? 0.5 : Number.isFinite(Number(t.alpha)) ? Number(t.alpha) : 1,
      textureScaleX: Number.isFinite(Number(t.texture?.scaleX)) ? Number(t.texture?.scaleX) : undefined,
      textureScaleY: Number.isFinite(Number(t.texture?.scaleY)) ? Number(t.texture?.scaleY) : undefined,
    }
    tokens.push(buildTokenJson(t, tokenCtx))
  }

  // ── Walls (band = wall-height flag else the union of the scene's Level bands; GM sees secret doors) ──
  const unionBottom = levelDocs.length ? Math.min(...levelDocs.map(sharedLevelBase)) : 0
  let unionTop = (gridSize * 2) / pxPerUnit
  if (levelDocs.length) {
    const tops = levelDocs.map(sharedLevelTop).filter((v) => Number.isFinite(v))
    unionTop = tops.length ? Math.max(...tops) : unionBottom + (gridSize * 2) / pxPerUnit
  }
  const wallBand = (w: FoundryWallLike): { bottom: number; top: number } => {
    const wh = w.flags?.['wall-height'] || {}
    const hasFlag = Number.isFinite(wh.bottom) || Number.isFinite(wh.top)
    const bottom = hasFlag ? (Number.isFinite(wh.bottom) ? (wh.bottom as number) : 0) : unionBottom
    const top = hasFlag ? (Number.isFinite(wh.top) ? (wh.top as number) : bottom + (gridSize * 2) / pxPerUnit) : unionTop
    return { bottom, top }
  }
  const walls = buildWallsJson(toArray(scene.walls), {
    pxPerUnit,
    gridSize,
    ceilUnits: null, // render-all: no cutaway
    docInSlice: () => true,
    wallBand,
    assetUrl,
    wallOpacity: opts.wallOpacity ?? 1,
    revealSecretDoors: true, // the world/scene viewer shows a GM their secret doors
    viewerIsGm: isGm,
  })

  // ── Tiles + notes ──
  const tiles = buildTilesJson(toArray(scene.tiles), { pxPerUnit, docInSlice: () => true, assetUrl, terrainAt: null })
  const notes = buildNotesJson(toArray(scene.notes), assetUrl, { pxPerUnit })
  // Drawings (annotations): strip GM-hidden ones for players (position/text leak).
  const drawings = buildDrawingsJson(toArray(scene.drawings) as ProducerDrawing[], { docInSlice: (d) => isGm || !d.hidden })
  // Measured templates (AoE): distance in grid units → px; strip GM-hidden for players.
  const templates = buildTemplatesJson(toArray(scene.templates) as ProducerTemplate[], { pxPerUnit, docInSlice: (d) => isGm || !d.hidden })

  // ── Continuous heightmap terrain (CFG flag, playtable→crit-fumble-core fallback) ──
  const heightfield = cfgFlags(scene.flags as Record<string, unknown> | undefined).heightfield as { cols?: number; rows?: number; heights?: unknown[] } | undefined
  // Drape the same map the flat floor uses: first Level background, else scene-root.
  let mapSrc: string | undefined
  for (const l of levelDocs) {
    const s = resolveUrl(l.background?.src)
    if (s) {
      mapSrc = s
      break
    }
  }
  if (!mapSrc) mapSrc = resolveUrl(scene.background?.src) ?? undefined
  const terrain = buildTerrainJson(heightfield ?? null, { pxPerUnit, src: mapSrc }) ?? undefined

  const background: { color?: number } = {}
  const bg = parseColor(scene.backgroundColor)
  if (bg != null) background.color = bg

  // ── Offline line-of-sight cull (unchanged): when the host passed the viewer's vision-source token
  // ids and the viewer is not a GM, drop tokens no source can see (vision.ts enforces the lighting rule).
  let visibleTokens = tokens
  const visionSources = opts.visionSources || []
  if (!isGm && visionSources.length) {
    const idSet = new Set(visionSources)
    const sources = allTokens
      .filter((t) => idSet.has((t.id ?? t._id) as string))
      .map((t) => {
        const tw = (num(t.width) || 1) * gridSize
        const th = (num(t.height) || 1) * gridSize
        const rangeU = t.sight?.enabled === false ? 0 : num(t.sight?.range)
        return { id: (t.id ?? t._id) as string, x: num(t.x) + tw / 2, y: num(t.y) + th / 2, range: rangeU * pxPerUnit }
      })
    const visMap = computeTokenVisibility({
      tokens: tokens.map((t) => ({ id: t.id, x: (t.x ?? 0) + (t.width ?? 0) / 2, y: (t.y ?? 0) + (t.height ?? 0) / 2 })),
      sources,
      walls: walls.map((w) => ({ x1: w.x1 ?? 0, y1: w.y1 ?? 0, x2: w.x2 ?? 0, y2: w.y2 ?? 0, blocksSight: w.blocksSight })),
      // The cull must see ALL lights (uncapped) — the maxLights cap is a RENDER-payload budget, not a
      // visibility input. Feeding the capped set would drop fog-of-war (maxLights:0 → empty → cull skipped)
      // and wrongly hide a token lit only by a capped-out light. `rawLights` already excludes hidden/secret.
      lights: rawLights.map((l) => ({ x: l.x ?? 0, y: l.y ?? 0, radius: l.radius ?? 0 })),
      gm: isGm,
      tokenVision: scene.tokenVision,
      globalLight: globalLightOn,
    })
    visibleTokens = tokens.filter((t) => visMap.get(t.id) !== false)
  }

  const viewerScene: ViewerScene = {
    grid: buildGridJson(grid, gridSize),
    bounds: { width, height, x: boundsX, y: boundsY },
    background,
    levels,
    ambient,
    lights,
    tokens: visibleTokens,
    walls,
    tiles,
    notes,
    drawings,
    templates,
    // undefined when there's no (valid) heightfield → core falls back to the flat floor.
    terrain,
  }

  const levelNames = levelDocs
    .map((l) => {
      const entry: FoundrySceneConversion['levelNames'][number] = { name: l.name ?? null, elevation: sharedLevelBase(l) * pxPerUnit }
      const id = l.id ?? l._id
      if (id) entry.id = id
      const seeThrough = (l.visibility?.levels ?? []).filter((v): v is string => typeof v === 'string' && v.length > 0)
      if (seeThrough.length) entry.visibleLevelIds = seeThrough
      return entry
    })
    .sort((a, b) => a.elevation - b.elevation)

  return { scene: viewerScene, levelNames }
}
