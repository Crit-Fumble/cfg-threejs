/**
 * vtt-viewer-core-2d.browser.mjs — headless-browser TDD for the core's 2D mode:
 * a flat, unlit, Foundry-canvas-style render that NEVER loads 3D assets.
 *
 * Contract under test (mode: '2d'):
 *  - GLB models are never fetched — the injected GLTFLoader must see ZERO calls;
 *  - tokens render their 2D texture art as a FLAT quad (no billboard Sprite,
 *    no box body, no flight-stand stalk) + the flat disposition ring (viewer aid);
 *  - walls render as thin FLAT strips (viewer aid), not extruded boxes;
 *  - nothing is lit: no Ambient/Hemisphere/Directional/Point lights in the scene
 *    (flat content uses unlit materials), even when the JSON asks for lights;
 *  - render() draws with an orthographic straight-down camera;
 *  - setMode('3d') rebuilds the same JSON with the full 3D content (model loads).
 *
 *   node tests/vtt-viewer-core-2d.browser.mjs   (exit 0 = pass)
 */
import { chromium } from '@playwright/test'
import * as esbuild from 'esbuild'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { resolveChrome, CHROME_ARGS } from './shared/chrome.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORE = join(__dirname, '../src/core.ts')
const CHROME = resolveChrome()

const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const SCENE = {
  bounds: { width: 2000, height: 2000 },
  grid: { size: 100, showHelper: true },
  ambient: { hemisphere: { sky: 0xffffff, ground: 0x222222, intensity: 0.5 }, sun: { color: 0xffffff, intensity: 0.6, castShadow: true } },
  levels: [{ id: 'l0', elevation: 0, which: 'bottom', src: PIXEL_PNG }],
  lights: [{ id: 'pl1', x: 500, y: 500, elevation: 50, color: 0xffaa00, radius: 400, intensity: 1.5 }],
  tokens: [
    { id: 'art-token', x: 500, y: 500, width: 100, height: 100, elevation: 0, texture: PIXEL_PNG },
    { id: 'flying-model-token', x: 800, y: 500, width: 100, height: 100, elevation: 150, floorElevation: 0, model: 'should-not-load.glb', texture: PIXEL_PNG },
    { id: 'plain-token', x: 1100, y: 500, width: 100, height: 100, elevation: 0, color: 0x4caf50 },
  ],
  walls: [{ id: 'w1', x1: 0, y1: 0, x2: 400, y2: 0, bottom: 0, top: 300, opacity: 0.85 }],
  tiles: [{ id: 't1', x: 600, y: 1500, width: 200, height: 200, elevation: 50 }],
  notes: [{ id: 'n1', x: 300, y: 1200, size: 60 }],
}

