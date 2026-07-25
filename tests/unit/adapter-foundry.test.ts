import { convertFoundryScene, dispositionColor, foundrySceneToViewer } from '@/adapter-foundry'

// A plain object shaped like a Foundry Scene doc (grid 100px = 5ft → 20px/ft).
const FOUNDRY_SCENE = {
  grid: { size: 100, distance: 5 },
  width: 3000,
  height: 3000,
  backgroundColor: '#223044',
  tokens: [
    { _id: 't1', x: 500, y: 500, width: 1, height: 1, elevation: 0, disposition: 1 }, // 1×1 grid → 100px
    { _id: 't2', x: 1000, y: 800, width: 2, height: 2, elevation: 10, disposition: -1 }, // 2×2 → 200px, +10ft → 200px up
  ],
  walls: [
    { _id: 'w1', c: [0, 0, 500, 0] }, // no wall-height, no levels → default 2-grid tall = 200px
    { _id: 'w2', c: [1000, 0, 1000, 500], flags: { 'wall-height': { bottom: 0, top: 30 } } }, // 30ft → 600px
  ],
}

// Full-parity fixture mirroring the plugin's CFG 3D Test seed shape: two Levels,
// an ambient light, token light/models/hidden/secret, tiles, notes, darkness.
const PARITY_SCENE = {
  grid: { size: 100, distance: 5, type: 1, color: '#000000', alpha: 0.2 },
  width: 2000,
  height: 2000,
  padding: 0.25,
  backgroundColor: '#4f7a46',
  environment: { darknessLevel: 0.25 },
  levels: [
    { _id: 'lg', name: 'Ground', sort: 0, elevation: { bottom: 0, top: 20 }, background: { src: 'worlds/w/ground.png' } },
    { _id: 'lu', name: 'Upper', sort: 10, elevation: { bottom: 20, top: 40 }, background: { src: 'worlds/w/upper.png' }, foreground: { src: 'worlds/w/roof.png' } },
  ],
  lights: [
    { _id: 'al', x: 1500, y: 1350, elevation: 0, config: { dim: 28, bright: 14, color: '#ff8a3d', luminosity: 0.5 } },
    { _id: 'hidden-l', x: 1, y: 1, hidden: true, config: { dim: 10, bright: 5 } },
  ],
  tokens: [
    {
      _id: 'center',
      x: 1450,
      y: 1450,
      width: 1,
      height: 1,
      elevation: 0,
      disposition: 1,
      level: 'lg',
      texture: { src: 'icons/hero.png' },
      light: { dim: 26, bright: 13, color: '#ffce8a', luminosity: 0.4 },
    },
    { _id: 'upstairs', x: 1500, y: 1300, width: 1, height: 1, elevation: 30, disposition: -1, level: 'lu' },
    { _id: 'burrower', x: 1600, y: 1450, width: 1, height: 1, elevation: -15, disposition: 0, flags: { levels: { rangeBottom: 0 } } },
    { _id: 'tree', x: 1150, y: 1650, width: 2, height: 2, elevation: 0, disposition: 0, flags: { 'crit-fumble-core': { modelSrc: 'worlds/w/tree.glb', modelScale: 1.5, modelRotation: 90 } } },
    { _id: 'sneaky', x: 100, y: 100, width: 1, height: 1, hidden: true, disposition: 0, light: { dim: 20, bright: 10 } },
    { _id: 'secret', x: 200, y: 200, width: 1, height: 1, disposition: -2 },
  ],
  walls: [
    { _id: 'wl', c: [1000, 1000, 2000, 1000] }, // unflagged → union of level bands 0..40ft = 0..800px
    { _id: 'we', c: [2000, 1000, 2000, 2000], flags: { 'wall-height': { bottom: 0, top: 30 } } },
  ],
  tiles: [
    { _id: 'rug', x: 1100, y: 1600, width: 320, height: 320, elevation: 0 },
    { _id: 'platform', x: 1380, y: 1180, width: 360, height: 360, flags: { levels: { rangeBottom: 20 } } },
    { _id: 'hidden-tile', x: 1, y: 1, width: 100, height: 100, hidden: true },
  ],
  notes: [{ _id: 'quest', x: 1750, y: 1300, iconSize: 60, texture: { src: 'icons/svg/book.svg' } }],
}

