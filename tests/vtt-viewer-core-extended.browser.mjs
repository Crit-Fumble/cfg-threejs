/**
 * vtt-viewer-core-extended.browser.mjs — headless-browser TDD for the "full parity"
 * viewer-core extensions (2026-07-01): textured/model tokens with ring+stalk, per-Level
 * stacked backgrounds, lights, notes, tiles, and an optional grid helper. Same
 * bundle-.ts-directly-with-esbuild + cached-chromium approach as the other core tests.
 *
 *   node tests/vtt-viewer-core-extended.browser.mjs   (exit 0 = pass)
 */
import { chromium } from '@playwright/test'
import * as esbuild from 'esbuild'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { resolveChrome, CHROME_ARGS } from './shared/chrome.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORE = join(__dirname, '../src/core.ts')
const CHROME = resolveChrome()

// A 1x1 opaque PNG — deterministic, no network, so texture-load tests never flake.
const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const SCENE = {
  bounds: { width: 2000, height: 2000 },
  grid: { size: 100, showHelper: true },
  ambient: { hemisphere: { sky: 0xffffff, ground: 0x222222, intensity: 0.5 }, sun: { color: 0xffffff, intensity: 0.6, castShadow: true } },
  levels: [
    { id: 'l0', elevation: 0, which: 'bottom', src: PIXEL_PNG },
    { id: 'l1', elevation: 300, which: 'top', src: PIXEL_PNG },
  ],
  lights: [
    { id: 'pl1', x: 500, y: 500, elevation: 50, color: 0xffaa00, radius: 400, intensity: 1.5 },
    { id: 'pl2', x: 1200, y: 800, elevation: 20, color: 0x2266ff, radius: 300 },
  ],
  tokens: [
    { id: 'ground-token', x: 500, y: 500, width: 100, height: 100, elevation: 0, color: 0x4caf50 }, // ring, no stalk
    { id: 'flying-token', x: 800, y: 500, width: 100, height: 100, elevation: 150, floorElevation: 0, color: 0xe53935 }, // ring + stalk
    { id: 'textured-token', x: 1100, y: 500, width: 100, height: 100, elevation: 0, texture: PIXEL_PNG },
    { id: 'no-ring-token', x: 1400, y: 500, width: 100, height: 100, elevation: 0, ring: false },
    { id: 'model-no-loader-token', x: 1700, y: 500, width: 100, height: 100, elevation: 0, model: 'nonexistent.glb' }, // no GLTFLoader injected → falls back to box
    // Underground (elevation < floorElevation): the post should attach at the mini's TOP, not its feet.
    { id: 'deep-underground-token', x: 500, y: 800, width: 100, height: 100, elevation: -150, floorElevation: 0, color: 0x795548 }, // fully below the floor → ring + stalk(top→floor) + box
    { id: 'shallow-underground-token', x: 800, y: 800, width: 100, height: 100, elevation: -30, floorElevation: 0, color: 0x795548 }, // mini's own body already crosses the floor → no stalk
  ],
  notes: [{ id: 'n1', x: 300, y: 1200, size: 60, texture: PIXEL_PNG }],
  tiles: [{ id: 't1', x: 600, y: 1500, width: 200, height: 200, elevation: 50 }],
  walls: [{ id: 'w1', x1: 0, y1: 0, x2: 400, y2: 0, bottom: 0, top: 300, opacity: 0.85 }],
}

const log = (...a) => console.log('[viewer-extended-test]', ...a)
const fail = (m) => {
  console.error('[viewer-extended-test] FAIL:', m)
  process.exitCode = 1
}