const log = (...a) => console.log('[viewer-2d-test]', ...a)
const fail = (m) => {
  console.error('[viewer-2d-test] FAIL:', m)
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
    // Spy GLTFLoader: any construction or .load() call is a contract violation in 2D.
    window.__gltfCalls = 0
    class SpyGLTFLoader {
      load() {
        window.__gltfCalls++
      }
    }
    const v = window.CFGViewer.createViewer({
      element: document.getElementById('v'),
      THREE: window.CFGViewer.THREE,
      width: 800,
      height: 600,
      GLTFLoader: SpyGLTFLoader,
      mode: '2d',
    })
    v.loadScene(scene)
    await new Promise((r) => setTimeout(r, 300)) // let texture loads settle

    const THREE = window.CFGViewer.THREE
    const lightTypes = []
    v.scene.traverse((c) => {
      if (c.isLight) lightTypes.push(c.type)
    })
    const tokenShape = (id) => {
      const g = v.tokens.get(id)
      if (!g) return null
      return {
        children: g.children.map((c) => ({
          type: c.type,
          geo: c.geometry?.type ?? null,
          flat: c.rotation ? Math.abs(c.rotation.x + Math.PI / 2) < 0.01 : false,
          hasMap: !!c.material?.map,
          unlit: c.material ? c.material.type === 'MeshBasicMaterial' || c.material.type === 'SpriteMaterial' : false,
        })),
        hasSprite: g.children.some((c) => c.type === 'Sprite'),
        hasStalk: g.children.some((c) => c.geometry?.type === 'CylinderGeometry'),
      }
    }
    // Walls render INSTANCED in 2D too: a unit flat strip per instance.
    const wall = v.scene.children.find((c) => c.isInstancedMesh && c.geometry?.type === 'PlaneGeometry')
    const level = v.scene.children.find((c) => c.geometry?.type === 'PlaneGeometry' && c.geometry.parameters.width === scene.bounds.width)

    const before3d = {
      gltfCalls: window.__gltfCalls,
      mode: v.getSceneGraph().mode,
      lightTypes,
      art: tokenShape('art-token'),
      flyingModel: tokenShape('flying-model-token'),
      plain: tokenShape('plain-token'),
      wall: wall
        ? (() => {
            const THREE = window.CFGViewer.THREE
            const m = new THREE.Matrix4()
            const pos = new THREE.Vector3()
            const quat = new THREE.Quaternion()
            const scl = new THREE.Vector3()
            wall.getMatrixAt(0, m)
            m.decompose(pos, quat, scl)
            // Flat = the unit strip's normal (local +Z) points world-up after rotation.
            const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quat)
            return {
              geo: wall.geometry.type,
              flat: Math.abs(normal.y - 1) < 0.01,
              unlit: wall.material.type === 'MeshBasicMaterial',
              semanticHeight: v.getSceneGraph().walls[0]?.height ?? null,
            }
          })()
        : null,
      levelUnlit: level ? level.material.type === 'MeshBasicMaterial' : null,
      renderCam: (() => {
        // render() must draw with an orthographic camera in 2D mode.
        let used = null
        const orig = v.renderer.render.bind(v.renderer)
        v.renderer.render = (s, cam) => {
          used = cam.type
          orig(s, cam)
        }
        v.render()
        v.renderer.render = orig
        return used
      })(),
    }

    // Switching to 3D rebuilds the SAME json with full 3D content (model now loads).
    v.setMode('3d')
    await new Promise((r) => setTimeout(r, 100))
    const after3d = {
      gltfCalls: window.__gltfCalls,
      mode: v.getSceneGraph().mode,
      flyingHasStalk: !!v.tokens.get('flying-model-token')?.children.some((c) => c.geometry?.type === 'CylinderGeometry'),
      renderCam: (() => {
        let used = null
        const orig = v.renderer.render.bind(v.renderer)
        v.renderer.render = (s, cam) => {
          used = cam.type
          orig(s, cam)
        }
        v.render()
        v.renderer.render = orig
        return used
      })(),
    }
    return { before3d, after3d }
  }, SCENE)

  const b = out.before3d
  log('2d:', JSON.stringify(b))
  log('after setMode(3d):', JSON.stringify(out.after3d))

  if (b.mode !== '2d') fail(`getSceneGraph().mode ${b.mode} != '2d'`)
  if (b.gltfCalls !== 0) fail(`2D mode made ${b.gltfCalls} GLTF load call(s) — 3D assets must never load in 2D`)
  if (b.lightTypes.length !== 0) fail(`2D scene contains lights ${JSON.stringify(b.lightTypes)} — 2D is unlit`)
  if (b.renderCam !== 'OrthographicCamera') fail(`2D render() used ${b.renderCam}, expected OrthographicCamera`)

  // Token with texture: flat unlit textured quad, no Sprite billboard, no stalk.
  if (!b.art) fail('art-token missing')
  else {
    if (b.art.hasSprite) fail('art-token has a billboard Sprite in 2D — expected a flat quad')
    const quad = b.art.children.find((c) => c.geo === 'PlaneGeometry')
    if (!quad) fail('art-token has no flat PlaneGeometry quad')
    else {
      if (!quad.flat) fail('art-token quad is not lying flat')
      if (!quad.hasMap) fail('art-token quad has no texture map')
      if (!quad.unlit) fail('art-token quad is not unlit (MeshBasicMaterial)')
    }
  }
  // Flying model token: no stalk, no model, still shows flat art.
  if (!b.flyingModel) fail('flying-model-token missing')
  else {
    if (b.flyingModel.hasStalk) fail('flying-model-token has a stalk in 2D')
    if (!b.flyingModel.children.some((c) => c.geo === 'PlaneGeometry' && c.hasMap)) fail('flying-model-token has no flat art quad')
  }
  // Plain token: flat tinted quad fallback (no 40-tall box body).
  if (!b.plain) fail('plain-token missing')
  else if (b.plain.children.some((c) => c.geo === 'BoxGeometry')) fail('plain-token renders a 3D box in 2D — expected a flat tinted quad')

  // Wall: thin flat strip, unlit; semantic band still reported.
  if (!b.wall) fail('wall not found')
  else {
    if (b.wall.geo !== 'PlaneGeometry') fail(`wall geometry ${b.wall.geo} != PlaneGeometry (flat strip)`)
    if (!b.wall.flat) fail('wall strip is not lying flat')
    if (!b.wall.unlit) fail('wall strip is not unlit')
    if (b.wall.semanticHeight !== 300) fail(`wall semanticHeight ${b.wall.semanticHeight} != 300 (reporting must not change)`)
  }
  if (b.levelUnlit === false) fail('level plane is not unlit in 2D')

  // Mode switch back to 3D: full content, model loads, perspective camera.
  const a = out.after3d
  if (a.mode !== '3d') fail(`after setMode: mode ${a.mode} != '3d'`)
  if (a.gltfCalls < 1) fail('setMode(3d) did not load the GLB model')
  if (!a.flyingHasStalk) fail('flying token has no stalk after switching to 3D')
  if (a.renderCam !== 'PerspectiveCamera') fail(`3D render() used ${a.renderCam}, expected PerspectiveCamera`)

  if (!process.exitCode) log('PASS — 2D mode is flat, unlit, and never touches 3D assets; setMode round-trips')
} catch (e) {
  fail(e?.stack || e?.message || String(e))
} finally {
  await browser.close()
}