describe('dispositionColor', () => {
  it('matches the Foundry CONFIG.Canvas.dispositionColors default palette', () => {
    expect(dispositionColor(1)).toBe(0x43dfdf) // FRIENDLY (no player owner)
    expect(dispositionColor(1, true)).toBe(0x33bc4e) // PARTY (player-owned)
    expect(dispositionColor(-1)).toBe(0xe72124) // HOSTILE
    expect(dispositionColor(0)).toBe(0xf1d836) // NEUTRAL
    expect(dispositionColor(-2)).toBe(0xa612d4) // SECRET
    expect(dispositionColor(undefined)).toBe(0x555555) // INACTIVE
  })
})

describe('foundrySceneToViewer (base conversions)', () => {
  it('converts grid size, padded bounds, and background colour', () => {
    const v = foundrySceneToViewer(FOUNDRY_SCENE)
    expect(v.grid?.size).toBe(100)
    // padding default 0.25 → origin ceil(0.25·3000/100)·100 = 800
    expect(v.bounds).toEqual({ width: 3000, height: 3000, x: 800, y: 800 })
    expect(v.background?.color).toBe(0x223044)
  })

  it('converts token grid-units → px and elevation distance-units → px', () => {
    const v = foundrySceneToViewer(FOUNDRY_SCENE)
    const t1 = v.tokens?.find((t) => t.id === 't1')
    const t2 = v.tokens?.find((t) => t.id === 't2')
    expect(t1).toMatchObject({ x: 500, y: 500, width: 100, height: 100, elevation: 0, color: 0x43dfdf })
    expect(t2).toMatchObject({ x: 1000, y: 800, width: 200, height: 200, elevation: 200, color: 0xe72124 })
    // texture.fit defaults to Foundry 'contain' (aspect-preserving)
    expect(t1?.fit).toBe('contain')
  })

  it('honours an explicit texture.fit', () => {
    const scene = { grid: { size: 100, distance: 5 }, width: 1000, height: 1000, tokens: [{ _id: 'f', x: 0, y: 0, width: 1, height: 1, texture: { src: 'a.png', fit: 'cover' } }] }
    expect(foundrySceneToViewer(scene).tokens?.find((x) => x.id === 'f')?.fit).toBe('cover')
  })

  it('a Dynamic Token Ring carries subject texture + ring/background colours + subject scale', () => {
    const scene = {
      grid: { size: 100, distance: 5 },
      width: 1000,
      height: 1000,
      tokens: [
        {
          _id: 'r',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          disposition: 1,
          texture: { src: 'raw.png' },
          ring: { enabled: true, colors: { ring: '#ff0000', background: '#00ff00' }, subject: { texture: 'subject.png', scale: 1.5 } },
        },
      ],
    }
    const t = foundrySceneToViewer(scene).tokens?.find((x) => x.id === 'r')
    expect(t).toMatchObject({ texture: 'subject.png', ringColor: 0xff0000, ringBackground: 0x00ff00, artScale: 1.5 })
    // Ring off → raw art, no ring-colour/scale overrides.
    const off = foundrySceneToViewer({ ...scene, tokens: [{ ...scene.tokens[0], ring: { enabled: false } }] }).tokens?.find((x) => x.id === 'r')
    expect(off?.texture).toBe('raw.png')
    expect(off?.ringColor).toBeUndefined()
    expect(off?.ringBackground).toBeUndefined()
    expect(off?.artScale).toBeUndefined()
  })

  it('converts wall-height flags to px top/bottom, defaulting to a 2-grid wall when absent', () => {
    const v = foundrySceneToViewer(FOUNDRY_SCENE)
    const w1 = v.walls?.find((w) => w.id === 'w1')
    const w2 = v.walls?.find((w) => w.id === 'w2')
    expect(w1).toMatchObject({ x1: 0, y1: 0, x2: 500, y2: 0, bottom: 0, top: 200 })
    expect(w2).toMatchObject({ x1: 1000, y1: 0, x2: 1000, y2: 500, bottom: 0, top: 600 })
  })

  it('reads collections from Foundry EmbeddedCollection-shaped {contents} objects', () => {
    const v = foundrySceneToViewer({
      grid: { size: 100, distance: 5 },
      tokens: { contents: [{ _id: 'a', x: 0, y: 0 }] } as any,
      walls: { contents: [{ _id: 'w', c: [0, 0, 100, 0] }] } as any,
    })
    expect(v.tokens?.map((t) => t.id)).toEqual(['a'])
    expect(v.walls?.map((w) => w.id)).toEqual(['w'])
  })

  it('falls back to sane defaults for an empty scene', () => {
    const v = foundrySceneToViewer()
    expect(v.grid?.size).toBe(100)
    expect(v.bounds).toMatchObject({ width: 2000, height: 2000 })
    expect(v.background).toEqual({})
    expect(v.tokens).toEqual([])
    expect(v.walls).toEqual([])
  })
})

