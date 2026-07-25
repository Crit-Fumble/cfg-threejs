import type * as ThreeNS from 'three'
import {
  QUALITY_PRESETS,
  detectTier,
  lightBudgetFromUniforms,
  minTier,
  selectLights,
  createGovernor,
  type QualityTier,
} from './quality.js'

/**
 * @crit-fumble/shared vtt-viewer core — a framework-agnostic three.js scene renderer.
 *
 * ZERO Foundry / React / Next / Discord imports. `THREE` is INJECTED by the host so
 * the same core mounts into the Foundry plugin (its bundled three), the core web app /
 * PlayTable (vendored three), a bare iframe, or a Discord Activity — one renderer, a
 * thin per-surface data adapter that produces the normalized scene JSON below.
 *
 * The core only ever receives fully-resolved primitives (absolute texture URLs, px
 * positions, radians, resolved colors) — host-specific resolution (Foundry asset
 * routing, Level-band math, wall-height flags, per-player visibility) stays in the
 * adapter/host, never here.
 *
 * Scene JSON (all coordinates in PIXELS; an adapter converts grid-units → px):
 *   {
 *     grid?:    { size:number, showHelper?:boolean, color?:number, opacity?:number },
 *     bounds?:  { width:number, height:number, x?:number, y?:number },
 *     background?: { color?:number },
 *     levels?:  [{ elevation, which:'bottom'|'top', src, alphaTest?, tint?, rotation?, offsetX?, offsetY? }],
 *     ambient?: { hemisphere?:{sky,ground,intensity}, sun?:{color,intensity,castShadow?} },
 *     lights?:  [{ x, y, elevation?, color?, radius?, intensity?, castShadow? }],
 *     tokens:   [{ id, x, y, width, height, elevation?, color?, texture?, model?, modelScale?,
 *                  modelRotation?, floorElevation?, ring? }],
 *     walls?:   [{ id, x1, y1, x2, y2, bottom, top, color? }],
 *     notes?:   [{ x, y, size?, texture? }],
 *     tiles?:   [{ x, y, width, height, elevation?, texture?, alpha?, color? }],
 *   }
 * World mapping: scene x → world x, scene y → world z, elevation → world y (up).
 * A `levels` entry present (non-empty) replaces the single flat ground plane — the
 * host is responsible for deciding when its floor is degenerate/blank-slate.
 * `bounds.x`/`.y` (default 0) offset where ground/levels/grid are centered — for a
 * host whose playable rect isn't anchored at world origin (e.g. Foundry's inner
 * scene rect within a padded canvas). Tokens/walls/notes/tiles are always placed
 * at their own absolute x/y regardless of `bounds` — only ground/levels/grid need it.
 */

export interface ViewerToken {
  id: string
  x?: number
  y?: number
  width?: number
  height?: number
  elevation?: number
  color?: number
  texture?: string | null
  /** GLTF/GLB URL — when set, loaded async and swapped in over the billboard fallback. */
  model?: string | null
  modelScale?: number
  /** Yaw in degrees about the up axis. */
  modelRotation?: number
  /** The token's floor (px); a flight-stand stalk + base ring render when this
   * differs from `elevation`. Defaults to `elevation` (no stalk). */
  floorElevation?: number
  /** Multiplicative art tint (Foundry `texture.tint`). Default 0xffffff (no tint). Multiplies
   * the texture like PIXI's sprite tint — used for ghost/clone/injured recolours. */
  tint?: number
  /** Whole-token opacity (Foundry `document.alpha`, and the GM's hidden-token dim). Default 1.
   * < 1 renders the body translucent (blended, no depth-write, drawn after walls) at creation
   * time — robust to async art load, unlike a post-hoc material mutation. */
  alpha?: number
  /** Art scale multipliers (Foundry `texture.scaleX/scaleY`). Default 1. A NEGATIVE scaleX
   * mirrors the art horizontally (which way a creature faces); |scaleY| is used (a standing
   * billboard is never flipped upside-down). Applied on top of the footprint sizing. */
  textureScaleX?: number
  textureScaleY?: number
  /** Dynamic-ring subject scale (Foundry `ring.subject.scale`). Default 1. Multiplies the art
   * so a portrait fills its ring consistently — applied ON TOP of textureScaleX/Y. */
  artScale?: number
  /** Token facing in degrees (Foundry `rotation`, or 0 when `lockRotation`). Applied to the 2D
   * top-down art quad (spun in the ground plane) and to a GLB model's yaw — NEVER the
   * camera-facing 3D billboard. Also seeds the character-camera azimuth. Default 0. */
  rotation?: number
  /** How the art fills its cell (Foundry `texture.fit`): 'contain' preserves aspect within the
   * cell (letterbox), 'cover' preserves aspect and crops, 'fill' stretches, 'width'/'height' fit
   * one axis. Undefined → 'fill' (the historical footprint-stretch, kept for back-compat; the
   * producers emit Foundry's 'contain' default). Needs the texture's natural size, so it applies
   * once the art loads. */
  fit?: 'contain' | 'cover' | 'fill' | 'width' | 'height'
  /** Disposition-tinted base ring on the floor. Default true. */
  ring?: boolean
  /** Base-ring colour override (Foundry Dynamic Ring `ring.colors.ring`). Default: `color`. */
  ringColor?: number
  /** Dynamic-ring background disc colour (`ring.colors.background`). When set, a filled disc is
   * drawn behind the token (the ring's backdrop). Omit for none. */
  ringBackground?: number
  /** Selected/controlled by the viewer → a bright highlight ring at the floor. */
  selected?: boolean
  /** Targeted by the viewer (attack/spell/etc.) → a coloured reticle halo above the token. */
  targeted?: boolean
  /** Reticle colour for `targeted` (e.g. the targeting user's colour). Default red. */
  targetColor?: number
  /** The native Foundry Level-doc id this token is on (`token.level`). Lets the host slice keep the
   * token on its own level (and see-through levels) by id; falls back to `floorElevation` band when
   * absent. Omitted when the token carries no explicit level. */
  levelId?: string
  /** Whether the VIEWER may take control of this token (i.e. look through it in Character view). The
   * server sets `false` on tokens a non-GM player does NOT own (Foundry control permission); left
   * undefined for a GM or when no ownership gate applies → the host treats undefined as controllable.
   * A host restricting Character view to owned tokens must reject a subject whose `controllable === false`. */
  controllable?: boolean
  /** Resource pools shown as bars UNDER the token (Foundry `bar1`/`bar2` → the linked actor's
   * attribute, e.g. HP). The host resolves the live values from the linked sheet; the viewer just
   * draws them. Rendered in the 2D map view (Foundry-canvas parity). Empty/absent → no bars. */
  bars?: ViewerTokenBar[]
}
export interface ViewerTokenBar {
  value: number
  max: number
  /** Bar fill colour (0xRRGGBB). Default derives from value/max (green→amber→red). */
  color?: number
}

/** How a wall segment renders. 'door' = visible door panel (wood, handle knob,
 * lock block when locked, swings ajar when open). 'secretDoor' = same panel in
 * the secret purple — the ADAPTER must only emit this for GM viewers (players
 * receive a plain 'wall' until the GM reveals/opens it). 'window' = translucent
 * glass. Default 'wall'. */
export type ViewerWallKind = 'wall' | 'door' | 'secretDoor' | 'window'
export type ViewerDoorState = 'closed' | 'open' | 'locked'

export interface ViewerWall {
  id?: string
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  bottom?: number
  top?: number
  color?: number
  /** Default 1 (opaque). A host may want walls slightly translucent (e.g. 0.85).
   * Ignored for windows (glass opacity) and door panels (always opaque). */
  opacity?: number
  kind?: ViewerWallKind
  /** Doors/secret doors only. Default 'closed'. */
  doorState?: ViewerDoorState
  /** Optional bitmap texture (Foundry's native `animation.texture`, present on every
   * wall). A textured segment renders as a flat, unlit vertical quad with this map
   * instead of the instanced coloured box — "flat walls with bitmap textures". */
  texture?: string
  /** Mirror the wall texture horizontally. */
  flip?: boolean
  /** Texture tile counts (UV repeats) across the segment length/height. Default 1 (no tiling). */
  tileX?: number
  tileY?: number
  /** Whether this segment blocks SIGHT (Foundry `wall.sight !== 0`). Default true. Consumed by
   * the offline vision computation (vision.ts) for line-of-sight; does NOT affect rendering. */
  blocksSight?: boolean
  /** Native Foundry wall restriction/animation nodes carried by the producer for parity + potential
   * future render use; the CURRENT flat-wall renderer does not consume them (kept so the two producers
   * emit byte-identical output). `dir` = one-sided (0 both/1 left/2 right); `blocksLight` gates shadow
   * casting semantics; `double`/`swingDir`/`animType` describe door-swing animation. */
  dir?: number
  blocksLight?: boolean
  double?: boolean
  swingDir?: number
  animType?: string
  /** Native Foundry Level-doc ids this placeable is explicitly restricted to (`document.levels`).
   * Empty/absent = belongs to ALL levels (governed by geometry/elevation instead) — omitted from the
   * payload so the common case stays byte-identical. The host-side level slice
   * (`filterSceneToLevel`) keeps a level-restricted placeable on exactly its member levels. */
  levelIds?: string[]
}

export interface ViewerLevel {
  /** The Foundry Level-doc id this background quad belongs to (native `_id`). Lets the host slice
   * match placeables' `levelIds` to the active level by id, not just by elevation band. */
  id?: string
  elevation?: number
  which?: 'bottom' | 'top'
  src: string
  alphaTest?: number
  tint?: number
  rotation?: number
  offsetX?: number
  offsetY?: number
  /** Foundry `level.visibility.levels` — other Level-doc ids this level authorizes SEE-THROUGH to.
   * The host slice reveals those levels' placeables too when this level is active. */
  visibleLevelIds?: string[]
}

export interface ViewerLight {
  id?: string
  x?: number
  y?: number
  elevation?: number
  color?: number
  radius?: number
  intensity?: number
  castShadow?: boolean
  /** Shadow-camera near plane (world px). Default 1; a host may want it proportional
   * to its own grid scale (e.g. gridSizePx * 0.2) to reduce shadow acne. */
  shadowNear?: number
  /** Shadow normal-bias (world px), reduces peter-panning on textured surfaces. */
  shadowNormalBias?: number
  /** Native Foundry Level-doc ids this light is restricted to (see `ViewerWall.levelIds`). */
  levelIds?: string[]
}

export interface ViewerAmbient {
  hemisphere?: { sky?: number; ground?: number; intensity?: number }
  sun?: { color?: number; intensity?: number; castShadow?: boolean; shadowNormalBias?: number }
  /** Unlit brightness (0..1) the floor map is drawn at in 3D — the host's effective scene
   * brightness (global-light + darkness), so the map matches Foundry's own canvas. */
  floorBrightness?: number
}

export interface ViewerNote {
  id?: string
  x?: number
  y?: number
  size?: number
  texture?: string | null
  /** The linked JournalEntry id (Foundry `note.entryId`). Clicking the pin opens this entry; the host
   * reads it off the picked sprite's `userData.entryId`. Absent for a bare label note. */
  entryId?: string
  /** A short label shown under the pin (Foundry `note.text`, usually the entry title). */
  text?: string
  /** Native Foundry Level-doc ids this note is restricted to (see `ViewerWall.levelIds`). */
  levelIds?: string[]
}

export interface ViewerTile {
  id?: string
  x?: number
  y?: number
  width?: number
  height?: number
  elevation?: number
  texture?: string | null
  alpha?: number
  color?: number
  /** Native Foundry Level-doc ids this tile is restricted to (see `ViewerWall.levelIds`). */
  levelIds?: string[]
}

/**
 * A native Foundry Region rendered as flat-topped terrain: a horizontal fill at its
 * standable surface height, plus a vertical skirt down (or up) to a reference floor — a
 * low-poly "papercraft" tier. Geometry comes straight from Foundry's own resolved region
 * data (triangulation for the fill, polygon rings for the skirt), so nothing is
 * re-triangulated here.
 */
export interface ViewerRegion {
  id?: string
  /** Standable surface height in px (world Y). */
  elevation: number
  /** Reference floor the skirt drops/rises to (px); default 0 (scene floor / sea level). */
  base?: number
  /** Foundry's footprint triangulation: flat [x0,y0,x1,y1,…] canvas px + triangle indices. */
  vertices: number[]
  indices: number[]
  /** Boundary loops [x0,y0,…] (outer + holes) for the vertical skirt. */
  rings?: number[][]
  /** Scene map texture to drape over the raised top (the lifted island content); else a flat colour. */
  src?: string
  color?: number
  opacity?: number
}

/**
 * A continuous low-poly terrain surface: a subdivided plane over the scene bounds whose
 * vertices are displaced by a per-cell height field (a heightmap). The scene's map texture
 * drapes over it and relief shading is baked into vertex colours so it stays unlit
 * (papercraft) yet slopes still read. `heights` is row-major, length cols*rows, in world px.
 */
export interface ViewerTerrain {
  cols: number
  rows: number
  heights: number[]
  src?: string
  color?: number
}

export interface ViewerScene {
  grid?: { size?: number; showHelper?: boolean; color?: number; opacity?: number; distance?: number; units?: string }
  bounds?: { width: number; height: number; x?: number; y?: number }
  background?: { color?: number }
  terrain?: ViewerTerrain
  levels?: ViewerLevel[]
  ambient?: ViewerAmbient
  lights?: ViewerLight[]
  tokens?: ViewerToken[]
  walls?: ViewerWall[]
  notes?: ViewerNote[]
  tiles?: ViewerTile[]
  regions?: ViewerRegion[]
  drawings?: ViewerDrawing[]
  templates?: ViewerTemplate[]
}
/** A FoundryVTT MeasuredTemplate (AoE) resolved for the map render — all lengths already in scene px.
 * `x`/`y` is the origin: the CENTRE for a circle, the APEX for a cone, the START for a ray/rect. */
export interface ViewerTemplate {
  id: string
  type: 'circle' | 'cone' | 'ray' | 'rect'
  x: number
  y: number
  /** circle: radius (px). cone/ray: length (px). rect: the diagonal length (px). */
  size: number
  /** degrees (0 = +x, screen-down = +90) — cone/ray/rect facing. */
  direction?: number
  /** cone spread in degrees (Foundry default 53). */
  angle?: number
  /** ray width (px). */
  width?: number
  fillColor?: number
  fillAlpha?: number
  borderColor?: number
}
/** A FoundryVTT Drawing (annotation) resolved for the map render: a stroked shape on the ground plane
 * — freehand/polygon (`points`), rectangle, or ellipse (`width`/`height`), plus an optional text label. */
export interface ViewerDrawing {
  id: string
  /** Shape origin (top-left / points-relative) in scene px. */
  x?: number
  y?: number
  type: 'polygon' | 'rect' | 'ellipse'
  /** rect/ellipse footprint (scene px). */
  width?: number
  height?: number
  /** polygon/freehand vertices RELATIVE to (x,y): [x0,y0,x1,y1,…] in scene px. */
  points?: number[]
  /** rotation about the shape's bounds centre, in degrees. */
  rotation?: number
  strokeColor?: number
  strokeAlpha?: number
  /** Stroke thickness in WORLD units (scene px), Foundry-parity — scales with zoom. Absent → 8. */
  strokeWidth?: number
  fillColor?: number
  fillAlpha?: number
  /** Optional text label drawn at the shape origin. */
  text?: string
  fontSize?: number
  textColor?: number
}

export interface ViewerTokenDelta extends ViewerToken {
  remove?: boolean
}

export interface ViewerDelta {
  tokens?: ViewerTokenDelta[]
}

export interface SceneGraphToken {
  id: string
  pos: [number, number, number]
}

export interface SceneGraphWall {
  pos: [number, number, number]
  height: number
  kind: ViewerWallKind
  doorState?: ViewerDoorState
}

export interface SceneGraph {
  mode: '2d' | '3d'
  tokenCount: number
  wallCount: number
  hasGround: boolean
  /** True when continuous heightmap terrain replaced the flat map floor (3D only). */
  hasTerrain: boolean
  levelCount: number
  lightCount: number
  noteCount: number
  tileCount: number
  hasGrid: boolean
  tokens: SceneGraphToken[]
  walls: SceneGraphWall[]
}

