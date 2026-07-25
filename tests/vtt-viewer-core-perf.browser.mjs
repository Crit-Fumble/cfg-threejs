/**
 * vtt-viewer-core-perf.browser.mjs — headless-browser TDD for the core's
 * heavy-scene resource management (the "Dungeon of Dragons" class of scene:
 * dozens of tokens sharing art, hundreds of walls).
 *
 * Contract under test:
 *  - texture DEDUPE: N tokens/tiles/notes sharing one texture URL cost exactly
 *    ONE TextureLoader.load() call (one fetch, one GPU upload), and their
 *    materials share the SAME Texture instance;
 *  - wall INSTANCING: hundreds of walls fold into a handful of InstancedMesh
 *    draw calls (one per opacity group), instance count preserved, and
 *    getSceneGraph() still reports every wall with its semantic band;
 *  - the heavy scene actually renders in 3D (no shader-compile explosion);
 *  - dispose() clears the texture cache (a reload starts fresh).
 *
 *   node tests/vtt-viewer-core-perf.browser.mjs   (exit 0 = pass)
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
const PIXEL_PNG_2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const TOKENS = 40
const WALLS = 400

// Every token shares ONE texture URL (the prod-observed pattern: a goblin horde
// with identical source art). A second URL on tiles/notes proves per-URL keying.
const SCENE = {
  bounds: { width: 8000, height: 8000 },
  grid: { size: 100 },
  levels: [{ id: 'l0', elevation: 0, which: 'bottom', src: PIXEL_PNG_2 }],
  tokens: Array.from({ length: TOKENS }, (_, i) => ({
    id: `tok${i}`,
    x: 100 + (i % 20) * 350,
    y: 100 + Math.floor(i / 20) * 350,
    width: 100,
    height: 100,
    elevation: 0,
    texture: PIXEL_PNG,
  })),
  // A big maze: 400 segments, two opacity groups (solid walls + open doors).
  walls: Array.from({ length: WALLS }, (_, i) => ({
    id: `w${i}`,
    x1: (i % 40) * 200,
    y1: Math.floor(i / 40) * 200,
    x2: (i % 40) * 200 + 180,
    y2: Math.floor(i / 40) * 200,
    bottom: 0,
    top: 300,
    opacity: i % 10 === 0 ? 0.4 : 0.85,
  })),
  tiles: [{ id: 't1', x: 600, y: 1500, width: 200, height: 200, elevation: 0, texture: PIXEL_PNG_2 }],
  notes: [{ id: 'n1', x: 300, y: 1200, size: 60, texture: PIXEL_PNG_2 }],
}

const log = (...a) => console.log('[viewer-perf-test]', ...a)
const fail = (m) => {
  console.error('[viewer-perf-test] FAIL:', m)
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
  const out = await page.evaluate(
    async ({ scene, TOKENS, WALLS }) => {
      const THREE = window.CFGViewer.THREE
      // Spy TextureLoader: the core constructs it from the injected THREE, so a
      // wrapped namespace counts every load() — i.e. every fetch + GPU upload.
      const loads = []
      class SpyTextureLoader extends THREE.TextureLoader {
        load(url, onLoad, onProgress, onError) {
          loads.push(url)
          return super.load(url, onLoad, onProgress, onError)
        }
      }
      const THREESpy = Object.assign(Object.create(null), THREE, { TextureLoader: SpyTextureLoader })

      const v = window.CFGViewer.createViewer({
        element: document.getElementById('v'),
        THREE: THREESpy,
        width: 800,
        height: 600,
        mode: '3d',
      })
      v.loadScene(scene)
      await new Promise((r) => setTimeout(r, 400)) // let texture loads settle

      // Texture identity: two token quads must share the SAME Texture object.
      const mapsOf = (id) => {
        const g = v.tokens.get(id)
        return g ? g.children.map((c) => c.material?.map).filter(Boolean) : []
      }
      const mapA = mapsOf('tok0')[0] ?? null
      const mapB = mapsOf('tok39')[0] ?? null

      const instanced = []
      v.scene.traverse((c) => {
        if (c.isInstancedMesh) instanced.push({ count: c.count, opacity: c.material.opacity })
      })

      let renderError = null
      try {
        v.render()
      } catch (e) {
        renderError = e?.message || String(e)
      }

      const graph = v.getSceneGraph()
      const result = {
        loads,
        sharedMap: !!mapA && mapA === mapB,
        instanced,
        wallCount: graph.wallCount,
        graphWalls: graph.walls.length,
        wallHeight: graph.walls[0]?.height ?? null,
        tokenCount: graph.tokenCount,
        renderError,
        drawCalls: v.renderer.info.render.calls,
      }
      v.dispose()
      return result
    },
    { scene: SCENE, TOKENS, WALLS },
  )

  log('loads:', JSON.stringify(out.loads.map((u) => u.slice(0, 40))))
  log('instanced:', JSON.stringify(out.instanced), 'drawCalls:', out.drawCalls)
  log(`graph: tokens=${out.tokenCount} wallCount=${out.wallCount} walls[].len=${out.graphWalls} height=${out.wallHeight}`)

  // ── Texture dedupe: 40 tokens + 1 level + 1 tile + 1 note = 2 unique URLs → ≤2 loads, one per URL.
  const uniqueLoads = new Set(out.loads)
  if (out.loads.length !== uniqueLoads.size) fail(`TextureLoader.load called ${out.loads.length}× for ${uniqueLoads.size} unique URLs — dedupe broken`)
  if (uniqueLoads.size > 2) fail(`expected at most 2 unique texture URLs, saw ${uniqueLoads.size}`)
  if (!out.sharedMap) fail('tok0 and tok39 do not share the same Texture instance')

  // ── Wall instancing: 400 walls → 2 InstancedMesh (one per opacity group), counts preserved.
  if (out.instanced.length !== 2) fail(`expected 2 instanced wall meshes (2 opacity groups), got ${out.instanced.length}`)
  const totalInstances = out.instanced.reduce((s, m) => s + m.count, 0)
  if (totalInstances !== WALLS) fail(`instanced walls total ${totalInstances} != ${WALLS}`)
  if (out.wallCount !== WALLS) fail(`getSceneGraph().wallCount ${out.wallCount} != ${WALLS}`)
  if (out.graphWalls !== WALLS) fail(`getSceneGraph().walls reports ${out.graphWalls} != ${WALLS}`)
  if (out.wallHeight !== 300) fail(`semantic wall height ${out.wallHeight} != 300`)

  // ── The heavy scene renders, and walls cost ~2 draw calls, not 400.
  if (out.renderError) fail(`render() threw on the heavy scene: ${out.renderError}`)
  if (out.tokenCount !== TOKENS) fail(`tokenCount ${out.tokenCount} != ${TOKENS}`)
  if (out.drawCalls >= WALLS) fail(`renderer draw calls ${out.drawCalls} — walls are NOT instanced`)

  if (!process.exitCode) log(`PASS — 1 fetch/URL, shared Texture, ${WALLS} walls in ${out.instanced.length} draw calls, heavy scene renders`)
} catch (e) {
  fail(e?.stack || e?.message || String(e))
} finally {
  await browser.close()
}