describe('convertFoundryScene (full parity)', () => {
  const resolveUrl = (p: string) => `/assets/${p}`

  it('emits levels with band elevations, roofs at finite tops only, and resolved srcs', () => {
    const { scene } = convertFoundryScene(PARITY_SCENE, { resolveUrl })
    expect(scene.levels).toHaveLength(3) // ground bottom, upper bottom, upper roof
    const [g, u, roof] = scene.levels!
    expect(g).toMatchObject({ elevation: 0, which: 'bottom', src: '/assets/worlds/w/ground.png' })
    expect(u).toMatchObject({ elevation: 400, which: 'bottom', src: '/assets/worlds/w/upper.png' })
    expect(roof).toMatchObject({ elevation: 800, which: 'top', src: '/assets/worlds/w/roof.png' })
  })

  it('skips a roof on an open (null-top) band', () => {
    const { scene } = convertFoundryScene(
      { grid: { size: 100, distance: 5 }, levels: [{ _id: 'l', elevation: { bottom: 0, top: null }, background: { src: 'a.png' }, foreground: { src: 'r.png' } }] },
      { resolveUrl },
    )
    expect(scene.levels).toHaveLength(1)
    expect(scene.levels?.[0].which).toBe('bottom')
  })

  it('computes token floorElevation from its Level, else flags.levels.rangeBottom, else 0', () => {
    const { scene } = convertFoundryScene(PARITY_SCENE, { resolveUrl })
    const by = (id: string) => scene.tokens?.find((t) => t.id === id)
    expect(by('center')).toMatchObject({ elevation: 0, floorElevation: 0 })
    expect(by('upstairs')).toMatchObject({ elevation: 600, floorElevation: 400 })
    expect(by('burrower')).toMatchObject({ elevation: -300, floorElevation: 0 })
  })

  it('maps crit-fumble-core model flags through resolveUrl', () => {
    const { scene } = convertFoundryScene(PARITY_SCENE, { resolveUrl })
    const tree = scene.tokens?.find((t) => t.id === 'tree')
    expect(tree).toMatchObject({ model: '/assets/worlds/w/tree.glb', modelScale: 1.5, modelRotation: 90 })
  })

  it('reads the migrated flags.playtable namespace, preferring it over legacy crit-fumble-core', () => {
    const scene = {
      grid: { size: 100, distance: 5 },
      width: 1000,
      height: 1000,
      // model authored under the new namespace; heightfield still under the legacy one → both read.
      flags: { 'crit-fumble-core': { heightfield: { cols: 2, rows: 2, heights: [0, 1, 2, 3] } } },
      background: { src: 'map.png' },
      tokens: [
        { _id: 'new', x: 0, y: 0, width: 1, height: 1, flags: { playtable: { modelSrc: 'new.glb', modelScale: 2 } } },
        // playtable wins per-key over a legacy value on the SAME token.
        { _id: 'both', x: 100, y: 0, width: 1, height: 1, flags: { 'crit-fumble-core': { modelSrc: 'old.glb' }, playtable: { modelSrc: 'won.glb' } } },
      ],
    }
    const { scene: v } = convertFoundryScene(scene, { resolveUrl })
    expect(v.tokens?.find((t) => t.id === 'new')).toMatchObject({ model: '/assets/new.glb', modelScale: 2 })
    expect(v.tokens?.find((t) => t.id === 'both')?.model).toBe('/assets/won.glb')
    // legacy scene-level heightfield still renders (fallback read).
    expect(v.terrain).toMatchObject({ cols: 2, rows: 2 })
  })

  it('gives unflagged walls the union of the level bands', () => {
    const { scene } = convertFoundryScene(PARITY_SCENE, { resolveUrl, wallOpacity: 0.85 })
    const wl = scene.walls?.find((w) => w.id === 'wl')
    const we = scene.walls?.find((w) => w.id === 'we')
    expect(wl).toMatchObject({ bottom: 0, top: 800, opacity: 0.85 }) // union 0..40ft
    expect(we).toMatchObject({ bottom: 0, top: 600, opacity: 0.85 })
  })

  it('emits ambient from the darkness curve and point lights incl. the token light', () => {
    const { scene } = convertFoundryScene(PARITY_SCENE, { resolveUrl })
    expect(scene.ambient?.hemisphere?.intensity).toBeCloseTo(0.1 + 0.6 * 0.75)
    expect(scene.ambient?.sun?.intensity).toBeCloseTo(0.35 + 0.7 * 0.75)
    // ambient-light doc + center token's light; hidden light + hidden token's light dropped
    expect(scene.lights).toHaveLength(2)
    const doc = scene.lights?.find((l) => l.x === 1500 && l.y === 1350)
    expect(doc).toMatchObject({ color: 0xff8a3d, radius: 560, elevation: 60 })
    expect(doc?.intensity).toBeCloseTo(1.8)
    const tokenLight = scene.lights?.find((l) => l.x === 1500 && l.y === 1500)
    expect(tokenLight).toMatchObject({ color: 0xffce8a, radius: 520 })
  })

  it('maps door/window walls: kinds, door states, and the sight/move window signature', () => {
    const walls = [
      { _id: 'plain', c: [0, 0, 100, 0] },
      { _id: 'door-closed', c: [0, 100, 100, 100], door: 1, ds: 0 },
      { _id: 'door-open', c: [0, 200, 100, 200], door: 1, ds: 1 },
      { _id: 'door-locked', c: [0, 300, 100, 300], door: 1, ds: 2 },
      { _id: 'window', c: [0, 400, 100, 400], door: 0, move: 20, sight: 0 },
      { _id: 'window-prox', c: [0, 500, 100, 500], door: 0, move: 20, sight: 30 },
      { _id: 'invisible-blocker', c: [0, 600, 100, 600], door: 0, move: 20, sight: 20 }, // blocks sight → wall
    ]
    const { scene } = convertFoundryScene({ grid: { size: 100, distance: 5 }, walls }, { resolveUrl, wallOpacity: 0.85 })
    const byId = Object.fromEntries(scene.walls!.map((w) => [w.id, w]))
    expect(byId['plain']).toMatchObject({ kind: 'wall', opacity: 0.85 })
    expect(byId['plain'].doorState).toBeUndefined()
    expect(byId['door-closed']).toMatchObject({ kind: 'door', doorState: 'closed' })
    expect(byId['door-open']).toMatchObject({ kind: 'door', doorState: 'open' })
    expect(byId['door-locked']).toMatchObject({ kind: 'door', doorState: 'locked' })
    expect(byId['window']).toMatchObject({ kind: 'window' })
    expect(byId['window-prox']).toMatchObject({ kind: 'window' })
    expect(byId['invisible-blocker']).toMatchObject({ kind: 'wall' })
    // doors/windows leave style opacity to the core
    expect(byId['door-closed'].opacity).toBeUndefined()
    expect(byId['window'].opacity).toBeUndefined()
  })

  it('secret doors: GM sees them; players get an indistinguishable wall until the GM opens one', () => {
    const walls = [
      { _id: 'secret-closed', c: [0, 0, 100, 0], door: 2, ds: 0 },
      { _id: 'secret-locked', c: [0, 100, 100, 100], door: 2, ds: 2 },
      { _id: 'secret-open', c: [0, 200, 100, 200], door: 2, ds: 1 },
    ]
    const gm = convertFoundryScene({ grid: { size: 100, distance: 5 }, walls }, { resolveUrl, viewerIsGm: true }).scene
    const gmById = Object.fromEntries(gm.walls!.map((w) => [w.id, w]))
    expect(gmById['secret-closed']).toMatchObject({ kind: 'secretDoor', doorState: 'closed' })
    expect(gmById['secret-locked']).toMatchObject({ kind: 'secretDoor', doorState: 'locked' })
    expect(gmById['secret-open']).toMatchObject({ kind: 'secretDoor', doorState: 'open' })

    const player = convertFoundryScene({ grid: { size: 100, distance: 5 }, walls }, { resolveUrl, viewerIsGm: false }).scene
    const plById = Object.fromEntries(player.walls!.map((w) => [w.id, w]))
    // Closed/locked secrets are PLAIN WALLS in the player payload — no leak.
    expect(plById['secret-closed']).toMatchObject({ kind: 'wall' })
    expect(plById['secret-closed'].doorState).toBeUndefined()
    expect(plById['secret-locked']).toMatchObject({ kind: 'wall' })
    expect(plById['secret-locked'].doorState).toBeUndefined()
    // An OPEN secret door is revealed — players see an ordinary open door.
    expect(plById['secret-open']).toMatchObject({ kind: 'door', doorState: 'open' })
  })

  it('caps lights at maxLights keeping the biggest radius·intensity, shadows only in-budget', () => {
    // 60 light docs with ascending radius: the cap must keep the BIGGEST 24,
    // and only the top 4 (shadowBudget default) may cast shadows.
    const lights = Array.from({ length: 60 }, (_, i) => ({
      _id: `l${i}`,
      x: i * 10,
      y: 0,
      config: { dim: i + 1, bright: 0, color: '#ffffff', alpha: 0.5 },
    }))
    const { scene } = convertFoundryScene({ grid: { size: 100, distance: 5 }, lights }, { resolveUrl })
    expect(scene.lights).toHaveLength(24)
    const radii = scene.lights!.map((l) => l.radius ?? 0)
    // kept set = exactly the 24 largest radii ((37..60) ft · 20 px/ft), biggest-first
    expect(radii[0]).toBeGreaterThan(radii[23])
    expect(new Set(radii)).toEqual(new Set(Array.from({ length: 24 }, (_, i) => (60 - i) * 20)))
    const casting = scene.lights!.filter((l) => l.castShadow)
    expect(casting).toHaveLength(4)
    // shadow casters are the strongest lights, not arbitrary ones
    const castRadii = casting.map((l) => l.radius ?? 0)
    expect(Math.min(...castRadii)).toBeGreaterThanOrEqual(radii[4] ?? 0)
  })

  it('honors maxLights/shadowBudget overrides (0 disables)', () => {
    const lights = Array.from({ length: 10 }, (_, i) => ({
      _id: `l${i}`,
      x: i * 10,
      y: 0,
      config: { dim: i + 1, bright: 0, color: '#ffffff', alpha: 0.5 },
    }))
    const capped = convertFoundryScene({ grid: { size: 100, distance: 5 }, lights }, { resolveUrl, maxLights: 3, shadowBudget: 1 }).scene
    expect(capped.lights).toHaveLength(3)
    expect(capped.lights!.filter((l) => l.castShadow)).toHaveLength(1)
    const dark = convertFoundryScene({ grid: { size: 100, distance: 5 }, lights }, { resolveUrl, maxLights: 0 }).scene
    expect(dark.lights ?? []).toHaveLength(0)
    const noShadows = convertFoundryScene({ grid: { size: 100, distance: 5 }, lights }, { resolveUrl, shadowBudget: 0 }).scene
    expect(noShadows.lights!.some((l) => l.castShadow)).toBe(false)
  })

  it('emits tiles with rangeBottom elevation + elevation-tinted fallbacks, skipping hidden', () => {
    const { scene } = convertFoundryScene(PARITY_SCENE, { resolveUrl })
    expect(scene.tiles).toHaveLength(2)
    expect(scene.tiles?.find((t) => t.id === 'rug')).toMatchObject({ elevation: 0, color: 0x515b6b })
    expect(scene.tiles?.find((t) => t.id === 'platform')).toMatchObject({ elevation: 400, color: 0x7a6a52 })
  })

  it('passes absolute URLs through without the resolver', () => {
    const calls: string[] = []
    const { scene } = convertFoundryScene(
      { grid: { size: 100, distance: 5 }, tokens: [{ _id: 'a', x: 0, y: 0, texture: { src: 'https://cdn.example/s3.png' } }] },
      {
        resolveUrl: (p) => {
          calls.push(p)
          return `/assets/${p}`
        },
      },
    )
    expect(scene.tokens?.[0].texture).toBe('https://cdn.example/s3.png')
    expect(calls).toEqual([])
  })

  it('strips hidden + secret content for non-GM viewers, keeps it for GMs', () => {
    const gm = convertFoundryScene(PARITY_SCENE, { resolveUrl, viewerIsGm: true }).scene
    const player = convertFoundryScene(PARITY_SCENE, { resolveUrl, viewerIsGm: false }).scene
    expect(gm.tokens?.map((t) => t.id)).toEqual(expect.arrayContaining(['sneaky', 'secret']))
    expect(player.tokens?.map((t) => t.id)).not.toEqual(expect.arrayContaining(['sneaky']))
    expect(player.tokens?.map((t) => t.id)).not.toEqual(expect.arrayContaining(['secret']))
    // hidden token's light never emits for anyone (position leak)
    expect(gm.lights?.some((l) => l.x === 150 && l.y === 150)).toBe(false)
  })

  it('defaults a note without iconSize to the unified 50 (converged on the plugin producer)', () => {
    const { scene } = convertFoundryScene({ grid: { size: 100, distance: 5 }, notes: [{ _id: 'n', x: 0, y: 0 }] }, { resolveUrl })
    expect(scene.notes?.find((n) => n.id === 'n')?.size).toBe(50)
  })

  it('grid opacity falls back (never NaN) for a non-numeric alpha', () => {
    const { scene } = convertFoundryScene({ grid: { size: 100, distance: 5, alpha: 'x' as never } }, {})
    expect(scene.grid?.opacity).toBe(0.4)
  })

  it('the offline LOS cull uses the UNCAPPED lights — a capped-out scene still hides an out-of-sight token', () => {
    // A scene that HAS a light but caps it out of the render payload (maxLights:0) must NOT skip the LOS
    // cull: an out-of-sight, unlit token stays hidden from a non-GM viewer (no fog-of-war leak).
    const scene = {
      grid: { size: 100, distance: 5 },
      width: 3000,
      height: 3000,
      lights: [{ _id: 'lite', x: 50, y: 50, config: { dim: 1 } }], // small light near the source, not the target
      tokens: [
        { _id: 'src', x: 0, y: 0, width: 1, height: 1, disposition: 1, sight: { enabled: true, range: 1 } }, // 1ft = 20px innate sight
        { _id: 'far', x: 1000, y: 1000, width: 1, height: 1, disposition: 0 }, // far, unlit, out of sight range
      ],
    }
    const player = convertFoundryScene(scene, { viewerIsGm: false, visionSources: ['src'], maxLights: 0 }).scene
    const ids = player.tokens?.map((t) => t.id) ?? []
    expect(ids).toContain('src') // a source always sees itself
    expect(ids).not.toContain('far') // out-of-sight token stays culled despite the render light-cap
  })

  it('returns level display names sorted by elevation (px), carrying the Level-doc id', () => {
    const { levelNames } = convertFoundryScene(PARITY_SCENE, { resolveUrl })
    expect(levelNames).toEqual([
      { name: 'Ground', elevation: 0, id: 'lg' },
      { name: 'Upper', elevation: 400, id: 'lu' },
    ])
  })

  it('emits grid style (showHelper off for gridless)', () => {
    const { scene } = convertFoundryScene(PARITY_SCENE, {})
    // opacity floors at 0.25 (the shared/plugin grid helper keeps the grid legible in 3D).
    expect(scene.grid).toMatchObject({ size: 100, showHelper: true, color: 0x000000, opacity: 0.25 })
    const gridless = convertFoundryScene({ grid: { size: 100, distance: 5, type: 0 } }, {}).scene
    expect(gridless.grid?.showHelper).toBe(false)
  })
})