/**
 * '3d' (default) — the full lit scene: extruded walls, billboard/GLB token bodies,
 * flight stands, lights + shadows, perspective camera.
 * '2d' — a flat, UNLIT, Foundry-canvas-style render: level maps, grid, tiles, note
 * pins, flat token ART quads + disposition rings, thin flat wall strips. No lights,
 * no shadow maps, no billboards, no flight stands, and — critically — 3D model assets
 * (GLB) are NEVER fetched. Draws with a straight-down orthographic camera.
 */
export type ViewerMode = '2d' | '3d'

export interface CreateViewerOptions {
  element: HTMLElement
  THREE: typeof ThreeNS
  width?: number
  height?: number
  /** GLTFLoader constructor (three/examples/jsm) — only needed if tokens use `model`. */
  GLTFLoader?: new () => {
    load(url: string, onLoad: (gltf: { scene?: ThreeNS.Object3D; scenes?: ThreeNS.Object3D[] }) => void, onProgress?: unknown, onError?: (err: unknown) => void): void
  }
  powerPreference?: 'high-performance' | 'low-power' | 'default'
  /** Try a hardware context first, throwing (and falling back to software) on a major
   * performance caveat. Default true; set false to always accept whatever's available. */
  failIfMajorPerformanceCaveat?: boolean
  /** Enable shadow maps + shadow-casting lights. Default false (cheaper, safer default
   * for a generic embed); the Foundry plugin opts in. Ignored in 2D mode (unlit). */
  shadows?: boolean
  /** Initial render mode. Default '3d'. See ViewerMode. */
  mode?: ViewerMode
  /** Adaptive render quality (#166). 'auto' (default) picks a tier from the GPU +
   * device signals — Steam Deck / integrated / software step down; a thin
   * fragment-uniform budget hard-caps the light count so the shader still
   * COMPILES. Pin a tier ('high'|'medium'|'low'|'potato') to override. Controls
   * pixel-ratio cap, MSAA, shadows, light budget, texture size, and enables the
   * runtime frame-budget governor. Ignored in 2D mode. */
  quality?: QualityTier | 'auto'
  /** Cap the render rate to N fps (#166). Throttles render() AND retargets the
   * frame governor to that budget, so a steady low cap (e.g. 15) trades motion
   * smoothness for much lower GPU/battery load — "fast at 15fps beats laggy at
   * 60fps". null/undefined = uncapped (governor targets ~30fps). Runtime-settable
   * via setFpsCap(). */
  fpsCap?: number | null
}

/** GPU-resource accounting — cache sizes plus the renderer's own live counts.
 * `gpu*` come from renderer.info.memory: what is ACTUALLY resident on the GPU,
 * the ground truth that the collector exists to keep bounded. */
export interface ViewerMemoryStats {
  texturesCached: number
  texturesLoading: number
  modelsCached: number
  modelsLoading: number
  pooledGeometries: number
  gpuTextures: number
  gpuGeometries: number
  /** What the most recent sweep reclaimed, and the generation it ran in. */
  lastGC: { textures: number; models: number; generation: number }
}

export interface Viewer {
  loadScene(json: ViewerScene): void
  applyDelta(delta: ViewerDelta): void
  getSceneGraph(): SceneGraph
  resize(nw?: number, nh?: number): void
  render(): void
  dispose(): void
  /** Switch between the flat 2D and full 3D renders — rebuilds the last-loaded scene.
   * A session that never enters '3d' never fetches GLB models. */
  setMode(mode: ViewerMode): void
  /** STRICTLY sweep cached GPU resources (textures, GLB prototypes) not used by
   * the current scene. A gentler sweep (one-generation grace window, so slice
   * reloads and mode flips don't thrash) runs automatically after every
   * loadScene; call this for a host's explicit "free everything not on screen
   * right now". Returns what was freed. */
  gc(): { textures: number; models: number }
  getMemoryStats(): ViewerMemoryStats
  /** Current adaptive-quality snapshot (#166): resolved tier + live governor state. */
  getQuality(): { tier: QualityTier; renderScale: number; shadows: boolean; maxLights: number; antialias: boolean; fpsCap: number | null }
  /** Pin a quality tier at runtime (host "Performance" setting). */
  setQuality(tier: QualityTier): void
  /** Cap the render rate to N fps, or null to uncap (host "Frame rate cap" setting). (#166) */
  setFpsCap(fps: number | null): void
  /** Raycast a screen point onto the terrain → normalized field (u,v) ∈ [0,1], for the sculpt brush. */
  raycastTerrain(clientX: number, clientY: number): { u: number; v: number } | null
  /** Re-displace the terrain mesh from a new (px) height field in place — live sculpting, no rebuild. */
  updateTerrainHeights(newHeights: number[]): void
  /** The terrain's CURRENT displayed heights (px), including live un-committed sculpt strokes — so a
   *  new stroke rebases on what's on screen, not a stale scene prop. Null when there's no terrain. */
  getTerrainHeights(): number[] | null
  /** Show/hide a brush-size ring on the terrain under the cursor (sculpt affordance). */
  showBrushCursor(clientX: number, clientY: number, radiusFrac: number, shape?: 'circle' | 'square', snapWorld?: number): void
  hideBrushCursor(): void
  /** Level-Stamp reticle: footprint tile at an explicit world XZ + target height (grid px).
   *  `placed` switches ethereal-cyan (moving, no terrain change) → green (stamped down). */
  showReticle(worldX: number, worldZ: number, radiusFrac: number, shape: 'circle' | 'square', worldY: number, placed?: boolean): void
  hideReticle(): void
  /** World XZ of a heightfield cell centre (for placing the reticle from cell indices). Null if no terrain. */
  terrainCellToWorld(i: number, j: number): { x: number; z: number } | null
  /** The loaded scene's grid cell size in world px (for camera framing that needs px/cell —
   * e.g. the character-view eye height). Falls back to 100 when no scene is loaded. */
  getGridSize(): number
  /** Show/hide ALL map-note pins at once (a host "Show/Hide map pins" toggle). Cheap: flips each
   * pin sprite's `.visible` without touching geometry. Re-applied to pins added by a later loadScene. */
  setNotesVisible(visible: boolean): void
  scene: ThreeNS.Scene
  camera: ThreeNS.PerspectiveCamera
  /** The straight-down orthographic camera 2D mode draws with (framed on `bounds`). */
  camera2d: ThreeNS.OrthographicCamera
  renderer: ThreeNS.WebGLRenderer
  /** tokenId → THREE.Group, exposed for host-side 3D picking (raycast against `.values()`). */
  tokens: Map<string, ThreeNS.Group>
  /** Map-note pin sprites, exposed for host-side click-to-open: raycast these and read the hit
   * sprite's `userData.entryId` (the linked JournalEntry) / `userData.text`. */
  notes: ThreeNS.Sprite[]
  /** Drawing groups (freehand/rect/ellipse), exposed for host-side picking: raycast RECURSIVELY
   * (intersectObjects(drawings, true), with a Line threshold for thin outlines) and read the hit
   * object's `userData.drawingId`. */
  drawings: ThreeNS.Group[]
  /** Highlight one drawing (by id) as selected — brightens its outline; null clears all. */
  setDrawingHighlight(id: string | null): void
  /** MeasuredTemplate groups (circle/cone/ray/rect), exposed for host-side picking (recursive raycast,
   * read the hit object's `userData.templateId`). */
  templates: ThreeNS.Group[]
}

// 2D-mode paint order (world-Y of flat content; the ortho camera looks straight down,
// so Y only decides what draws over what): floor 0 < grid 0.5 < walls < tokens.
// Overhead tiles keep their real elevation so roofs still cover tokens, like Foundry.
const WALL_2D_Y = 1
const TOKEN_2D_Y = 2

/** Try a hardware WebGL context first (so a real GPU is preferred); fall back to software. */
function createRenderer(THREE: typeof ThreeNS, powerPreference: 'high-performance' | 'low-power' | 'default', failIfMajorPerformanceCaveat: boolean, antialias: boolean): ThreeNS.WebGLRenderer {
  // logarithmicDepthBuffer: hosts run an extreme camera range (near 1, far up to
  // 5e6 for big scenes). A linear depth buffer has almost no precision out there,
  // so thin walls z-fight/flicker. The log buffer spreads precision across the
  // whole range and kills the shimmer. (#166)
  const opts = { antialias, alpha: true, powerPreference, logarithmicDepthBuffer: true }
  if (powerPreference !== 'low-power' && failIfMajorPerformanceCaveat) {
    try {
      return new THREE.WebGLRenderer({ ...opts, failIfMajorPerformanceCaveat: true })
    } catch {
      /* no hardware GPU — fall through to a plain context */
    }
  }
  return new THREE.WebGLRenderer(opts)
}

/**
 * API: createViewer({ element, THREE, width?, height?, GLTFLoader?, powerPreference?,
 *   failIfMajorPerformanceCaveat?, shadows?, mode? }) →
 *   { loadScene(json), applyDelta(delta), getSceneGraph(), resize(w,h), render(),
 *     setMode('2d'|'3d'), dispose(), scene, camera, camera2d, renderer, tokens }
 */