const built = await esbuild.build({
  stdin: {
    contents: `import * as THREE from 'three'; import { createViewer } from ${JSON.stringify(CORE)}; globalThis.CFGViewer = { createViewer, THREE };`,
    resolveDir: __dirname,
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  write: false,
  legalComments: 'none',
})

const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: CHROME_ARGS })
const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage()
page.on('pageerror', (e) => fail('pageerror: ' + e.message))
try {
  await page.setContent('<!doctype html><html><body><div id="v" style="width:800px;height:600px"></div></body></html>')
  await page.addScriptTag({ content: built.outputFiles[0].text })
  const out = await page.evaluate(async (scene) => {
    const v = window.CFGViewer.createViewer({ element: document.getElementById('v'), THREE: window.CFGViewer.THREE, width: 800, height: 600, shadows: true })
    v.loadScene(scene)
    await new Promise((r) => setTimeout(r, 600)) // let async texture/model loads settle
    const sg = v.getSceneGraph()
    const lightTypes = v.scene.children.filter((c) => c.isLight).map((c) => c.type)
    const hasGridHelper = v.scene.children.some((c) => c.type === 'GridHelper')
    const groundToken = [...v.tokens.entries()].find(([id]) => id === 'ground-token')?.[1]
    const flyingToken = [...v.tokens.entries()].find(([id]) => id === 'flying-token')?.[1]
    const texturedToken = [...v.tokens.entries()].find(([id]) => id === 'textured-token')?.[1]
    const noRingToken = [...v.tokens.entries()].find(([id]) => id === 'no-ring-token')?.[1]
    const modelFallbackToken = [...v.tokens.entries()].find(([id]) => id === 'model-no-loader-token')?.[1]
    const deepUnderground = [...v.tokens.entries()].find(([id]) => id === 'deep-underground-token')?.[1]
    const shallowUnderground = [...v.tokens.entries()].find(([id]) => id === 'shallow-underground-token')?.[1]
    const stalkOf = (g) => g?.children.find((c) => c.geometry?.type === 'CylinderGeometry')
    return {
      sg,
      lightTypes,
      hasGridHelper,
      tokensExposed: v.tokens instanceof Map,
      groundTokenChildCount: groundToken?.children.length,
      flyingTokenChildCount: flyingToken?.children.length,
      texturedTokenSpriteHasMap: (() => {
        const sprite = texturedToken?.children.find((c) => c.type === 'Sprite')
        return !!sprite?.material?.map
      })(),
      noRingTokenChildCount: noRingToken?.children.length,
      modelFallbackHasBoxOrSprite: modelFallbackToken?.children.some((c) => c.type === 'Mesh' || c.type === 'Sprite'),
      wall: (() => {
        // Walls render INSTANCED: unit box (depth 8) scaled per instance.
        const w = v.scene.children.find((c) => c.isInstancedMesh && c.geometry?.parameters?.depth === 8)
        if (!w) return null
        const THREE = window.CFGViewer.THREE
        const m = new THREE.Matrix4()
        const pos = new THREE.Vector3()
        const quat = new THREE.Quaternion()
        const scl = new THREE.Vector3()
        w.getMatrixAt(0, m)
        m.decompose(pos, quat, scl)
        return {
          instanceCount: w.count,
          opacity: w.material.opacity,
          transparent: w.material.transparent,
          castShadow: w.castShadow,
          receiveShadow: w.receiveShadow,
          doubleSide: w.material.side === THREE.DoubleSide,
          visualHeight: scl.y, // unit box scaled to the wall band height
          visualBottom: pos.y - scl.y / 2,
        }
      })(),
      // Any full-bounds opaque BoxGeometry in a levels[] scene would block the alpha
      // see-through holes Levels rely on — there must be none (levels are thin
      // DoubleSide planes only; the thin box ground is only for the NO-levels fallback).
      fullBoundsBoxCount: v.scene.children.filter(
        (c) => c.geometry?.type === 'BoxGeometry' && c.geometry.parameters.width === scene.bounds.width && c.geometry.parameters.depth === scene.bounds.height,
      ).length,
      levelPlanesTransparencyReady: v.scene.children
        .filter((c) => c.geometry?.type === 'PlaneGeometry' && c.geometry.parameters.width === scene.bounds.width)
        .map((p) => ({ alphaTest: p.material.alphaTest, doubleSide: p.material.side === window.CFGViewer.THREE.DoubleSide })),
      deepStalk: (() => {
        const s = stalkOf(deepUnderground)
        // Stalks use the POOLED unit cylinder scaled per-token: visual height =
        // unit geometry height × scale.y.
        return s ? { height: s.geometry.parameters.height * s.scale.y, y: s.position.y } : null
      })(),
      deepUndergroundChildCount: deepUnderground?.children.length,
      shallowStalk: (() => !!stalkOf(shallowUnderground))(),
      shallowUndergroundChildCount: shallowUnderground?.children.length,
    }
  }, SCENE)

  log('sceneGraph:', JSON.stringify(out.sg))
  log('lightTypes:', JSON.stringify(out.lightTypes))

  if (!out.tokensExposed) fail('viewer.tokens is not a Map — picking would break')
  if (out.sg.tokenCount !== 7) fail(`tokenCount ${out.sg.tokenCount} != 7`)
  if (out.sg.wallCount !== 1) fail(`wallCount ${out.sg.wallCount} != 1`)
  if (out.sg.levelCount !== 2) fail(`levelCount ${out.sg.levelCount} != 2`)
  if (out.sg.hasGround) fail('hasGround true but levels[] was provided — should skip the flat ground')
  if (out.sg.lightCount !== 2) fail(`lightCount ${out.sg.lightCount} != 2 (point lights)`)
  if (out.sg.noteCount !== 1) fail(`noteCount ${out.sg.noteCount} != 1`)
  if (out.sg.tileCount !== 1) fail(`tileCount ${out.sg.tileCount} != 1`)
  if (!out.sg.hasGrid) fail('hasGrid false but grid.showHelper was true')
  if (!out.hasGridHelper) fail('no GridHelper found in scene.children')
  if (!out.lightTypes.includes('HemisphereLight')) fail(`ambient hemisphere missing, got lightTypes=${JSON.stringify(out.lightTypes)}`)
  if (!out.lightTypes.includes('DirectionalLight')) fail('ambient sun (DirectionalLight) missing')
  if (out.lightTypes.filter((t) => t === 'PointLight').length !== 2) fail(`expected 2 PointLight, got ${JSON.stringify(out.lightTypes)}`)

  // ground-token: ring only (1 child: ring) + box (no texture/model) = 2 children, no stalk
  if (out.groundTokenChildCount !== 2) fail(`ground-token has ${out.groundTokenChildCount} children, expected 2 (ring + box)`)
  // flying-token: ring + stalk + box = 3 children
  if (out.flyingTokenChildCount !== 3) fail(`flying-token has ${out.flyingTokenChildCount} children, expected 3 (ring + stalk + box)`)
  if (!out.texturedTokenSpriteHasMap) fail('textured-token sprite has no texture map — texture load did not apply')
  // no-ring-token: ring:false → just the box = 1 child
  if (out.noRingTokenChildCount !== 1) fail(`no-ring-token has ${out.noRingTokenChildCount} children, expected 1 (box only, ring disabled)`)
  if (!out.modelFallbackHasBoxOrSprite) fail('model-no-loader-token did not fall back to a box/sprite when no GLTFLoader was injected')

  if (!out.wall) fail('instanced wall mesh not found in scene.children')
  else {
    if (Math.abs(out.wall.opacity - 0.85) > 0.01) fail(`wall opacity ${out.wall.opacity} != 0.85`)
    if (!out.wall.transparent) fail('wall opacity < 1 but material.transparent is false')
    if (!out.wall.castShadow) fail('wall castShadow is false')
    if (!out.wall.receiveShadow) fail('wall receiveShadow is false')
    if (!out.wall.doubleSide) fail('wall material.side is not THREE.DoubleSide')
    // wall {bottom:0, top:300} → semantic height 300 (getSceneGraph, checked above via w1).
    // The visual mesh must stop exactly at bottom=0 — no foundation bleeding into
    // whatever level sits below this wall's own band.
    const w1 = out.sg.walls.find((w) => Math.round(w.height) === 300)
    if (!w1) fail(`no wall in getSceneGraph reporting the semantic height 300, got ${JSON.stringify(out.sg.walls)}`)
    if (Math.abs(out.wall.visualHeight - 300) > 1) fail(`wall visual mesh height ${out.wall.visualHeight} != 300 (no foundation extension)`)
    if (Math.abs(out.wall.visualBottom - 0) > 1) fail(`wall visual bottom ${out.wall.visualBottom} != 0 (should stop exactly at bottom, no foundation)`)
  }

  // Levels must be thin alpha-capable planes ONLY — no opaque backing slab. Level
  // textures see through to lower floors via alpha holes (the FoundryVTT Levels
  // convention); any full-bounds opaque geometry blocks exactly that (regression:
  // v1.8.7 added such slabs and upper floors turned into solid sheets).
  if (out.fullBoundsBoxCount !== 0) fail(`levels[] scene has ${out.fullBoundsBoxCount} full-bounds opaque box(es) — these block Level alpha see-through holes`)
  if (out.levelPlanesTransparencyReady.length !== 2) fail(`expected 2 level planes, got ${out.levelPlanesTransparencyReady.length}`)
  for (const p of out.levelPlanesTransparencyReady) {
    if (!(p.alphaTest > 0)) fail(`level plane alphaTest ${p.alphaTest} — transparent holes would render opaque`)
    if (!p.doubleSide) fail('level plane is not DoubleSide — invisible from below')
  }

  // Underground tokens (elevation < floorElevation): the post should attach at the
  // mini's TOP (not its feet) so it reads as hanging from the surface, not piercing
  // through to the feet — and shouldn't draw a post at all when the mini's own body
  // already crosses the floor.
  if (out.deepUndergroundChildCount !== 3) fail(`deep-underground-token has ${out.deepUndergroundChildCount} children, expected 3 (ring + stalk + box)`)
  if (!out.deepStalk) fail('deep-underground-token has no stalk — expected one attached at its top (fully below the floor)')
  else {
    // footprint=100, floorElevation-elevation=150 (floorLocalY) → stalk spans [100,150],
    // height 50, centered at 125 (group-local, i.e. 150 world px below the token's own y=-150... in
    // WORLD space the stalk center = elevation(-150) + local(125) = -25).
    if (Math.abs(out.deepStalk.height - 50) > 1) fail(`deep-underground-token stalk height ${out.deepStalk.height} != 50`)
  }
  if (out.shallowUndergroundChildCount !== 2) fail(`shallow-underground-token has ${out.shallowUndergroundChildCount} children, expected 2 (ring + box, no stalk)`)
  if (out.shallowStalk) fail('shallow-underground-token has a stalk, but its own body already crosses the floor — none expected')

  // bounds.x/.y — a host whose playable rect isn't anchored at world origin (e.g. Foundry's
  // inner scene rect within a padded canvas). Ground/levels/grid must center on the OFFSET
  // rect, not (0,0) — tokens/walls (already absolute) are unaffected and not re-tested here.
  const OFFSET_SCENE = {
    bounds: { width: 1000, height: 800, x: 300, y: 200 }, // rect spans (300,200)-(1300,1000)
    grid: { size: 100, showHelper: true },
    levels: [{ id: 'l0', elevation: 0, which: 'bottom', src: PIXEL_PNG }],
  }
  const offsetOut = await page.evaluate((scene) => {
    const v = window.CFGViewer.createViewer({ element: document.getElementById('v'), THREE: window.CFGViewer.THREE, width: 800, height: 600 })
    v.loadScene(scene)
    const level = v.scene.children.find((c) => c.geometry?.type === 'PlaneGeometry' && c.material?.map)
    const gridHelper = v.scene.children.find((c) => c.type === 'GridHelper')
    return { levelPos: level ? [level.position.x, level.position.z] : null, gridPos: gridHelper ? [gridHelper.position.x, gridHelper.position.z] : null }
  }, OFFSET_SCENE)
  log('offset test:', JSON.stringify(offsetOut))
  const expectCx = 300 + 1000 / 2 // 800
  const expectCz = 200 + 800 / 2 // 600
  if (!offsetOut.levelPos || Math.abs(offsetOut.levelPos[0] - expectCx) > 1 || Math.abs(offsetOut.levelPos[1] - expectCz) > 1)
    fail(`level centered at ${JSON.stringify(offsetOut.levelPos)}, expected [${expectCx},${expectCz}] (bounds.x/.y offset ignored)`)
  if (!offsetOut.gridPos || Math.abs(offsetOut.gridPos[0] - expectCx) > 1 || Math.abs(offsetOut.gridPos[1] - expectCz) > 1)
    fail(`grid centered at ${JSON.stringify(offsetOut.gridPos)}, expected [${expectCx},${expectCz}] (bounds.x/.y offset ignored)`)

  if (!process.exitCode) log('PASS — levels/ambient/lights/notes/tiles/grid/ring/stalk/texture/model-fallback/bounds-offset all render correctly')
} catch (e) {
  fail(e?.stack || e?.message || String(e))
} finally {
  await browser.close()
}