// Parity with the plugin's live heightmap terrain (overlay-3d.js _buildTerrainJson →
// scene-json.js buildTerrainJson). The offline adapter must read the scene flag
// flags['crit-fumble-core'].heightfield and emit the identical `terrain` shape the
// core already renders — so a sculpted world shows its relief offline, not a flat map.
describe('convertFoundryScene — heightmap terrain', () => {
  const resolveUrl = (p: string) => `/assets/${p}`
  // grid 100px = 5ft → 20 px/ft. heights are grid-distance UNITS, row-major (cols×rows).
  const HF_SCENE = {
    grid: { size: 100, distance: 5 },
    width: 2000,
    height: 2000,
    background: { src: 'worlds/w/map.webp' },
    flags: { 'crit-fumble-core': { heightfield: { cols: 3, rows: 2, heights: [0, 1, 2, 3, 4, 5] } } },
  }

  it('emits terrain: cols/rows preserved, heights scaled grid-units → px, map draped from scene background', () => {
    const { scene } = convertFoundryScene(HF_SCENE, { resolveUrl })
    expect(scene.terrain).toEqual({
      cols: 3,
      rows: 2,
      heights: [0, 20, 40, 60, 80, 100], // × 20 px/ft
      src: '/assets/worlds/w/map.webp',
    })
  })

  it('drapes the FIRST level background over the scene-root one (same source as the flat floor)', () => {
    const { scene } = convertFoundryScene(
      {
        ...HF_SCENE,
        background: { src: 'worlds/w/root.webp' },
        levels: [{ _id: 'lg', sort: 0, elevation: { bottom: 0, top: 20 }, background: { src: 'worlds/w/ground.webp' } }],
      },
      { resolveUrl },
    )
    expect(scene.terrain?.src).toBe('/assets/worlds/w/ground.webp')
  })

  it('emits terrain with no src when no map is available (core falls back to its flat colour)', () => {
    const { scene } = convertFoundryScene(
      { grid: { size: 100, distance: 5 }, flags: { 'crit-fumble-core': { heightfield: { cols: 2, rows: 2, heights: [0, 1, 2, 3] } } } },
      { resolveUrl },
    )
    expect(scene.terrain).toMatchObject({ cols: 2, rows: 2, heights: [0, 20, 40, 60] })
    expect(scene.terrain?.src).toBeUndefined()
  })

  it('omits terrain entirely when there is no heightfield (core keeps its flat map floor)', () => {
    expect(convertFoundryScene(FOUNDRY_SCENE, { resolveUrl }).scene.terrain).toBeUndefined()
    expect(convertFoundryScene(PARITY_SCENE, { resolveUrl }).scene.terrain).toBeUndefined()
  })

  it('omits terrain on a degenerate field so the core never bails to a FLOORLESS scene', () => {
    const t = (heightfield: unknown) =>
      convertFoundryScene({ grid: { size: 100, distance: 5 }, flags: { 'crit-fumble-core': { heightfield } } } as never, { resolveUrl }).scene.terrain
    expect(t({ cols: 1, rows: 4, heights: [0, 0, 0, 0] })).toBeUndefined() // cols < 2
    expect(t({ cols: 4, rows: 1, heights: [0, 0, 0, 0] })).toBeUndefined() // rows < 2
    expect(t({ cols: 3, rows: 3, heights: [0, 1, 2] })).toBeUndefined() // heights.length < cols*rows
    expect(t({ cols: 2, rows: 2 })).toBeUndefined() // no heights array
    expect(t(null)).toBeUndefined()
  })

  it('tolerates extra trailing heights (parity with the plugin) and coerces non-finite cells to 0', () => {
    const { scene } = convertFoundryScene(
      {
        grid: { size: 100, distance: 5 },
        flags: { 'crit-fumble-core': { heightfield: { cols: 2, rows: 2, heights: [1, 'x', null, 4, 9, 9] } } },
      } as never,
      { resolveUrl },
    )
    // The whole array is scaled (extras kept, as the plugin does — the core reads only the first cols*rows).
    expect(scene.terrain?.heights).toEqual([20, 0, 0, 80, 180, 180])
  })

  it('is NOT GM-gated — terrain is the scene relief/map, not hidden GM content', () => {
    const player = convertFoundryScene(HF_SCENE, { resolveUrl, viewerIsGm: false }).scene
    expect(player.terrain).toMatchObject({ cols: 3, rows: 2 })
  })
})