export function createViewer({
  element,
  THREE,
  width,
  height,
  GLTFLoader,
  powerPreference = 'high-performance',
  failIfMajorPerformanceCaveat = true,
  shadows,
  mode: initialMode = '3d',
  quality = 'auto',
  fpsCap: initialFpsCap = null,
}: CreateViewerOptions): Viewer {
  if (!element) throw new Error('createViewer: `element` is required')
  if (!THREE) throw new Error('createViewer: inject `THREE` (the host provides its three build)')

  const w = width || element.clientWidth || 800
  const h = height || element.clientHeight || 600
  let mode: ViewerMode = initialMode === '2d' ? '2d' : '3d'
  const is2d = () => mode === '2d'
  let lastScene: ViewerScene | null = null

  // ── Adaptive quality (#166) ────────────────────────────────────────────────
  // antialias must be chosen at context creation, so pre-detect a tier from
  // device signals (navigator + DPR) first, then refine from the live GL
  // context (GPU string + fragment-uniform budget) right after.
  const nav: Partial<Navigator> & { deviceMemory?: number } = typeof navigator !== 'undefined' ? navigator : {}
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1
  const autoQuality = quality === 'auto'
  let tier: QualityTier = autoQuality
    ? detectTier({ hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory, devicePixelRatio: dpr, userAgent: nav.userAgent })
    : quality
  let preset = QUALITY_PRESETS[tier]

  const renderer = createRenderer(THREE, powerPreference, failIfMajorPerformanceCaveat, preset.antialias)

  // Refine from the real GL context: the GPU name (Deck/software) and — critically
  // — the fragment-uniform budget, which hard-caps how many lights the forward
  // renderer can pack into the fragment shader before it fails to COMPILE.
  let uniformLightCeiling = preset.maxLights
  if (autoQuality) {
    try {
      const gl = renderer.getContext()
      const maxFragU = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) as number
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      const rendererString = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
      tier = minTier(tier, detectTier({ maxFragmentUniforms: maxFragU, rendererString, hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory, devicePixelRatio: dpr, userAgent: nav.userAgent }))
      preset = QUALITY_PRESETS[tier]
      uniformLightCeiling = lightBudgetFromUniforms(maxFragU, preset.maxLights)
    } catch {
      /* keep the pre-detected preset — the GL probe is best-effort */
    }
  }

  // Explicit `shadows` (the plugin's user setting) is a hard ceiling; otherwise the
  // tier decides. The governor may drop shadows below this but never above it.
  const shadowsAllowed = shadows !== undefined ? shadows : preset.shadows
  let shadowsOn = shadowsAllowed
  let renderScale = 1
  const applyPixelRatio = () => renderer.setPixelRatio(Math.min(dpr, preset.pixelRatioCap) * renderScale)

  renderer.setSize(w, h, false)
  applyPixelRatio()
  renderer.shadowMap.enabled = shadowsOn
  // Frame-rate cap (#166): throttles render() + sets the governor's frame budget.
  let fpsCap: number | null = initialFpsCap && initialFpsCap > 0 ? initialFpsCap : null
  const budgetMs = () => (fpsCap ? 1000 / fpsCap : 33)
  const governor = createGovernor({ targetMs: budgetMs(), minScale: preset.minRenderScale })
  element.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, w / h, 1, 1e6)
  camera.up.set(0, 1, 0)
  // 2D mode's straight-down orthographic camera. `up` must be a horizontal axis
  // (the view direction is vertical); -Z keeps scene-north up on screen. Frustum is
  // framed on `bounds` by frameCamera().
  const camera2d = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1e6)
  camera2d.up.set(0, 0, -1)

  const tokens = new Map<string, ThreeNS.Group>()
  /** Per-wall semantics for getSceneGraph() — render geometry is INSTANCED (see
   * flushWalls), so reporting data lives here, not on meshes. */
  const wallSemantics: { x: number; z: number; semanticY: number; semanticHeight: number; kind: ViewerWallKind; doorState?: ViewerDoorState }[] = []
  /** The InstancedMesh(es) walls render as — one per style group (+ door hardware). */
  const wallMeshes: ThreeNS.Object3D[] = []
  /** Wall specs accumulated by addWall(), materialized once per loadScene by
   * flushWalls() — hundreds of individual wall meshes were hundreds of draw
   * calls per frame; instancing folds each style group into ONE. */
  interface PendingWall {
    x1: number
    y1: number
    x2: number
    y2: number
    bottom: number
    height: number
    len: number
    color: number
    opacity: number
    kind: ViewerWallKind
    doorState?: ViewerDoorState
    texture?: string
    flip?: boolean
    tileX?: number
    tileY?: number
  }
  const pendingWalls: PendingWall[] = []
  const levels: ThreeNS.Mesh[] = []
  const ambientLights: ThreeNS.Object3D[] = []
  const lights: ThreeNS.Light[] = []
  /** All point lights from the last scene (pre-budget). The active `lights` are a
   * budget-capped subset — see applyLightBudget (#166). */
  let allPointLights: ViewerLight[] = []
  const notes: ThreeNS.Sprite[] = []
  let notesVisible = true // host "Show/Hide map pins" toggle; re-applied to pins on every loadScene
  const tiles: ThreeNS.Mesh[] = []
  const regionMeshes: ThreeNS.Mesh[] = []
  const drawingGroups: ThreeNS.Group[] = []
  const templateGroups: ThreeNS.Group[] = []
  let ground: ThreeNS.Mesh | null = null
  let terrainMesh: ThreeNS.Mesh | null = null
  let brushCursor: ThreeNS.Line | null = null
  // Raw height field kept for sampling (grid drape, and any host that queries the surface).
  let terrainField: { cols: number; rows: number; heights: number[]; x0: number; z0: number; w: number; h: number } | null = null
  let grid: ThreeNS.Object3D | null = null
  // When the grid drapes over terrain, remember its params so live sculpting can re-drape it as the
  // surface changes (else the grid stays at the old heights and the raised ground buries it).
  let gridDraped: { size: number; color: number; opacity: number } | null = null
  let bounds: { width: number; height: number; x?: number; y?: number } = { width: 2000, height: 2000 }
  /** bounds center, in world XZ — where ground/levels/grid/frameCamera anchor. */
  const boundsCenter = () => ({ cx: (bounds.x || 0) + bounds.width / 2, cz: (bounds.y || 0) + bounds.height / 2 })
  /** One shared loader — three.js caches by URL through THREE.Cache only when enabled,
   * but a single instance still avoids per-call construction and keeps crossOrigin set
   * in exactly one place. */
  const textureLoader = new THREE.TextureLoader()
  textureLoader.setCrossOrigin('anonymous')

  // ────────────────────────────────────────────────────────────────────────────
  // Resource collector. three.js GPU resources are MANUAL memory: JS garbage
  // collection frees the handle, but the GPU-side buffers/textures stay resident
  // until .dispose() — a dangling allocation with no pointer. Ownership here is
  // explicit, C++-style:
  //   • OBJECT-owned (unique): per-object geometries/materials — freed by
  //     disposeObject() when their object leaves the scene.
  //   • CACHE-owned (shared): the per-URL texture cache, the per-URL GLB
  //     prototype cache, and the pooled unit geometries — SKIPPED by
  //     disposeObject() (many objects alias them) and freed ONLY by the
  //     mark-and-sweep below, or wholesale in dispose().
  // Mark-and-sweep: every loadScene() bumps `generation`; each cache hit during
  // the build stamps its entry (2D builds also re-stamp model entries without
  // fetching). The automatic sweep uses a ONE-generation grace window — an entry
  // survives a single build that ignores it (level-slice reloads, mode flips)
  // and is freed when a second consecutive build ignores it. viewer.gc() sweeps
  // strictly: everything the CURRENT scene doesn't reference.
  // ────────────────────────────────────────────────────────────────────────────
  let generation = 0
  let lastGC = { textures: 0, models: 0, generation: 0 }

  interface TextureEntry {
    tex: ThreeNS.Texture
    state: 'loading' | 'loaded' | 'error'
    gen: number
    swept: boolean
    onLoads: ((tex: ThreeNS.Texture) => void)[]
    onErrors: (() => void)[]
  }
  const textureCache = new Map<string, TextureEntry>()
  function getTexture(url: string, onLoad?: (tex: ThreeNS.Texture) => void, onError?: () => void): ThreeNS.Texture {
    const hit = textureCache.get(url)
    if (hit) {
      hit.gen = generation
      if (hit.state === 'loaded') onLoad?.(hit.tex)
      else if (hit.state === 'error') onError?.()
      else {
        if (onLoad) hit.onLoads.push(onLoad)
        if (onError) hit.onErrors.push(onError)
      }
      return hit.tex
    }
    const entry: TextureEntry = {
      tex: undefined as unknown as ThreeNS.Texture,
      state: 'loading',
      gen: generation,
      swept: false,
      onLoads: onLoad ? [onLoad] : [],
      onErrors: onError ? [onError] : [],
    }
    entry.tex = textureLoader.load(
      url,
      () => {
        entry.state = 'loaded'
        if (entry.swept) return // collected while in flight — consumers are gone
        for (const w of entry.onLoads.splice(0)) w(entry.tex)
        entry.onErrors.length = 0
        render()
      },
      undefined,
      () => {
        entry.state = 'error'
        if (entry.swept) return
        for (const w of entry.onErrors.splice(0)) w()
        entry.onLoads.length = 0
      },
    )
    entry.tex.colorSpace = THREE.SRGBColorSpace
    textureCache.set(url, entry)
    return entry.tex
  }

  // GLB prototype cache: one fetch + parse + set of GPU buffers per URL. getModel
  // DELIVERS a ready-to-own Object3D: for static models, a clone of the cached
  // prototype (clones SHARE geometry/material with the prototype — one GPU upload
  // for a same-model horde; prototype subtrees are tagged cfgShared so
  // disposeObject never frees what other clones alias). SKINNED models cannot be
  // shared this way — SkinnedMesh.copy keeps the clone bound to the PROTOTYPE's
  // skeleton, whose bones never join the scene (identity matrices → collapsed
  // mesh) — so a URL detected as skinned is marked in the cache and every
  // consumer gets its own PRIVATE parse (untagged: the token owns it outright).
  interface ModelEntry {
    proto: ThreeNS.Object3D | null
    state: 'loading' | 'loaded' | 'error'
    skinned: boolean
    gen: number
    swept: boolean
    onLoads: ((model: ThreeNS.Object3D) => void)[]
    onErrors: (() => void)[]
  }
  const modelCache = new Map<string, ModelEntry>()
  let gltfLoader: InstanceType<NonNullable<CreateViewerOptions['GLTFLoader']>> | null = null
  function setShadowFlags(obj: ThreeNS.Object3D) {
    obj.traverse((c: any) => {
      if (c.isMesh) {
        c.castShadow = true
        c.receiveShadow = true
      }
    })
  }
  function hasSkinnedMesh(obj: ThreeNS.Object3D): boolean {
    let skinned = false
    obj.traverse((c: any) => {
      if (c.isSkinnedMesh) skinned = true
    })
    return skinned
  }
  /** One un-cached parse — for skinned models each token owns its own copy,
   * INCLUDING the GLB-embedded textures (tagged cfgOwnedGlb so disposeObject
   * frees them; token-art materials' maps stay cache-owned and untouched). */
  function loadModelPrivate(url: string, onLoad: (model: ThreeNS.Object3D) => void, onError: () => void): void {
    try {
      if (!gltfLoader) gltfLoader = new GLTFLoader!()
      gltfLoader.load(
        url,
        (gltf) => {
          const model = gltf.scene || gltf.scenes?.[0]
          if (!model) return onError()
          setShadowFlags(model)
          model.traverse((c: any) => {
            c.userData.cfgOwnedGlb = true
          })
          onLoad(model)
        },
        undefined,
        () => onError(),
      )
    } catch {
      onError()
    }
  }
  function getModel(url: string, onLoad: (model: ThreeNS.Object3D) => void, onError: () => void): void {
    const hit = modelCache.get(url)
    if (hit) {
      hit.gen = generation
      if (hit.state === 'loaded' && hit.skinned) loadModelPrivate(url, onLoad, onError)
      else if (hit.state === 'loaded' && hit.proto) onLoad(hit.proto.clone(true))
      else if (hit.state === 'error') onError()
      else {
        hit.onLoads.push(onLoad)
        hit.onErrors.push(onError)
      }
      return
    }
    const entry: ModelEntry = { proto: null, state: 'loading', skinned: false, gen: generation, swept: false, onLoads: [onLoad], onErrors: [onError] }
    modelCache.set(url, entry)
    const fail = () => {
      entry.state = 'error'
      if (entry.swept) return
      for (const cb of entry.onErrors.splice(0)) cb()
      entry.onLoads.length = 0
    }
    try {
      if (!gltfLoader) gltfLoader = new GLTFLoader!()
      gltfLoader.load(
        url,
        (gltf) => {
          const proto = gltf.scene || gltf.scenes?.[0]
          if (!proto) return fail()
          entry.state = 'loaded'
          if (hasSkinnedMesh(proto)) {
            // Cache only the FACT that this URL is skinned; the parse itself is
            // discarded (sharing it would share the skeleton). Waiters each get
            // a private copy.
            entry.skinned = true
            if (entry.swept) return
            const waitersL = entry.onLoads.splice(0)
            const waitersE = entry.onErrors.splice(0)
            waitersL.forEach((cb, i) => loadModelPrivate(url, cb, waitersE[i] ?? (() => undefined)))
            return
          }
          setShadowFlags(proto)
          proto.traverse((c: any) => {
            c.userData.cfgShared = true // cache-owned — disposeObject must skip
          })
          entry.proto = proto
          if (entry.swept) return disposeModelProto(proto)
          for (const cb of entry.onLoads.splice(0)) cb(proto.clone(true))
          entry.onErrors.length = 0
        },
        undefined,
        fail,
      )
    } catch {
      fail()
    }
  }

  /** Free a GLB prototype's GPU side: geometries, instance buffers, skeleton
   * bone textures, materials AND every texture-valued material slot (GLB
   * textures live outside the URL texture cache — the prototype owns them
   * outright, including KHR-extension maps like clearcoat/sheen/transmission). */
  function disposeModelProto(proto: ThreeNS.Object3D) {
    proto.traverse((c: any) => {
      if (c.isInstancedMesh) c.dispose?.() // instance matrix/color GPU buffers
      if (c.isSkinnedMesh) c.skeleton?.dispose?.() // lazily-allocated boneTexture
      c.geometry?.dispose?.()
      const mats = Array.isArray(c.material) ? c.material : c.material ? [c.material] : []
      for (const m of mats) {
        for (const key of Object.keys(m)) {
          if (m[key]?.isTexture) m[key].dispose()
        }
        m.dispose?.()
      }
    })
  }

  // Pooled unit geometries (viewer-lifetime, freed only in dispose()): every
  // token used to allocate its own ring/quad/box/stalk geometry — a 100-token
  // horde was ~200 identical GPU buffers. One unit geometry per shape, scaled
  // per-mesh, keeps the buffer count flat no matter the token count.
  const geoPool = new Map<string, ThreeNS.BufferGeometry>()
  const pooledGeos = new Set<ThreeNS.BufferGeometry>()
  function pooledGeo(key: string, make: () => ThreeNS.BufferGeometry): ThreeNS.BufferGeometry {
    let g = geoPool.get(key)
    if (!g) {
      g = make()
      geoPool.set(key, g)
      pooledGeos.add(g)
    }
    return g
  }

  /**
   * Sweep cache entries not marked for `minAge` consecutive generations.
   * The automatic post-loadScene sweep uses minAge 2 — a generational grace
   * window, so hosts that re-load slices of one scene (the level picker slices
   * out other floors' textures; a 2D build never marks GLB entries) don't
   * thrash: an entry survives ONE build that ignores it and dies on the second.
   * Manual viewer.gc() uses minAge 1 — a host's explicit "free everything not
   * on screen right now".
   */
  function collectGarbage(minAge = 1): { textures: number; models: number } {
    let texFreed = 0
    let modelsFreed = 0
    for (const [url, entry] of textureCache) {
      if (generation - entry.gen < minAge) continue
      entry.swept = true
      entry.tex.dispose()
      textureCache.delete(url)
      texFreed++
    }
    for (const [url, entry] of modelCache) {
      if (generation - entry.gen < minAge) continue
      entry.swept = true
      if (entry.proto) disposeModelProto(entry.proto)
      modelCache.delete(url)
      modelsFreed++
    }
    lastGC = { textures: texFreed, models: modelsFreed, generation }
    return { textures: texFreed, models: modelsFreed }
  }

  function disposeObject(obj: ThreeNS.Object3D | null | undefined) {
    obj?.traverse?.((c: any) => {
      // InstancedMesh instance buffers (matrix/color) are PER-MESH — owned by
      // this object even when its geometry/material are cache-shared, and
      // geometry.dispose() does NOT free them.
      if (c.isInstancedMesh) c.dispose?.()
      if (c.userData?.cfgShared) return // geometry/material cache-owned (GLB prototype clone) — the sweep frees them
      if (c.isSkinnedMesh) c.skeleton?.dispose?.() // private skinned copies own their skeleton (boneTexture)
      // Sprites all alias three's module-level shared plane geometry — never
      // dispose it out from under every other live sprite.
      if (c.geometry && !pooledGeos.has(c.geometry) && !c.isSprite) c.geometry.dispose?.()
      const mats = Array.isArray(c.material) ? c.material : c.material ? [c.material] : []
      for (const m of mats) {
        // Private GLB copies own their embedded textures; every other material's
        // maps are cache-owned (material.dispose() never touches .map anyway).
        if (c.userData?.cfgOwnedGlb) {
          for (const key of Object.keys(m)) {
            if (m[key]?.isTexture) m[key].dispose()
          }
        }
        m.dispose?.()
      }
    })
  }

  function clear() {
    for (const g of tokens.values()) {
      scene.remove(g)
      disposeObject(g)
    }
    tokens.clear()
    for (const wl of wallMeshes) {
      scene.remove(wl)
      disposeObject(wl)
    }
    wallMeshes.length = 0
    wallSemantics.length = 0
    pendingWalls.length = 0
    for (const lv of levels) {
      scene.remove(lv)
      disposeObject(lv)
    }
    levels.length = 0
    // Light.dispose() → shadow.dispose() → frees the shadow-map RENDER TARGET —
    // the only path that does; removal alone orphans 1024²/512² GPU targets on
    // every rebuild. (No-op ?.() for non-light entries like the sun's target.)
    for (const l of ambientLights) {
      scene.remove(l)
      ;(l as { dispose?: () => void }).dispose?.()
    }
    ambientLights.length = 0
    for (const l of lights) {
      scene.remove(l)
      l.dispose?.()
    }
    lights.length = 0
    for (const n of notes) {
      scene.remove(n)
      disposeObject(n)
    }
    notes.length = 0
    for (const t of tiles) {
      scene.remove(t)
      disposeObject(t)
    }
    tiles.length = 0
    for (const r of regionMeshes) {
      scene.remove(r)
      disposeObject(r)
    }
    regionMeshes.length = 0
    for (const d of drawingGroups) {
      // A text-drawing sprite owns a per-drawing CanvasTexture that disposeObject won't free.
      d.traverse((c: unknown) => {
        const s = c as { isSprite?: boolean; material?: { map?: { isTexture?: boolean; dispose?: () => void } } }
        if (s.isSprite && s.material?.map?.isTexture) s.material.map.dispose?.()
      })
      scene.remove(d)
      disposeObject(d)
    }
    drawingGroups.length = 0
    for (const t of templateGroups) {
      scene.remove(t)
      disposeObject(t)
    }
    templateGroups.length = 0
    if (ground) {
      scene.remove(ground)
      disposeObject(ground)
      ground = null
    }
    if (terrainMesh) {
      scene.remove(terrainMesh)
      disposeObject(terrainMesh)
      terrainMesh = null
    }
    if (brushCursor) {
      scene.remove(brushCursor)
      disposeObject(brushCursor)
      brushCursor = null
    }
    if (reticleGroup) {
      scene.remove(reticleGroup)
      disposeObject(reticleGroup)
      reticleGroup = null
    }
    terrainField = null
    if (grid) {
      scene.remove(grid)
      disposeObject(grid)
      grid = null
    }
    gridDraped = null
  }

  /** Ambient + directional "sun" — rebuilt every `loadScene()` so day/night changes apply. */
  function applyAmbient(cfg: ViewerAmbient | undefined) {
    const hemi = cfg?.hemisphere
    const sunCfg = cfg?.sun
    if (!cfg) {
      // Backward-compatible default: flat ambient + a fixed directional light.
      const amb = new THREE.AmbientLight(0xffffff, 0.75)
      scene.add(amb)
      ambientLights.push(amb)
      const sun = new THREE.DirectionalLight(0xffffff, 0.8)
      sun.position.set(1, 2, 1.5)
      scene.add(sun)
      ambientLights.push(sun)
      return
    }
    const hemiLight = new THREE.HemisphereLight(hemi?.sky ?? 0xeeeeee, hemi?.ground ?? 0x303030, hemi?.intensity ?? 0.4)
    scene.add(hemiLight)
    ambientLights.push(hemiLight)
    const { cx, cz } = boundsCenter()
    const span = Math.max(bounds.width, bounds.height)
    const sun = new THREE.DirectionalLight(sunCfg?.color ?? 0xffffff, sunCfg?.intensity ?? 0.7)
    sun.position.set(cx - span * 0.55, span * 0.5, cz - span * 0.4)
    sun.target.position.set(cx, 0, cz)
    if (sunCfg?.castShadow) {
      sun.castShadow = true
      sun.shadow.mapSize.set(1024, 1024)
      const sc = sun.shadow.camera as ThreeNS.OrthographicCamera
      sc.left = -span * 0.7
      sc.right = span * 0.7
      sc.top = span * 0.7
      sc.bottom = -span * 0.7
      sc.near = span * 0.05
      sc.far = span * 2.6
      sun.shadow.bias = -0.0004
      if (sunCfg.shadowNormalBias) sun.shadow.normalBias = sunCfg.shadowNormalBias
    }
    scene.add(sun.target)
    scene.add(sun)
    ambientLights.push(sun, sun.target)
  }

  function addPointLight(l: ViewerLight, allowShadow: boolean) {
    const light = new THREE.PointLight(l.color ?? 0xffffff, l.intensity ?? 1, l.radius ?? 0, 0)
    light.position.set(l.x || 0, l.elevation || 0, l.y || 0)
    if (l.castShadow && shadowsOn && allowShadow) {
      light.castShadow = true
      light.shadow.mapSize.set(preset.shadowMapSize || 512, preset.shadowMapSize || 512)
      light.shadow.camera.near = l.shadowNear ?? 1
      light.shadow.camera.far = l.radius || 1000
      light.shadow.bias = -0.0006
      if (l.shadowNormalBias) light.shadow.normalBias = l.shadowNormalBias
    }
    scene.add(light)
    lights.push(light)
  }

  /**
   * Cap the active real-time point lights to the quality budget (#166). A forward
   * renderer costs fragments × lights and can fail shader compilation past a few
   * dozen — a 100×100 dungeon can carry hundreds. Keeps the most important lights
   * near the camera (selectLights) and drops the rest. Called once per loadScene
   * from the stored `allPointLights`. Rebuilds cleanly, so it also re-applies on a
   * quality change.
   */
  function applyLightBudget() {
    for (const l of lights) {
      scene.remove(l)
      ;(l as unknown as { dispose?: () => void }).dispose?.()
    }
    lights.length = 0
    const budget = Math.min(preset.maxLights, uniformLightCeiling)
    if (budget <= 0 || !allPointLights.length) return
    const cam = { x: camera.position.x, y: camera.position.y, z: camera.position.z }
    const specs = allPointLights.map((l) => ({ x: l.x || 0, y: l.elevation || 0, z: l.y || 0, intensity: l.intensity, radius: l.radius, src: l }))
    // Cap shadow-casting POINT lights to the tier budget: each is a cube shadow
    // map (6 faces + a texture unit), and too many overrun the GPU's texture-unit
    // limit → the whole render fails (walls vanish, GL error spam). selectLights
    // returns most-important-first, so the biggest lights get the few shadows.
    let shadowsLeft = shadowsOn ? preset.shadowCasters : 0
    for (const s of selectLights(specs, budget, cam)) {
      const castShadow = shadowsLeft > 0 && !!s.src.castShadow
      if (castShadow) shadowsLeft--
      addPointLight(s.src, castShadow)
    }
  }

  // Wall/door/window styling. Doors read as wood, secret doors reuse the
  // secret-content purple (same palette as secret-disposition tokens), windows
  // are glass. Door panels are always opaque; window glass ignores wallOpacity.
  const WALL_STYLE: Record<ViewerWallKind, { color: number; opacity: number | null }> = {
    wall: { color: 0x8a8f98, opacity: null }, // null → honor wl.opacity (host default)
    door: { color: 0x8a5a2b, opacity: 1 },
    secretDoor: { color: 0x9c27b0, opacity: 1 },
    window: { color: 0x9fc7e8, opacity: 0.28 },
  }
  const LOCKED_DOOR_COLOR = 0x6e4520 // darker panel + the lock block below the handle
  const HANDLE_COLOR = 0xd4af37 // brass knob
  const LOCK_COLOR = 0xcaa432 // gold lock block
  const DOOR_OPEN_RAD = -(Math.PI * 5) / 12 // 75° swing about the (x1,y1) hinge

  /** Queue a wall segment. Geometry is INSTANCED — flushWalls() folds every wall
   * of a style group (kind + door state + opacity) into ONE draw call (a big
   * dungeon carries hundreds of segments; per-wall meshes were per-wall draw
   * calls). */
  function addWall(wl: ViewerWall) {
    const x1 = wl.x1 || 0
    const y1 = wl.y1 || 0
    const x2 = wl.x2 || 0
    const y2 = wl.y2 || 0
    const bottom = wl.bottom || 0
    const height = Math.max(1, (wl.top ?? bottom + 200) - bottom)
    const len = Math.max(1, Math.hypot(x2 - x1, y2 - y1))
    const kind: ViewerWallKind = wl.kind && WALL_STYLE[wl.kind] ? wl.kind : 'wall'
    const isDoor = kind === 'door' || kind === 'secretDoor'
    const doorState: ViewerDoorState | undefined = isDoor ? (wl.doorState ?? 'closed') : undefined
    const style = WALL_STYLE[kind]
    const color = wl.color ?? (isDoor && doorState === 'locked' ? LOCKED_DOOR_COLOR : style.color)
    const opacity = style.opacity ?? wl.opacity ?? 1
    pendingWalls.push({ x1, y1, x2, y2, bottom, height, len, color, opacity, kind, doorState, texture: wl.texture, flip: wl.flip, tileX: wl.tileX, tileY: wl.tileY })
    wallSemantics.push({ x: (x1 + x2) / 2, z: (y1 + y2) / 2, semanticY: bottom + height / 2, semanticHeight: height, kind, doorState })
  }

  /** Materialize queued walls as InstancedMesh(es): unit geometry scaled/rotated
   * per instance, per-instance color, one mesh per STYLE group (kind + door
   * state + opacity). Open doors swing ~75° about their (x1,y1) hinge; doors get
   * an instanced brass handle knob on both faces (+ a lock block when locked);
   * windows render as translucent glass (no shadow). 3D = a thin box spanning
   * exactly `bottom`→`top`; 2D = a thin flat strip, color-coded the same way. */
  function flushWalls() {
    if (!pendingWalls.length) return
    const byStyle = new Map<string, PendingWall[]>()
    for (const wl of pendingWalls) {
      if (wl.texture) continue // textured segments render as their own flat quad (below)
      const key = `${wl.kind}|${wl.doorState ?? ''}|${wl.opacity}`
      const group = byStyle.get(key) ?? []
      group.push(wl)
      byStyle.set(key, group)
    }
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const qFlat = new THREE.Quaternion()
    const pos = new THREE.Vector3()
    const scl = new THREE.Vector3()
    const color = new THREE.Color()
    const yAxis = new THREE.Vector3(0, 1, 0)
    const xAxis = new THREE.Vector3(1, 0, 0)
    // Door hardware, accumulated across every door group and instanced once.
    const handles: { x: number; y: number; z: number }[] = []
    const locks: { x: number; y: number; z: number; yaw: number }[] = []

    for (const group of byStyle.values()) {
      const { kind, doorState, opacity } = group[0]
      const isGlass = kind === 'window'
      const geo = is2d() ? pooledGeo('wall2d', () => new THREE.PlaneGeometry(1, 8)) : pooledGeo('wall3d', () => new THREE.BoxGeometry(1, 1, 8))
      const mat = is2d()
        ? new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: opacity < 1, opacity })
        : new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: isGlass ? 0.15 : 0.9,
            side: THREE.DoubleSide,
            transparent: opacity < 1,
            opacity,
            depthWrite: !isGlass, // glass must not occlude what's behind it
          })
      const mesh = new THREE.InstancedMesh(geo, mat, group.length)
      for (let i = 0; i < group.length; i++) {
        const wl = group[i]
        // Segment yaw about world Y; an OPEN door adds the swing, and the panel
        // pivots about its (x1,y1) end (hinge) instead of the midpoint.
        const yaw = -Math.atan2(wl.y2 - wl.y1, wl.x2 - wl.x1) + (doorState === 'open' ? DOOR_OPEN_RAD : 0)
        const cos = Math.cos(yaw)
        const sin = Math.sin(yaw)
        const cxP = wl.x1 + cos * (wl.len / 2)
        const czP = wl.y1 - sin * (wl.len / 2)
        if (is2d()) {
          // Lie flat (rotX -90°) then align with the segment about world Y.
          q.setFromAxisAngle(yAxis, yaw)
          qFlat.setFromAxisAngle(xAxis, -Math.PI / 2)
          q.multiply(qFlat)
          pos.set(cxP, WALL_2D_Y, czP)
          scl.set(wl.len, 1, 1)
        } else {
          q.setFromAxisAngle(yAxis, yaw)
          pos.set(cxP, wl.bottom + wl.height / 2, czP)
          scl.set(wl.len, wl.height, 1)
        }
        mesh.setMatrixAt(i, m.compose(pos, q, scl))
        mesh.setColorAt(i, color.set(wl.color))
        // Door hardware (3D only — illegible at 2D map scale): handle knob near
        // the far (non-hinge) end on both faces, lock block under it when locked.
        if (!is2d() && (kind === 'door' || kind === 'secretDoor')) {
          const inset = Math.min(14, wl.len * 0.12)
          const hx = wl.x1 + cos * (wl.len - inset)
          const hz = wl.y1 - sin * (wl.len - inset)
          // Panel normal = local +Z rotated by yaw.
          const nx = sin
          const nz = cos
          const hy = wl.bottom + wl.height * 0.45
          for (const side of [7, -7]) {
            handles.push({ x: hx + nx * side, y: hy, z: hz + nz * side })
            if (doorState === 'locked') locks.push({ x: hx + nx * side, y: hy - 16, z: hz + nz * side, yaw })
          }
        }
      }
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      // Recompute bounds over the instance transforms — without this three.js
      // frustum-culls the whole group by the UNIT geometry's bounds (a 1×1 box at
      // the origin), so walls far from world-origin flicker in/out as the camera
      // turns away from (0,0). (#166)
      mesh.computeBoundingSphere()
      if (!is2d() && !isGlass) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
      scene.add(mesh)
      wallMeshes.push(mesh)
    }

    if (handles.length) {
      const geo = pooledGeo('handle', () => new THREE.SphereGeometry(4.5, 10, 8))
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: HANDLE_COLOR, roughness: 0.35, metalness: 0.6 }), handles.length)
      for (let i = 0; i < handles.length; i++) {
        pos.set(handles[i].x, handles[i].y, handles[i].z)
        mesh.setMatrixAt(i, m.compose(pos, q.identity(), scl.set(1, 1, 1)))
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere() // correct frustum-cull bounds (#166) — see wall mesh above
      scene.add(mesh)
      wallMeshes.push(mesh)
    }
    if (locks.length) {
      const geo = pooledGeo('lock', () => new THREE.BoxGeometry(8, 11, 3))
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: LOCK_COLOR, roughness: 0.4, metalness: 0.5 }), locks.length)
      for (let i = 0; i < locks.length; i++) {
        pos.set(locks[i].x, locks[i].y, locks[i].z)
        q.setFromAxisAngle(yAxis, locks[i].yaw)
        mesh.setMatrixAt(i, m.compose(pos, q, scl.set(1, 1, 1)))
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere() // correct frustum-cull bounds (#166) — see wall mesh above
      scene.add(mesh)
      wallMeshes.push(mesh)
    }
    // Textured walls (Foundry native `animation.texture`) → a flat vertical quad with the
    // bitmap, opted out of instancing (each carries its own map). UNLIT so the bitmap reads
    // at authored brightness like the floor; double-sided; no door swing (flat walls).
    for (const wl of pendingWalls) {
      if (!wl.texture) continue
      const tex = getTexture(wl.texture)
      const tileX = wl.tileX && wl.tileX > 0 ? wl.tileX : 1
      const tileY = wl.tileY && wl.tileY > 0 ? wl.tileY : 1
      const tiled = tileX !== 1 || tileY !== 1
      // Tiling repeats the texture across the segment (UVs scaled on the quad); wrap must be Repeat.
      // Safe to set globally: a non-tiled wall keeps 0–1 UVs, which render identically under either wrap mode.
      if (tiled && tex.wrapS !== THREE.RepeatWrapping) {
        tex.wrapS = THREE.RepeatWrapping
        tex.wrapT = THREE.RepeatWrapping
        tex.needsUpdate = true
      }
      const yaw = -Math.atan2(wl.y2 - wl.y1, wl.x2 - wl.x1)
      const cxP = (wl.x1 + wl.x2) / 2
      const czP = (wl.y1 + wl.y2) / 2
      const wmat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: wl.opacity < 1, opacity: wl.opacity })
      let quad: ThreeNS.Mesh
      if (is2d()) {
        quad = new THREE.Mesh(pooledGeo('wall2d', () => new THREE.PlaneGeometry(1, 8)), wmat)
        q.setFromAxisAngle(yAxis, yaw)
        qFlat.setFromAxisAngle(xAxis, -Math.PI / 2)
        q.multiply(qFlat)
        quad.quaternion.copy(q)
        quad.scale.set(wl.len, 1, 1)
        quad.position.set(cxP, WALL_2D_Y, czP)
      } else {
        const geo = new THREE.PlaneGeometry(wl.len, wl.height)
        if (tiled) {
          const uv = geo.attributes.uv
          for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * tileX, uv.getY(i) * tileY)
          uv.needsUpdate = true
        }
        quad = new THREE.Mesh(geo, wmat)
        quad.rotation.y = yaw
        quad.position.set(cxP, wl.bottom + wl.height / 2, czP)
      }
      if (wl.flip) quad.scale.x = -1 // mirror the texture horizontally (double-sided → no winding issue)
      scene.add(quad)
      wallMeshes.push(quad)
    }
    pendingWalls.length = 0
  }

  /** One scene-rect-sized textured quad — a Level background/foreground floor. */
  function addLevel(lv: ViewerLevel) {
    const geo = new THREE.PlaneGeometry(bounds.width, bounds.height)
    const tex = getTexture(lv.src)
    // The floor map is drawn UNLIT in both 2D and 3D so it reads at its authored
    // brightness like Foundry's own canvas. three r155+ uses PHYSICAL lights, under which
    // a lit MeshStandard floor rendered far darker than 2D ("3D is too dark, can't see the
    // grid"). In 3D we tint by Foundry's effective scene brightness (`floorBrightness`,
    // derived from global-light + darkness) rather than relighting the map.
    const fb = is2d() ? 1 : (lastScene?.ambient?.floorBrightness ?? 0.9)
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      color: new THREE.Color(fb, fb, fb),
      side: THREE.DoubleSide,
      alphaTest: lv.alphaTest ?? 0.75,
    })
    if (lv.tint != null && lv.tint !== 0xffffff) mat.color.multiply(new THREE.Color(lv.tint))
    const plane = new THREE.Mesh(geo, mat)
    plane.rotation.x = -Math.PI / 2
    if (lv.rotation) plane.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), lv.rotation)
    const { cx: bx, cz: bz } = boundsCenter()
    const cx = bx + (lv.offsetX || 0)
    const cz = bz + (lv.offsetY || 0)
    let y = lv.elevation || 0
    if (lv.which === 'top') y += 0.6 // nudge a roof above the band top — avoids z-fight
    plane.position.set(cx, y, cz)
    plane.receiveShadow = true
    scene.add(plane)
    levels.push(plane)
    // NO opacity slab under a Level, ever: Level textures rely on alpha holes/edges to
    // see through to the floors below (the FoundryVTT Levels convention), and any
    // full-bounds backing geometry blocks exactly that. Levels stay thin DoubleSide
    // planes — matching Foundry's own look; walls stop flush at their bottom, so
    // nothing pokes below a floor anyway.
  }

  /**
   * Continuous heightmap terrain: a subdivided plane over the scene bounds, each vertex
   * displaced by a per-cell height, the map texture draped over it. Low-poly relief shading
   * is BAKED into vertex colours (unlit MeshBasic like the flat floor — predictable
   * brightness, papercraft look — but slopes still read from the baked light). Replaces the
   * flat map floor in 3D. `heights` is row-major (cols×rows) in world px.
   */
  /**
   * SMOOTH heightmap terrain — a corner-lattice displaced grid (cols×rows sample points at the tile
   * CORNERS, bilinearly interpolated between). Heightmapping represents terrain SHAPE (rolling
   * landscape); crisp cliffs/tiles/levels are a separate future construct (walls/tiles/levels). At
   * ≥2 samples/grid-square the surface reads as genuine rolling terrain, not the jagged 1-sample look.
   * The map texture drapes planar over the surface; baked fixed-sun lambert shading gives it form.
   */
  function addTerrain(t: ViewerTerrain) {
    const cols = Math.max(2, t.cols | 0)
    const rows = Math.max(2, t.rows | 0)
    const heights = t.heights || []
    if (heights.length < cols * rows) return
    const w = bounds.width
    const h = bounds.height
    const { cx: bx, cz: bz } = boundsCenter()
    const x0 = bx - w / 2
    const z0 = bz - h / 2
    const nV = cols * rows
    const pos = new Float32Array(nV * 3)
    const uv = new Float32Array(nV * 2)
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i
        pos[k * 3] = x0 + (i / (cols - 1)) * w
        pos[k * 3 + 1] = heights[k] || 0
        pos[k * 3 + 2] = z0 + (j / (rows - 1)) * h
        uv[k * 2] = i / (cols - 1)
        uv[k * 2 + 1] = 1 - j / (rows - 1) // canvas Y grows downward; flip V to match the map
      }
    }
    const idx: number[] = []
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i
        const b = a + 1
        const c = a + cols
        const d = c + 1
        idx.push(a, c, b, b, c, d)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geo.setIndex(idx)
    geo.computeVertexNormals()
    const normals = geo.getAttribute('normal')
    const col = new Float32Array(nV * 3)
    const fb = is2d() ? 1 : (lastScene?.ambient?.floorBrightness ?? 0.9)
    const sx = 0.36
    const sy = 0.86
    const sz = 0.36 // sun dir (normalized-ish)
    for (let k = 0; k < nV; k++) {
      const d = Math.max(0, normals.getX(k) * sx + normals.getY(k) * sy + normals.getZ(k) * sz)
      const shade = (0.55 + 0.45 * d) * fb
      col[k * 3] = shade
      col[k * 3 + 1] = shade
      col[k * 3 + 2] = shade
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    if (t.src) mat.map = getTexture(t.src)
    else mat.color = new THREE.Color(t.color ?? 0x6a7f52)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.receiveShadow = true
    scene.add(mesh)
    terrainMesh = mesh
    terrainField = { cols, rows, heights, x0, z0, w, h }
  }

  /** Bilinear terrain surface height (world px) at world (x, z) — corner-lattice sample grid; 0 when
   *  there's no field. Smooth model → the draped grid, brush cursor and stamp aura all follow the hill. */
  function terrainHeightAt(x: number, z: number): number {
    const f = terrainField
    if (!f) return 0
    const u = Math.min(1, Math.max(0, (x - f.x0) / f.w)) * (f.cols - 1)
    const v = Math.min(1, Math.max(0, (z - f.z0) / f.h)) * (f.rows - 1)
    const i0 = Math.floor(u)
    const j0 = Math.floor(v)
    const i1 = Math.min(f.cols - 1, i0 + 1)
    const j1 = Math.min(f.rows - 1, j0 + 1)
    const fx = u - i0
    const fy = v - j0
    const at = (i: number, j: number) => f.heights[j * f.cols + i] || 0
    const top = at(i0, j0) * (1 - fx) + at(i1, j0) * fx
    const bot = at(i0, j1) * (1 - fx) + at(i1, j1) * fx
    return top * (1 - fy) + bot * fy
  }

  /**
   * Raycast a screen point onto the terrain and return the normalized field position
   * (u, v ∈ [0,1]) under the cursor, or null. The host uses this as a sculpt-brush centre.
   */
  function raycastTerrain(clientX: number, clientY: number): { u: number; v: number } | null {
    if (!terrainMesh || !terrainField) return null
    const el = renderer.domElement
    const rect = el.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1))
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, camera)
    const hit = ray.intersectObject(terrainMesh, false)[0]
    if (!hit) return null
    const f = terrainField
    return { u: Math.min(1, Math.max(0, (hit.point.x - f.x0) / f.w)), v: Math.min(1, Math.max(0, (hit.point.z - f.z0) / f.h)) }
  }

  /**
   * Re-displace the existing terrain mesh from a new height field IN PLACE (positions +
   * normals + baked shading), no scene rebuild — for live sculpting. `newHeights` must match
   * the current cols*rows (grid units → px is already applied by the producer, so these are px).
   */
  function updateTerrainHeights(newHeights: number[]): void {
    const f = terrainField
    if (!terrainMesh || !f || !newHeights || newHeights.length < f.cols * f.rows) return
    // Smooth model: the corner-lattice topology is stable — re-displace the existing vertices in place
    // (positions + normals + baked shading), no geometry rebuild.
    const geo = terrainMesh.geometry as ThreeNS.BufferGeometry
    const posAttr = geo.getAttribute('position') as ThreeNS.BufferAttribute
    for (let k = 0; k < f.cols * f.rows; k++) posAttr.setY(k, newHeights[k] || 0)
    posAttr.needsUpdate = true
    geo.computeVertexNormals()
    const normals = geo.getAttribute('normal') as ThreeNS.BufferAttribute
    const col = geo.getAttribute('color') as ThreeNS.BufferAttribute
    const fb = is2d() ? 1 : (lastScene?.ambient?.floorBrightness ?? 0.9)
    for (let k = 0; k < f.cols * f.rows; k++) {
      const d = Math.max(0, normals.getX(k) * 0.36 + normals.getY(k) * 0.86 + normals.getZ(k) * 0.36)
      const shade = (0.55 + 0.45 * d) * fb
      col.setXYZ(k, shade, shade, shade)
    }
    col.needsUpdate = true
    f.heights = newHeights
    // Re-drape the grid so its lines rise with the ground the GM just sculpted (no-op for a flat grid).
    if (gridDraped) {
      if (grid) {
        scene.remove(grid)
        disposeObject(grid)
      }
      grid = buildDrapedGrid(gridDraped.size, gridDraped.color, gridDraped.opacity)
    }
    render()
  }

  /** Unit brush outline on the XZ ground plane: a circle (Euclidean footprint) or a square
   *  (Chebyshev footprint) that matches the brush's own math, so the GM literally sees the shape
   *  they picked. LineLoop keeps it a thin overlay ring regardless of shape/zoom. */
  function buildBrushCursorGeo(shape: 'circle' | 'square'): ThreeNS.BufferGeometry {
    const pts: ThreeNS.Vector3[] = []
    if (shape === 'square') {
      pts.push(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 0, -1), new THREE.Vector3(1, 0, 1), new THREE.Vector3(-1, 0, 1))
    } else {
      const N = 48
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2
        pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)))
      }
    }
    return new THREE.BufferGeometry().setFromPoints(pts)
  }

  /** Show a brush outline on the terrain under the cursor sized to the brush (radiusFrac = fraction
   *  of the field span) and shaped like the active footprint, so the GM sees where/how big/what shape
   *  a sculpt dab lands. Hidden when off-terrain. */
  function showBrushCursor(clientX: number, clientY: number, radiusFrac: number, shape: 'circle' | 'square' = 'circle', snapWorld = 0): void {
    if (!terrainMesh || !terrainField) return
    const el = renderer.domElement
    const rect = el.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1))
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, camera)
    const hit = ray.intersectObject(terrainMesh, false)[0]
    if (!hit) {
      hideBrushCursor()
      return
    }
    // Grid-lock: snap the ring to the grid CELL CENTRE under the cursor (aligned to the field origin)
    // and re-sample the surface height there, so the GM visibly sees it lock tile-to-tile.
    let px = hit.point.x
    let pz = hit.point.z
    let py = hit.point.y
    if (snapWorld > 0 && terrainField) {
      const f = terrainField
      px = f.x0 + (Math.floor((hit.point.x - f.x0) / snapWorld) + 0.5) * snapWorld
      pz = f.z0 + (Math.floor((hit.point.z - f.z0) / snapWorld) + 0.5) * snapWorld
      py = terrainHeightAt(px, pz)
    }
    // Rebuild only when the shape changes (cheap; hover updates just move/scale it).
    if (!brushCursor || brushCursor.userData.shape !== shape) {
      if (brushCursor) {
        scene.remove(brushCursor)
        disposeObject(brushCursor)
      }
      brushCursor = new THREE.LineLoop(
        buildBrushCursorGeo(shape),
        new THREE.LineBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.9, depthTest: false }),
      )
      brushCursor.userData.shape = shape
      brushCursor.renderOrder = 30
      scene.add(brushCursor)
    }
    const f = terrainField
    const r = Math.max(20, radiusFrac * Math.max(f.w, f.h))
    brushCursor.scale.set(r, 1, r)
    brushCursor.position.set(px, py + 5, pz)
    brushCursor.visible = true
    render()
  }

  function hideBrushCursor(): void {
    if (brushCursor) {
      brushCursor.visible = false
      render()
    }
  }

  // ── Level-Stamp reticle: a footprint outline placed at an EXPLICIT world position + TARGET height
  // (not the terrain surface), so the GM sees exactly which tiles and at what elevation the stamp will
  // set. Distinct cyan colour from the yellow freehand brush cursor. ──────────────────────────────
  // The reticle is a translucent, slightly-3D cyan TILE (fill + a bit of height) topped by a bright
  // outline, so it reads as a solid block hovering at the target elevation — distinct from the yellow
  // freehand brush ring.
  let reticleGroup: ThreeNS.Object3D | null = null
  let reticleAura: ThreeNS.Mesh | null = null
  /** The stamp's AURA: a translucent wash over the exact SAMPLES the stamp will affect, hugging the
   *  CURRENT smooth surface — so the GM sees which terrain the footprint covers before placing.
   *  Corner-lattice: samples sit at i/(cols-1); each gets a small patch at its interpolated height. */
  function updateReticleAura(worldX: number, worldZ: number, radiusFrac: number, shape: 'circle' | 'square', visible: boolean): void {
    if (reticleAura) {
      scene.remove(reticleAura)
      disposeObject(reticleAura)
      reticleAura = null
    }
    const f = terrainField
    if (!visible || !f) return
    const dx = f.w / (f.cols - 1) // sample spacing (corner lattice)
    const dz = f.h / (f.rows - 1)
    const ci = ((worldX - f.x0) / f.w) * (f.cols - 1)
    const cj = ((worldZ - f.z0) / f.h) * (f.rows - 1)
    const rCells = Math.max(0.5, radiusFrac * Math.max(f.cols, f.rows))
    const pos: number[] = []
    const iMin = Math.max(0, Math.floor(ci - rCells))
    const iMax = Math.min(f.cols - 1, Math.ceil(ci + rCells))
    const jMin = Math.max(0, Math.floor(cj - rCells))
    const jMax = Math.min(f.rows - 1, Math.ceil(cj + rCells))
    for (let j = jMin; j <= jMax; j++) {
      for (let i = iMin; i <= iMax; i++) {
        const dist = shape === 'square' ? Math.max(Math.abs(i - ci), Math.abs(j - cj)) : Math.hypot(i - ci, j - cj)
        if (dist > rCells) continue
        const y = (f.heights[j * f.cols + i] || 0) + 2
        const xa = f.x0 + i * dx - dx / 2
        const xb = xa + dx
        const za = f.z0 + j * dz - dz / 2
        const zb = za + dz
        pos.push(xa, y, za, xa, y, zb, xb, y, za, xb, y, za, xa, y, zb, xb, y, zb)
      }
    }
    if (!pos.length) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
    reticleAura = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x33ddff, transparent: true, opacity: 0.28, depthTest: false, side: THREE.DoubleSide }))
    reticleAura.renderOrder = 29
    scene.add(reticleAura)
  }

  function showReticle(worldX: number, worldZ: number, radiusFrac: number, shape: 'circle' | 'square', worldY: number, placed = false): void {
    if (!terrainField) return
    if (!reticleGroup || reticleGroup.userData.shape !== shape) {
      if (reticleGroup) {
        scene.remove(reticleGroup)
        disposeObject(reticleGroup)
      }
      const g = new THREE.Group()
      const fillMat = new THREE.MeshBasicMaterial({ color: 0x33ddff, transparent: true, opacity: 0.22, depthTest: false, side: THREE.DoubleSide })
      // unit prism (scaled per-frame): box spans ±1 → half-width matches the square footprint; cylinder radius 1 matches the circle.
      const fill = shape === 'square' ? new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2), fillMat) : new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 40), fillMat)
      fill.renderOrder = 30
      const outline = new THREE.LineLoop(buildBrushCursorGeo(shape), new THREE.LineBasicMaterial({ color: 0x33ddff, transparent: true, opacity: 0.95, depthTest: false }))
      outline.renderOrder = 31
      g.add(fill)
      g.add(outline)
      g.userData.shape = shape
      g.userData.fill = fill
      g.userData.outline = outline
      scene.add(g)
      reticleGroup = g
    }
    const f = terrainField
    const r = Math.max(20, radiusFrac * Math.max(f.w, f.h))
    const thickness = Math.max(8, (lastScene?.grid?.size ?? 100) * 0.25) // "a bit of height" — a quarter-tile slab
    const fill = reticleGroup.userData.fill as ThreeNS.Mesh
    const outline = reticleGroup.userData.outline as ThreeNS.Object3D
    // Ethereal (unplaced, cyan + translucent) vs placed (green + solid-ish): the stamp behaves like an
    // object — pick it up, move it freely, and only PLACING it changes terrain.
    const fillMat = fill.material as ThreeNS.MeshBasicMaterial
    const lineMat = (outline as ThreeNS.Line).material as ThreeNS.LineBasicMaterial
    // Ethereal = cyan (moving, no change); placed = amber (set) — both pop against the green terrain.
    fillMat.color.setHex(placed ? 0xffa030 : 0x33ddff)
    fillMat.opacity = placed ? 0.4 : 0.22
    lineMat.color.setHex(placed ? 0xffa030 : 0x33ddff)
    fill.scale.set(r, thickness, r)
    fill.position.set(0, thickness / 2, 0)
    outline.scale.set(r, 1, r)
    outline.position.set(0, thickness + 1, 0)
    reticleGroup.position.set(worldX, worldY, worldZ)
    reticleGroup.visible = true
    // Aura only while GHOSTED — after placing, the terrain itself shows the result.
    updateReticleAura(worldX, worldZ, radiusFrac, shape, !placed)
    render()
  }
  function hideReticle(): void {
    updateReticleAura(0, 0, 0, 'circle', false)
    if (reticleGroup) {
      reticleGroup.visible = false
      render()
    }
  }
  function terrainCellToWorld(i: number, j: number): { x: number; z: number } | null {
    const f = terrainField
    if (!f) return null
    const ci = Math.min(f.cols - 1, Math.max(0, i))
    const cj = Math.min(f.rows - 1, Math.max(0, j))
    // Corner-lattice: sample (i,j) sits at i/(cols-1) across the bounds — reticle/stamp anchor there.
    return { x: f.x0 + (ci / (f.cols - 1)) * f.w, z: f.z0 + (cj / (f.rows - 1)) * f.h }
  }

  /**
   * A native Foundry Region as flat-topped terrain: a horizontal fill at its surface
   * height (from Foundry's own triangulation) + a vertical skirt to the reference floor.
   * Unlit MeshBasic like the map floor (papercraft/low-poly look, and immune to the
   * physical-light dimming); the skirt is a shaded shade of the top so tiers read as solid.
   */
  function addRegion(rg: ViewerRegion) {
    const verts = rg.vertices
    const idx = rg.indices
    if (!verts?.length || !idx?.length) return
    const surface = rg.elevation || 0
    const base = rg.base ?? 0
    const color = rg.color ?? 0x8a9a5b
    const opacity = rg.opacity ?? 1
    const transparent = opacity < 1
    const { cx: bx, cz: bz } = boundsCenter()
    const x0 = bx - bounds.width / 2
    const z0 = bz - bounds.height / 2
    // Top fill: canvas (x,y) → world (x, surface, z), reusing Foundry's triangle indices.
    // UVs come from each vertex's position in the scene rect so the MAP drapes onto the
    // raised top — the lifted area shows the actual island art, not a flat colour.
    const pos = new Float32Array((verts.length / 2) * 3)
    const uv = new Float32Array((verts.length / 2) * 2)
    for (let i = 0, j = 0, u = 0; i < verts.length; i += 2, j += 3, u += 2) {
      pos[j] = verts[i]
      pos[j + 1] = surface
      pos[j + 2] = verts[i + 1]
      uv[u] = (verts[i] - x0) / bounds.width
      uv[u + 1] = 1 - (verts[i + 1] - z0) / bounds.height
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geo.setIndex(Array.from(idx))
    geo.computeVertexNormals()
    const topMat = rg.src
      ? new THREE.MeshBasicMaterial({ map: getTexture(rg.src), side: THREE.DoubleSide, transparent, opacity })
      : new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent, opacity })
    const fill = new THREE.Mesh(geo, topMat)
    fill.receiveShadow = true
    scene.add(fill)
    regionMeshes.push(fill)
    // Vertical skirt between the surface and the reference floor (both raised and sunken).
    const top = Math.max(surface, base)
    const bot = Math.min(surface, base)
    if (rg.rings?.length && top - bot > 0.5) {
      const sp: number[] = []
      for (const ring of rg.rings) {
        const n = Math.floor(ring.length / 2)
        for (let i = 0; i < n; i++) {
          const ax = ring[i * 2]
          const az = ring[i * 2 + 1]
          const bx = ring[((i + 1) % n) * 2]
          const bz = ring[((i + 1) % n) * 2 + 1]
          sp.push(ax, top, az, bx, top, bz, bx, bot, bz)
          sp.push(ax, top, az, bx, bot, bz, ax, bot, az)
        }
      }
      const sgeo = new THREE.BufferGeometry()
      sgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sp), 3))
      sgeo.computeVertexNormals()
      // Cliff face: an earthy rock tone under a map-draped top, else a shade of the tier colour.
      const sideColor = rg.src ? new THREE.Color(0x6b5a45) : new THREE.Color(color).multiplyScalar(0.72)
      const skirt = new THREE.Mesh(sgeo, new THREE.MeshBasicMaterial({ color: sideColor, side: THREE.DoubleSide, transparent, opacity }))
      scene.add(skirt)
      regionMeshes.push(skirt)
    }
  }

  // Draw the FoundryVTT-style MAP PIN — a teardrop marker (round head + point) with a cream disc for
  // the note icon — onto a 128² canvas. Each note gets its own canvas so a loaded icon can composite
  // into the disc. The sprite's bottom-centre anchor puts the pin's TIP at the note's ground point.
  function drawPin(g: CanvasRenderingContext2D) {
    const cx = 64
    const headY = 46
    const r = 34
    g.clearRect(0, 0, 128, 128)
    g.beginPath()
    g.moveTo(cx - 22, headY + 16) // point (triangle) down to the tip
    g.lineTo(cx + 22, headY + 16)
    g.lineTo(cx, 122)
    g.closePath()
    g.moveTo(cx + r, headY) // round head
    g.arc(cx, headY, r, 0, Math.PI * 2)
    g.fillStyle = '#f0b429' // amber
    g.fill()
    g.lineWidth = 5
    g.strokeStyle = 'rgba(38,24,6,0.85)'
    g.stroke()
    g.beginPath() // cream disc for the icon
    g.arc(cx, headY, 18, 0, Math.PI * 2)
    g.fillStyle = '#fff6e0'
    g.fill()
  }

  function addNote(n: ViewerNote) {
    const size = (n.size || 50) * 1.4 // pins read a touch larger than the old flat marker
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 128
    const g = canvas.getContext('2d')
    if (!g) return
    drawPin(g)
    const tex = new THREE.CanvasTexture(canvas)
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
    const sprite = new THREE.Sprite(mat)
    sprite.userData = { noteId: n.id, entryId: n.entryId, text: n.text } // for host click-to-open
    sprite.renderOrder = 10 // stay visible above geometry
    sprite.center.set(0.5, 0) // anchor the TIP (bottom) at the note position
    sprite.scale.set(size, size, 1)
    sprite.position.set(n.x || 0, 1, n.y || 0)
    sprite.visible = notesVisible
    if (n.texture) {
      getTexture(n.texture, (iconTex) => {
        const img = iconTex.image as CanvasImageSource | undefined
        if (!img) return
        g.save() // composite the entry icon inside the disc
        g.beginPath()
        g.arc(64, 46, 17, 0, Math.PI * 2)
        g.clip()
        g.drawImage(img, 47, 29, 34, 34)
        g.restore()
        tex.needsUpdate = true
        render()
      })
    }
    scene.add(sprite)
    notes.push(sprite)
  }

  function setNotesVisible(visible: boolean) {
    notesVisible = visible
    for (const s of notes) s.visible = visible
    render()
  }

  // A thick stroke as a flat ribbon MESH on the ground plane. WebGL ignores LineBasicMaterial.linewidth,
  // so a stroke width in WORLD units (Foundry-parity, scales with zoom) must be real geometry: offset
  // each vertex along its miter normal by half the width and triangulate the two rails. Core-THREE only
  // (the injected build has no examples/jsm Line2). `pts` are world XZ [x,z]; y is the ground height.
  function strokeRibbonGeometry(pts: Array<[number, number]>, halfWidth: number, yy: number, closed: boolean): ThreeNS.BufferGeometry | null {
    const n = pts.length
    if (n < 2) return null
    const edgeNormal = (i: number): [number, number] => {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      let dx = b[0] - a[0]
      let dz = b[1] - a[1]
      const len = Math.hypot(dx, dz) || 1
      dx /= len
      dz /= len
      return [-dz, dx] // left-hand perpendicular in the XZ plane
    }
    const pos: number[] = []
    for (let i = 0; i < n; i++) {
      const nIn = closed || i > 0 ? edgeNormal((i - 1 + n) % n) : null
      const nOut = closed || i < n - 1 ? edgeNormal(i) : null
      let mx: number
      let mz: number
      let scale: number
      if (nIn && nOut) {
        mx = nIn[0] + nOut[0]
        mz = nIn[1] + nOut[1]
        const ml = Math.hypot(mx, mz) || 1
        mx /= ml
        mz /= ml
        // Clamp the miter so sharp corners don't shoot spikes (cos < 0.25 → cap at 4× half-width).
        scale = halfWidth / Math.max(mx * nOut[0] + mz * nOut[1], 0.25)
      } else {
        const nn = (nIn ?? nOut) as [number, number]
        mx = nn[0]
        mz = nn[1]
        scale = halfWidth
      }
      const p = pts[i]
      pos.push(p[0] + mx * scale, yy, p[1] + mz * scale) // left rail vertex 2i
      pos.push(p[0] - mx * scale, yy, p[1] - mz * scale) // right rail vertex 2i+1
    }
    const idx: number[] = []
    const segs = closed ? n : n - 1
    for (let i = 0; i < segs; i++) {
      const a = (i % n) * 2
      const c = ((i + 1) % n) * 2
      idx.push(a, a + 1, c, a + 1, c + 1, c) // two triangles bridging rail i → i+1
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setIndex(idx)
    return geo
  }

  // A FoundryVTT Drawing on the ground plane: a stroked outline (freehand polygon / rect / ellipse)
  // with an optional fill for closed shapes. Lines + solid meshes only (disposeObject frees them).
  function addDrawing(d: ViewerDrawing) {
    const group = new THREE.Group()
    // drawingId → host picking; strokeColor → restore after a selection highlight.
    group.userData = { drawingId: d.id, strokeColor: d.strokeColor ?? 0xffdd55 }
    const ox = d.x || 0
    const oz = d.y || 0
    const y = 0.62 // just above the floor, below tokens/pins

    // TEXT drawing: a canvas-textured label sprite (itself the pick target — no outline/fill box).
    if (d.text) {
      const fs = Math.min(Math.max(d.fontSize || 28, 8), 96)
      const text = d.text.slice(0, 120)
      const canvas = document.createElement('canvas')
      const g = canvas.getContext('2d')
      if (g) {
        g.font = `bold ${fs}px sans-serif`
        const pad = Math.ceil(fs * 0.4)
        canvas.width = Math.max(2, Math.ceil(g.measureText(text).width) + pad * 2) // NB: resets ctx state
        canvas.height = Math.ceil(fs * 1.5)
        g.font = `bold ${fs}px sans-serif`
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.lineWidth = Math.max(3, fs * 0.16) // dark halo so any colour stays legible over the map
        g.strokeStyle = 'rgba(0,0,0,0.85)'
        g.strokeText(text, canvas.width / 2, canvas.height / 2)
        const col = d.textColor ?? d.strokeColor ?? 0xffffff
        g.fillStyle = `#${(col & 0xffffff).toString(16).padStart(6, '0')}`
        g.fillText(text, canvas.width / 2, canvas.height / 2)
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false }))
        sprite.renderOrder = 11
        const worldH = fs
        const sx = worldH * (canvas.width / canvas.height)
        sprite.scale.set(sx, worldH, 1)
        sprite.userData = { drawingId: d.id, baseScale: [sx, worldH] } // baseScale → restore after a highlight bump
        sprite.position.set(ox, 1.4, oz) // centred on the placement point
        group.add(sprite)
      }
      scene.add(group)
      drawingGroups.push(group)
      return
    }

    // LOCAL outline points (relative to the origin) — so `rotation` can pivot about the shape centre
    // (Foundry rotates a drawing about its bounds centre) with the geometry baked, keeping the GROUP at
    // (0,0,0) so drag-move (group.position) + picking stay simple.
    const local: Array<[number, number]> = []
    if (d.type === 'polygon' && d.points && d.points.length >= 4) {
      for (let i = 0; i + 1 < d.points.length; i += 2) local.push([d.points[i], d.points[i + 1]])
    } else if (d.type === 'rect') {
      const w = d.width || 0
      const h = d.height || 0
      local.push([0, 0], [w, 0], [w, h], [0, h])
    } else if (d.type === 'ellipse') {
      const rx = (d.width || 0) / 2
      const rz = (d.height || 0) / 2
      for (let a = 0; a < 64; a++) {
        const t = (a / 64) * Math.PI * 2
        local.push([rx + Math.cos(t) * rx, rz + Math.sin(t) * rz])
      }
    }
    const rot = ((d.rotation ?? 0) * Math.PI) / 180
    if (rot && local.length) {
      let minX = Infinity
      let maxX = -Infinity
      let minZ = Infinity
      let maxZ = -Infinity
      for (const [a, b] of local) {
        minX = Math.min(minX, a)
        maxX = Math.max(maxX, a)
        minZ = Math.min(minZ, b)
        maxZ = Math.max(maxZ, b)
      }
      const cx = (minX + maxX) / 2
      const cz = (minZ + maxZ) / 2
      const cos = Math.cos(rot)
      const sin = Math.sin(rot)
      for (const p of local) {
        const dx = p[0] - cx
        const dz = p[1] - cz
        p[0] = cx + dx * cos - dz * sin
        p[1] = cz + dx * sin + dz * cos
      }
    }
    // Fill for closed shapes (rect/ellipse) — a Shape from the (rotation-baked) local points; always
    // present as a reliable interior PICK target (~invisible when the drawing has no user fill).
    if (d.type !== 'polygon' && local.length >= 3) {
      const hasFill = d.fillColor != null && (d.fillAlpha ?? 0) > 0
      const fill = new THREE.Mesh(
        new THREE.ShapeGeometry(new THREE.Shape(local.map(([a, b]) => new THREE.Vector2(a, b)))),
        new THREE.MeshBasicMaterial({ color: hasFill ? (d.fillColor as number) : 0x000000, transparent: true, opacity: hasFill ? (d.fillAlpha as number) : 0.001, depthWrite: false, side: THREE.DoubleSide }),
      )
      fill.rotation.x = Math.PI / 2 // shape(a,b) → local(a,0,b)
      fill.position.set(ox, y - 0.02, oz)
      fill.userData = { drawingId: d.id }
      group.add(fill)
    }
    // Outline (all types) — a world-unit-thick ribbon MESH (closed for rect/ellipse). strokeWidth is
    // in scene px = world units; default 8 (Foundry's own default) when the doc carries none.
    if (local.length >= 2) {
      const isClosed = d.type !== 'polygon'
      const hw = Math.max(0.5, (d.strokeWidth ?? 8) / 2)
      const geo = strokeRibbonGeometry(local.map(([a, b]) => [ox + a, oz + b]), hw, y, isClosed)
      if (geo) {
        const stroke = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ color: d.strokeColor ?? 0xffdd55, transparent: true, opacity: d.strokeAlpha ?? 0.95, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
        )
        stroke.renderOrder = 9
        stroke.userData = { drawingId: d.id, isStroke: true } // isStroke → setDrawingHighlight recolours it
        group.add(stroke)
      }
    }
    scene.add(group)
    drawingGroups.push(group)
  }

  // Highlight one drawing as selected (brighten its outline to white); null restores all to base.
  // Highlight the selected drawing OR template (by id) — brightens its outline (drawings & templates)
  // or bumps a text label's scale; null clears. Both annotation families share this so a host has one
  // selection call. Matches userData.drawingId (drawings) or userData.templateId (templates).
  function setDrawingHighlight(id: string | null) {
    for (const g of [...drawingGroups, ...templateGroups]) {
      const on = id != null && ((g.userData?.drawingId ?? g.userData?.templateId) as string | undefined) === id
      const base = (g.userData?.strokeColor as number | undefined) ?? 0xffdd55
      for (const c of g.children) {
        const anyC = c as unknown as { isLine?: boolean; isMesh?: boolean; isSprite?: boolean; userData?: { isStroke?: boolean } }
        if (anyC.isLine) {
          const m = (c as ThreeNS.Line).material as ThreeNS.LineBasicMaterial
          m.color.setHex(on ? 0xffffff : base)
          ;(c as ThreeNS.Line).renderOrder = on ? 12 : 9
        } else if (anyC.isMesh && anyC.userData?.isStroke) {
          // The stroke is a ribbon mesh now (world-unit width); recolour it like the old line. The
          // fill mesh is also a Mesh but carries no isStroke flag, so it keeps its user fill colour.
          const m = (c as ThreeNS.Mesh).material as ThreeNS.MeshBasicMaterial
          m.color.setHex(on ? 0xffffff : base)
          ;(c as ThreeNS.Mesh).renderOrder = on ? 12 : 9
        } else if (anyC.isSprite) {
          // A text label has no outline to recolour — bump its scale so the selection is visible.
          const sp = c as ThreeNS.Sprite
          const bs = (sp.userData?.baseScale as number[] | undefined) ?? [sp.scale.x, sp.scale.y]
          const k = on ? 1.18 : 1
          sp.scale.set(bs[0] * k, bs[1] * k, 1)
          sp.renderOrder = on ? 13 : 11
        }
      }
    }
    render()
  }

  // A FoundryVTT MeasuredTemplate (AoE) on the ground plane: a translucent filled shape + outline.
  // circle = disc; cone = wedge (apex at origin); ray = a directed rectangle; rect = origin→diagonal box.
  function addTemplate(t: ViewerTemplate) {
    const group = new THREE.Group()
    // templateId → host picking; strokeColor (the border) → restore after a selection highlight.
    group.userData = { templateId: t.id, strokeColor: t.borderColor ?? 0xff3355 }
    const ox = t.x || 0
    const oz = t.y || 0
    const y = 0.64 // just above drawings
    const border = t.borderColor ?? 0xff3355
    const fill = t.fillColor ?? border
    const fillAlpha = t.fillAlpha ?? 0.2
    const dir = ((t.direction ?? 0) * Math.PI) / 180
    // Local outline points (a = worldX offset, b = worldZ offset from the origin). Shape auto-closes.
    const pts: [number, number][] = []
    if (t.type === 'circle') {
      const r = t.size || 0
      for (let a = 0; a < 64; a++) {
        const th = (a / 64) * Math.PI * 2
        pts.push([Math.cos(th) * r, Math.sin(th) * r])
      }
    } else if (t.type === 'cone') {
      const L = t.size || 0
      const spread = ((t.angle ?? 53) * Math.PI) / 180
      pts.push([0, 0])
      const steps = 32
      for (let a = 0; a <= steps; a++) {
        const th = dir - spread / 2 + (a / steps) * spread
        pts.push([Math.cos(th) * L, Math.sin(th) * L])
      }
    } else if (t.type === 'ray') {
      const L = t.size || 0
      const hw = (t.width || 0) / 2
      const px = Math.cos(dir)
      const pz = Math.sin(dir)
      const nx = -pz
      const nz = px // unit normal
      pts.push([nx * hw, nz * hw], [px * L + nx * hw, pz * L + nz * hw], [px * L - nx * hw, pz * L - nz * hw], [-nx * hw, -nz * hw])
    } else {
      // rect: origin → the diagonal endpoint (Foundry MeasuredTemplate rect).
      const dx = Math.cos(dir) * (t.size || 0)
      const dz = Math.sin(dir) * (t.size || 0)
      pts.push([0, 0], [dx, 0], [dx, dz], [0, dz])
    }
    if (pts.length >= 3) {
      // Fill: a Shape (XY) → ShapeGeometry, laid flat by rotation.x=+PI/2 (shape(a,b)→local(a,0,b)).
      const shape = new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b)))
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: fill, transparent: true, opacity: fillAlpha, depthWrite: false, side: THREE.DoubleSide }))
      mesh.rotation.x = Math.PI / 2
      mesh.position.set(ox, y - 0.01, oz)
      mesh.userData = { templateId: t.id }
      group.add(mesh)
      // Outline: a closed loop through the same points (world coords).
      const lpts = [...pts, pts[0]].map(([a, b]) => new THREE.Vector3(ox + a, y, oz + b))
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(lpts), new THREE.LineBasicMaterial({ color: border, transparent: true, opacity: 0.95, depthTest: false }))
      line.renderOrder = 10
      line.userData = { templateId: t.id }
      group.add(line)
    }
    scene.add(group)
    templateGroups.push(group)
  }

  function addTile(t: ViewerTile) {
    const width = t.width || 0
    const height = t.height || 0
    if (width < 1 || height < 1) return
    const geo = new THREE.PlaneGeometry(width, height)
    let mat: ThreeNS.MeshStandardMaterial | ThreeNS.MeshBasicMaterial
    if (t.texture) {
      const tex = getTexture(t.texture)
      mat = is2d()
        ? new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: t.alpha ?? 1, side: THREE.DoubleSide })
        : new THREE.MeshStandardMaterial({ map: tex, transparent: true, opacity: t.alpha ?? 1, side: THREE.DoubleSide, roughness: 0.95 })
    } else {
      mat = is2d()
        ? new THREE.MeshBasicMaterial({ color: t.color ?? 0x515b6b, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
        : new THREE.MeshStandardMaterial({ color: t.color ?? 0x515b6b, transparent: true, opacity: 0.9, side: THREE.DoubleSide, roughness: 0.95 })
    }
    const plane = new THREE.Mesh(geo, mat)
    plane.rotation.x = -Math.PI / 2
    // A Tile's (x,y) is already its center (default texture anchor 0.5/0.5) — don't
    // add half-size, that double-shifts it off-grid. Tiles keep their real elevation in
    // BOTH modes: straight-down, an overhead tile still covers what's under it (roofs).
    plane.position.set(t.x || 0, (t.elevation || 0) + 0.5, t.y || 0)
    if (!is2d()) {
      plane.receiveShadow = true
      plane.castShadow = true
    }
    scene.add(plane)
    tiles.push(plane)
  }

  // Resource-bar fill colour by fill ratio (Foundry-ish): green → amber → red.
  function barFillColor(ratio: number): number {
    return ratio > 0.5 ? 0x4ade80 : ratio > 0.25 ? 0xfacc15 : 0xf87171
  }

  function addToken(t: ViewerToken) {
    // Duplicate id (malformed adapter output or a delta ADD racing a reload):
    // without this, tokens.set orphans the previous group in the scene forever.
    const prev = tokens.get(t.id)
    if (prev) {
      scene.remove(prev)
      disposeObject(prev)
      tokens.delete(t.id)
    }
    const group = new THREE.Group()
    const cx = (t.x || 0) + (t.width || 0) / 2
    const cz = (t.y || 0) + (t.height || 0) / 2
    const elevation = t.elevation || 0
    group.userData = { tokenId: t.id, rotation: t.rotation ?? 0 }

    const tw = t.width || 50
    const th = t.height || 50
    const footprint = Math.max(tw, th)
    const floorElevation = t.floorElevation ?? elevation

    // Foundry `texture.fit`: size the art within its (cellW × cellH) cell given the texture's
    // NATURAL dimensions. Undefined/'fill' → stretch to the cell (historical behaviour); the
    // others preserve aspect. Returns the cell as-is when the natural size is unknown.
    const fitDims = (cellW: number, cellH: number, texW?: number, texH?: number): [number, number] => {
      const mode = t.fit
      if (!texW || !texH || !mode || mode === 'fill') return [cellW, cellH]
      const s =
        mode === 'cover'
          ? Math.max(cellW / texW, cellH / texH)
          : mode === 'width'
            ? cellW / texW
            : mode === 'height'
              ? cellH / texH
              : Math.min(cellW / texW, cellH / texH) // 'contain'
      return [texW * s, texH * s]
    }

    // ── 2D: flat token art on the map, Foundry-canvas style. ────────────────────
    // No billboard, no box body, no flight stand — and the GLB model is NEVER
    // fetched. Elevation doesn't lift the token (flat view); underground tokens
    // stay visible on the map, same as Foundry's 2D canvas.
    if (is2d()) {
      group.position.set(cx, TOKEN_2D_Y, cz)
      // 2D never FETCHES models, but the scene still references them — re-stamp
      // the cache entry so time spent in 2D doesn't age live models into a sweep
      // (a 2D↔3D flip must not refetch every GLB).
      if (t.model) {
        const me = modelCache.get(t.model)
        if (me) me.gen = generation
      }
      if (t.ring !== false) {
        // Dynamic-ring background disc (`ring.colors.background`) — a filled circle
        // behind the subject, drawn first so the ring + art sit on top of it.
        if (t.ringBackground != null) {
          const bg = new THREE.Mesh(
            pooledGeo('ringbg', () => new THREE.CircleGeometry(0.5, 32)),
            new THREE.MeshBasicMaterial({ color: t.ringBackground, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }),
          )
          bg.scale.set(tw, th, 1)
          bg.rotation.x = -Math.PI / 2
          bg.position.set(0, 0.05, 0)
          group.add(bg)
        }
        // Pooled unit ring (radii 0.34→0.5) scaled to the footprint — identical
        // vertices to a per-token RingGeometry. Scaled non-uniformly (tw×th) so a
        // 2×1 token's ring hugs its cells instead of overhanging as a square.
        // `ringColor` (Dynamic Ring `ring.colors.ring`) overrides the disposition tint.
        const ring = new THREE.Mesh(
          pooledGeo('ring', () => new THREE.RingGeometry(0.34, 0.5, 32)),
          new THREE.MeshBasicMaterial({ color: t.ringColor ?? t.color ?? 0x6a90c0, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
        )
        ring.scale.set(tw, th, 1)
        ring.rotation.x = -Math.PI / 2
        ring.position.set(0, 0.1, 0)
        group.add(ring)
      }
      const alpha2d = t.alpha ?? 1
      const artMat = new THREE.MeshBasicMaterial({
        color: t.texture ? (t.tint ?? 0xffffff) : (t.color ?? 0x6a90c0),
        transparent: true,
        opacity: (t.texture ? 1 : 0.9) * alpha2d,
        alphaTest: t.texture && alpha2d >= 1 ? 0.3 : 0, // cut art fringe when opaque; blend smoothly when dimmed
        side: THREE.DoubleSide,
      })
      const art = new THREE.Mesh(pooledGeo('quad', () => new THREE.PlaneGeometry(1, 1)), artMat)
      // texture.scaleX/scaleY: sign on X mirrors the art; |Y| keeps it upright.
      // artScale (Dynamic Ring `ring.subject.scale`) sizes the portrait within its ring.
      const aScale2d = t.artScale ?? 1
      // Pre-load: stretch to the cell (fill). Re-scaled with `fit` in the texture callback below
      // once the natural size is known. Untextured (colour) tokens keep this footprint.
      art.scale.set(tw * (t.textureScaleX ?? 1) * aScale2d, th * Math.abs(t.textureScaleY ?? 1) * aScale2d, 1)
      art.rotation.x = -Math.PI / 2
      // Token facing: after laying the quad flat, spin it in the ground plane about world-up.
      // Sign matches the levels-quad convention (Foundry rotation is clockwise-from-north).
      if (t.rotation) art.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), -(t.rotation * Math.PI) / 180)
      art.position.set(0, 0.5, 0)
      group.add(art)
      if (t.texture) {
        getTexture(t.texture, (tex) => {
          artMat.map = tex
          artMat.needsUpdate = true
          const im = tex.image as { width?: number; height?: number } | undefined
          const [fw, fh] = fitDims(tw, th, im?.width, im?.height)
          art.scale.set(fw * (t.textureScaleX ?? 1) * aScale2d, fh * Math.abs(t.textureScaleY ?? 1) * aScale2d, 1)
          render()
        })
      }
      // Resource pools UNDER the token (Foundry bar1/bar2 parity) — a stacked bg+fill strip just below
      // the token's bottom edge (+z = "south"/down on the 2D canvas). Solid meshes (no canvas texture),
      // children of the group so they move with it; disposeObject frees the per-bar materials.
      if (t.bars?.length) {
        const barW = tw * 0.92
        const barH = th * 0.15
        const gap = th * 0.05
        const topZ = th / 2 + th * 0.08 // just clear of the token footprint
        t.bars.forEach((bar, i) => {
          const ratio = bar.max > 0 ? Math.max(0, Math.min(1, bar.value / bar.max)) : 0
          const zc = topZ + i * (barH + gap) + barH / 2
          const bg = new THREE.Mesh(pooledGeo('quad', () => new THREE.PlaneGeometry(1, 1)), new THREE.MeshBasicMaterial({ color: 0x0b0b0f, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }))
          bg.rotation.x = -Math.PI / 2
          bg.scale.set(barW, barH, 1)
          bg.position.set(0, 0.55, zc)
          group.add(bg)
          const fillW = Math.max(0.0001, barW * ratio)
          const fill = new THREE.Mesh(pooledGeo('quad', () => new THREE.PlaneGeometry(1, 1)), new THREE.MeshBasicMaterial({ color: bar.color ?? barFillColor(ratio), transparent: true, opacity: 0.96, depthWrite: false, side: THREE.DoubleSide }))
          fill.rotation.x = -Math.PI / 2
          fill.scale.set(fillW, barH * 0.72, 1)
          fill.position.set(-(barW - fillW) / 2, 0.56, zc) // left-align the fill within the bg
          group.add(fill)
        })
      }
      scene.add(group)
      tokens.set(t.id, group)
      return
    }

    // ── 3D: full body (billboard/box/GLB) + ring + flight stand. ────────────────
    group.position.set(cx, elevation, cz)

    // Disposition-tinted base ring on the token's floor — a ring (not a disc) so the
    // floor/grid shows through. A child of the group, positioned relative to elevation.
    // Non-uniform (tw×th) scale so a non-square token's ring hugs its footprint;
    // `ringColor`/`ringBackground` carry the Dynamic Token Ring's own colours.
    if (t.ring !== false) {
      if (t.ringBackground != null) {
        const bg = new THREE.Mesh(
          pooledGeo('ringbg', () => new THREE.CircleGeometry(0.5, 32)),
          new THREE.MeshBasicMaterial({ color: t.ringBackground, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }),
        )
        bg.scale.set(tw, th, 1)
        bg.rotation.x = -Math.PI / 2
        bg.position.set(0, floorElevation - elevation + 0.45, 0)
        group.add(bg)
      }
      const ring = new THREE.Mesh(
        pooledGeo('ring', () => new THREE.RingGeometry(0.34, 0.5, 32)),
        new THREE.MeshBasicMaterial({ color: t.ringColor ?? t.color ?? 0x6a90c0, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
      )
      ring.scale.set(tw, th, 1)
      ring.rotation.x = -Math.PI / 2
      ring.position.set(0, floorElevation - elevation + 0.5, 0)
      group.add(ring)
    }

    // Selection highlight — the viewer controls this token → a bright ring at the floor.
    if (t.selected) {
      const sel = new THREE.Mesh(
        new THREE.RingGeometry(0.52, 0.62, 40),
        new THREE.MeshBasicMaterial({ color: 0x49e0ff, transparent: true, opacity: 0.92, depthWrite: false, side: THREE.DoubleSide }),
      )
      sel.scale.set(footprint, footprint, 1)
      sel.rotation.x = -Math.PI / 2
      sel.position.set(0, floorElevation - elevation + 0.6, 0)
      group.add(sel)
    }
    // Target reticle — the viewer is aiming at this token (attack/spell) → a coloured
    // halo floating above it, readable from any angle.
    if (t.targeted) {
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.32, 0.5, 32),
        new THREE.MeshBasicMaterial({ color: t.targetColor ?? 0xff4b4b, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }),
      )
      halo.scale.set(footprint, footprint, 1)
      halo.rotation.x = -Math.PI / 2
      halo.position.set(0, Math.max(th, footprint) * 1.2, 0)
      group.add(halo)
    }

    // Flight-stand post from the floor to the mini, only when they differ — no
    // clutter for the common on-the-ground case. Above the floor (flying), the post
    // connects the mini's FEET (local y=0, its lowest point) down to the floor — a
    // stand planted in the ground supporting a floating mini. Below the floor
    // (elevation < floorElevation, e.g. underground/burrowing), the anchor flips: the
    // post connects the mini's TOP (its closest point to the surface) up to the floor,
    // so it reads as hanging from the surface by its head rather than a pole piercing
    // down through the mini to its feet. `footprint` approximates the mini's own
    // rendered height (matches the billboard/box fallback sizing below). If the mini's
    // own body already reaches the floor (a shallow burrow, top >= floor), no post is
    // drawn at all — the mini's body already bridges the gap.
    const lift = elevation - floorElevation
    const floorLocalY = -lift // the floor's Y position in the group's local space
    let yHi = 0 // the stalk's higher endpoint (local Y)
    let yLo = 0 // the stalk's lower endpoint (local Y)
    if (lift > 1) {
      // Flying: floor is below the feet (floorLocalY < 0) — post spans feet down to floor.
      yHi = 0
      yLo = floorLocalY
    } else if (lift < -1 && floorLocalY >= footprint) {
      // Fully underground: floor is above even the token's top — post spans top up to floor.
      yHi = floorLocalY
      yLo = footprint
    }
    if (yHi - yLo > 1) {
      const stalk = new THREE.Mesh(
        pooledGeo('stalk', () => new THREE.CylinderGeometry(2, 2, 1, 6)),
        new THREE.MeshBasicMaterial({ color: 0xffc107, transparent: true, opacity: 0.5 }),
      )
      stalk.scale.set(1, yHi - yLo, 1)
      stalk.position.set(0, (yHi + yLo) / 2, 0)
      group.add(stalk)
    }

    // Body: an optional glTF/GLB model, else a billboard (textured if `texture` is
    // set, else a plain tinted box). The billboard is also the model's failure fallback.
    // The group joins the scene BEFORE its body loads: cached assets call back
    // synchronously, and async arrivals guard on group.parent — a token removed
    // (delta or scene switch) while its asset was in flight is detached, so the
    // arrival must not build into it.
    scene.add(group)
    tokens.set(t.id, group)
    const alpha = t.alpha ?? 1
    const translucent = alpha < 1
    const addBillboard = (tex: ThreeNS.Texture | null) => {
      if (!group.parent) return
      // A textured token is normally an ALPHA-TESTED OPAQUE cutout (transparent:false,
      // alphaTest 0.5): it renders in the OPAQUE pass, writing colour+depth ONLY where the art
      // is solid; its transparent background is discarded. That keeps it OUT of the transparent
      // pass — where it would share unreliable depth ordering with the (also-transparent) walls
      // and punch holes at its edges (#166).
      // When the token is DIMMED (alpha < 1 — e.g. a hidden token shown to the GM, or a
      // ghost/incorporeal doc.alpha), it must instead BLEND: transparent + reduced opacity,
      // alphaTest 0 (smooth edges, not the "rough opaque core" a post-opacity cutoff gives),
      // depthWrite OFF (its transparent corners must not punch holes in the wall/glow behind),
      // and a renderOrder above the walls so the blend order — and thus how see-through it
      // looks — stays consistent as the camera orbits (the walls still WRITE depth, so a wall
      // genuinely in front still occludes it). Baked at creation → robust to async art arrival.
      const mat = new THREE.SpriteMaterial({
        map: tex || undefined,
        color: tex ? (t.tint ?? 0xffffff) : (t.color ?? 0x6a90c0),
        transparent: !tex || translucent,
        opacity: alpha,
        alphaTest: tex && !translucent ? 0.5 : 0,
        depthWrite: !translucent,
      })
      const sprite = new THREE.Sprite(mat)
      if (translucent) sprite.renderOrder = 20
      const billboardH = Math.max(th, footprint)
      // texture.scaleX/scaleY: sign on X mirrors the art (facing); |Y| keeps the mini upright.
      // artScale (Dynamic Ring `ring.subject.scale`) sizes the portrait within its ring. `fit`
      // frames the art within the cell by its natural size (tex already loaded here).
      const aScale = t.artScale ?? 1
      const bim = tex?.image as { width?: number; height?: number } | undefined
      const [bw, bh] = fitDims(tw, billboardH, bim?.width, bim?.height)
      sprite.scale.set(bw * (t.textureScaleX ?? 1) * aScale, bh * Math.abs(t.textureScaleY ?? 1) * aScale, 1)
      sprite.position.set(0, bh / 2, 0)
      group.add(sprite)
      render()
    }
    const addBox = () => {
      if (!group.parent) return
      const box = new THREE.Mesh(pooledGeo('box', () => new THREE.BoxGeometry(1, 1, 1)), new THREE.MeshStandardMaterial({ color: t.color ?? 0x6a90c0, roughness: 0.8, transparent: translucent, opacity: alpha }))
      box.scale.set(tw * 0.8, 40, th * 0.8)
      box.position.y = 20
      group.add(box)
    }
    const loadBillboardArt = () => {
      if (!t.texture) return addBox()
      getTexture(
        t.texture,
        (tex) => addBillboard(tex),
        () => addBox(),
      )
    }
    if (t.model && GLTFLoader) {
      getModel(
        t.model,
        (model) => {
          try {
            if (!group.parent) return
            // getModel delivered a ready-to-own object (a GPU-sharing clone of
            // the cached prototype, or a private parse for skinned models) —
            // per-token scale/rotation applies to it directly.
            const userScale = Number.isFinite(t.modelScale) ? (t.modelScale as number) : 1
            let box = new THREE.Box3().setFromObject(model)
            const size = new THREE.Vector3()
            box.getSize(size)
            const maxHoriz = Math.max(size.x, size.z) || 1
            model.scale.setScalar((footprint / maxHoriz) * userScale)
            // GLB yaw = authoring rotation (modelRotation) + the token's facing (rotation).
            if (t.modelRotation || t.rotation) model.rotation.y = ((t.modelRotation || 0) - (t.rotation || 0)) * (Math.PI / 180)
            box = new THREE.Box3().setFromObject(model)
            model.position.y -= box.min.y
            if (translucent) {
              // Dimmed (hidden/ghost) GLB: blend its materials. depthWrite stays ON — a solid
              // model isn't a flat cutout quad, so it self-sorts fine and shouldn't punch holes.
              model.renderOrder = 20
              model.traverse((o: ThreeNS.Object3D) => {
                const mm = (o as ThreeNS.Mesh).material as ThreeNS.Material | ThreeNS.Material[] | undefined
                if (!mm) return
                for (const one of Array.isArray(mm) ? mm : [mm]) {
                  one.transparent = true
                  one.opacity = alpha
                  one.needsUpdate = true
                }
              })
            }
            group.add(model)
            render()
          } catch {
            loadBillboardArt()
          }
        },
        () => loadBillboardArt(),
      )
    } else {
      loadBillboardArt()
    }
  }

  /** Frame the whole scene so a load is visible without setup: the perspective camera
   * from an angled bird's-eye, the 2D ortho camera straight down over the bounds. */
  function frameCamera() {
    const { cx, cz } = boundsCenter()
    const span = Math.max(bounds.width, bounds.height)
    camera.position.set(cx, span * 0.9, cz + span * 0.75)
    camera.lookAt(cx, 0, cz)
    camera.updateProjectionMatrix()
    frameCamera2d()
  }

  /** Fit the 2D ortho frustum to `bounds` at the renderer's current aspect. Separate
   * from frameCamera() so resize() can refit it WITHOUT stomping the host's
   * perspective-camera state (OrbitControls orbits, tracked/first-person poses). */
  function frameCamera2d() {
    const { cx, cz } = boundsCenter()
    const span = Math.max(bounds.width, bounds.height)
    const size = renderer.getSize(new THREE.Vector2())
    const aspect = size.y > 0 ? size.x / size.y : 1
    const halfH = span * 0.55
    const halfW = halfH * Math.max(aspect, 1)
    camera2d.left = -halfW
    camera2d.right = halfW
    camera2d.top = halfH
    camera2d.bottom = -halfH
    camera2d.position.set(cx, span * 2, cz)
    camera2d.lookAt(cx, 0, cz)
    camera2d.updateProjectionMatrix()
  }

  function buildGrid(json: ViewerScene) {
    if (!json.grid?.showHelper) return
    const size = json.grid.size || 100
    const color = json.grid.color ?? 0x6688aa
    const opacity = json.grid.opacity ?? 0.35
    // Over terrain, the flat grid plane would be buried by raised ground — drape the grid
    // lines over the surface instead so they stay visible at any elevation.
    if (terrainField && !is2d()) {
      gridDraped = { size, color, opacity }
      grid = buildDrapedGrid(size, color, opacity)
      return
    }
    gridDraped = null
    const span = Math.max(bounds.width, bounds.height)
    const divisions = Math.max(1, Math.round(span / size))
    const g = new THREE.GridHelper(span, divisions, color, color)
    const { cx: gcx, cz: gcz } = boundsCenter()
    g.position.set(gcx, 0.5, gcz)
    if (g.material) {
      const mat = g.material as ThreeNS.Material & { transparent: boolean; opacity: number }
      mat.transparent = true
      mat.opacity = opacity
    }
    scene.add(g)
    grid = g
  }

  /**
   * A square grid that follows the terrain surface: line segments sampled finely along each
   * grid line and lifted to the terrain height (+a hair, to sit just above it). Lines are
   * placed at world multiples of the scene grid size, so they line up with Foundry's grid.
   */
  function buildDrapedGrid(size: number, color: number, opacity: number): ThreeNS.Object3D {
    const w = bounds.width
    const h = bounds.height
    const { cx, cz } = boundsCenter()
    const x0 = cx - w / 2
    const z0 = cz - h / 2
    const x1 = x0 + w
    const z1 = z0 + h
    const sub = Math.max(1, Math.round(size / 45)) // samples per cell — enough to hug slopes
    const seg = size / sub
    const yAt = (x: number, z: number) => terrainHeightAt(x, z) + 2
    const pts: number[] = []
    for (let x = Math.ceil(x0 / size) * size; x <= x1 + 0.01; x += size) {
      for (let z = z0; z < z1 - 0.01; z += seg) {
        const z2 = Math.min(z1, z + seg)
        pts.push(x, yAt(x, z), z, x, yAt(x, z2), z2)
      }
    }
    for (let z = Math.ceil(z0 / size) * size; z <= z1 + 0.01; z += size) {
      for (let x = x0; x < x1 - 0.01; x += seg) {
        const x2 = Math.min(x1, x + seg)
        pts.push(x, yAt(x, z), z, x2, yAt(x2, z), z)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3))
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }))
    lines.renderOrder = 1
    scene.add(lines)
    return lines
  }

  function loadScene(json: ViewerScene) {
    lastScene = json
    generation++ // new mark epoch — everything this build touches survives the sweep
    clear()
    bounds = json?.bounds || bounds
    scene.background = json?.background?.color != null ? new THREE.Color(json.background.color) : null
    // 2D is UNLIT (flat Foundry-canvas look, all-Basic materials) — no lights at all.
    if (!is2d()) applyAmbient(json?.ambient)

    if (json?.terrain && !is2d()) {
      // Continuous heightmap terrain replaces the flat map floor (3D only; 2D keeps the flat map).
      addTerrain(json.terrain)
    } else if (json?.levels?.length) {
      for (const lv of json.levels) addLevel(lv)
    } else if (is2d()) {
      // Flat unlit fallback floor — no grazing angles exist straight-down.
      const g = new THREE.Mesh(new THREE.PlaneGeometry(bounds.width, bounds.height), new THREE.MeshBasicMaterial({ color: 0x2a3340 }))
      g.rotation.x = -Math.PI / 2
      const { cx: gcx, cz: gcz } = boundsCenter()
      g.position.set(gcx, 0, gcz)
      scene.add(g)
      ground = g
    } else {
      // A zero-thickness plane's projected silhouette shrinks toward zero width at
      // grazing/underside viewing angles — from below it reads as a thin sliver with
      // the wall/tokens floating over a void, not a solid floor. Give it real thickness
      // instead — kept thin so it still reads as Foundry's native flat floor, not a
      // chunky platform.
      const thickness = 6
      // Unlit like the map floor (see addLevel) so it isn't dimmed by the physical
      // lights; use the scene's own background colour so it matches Foundry's canvas.
      const g = new THREE.Mesh(
        new THREE.BoxGeometry(bounds.width, thickness, bounds.height),
        new THREE.MeshBasicMaterial({ color: json?.background?.color ?? 0x3a4658 }),
      )
      const { cx: gcx, cz: gcz } = boundsCenter()
      g.position.set(gcx, -thickness / 2, gcz) // top face at y=0, extends downward
      g.receiveShadow = true
      scene.add(g)
      ground = g
    }
    buildGrid(json)
    if (!is2d()) {
      allPointLights = json?.lights || []
      applyLightBudget()
    }
    for (const rg of json?.regions || []) addRegion(rg) // terrain first — floors under tokens/tiles
    for (const t of json?.tokens || []) addToken(t)
    for (const wl of json?.walls || []) addWall(wl)
    flushWalls()
    for (const t of json?.tiles || []) addTile(t)
    for (const n of json?.notes || []) addNote(n)
    for (const d of json?.drawings || []) addDrawing(d)
    for (const tp of json?.templates || []) addTemplate(tp)
    collectGarbage(2) // grace window: free entries TWO consecutive builds ignored
    frameCamera()
    render()
  }

  /** Switch flat-2D ↔ full-3D. Rebuilds the last-loaded scene in the new mode —
   * so a session that never enters '3d' never fetches GLB models. */
  function setMode(next: ViewerMode) {
    const m: ViewerMode = next === '2d' ? '2d' : '3d'
    if (m === mode) return
    mode = m
    if (lastScene) loadScene(lastScene)
    else {
      frameCamera()
      render()
    }
  }

  /** Incremental update — move/add/remove tokens without a full reload. */
  function applyDelta(delta: ViewerDelta) {
    for (const t of delta?.tokens || []) {
      if (t.remove) {
        const g = tokens.get(t.id)
        if (g) {
          scene.remove(g)
          disposeObject(g)
          tokens.delete(t.id)
        }
        continue
      }
      const g = tokens.get(t.id)
      if (g) {
        const cx = (t.x || 0) + (t.width || 0) / 2
        const cz = (t.y || 0) + (t.height || 0) / 2
        // 2D keeps tokens flat just above the map regardless of elevation.
        g.position.set(cx, is2d() ? TOKEN_2D_Y : t.elevation || 0, cz)
      } else {
        addToken(t)
      }
    }
    render()
  }

  function getSceneGraph(): SceneGraph {
    return {
      mode,
      tokenCount: tokens.size,
      wallCount: wallSemantics.length,
      hasGround: !!ground,
      hasTerrain: !!terrainMesh,
      levelCount: levels.length,
      lightCount: lights.length,
      noteCount: notes.length,
      tileCount: tiles.length,
      hasGrid: !!grid,
      tokens: [...tokens.entries()].map(([id, g]) => ({
        id,
        pos: [Math.round(g.position.x), Math.round(g.position.y), Math.round(g.position.z)],
      })),
      walls: wallSemantics.map((wl) => ({
        // The requested semantic band — render geometry is instanced, so the
        // reporting source of truth is the semantics list, not mesh transforms.
        pos: [Math.round(wl.x), Math.round(wl.semanticY), Math.round(wl.z)] as [number, number, number],
        height: Math.round(wl.semanticHeight),
        kind: wl.kind,
        ...(wl.doorState ? { doorState: wl.doorState } : {}),
      })),
    }
  }

  function resize(nw?: number, nh?: number) {
    const ww = nw || element.clientWidth || w
    const hh = nh || element.clientHeight || h
    renderer.setSize(ww, hh, false)
    camera.aspect = ww / hh
    camera.updateProjectionMatrix()
    frameCamera2d() // re-fit the 2D ortho frustum only — never stomp the host's 3D camera
    render()
  }

  let lastRenderT = 0
  function render() {
    const t = typeof performance !== 'undefined' ? performance.now() : 0
    // fps cap: skip this frame if we rendered too recently. Only throttles a
    // rapid (continuous) caller — an on-demand host whose calls are already
    // spaced wider than the cap renders every time. (#166)
    if (fpsCap && t && lastRenderT && t - lastRenderT < 1000 / fpsCap - 1) return
    renderer.render(scene, is2d() ? camera2d : camera)
    // Frame-budget governor (#166): the interval between renders during active
    // interaction is the real frame time. Hold the target by scaling resolution
    // (then shadows). 2D mode is unlit/cheap — leave it alone.
    if (t && !is2d()) {
      const dt = lastRenderT ? t - lastRenderT : 0
      lastRenderT = t
      // Governor trims ONLY render resolution — cheap + smooth, no shader recompile.
      // Shadows/lights are fixed per tier so there's no per-frame thrash.
      if (dt > 0 && governor.sample(dt)) {
        renderScale = governor.state.renderScale
        applyPixelRatio()
      }
    }
  }

  /** Current adaptive-quality snapshot (#166) — tier + live governor state. */
  function getQuality() {
    return { tier, renderScale, shadows: shadowsOn, maxLights: Math.min(preset.maxLights, uniformLightCeiling), antialias: preset.antialias, fpsCap }
  }

  /** Set (or clear with null) the render-rate cap at runtime (#166). Retargets
   * the governor to the new frame budget without disturbing the current scale. */
  function setFpsCap(fps: number | null) {
    fpsCap = fps && fps > 0 ? fps : null
    governor.setTarget(budgetMs())
  }

  /** Pin a quality tier at runtime (a host "Performance" setting). Re-applies pixel
   * ratio, shadows, and the light budget; resets the governor's dynamic scale. */
  function setQuality(t: QualityTier) {
    tier = t
    preset = QUALITY_PRESETS[t]
    uniformLightCeiling = Math.min(uniformLightCeiling, preset.maxLights)
    renderScale = 1
    shadowsOn = shadows !== undefined ? shadows : preset.shadows
    applyPixelRatio()
    renderer.shadowMap.enabled = shadowsOn
    applyLightBudget()
    render()
  }

  function getMemoryStats(): ViewerMemoryStats {
    let texturesLoading = 0
    for (const e of textureCache.values()) if (e.state === 'loading') texturesLoading++
    let modelsLoading = 0
    for (const e of modelCache.values()) if (e.state === 'loading') modelsLoading++
    const info = renderer.info?.memory
    return {
      texturesCached: textureCache.size,
      texturesLoading,
      modelsCached: modelCache.size,
      modelsLoading,
      pooledGeometries: geoPool.size,
      gpuTextures: info?.textures ?? 0,
      gpuGeometries: info?.geometries ?? 0,
      lastGC: { ...lastGC },
    }
  }

  function dispose() {
    clear()
    for (const entry of textureCache.values()) {
      entry.swept = true
      entry.tex.dispose()
    }
    textureCache.clear()
    for (const entry of modelCache.values()) {
      entry.swept = true
      if (entry.proto) disposeModelProto(entry.proto)
    }
    modelCache.clear()
    for (const g of geoPool.values()) g.dispose()
    geoPool.clear()
    pooledGeos.clear()
    renderer.dispose()
    if (renderer.domElement?.parentNode === element) element.removeChild(renderer.domElement)
  }

  return { loadScene, applyDelta, getSceneGraph, resize, render, dispose, setMode, gc: collectGarbage, getMemoryStats, getQuality, setQuality, setFpsCap, raycastTerrain, updateTerrainHeights, getTerrainHeights: () => (terrainField ? terrainField.heights.slice() : null), showBrushCursor, hideBrushCursor, showReticle, hideReticle, terrainCellToWorld, getGridSize: () => lastScene?.grid?.size ?? 100, setNotesVisible, scene, camera, camera2d, renderer, tokens, notes, drawings: drawingGroups, setDrawingHighlight, templates: templateGroups }
}