// #182 — native Foundry Level-model fidelity: per-placeable `document.levels` membership +
// `level.visibility.levels` see-through. Fixture mirrors a real v14 two-level scene where a wall,
// light, and tile are each RESTRICTED to the Upper level, and the Upper level authorizes see-through
// to Ground. Empty `levels: []` (the common case) must emit NO `levelIds` (byte-identical output).
describe('native Level membership + see-through (#182)', () => {
  const resolveUrl = (p: string) => `/assets/${p}`
  const LVL_SCENE = {
    grid: { size: 100, distance: 5 },
    width: 2000,
    height: 2000,
    levels: [
      { _id: 'lg', name: 'Ground', sort: 0, elevation: { bottom: 0, top: 20 }, background: { src: 'w/ground.png' } },
      { _id: 'lu', name: 'Upper', sort: 10, elevation: { bottom: 20, top: 40 }, background: { src: 'w/upper.png' }, visibility: { levels: ['lg'] } },
    ],
    tokens: [
      { _id: 'hero', x: 500, y: 500, width: 1, height: 1, elevation: 0, disposition: 1, level: 'lg' },
      { _id: 'flyer', x: 600, y: 600, width: 1, height: 1, elevation: 20, disposition: 1, level: 'lu' },
      { _id: 'anywhere', x: 700, y: 700, width: 1, height: 1, elevation: 0, disposition: 0 }, // no native level
    ],
    walls: [
      { _id: 'w-upper', c: [0, 0, 500, 0], levels: ['lu'] }, // restricted to Upper
      { _id: 'w-all', c: [0, 100, 500, 100], levels: [] }, // empty = all levels
      { _id: 'w-plain', c: [0, 200, 500, 200] }, // no levels field at all
    ],
    lights: [{ _id: 'l-upper', x: 100, y: 100, elevation: 20, levels: ['lu'], config: { dim: 20, bright: 10, color: '#ffffff' } }],
    tiles: [
      { _id: 'tile-upper', x: 100, y: 100, width: 200, height: 200, elevation: 20, levels: ['lu'], texture: { src: 'w/rug.png' } },
      { _id: 'tile-all', x: 400, y: 400, width: 100, height: 100, elevation: 0, levels: [] },
    ],
    notes: [{ _id: 'note-upper', x: 800, y: 800, iconSize: 40, texture: { src: 'icons/book.svg' }, levels: ['lu'] }],
  }

  it('emits levelIds on placeables restricted to specific levels', () => {
    const { scene } = convertFoundryScene(LVL_SCENE, { resolveUrl })
    expect(scene.walls?.find((w) => w.id === 'w-upper')?.levelIds).toEqual(['lu'])
    expect(scene.lights?.find((l) => l.id === 'l-upper')?.levelIds).toEqual(['lu'])
    expect(scene.tiles?.find((t) => t.id === 'tile-upper')?.levelIds).toEqual(['lu'])
    expect(scene.notes?.find((n) => n.id === 'note-upper')?.levelIds).toEqual(['lu'])
  })

  it('emits NO levelIds for all-levels (empty array) or absent membership — byte-identical common case', () => {
    const { scene } = convertFoundryScene(LVL_SCENE, { resolveUrl })
    expect(scene.walls?.find((w) => w.id === 'w-all')).not.toHaveProperty('levelIds')
    expect(scene.walls?.find((w) => w.id === 'w-plain')).not.toHaveProperty('levelIds')
    expect(scene.tiles?.find((t) => t.id === 'tile-all')).not.toHaveProperty('levelIds')
  })

  it('emits the native singular levelId on tokens that carry one, and omits it otherwise', () => {
    const { scene } = convertFoundryScene(LVL_SCENE, { resolveUrl })
    expect(scene.tokens?.find((t) => t.id === 'hero')?.levelId).toBe('lg')
    expect(scene.tokens?.find((t) => t.id === 'flyer')?.levelId).toBe('lu')
    expect(scene.tokens?.find((t) => t.id === 'anywhere')).not.toHaveProperty('levelId')
  })

  it('carries the Level id + see-through set onto the level quads and levelNames', () => {
    const { scene, levelNames } = convertFoundryScene(LVL_SCENE, { resolveUrl })
    const upperQuad = scene.levels?.find((l) => l.id === 'lu')
    expect(upperQuad?.visibleLevelIds).toEqual(['lg'])
    expect(scene.levels?.find((l) => l.id === 'lg')).not.toHaveProperty('visibleLevelIds')
    expect(levelNames.find((l) => l.id === 'lu')?.visibleLevelIds).toEqual(['lg'])
    expect(levelNames.find((l) => l.id === 'lg')).not.toHaveProperty('visibleLevelIds')
  })
})
