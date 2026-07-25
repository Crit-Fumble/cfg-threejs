/**
 * vtt-viewer-core-gc.browser.mjs — headless-browser TDD for the core's resource
 * collector. three.js GPU resources are MANUAL memory (JS GC frees the handle,
 * the GPU allocation stays until .dispose()), so the core owns an explicit
 * generational mark-and-sweep collector over its shared caches.
 *
 * Contract under test:
 *  - GLB model cache: N tokens sharing one STATIC model URL = ONE loader fetch;
 *    every token gets a clone that SHARES the prototype's geometry;
 *  - SKINNED models are never cache-cloned (shared skeleton = collapsed mesh):
 *    each token gets its own private parse with its own skeleton;
 *  - generational grace: an asset survives ONE build that ignores it and is
 *    swept (GPU side included) on the second — so level-slice reloads and mode
 *    flips never thrash, but abandoned scenes still reclaim;
 *  - manual gc() is STRICT: frees everything the current scene doesn't use;
 *  - 2D↔3D mode flips never refetch models (2D re-stamps without fetching);
 *  - rapid scene hopping keeps the caches bounded (≤ 2 generations resident);
 *  - shadow-casting lights are disposed on rebuild (shadow-map render targets
 *    don't accumulate in renderer.info.memory.textures);
 *  - pooled unit geometries keep a 50-token horde to a handful of GPU buffers;
 *  - dispose() empties every cache and the pool.
 *
 *   node tests/vtt-viewer-core-gc.browser.mjs   (exit 0 = pass)
 */
import { chromium } from '@playwright/test'
import * as esbuild from 'esbuild'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORE = join(__dirname, '../src/core.ts')
const CHROME =
  process.env.REVIEW_CHROME ||
  '/Users/personal/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PIXEL_PNG_2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const log = (...a) => console.log('[viewer-gc-test]', ...a)
const fail = (m) => {
  console.error('[viewer-gc-test] FAIL:', m)
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

const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-webgl'] })
const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage()
page.on('pageerror', (e) => fail('pageerror: ' + e.message))
try {
  await page.setContent('<!doctype html><html><body><div id="v" style="width:800px;height:600px"></div></body></html>')
  await page.addScriptTag({ content: built.outputFiles[0].text })
  const out = await page.evaluate(
    async ({ PIXEL_PNG, PIXEL_PNG_2 }) => {
      const THREE = window.CFGViewer.THREE
      // Spy GLTFLoader: counts fetches per URL; serves a STATIC box for
      // 'shared-model.glb' (geometry disposal observable) and a SKINNED mesh for
      // 'rigged.glb' (skeleton identity observable).
      const modelLoads = []
      window.__protoGeoDisposed = false
      class SpyGLTFLoader {
        load(url, onLoad) {
          modelLoads.push(url)
          setTimeout(() => {
            if (url.includes('rigged')) {
              // A minimally-valid skinned mesh: every vertex fully bound to bone 0
              // (real GLBs always carry skinIndex/skinWeight; Box3.setFromObject
              // walks them for skinned geometry).
              const geo = new THREE.BoxGeometry(10, 10, 10)
              const count = geo.attributes.position.count
              geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4))
              const weights = new Float32Array(count * 4)
              for (let w = 0; w < count; w++) weights[w * 4] = 1
              geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
              const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x8844aa }))
              const bone = new THREE.Bone()
              mesh.add(bone)
              mesh.bind(new THREE.Skeleton([bone]))
              const scene = new THREE.Group()
              scene.add(mesh)
              onLoad({ scene })
              return
            }
            const geo = new THREE.BoxGeometry(10, 10, 10)
            const origDispose = geo.dispose.bind(geo)
            geo.dispose = () => {
              window.__protoGeoDisposed = true
              origDispose()
            }
            const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8844aa }))
            const scene = new THREE.Group()
            scene.add(mesh)
            onLoad({ scene })
          }, 30)
        }
      }

      const v = window.CFGViewer.createViewer({
        element: document.getElementById('v'),
        THREE,
        width: 800,
        height: 600,
        GLTFLoader: SpyGLTFLoader,
        shadows: true,
        mode: '3d',
      })

      const tok = (id, x, extra = {}) => ({ id, x, y: 200, width: 100, height: 100, elevation: 0, ...extra })
      const loadsFor = (u) => modelLoads.filter((m) => m.includes(u)).length

      // ── Scene A: shared textures, 3 tokens on one STATIC model, 2 on a SKINNED one.
      const SCENE_A = {
        bounds: { width: 2000, height: 2000 },
        ambient: { sun: { intensity: 0.8, castShadow: true } },
        lights: [{ id: 'l1', x: 500, y: 500, elevation: 60, radius: 400, intensity: 1.2, castShadow: true }],
        tokens: [
          tok('a1', 100, { texture: PIXEL_PNG }),
          tok('a2', 300, { texture: PIXEL_PNG }),
          tok('b1', 500, { texture: PIXEL_PNG_2 }),
          tok('m1', 700, { model: 'shared-model.glb' }),
          tok('m2', 900, { model: 'shared-model.glb' }),
          tok('m3', 1100, { model: 'shared-model.glb' }),
          tok('s1', 1300, { model: 'rigged.glb' }),
          tok('s2', 1500, { model: 'rigged.glb' }),
        ],
      }
      v.loadScene(SCENE_A)
      await new Promise((r) => setTimeout(r, 500))
      v.render()

      const cloneGeos = ['m1', 'm2', 'm3'].map((id) => {
        let geo = null
        v.tokens.get(id)?.traverse((c) => {
          if (c.isMesh && c.geometry?.type === 'BoxGeometry' && c.userData.cfgShared) geo = c.geometry
        })
        return geo
      })
      const skeletons = ['s1', 's2'].map((id) => {
        let sk = null
        v.tokens.get(id)?.traverse((c) => {
          if (c.isSkinnedMesh) sk = c.skeleton
        })
        return sk
      })
      const afterA = {
        stats: v.getMemoryStats(),
        staticLoads: loadsFor('shared-model'),
        riggedLoads: loadsFor('rigged'),
        clonesPresent: cloneGeos.filter(Boolean).length,
        clonesShareGeometry: !!cloneGeos[0] && cloneGeos[0] === cloneGeos[1] && cloneGeos[1] === cloneGeos[2],
        skinnedPresent: skeletons.filter(Boolean).length,
        skinnedSkeletonsDistinct: !!skeletons[0] && !!skeletons[1] && skeletons[0] !== skeletons[1],
        manualGc: v.gc(),
      }

      // ── Mode flip right after A: models must survive (2D re-stamps) and 3D
      // return must NOT refetch.
      v.setMode('2d')
      const in2d = { modelsCached: v.getMemoryStats().modelsCached, lastGC: v.getMemoryStats().lastGC }
      v.setMode('3d')
      await new Promise((r) => setTimeout(r, 300))
      const backIn3d = { staticLoads: loadsFor('shared-model'), modelsCached: v.getMemoryStats().modelsCached }

      // ── Shadow-light rebuild churn: 6 reloads of the same scene must not
      // accumulate shadow-map render targets.
      v.render()
      const texBeforeChurn = v.renderer.info.memory.textures
      for (let i = 0; i < 6; i++) {
        v.loadScene(SCENE_A)
        v.render()
      }
      await new Promise((r) => setTimeout(r, 300))
      v.render()
      const texAfterChurn = v.renderer.info.memory.textures

      // ── Grace window: scene B drops PIXEL_PNG_2 + both models. First build:
      // everything survives (age 1). Second build: swept, GPU side included.
      const SCENE_B = { bounds: { width: 2000, height: 2000 }, tokens: [tok('a1', 100, { texture: PIXEL_PNG })] }
      v.loadScene(SCENE_B)
      await new Promise((r) => setTimeout(r, 100))
      const afterB1 = { stats: v.getMemoryStats(), protoDisposed: window.__protoGeoDisposed }
      v.loadScene(SCENE_B)
      await new Promise((r) => setTimeout(r, 100))
      const afterB2 = { stats: v.getMemoryStats(), protoDisposed: window.__protoGeoDisposed }

      // ── Manual gc() is strict: reload A (repopulates), then load B once and
      // gc() immediately — the unused entries die NOW, no grace.
      v.loadScene(SCENE_A)
      await new Promise((r) => setTimeout(r, 400))
      v.loadScene(SCENE_B)
      const strictGc = v.gc()
      const afterStrict = v.getMemoryStats()

      // ── Rapid hopping: 20 scenes, each with a UNIQUE generated texture — the
      // cache must stay bounded to the grace window (≤ 2 gens), GPU count flat.
      const mkTex = (i) => {
        const c = document.createElement('canvas')
        c.width = c.height = 2
        const ctx = c.getContext('2d')
        ctx.fillStyle = `rgb(${(i * 11) % 255},${(i * 37) % 255},${(i * 73) % 255})`
        ctx.fillRect(0, 0, 2, 2)
        return c.toDataURL()
      }
      for (let i = 0; i < 20; i++) {
        v.loadScene({ bounds: { width: 1000, height: 1000 }, tokens: [tok(`hop${i}`, 100, { texture: mkTex(i) })] })
      }
      await new Promise((r) => setTimeout(r, 400))
      v.render()
      const afterHop = v.getMemoryStats()

      // ── Horde: pooled unit geometry keeps GPU buffers flat for 50 tokens.
      v.loadScene({
        bounds: { width: 4000, height: 4000 },
        grid: { size: 100, showHelper: true },
        tokens: Array.from({ length: 50 }, (_, i) => tok(`h${i}`, 100 + (i % 10) * 350, { y: 100 + Math.floor(i / 10) * 350, color: 0x4caf50 })),
      })
      await new Promise((r) => setTimeout(r, 100))
      v.render()
      const afterHorde = v.getMemoryStats()

      v.dispose()
      const afterDispose = v.getMemoryStats()

      return { afterA, in2d, backIn3d, texBeforeChurn, texAfterChurn, afterB1, afterB2, strictGc, afterStrict, afterHop, afterHorde, afterDispose }
    },
    { PIXEL_PNG, PIXEL_PNG_2 },
  )

  const { afterA, in2d, backIn3d, texBeforeChurn, texAfterChurn, afterB1, afterB2, strictGc, afterStrict, afterHop, afterHorde, afterDispose } = out
  log('afterA:', JSON.stringify(afterA))
  log('modeFlip:', JSON.stringify({ in2d, backIn3d }))
  log('shadowChurn:', JSON.stringify({ texBeforeChurn, texAfterChurn }))
  log('grace:', JSON.stringify({ afterB1: afterB1.stats.lastGC, afterB2: afterB2.stats.lastGC }))
  log('strict:', JSON.stringify(strictGc), 'hop:', JSON.stringify({ cached: afterHop.texturesCached, gpu: afterHop.gpuTextures }))
  log('horde gpuGeometries:', afterHorde.gpuGeometries)

  // Scene A: one fetch per STATIC url; clones share geometry. Skinned: one parse
  // PER TOKEN (first parse discarded + one private each), distinct skeletons.
  if (afterA.staticLoads !== 1) fail(`static model: ${afterA.staticLoads} loads for 3 tokens — cache broken`)
  if (afterA.clonesPresent !== 3 || !afterA.clonesShareGeometry) fail('static clones missing or not sharing geometry')
  if (afterA.skinnedPresent !== 2) fail(`skinned tokens present ${afterA.skinnedPresent} != 2`)
  if (!afterA.skinnedSkeletonsDistinct) fail('skinned tokens SHARE a skeleton — collapsed-mesh bug')
  if (afterA.riggedLoads !== 3) fail(`rigged.glb loads ${afterA.riggedLoads} != 3 (1 detection parse + 2 private)`)
  if (afterA.stats.texturesCached !== 2) fail(`texturesCached ${afterA.stats.texturesCached} != 2`)
  if (afterA.stats.modelsCached !== 2) fail(`modelsCached ${afterA.stats.modelsCached} != 2 (static proto + skinned marker)`)
  if (afterA.manualGc.textures !== 0 || afterA.manualGc.models !== 0) fail(`strict gc right after load freed ${JSON.stringify(afterA.manualGc)}`)

  // Mode flips never thrash models.
  if (in2d.modelsCached !== 2) fail(`3D→2D flip dropped model entries (${in2d.modelsCached})`)
  if (in2d.lastGC.models !== 0) fail(`3D→2D flip swept ${in2d.lastGC.models} models`)
  if (backIn3d.staticLoads !== 1) fail(`2D→3D return refetched the static model (${backIn3d.staticLoads} loads)`)

  // Shadow-light churn: render targets must not accumulate (allow ±2 slack).
  if (texAfterChurn > texBeforeChurn + 2) fail(`shadow churn grew GPU textures ${texBeforeChurn} → ${texAfterChurn} — light dispose missing`)

  // Grace: first ignoring build keeps everything; second sweeps texture+models.
  if (afterB1.stats.lastGC.textures !== 0 || afterB1.stats.lastGC.models !== 0) fail(`grace violated: first build swept ${JSON.stringify(afterB1.stats.lastGC)}`)
  if (afterB1.protoDisposed) fail('prototype GPU-disposed during the grace window')
  if (afterB2.stats.texturesCached !== 1) fail(`after 2nd B build texturesCached ${afterB2.stats.texturesCached} != 1`)
  if (afterB2.stats.modelsCached !== 0) fail(`after 2nd B build modelsCached ${afterB2.stats.modelsCached} != 0`)
  if (!afterB2.protoDisposed) fail('swept prototype did NOT dispose its GPU geometry — dangling VRAM')

  // Strict manual gc(): everything unused dies immediately.
  if (strictGc.textures < 1 || strictGc.models < 1) fail(`strict gc freed ${JSON.stringify(strictGc)} — expected ≥1 texture + ≥1 model`)
  if (afterStrict.texturesCached !== 1 || afterStrict.modelsCached !== 0) fail(`after strict gc: ${afterStrict.texturesCached} tex / ${afterStrict.modelsCached} models cached`)

  // Rapid hopping stays bounded to the grace window.
  if (afterHop.texturesCached > 2) fail(`20-scene hop left ${afterHop.texturesCached} textures cached (> grace window)`)
  if (afterHop.gpuTextures > 6) fail(`20-scene hop left ${afterHop.gpuTextures} GPU textures resident`)

  // Horde: pooled geometry keeps buffers flat.
  if (afterHorde.gpuGeometries > 15) fail(`50-token horde resident GPU geometries ${afterHorde.gpuGeometries} — pooling broken`)

  // dispose() empties everything.
  if (afterDispose.texturesCached !== 0 || afterDispose.modelsCached !== 0 || afterDispose.pooledGeometries !== 0)
    fail(`dispose() left caches populated: ${JSON.stringify(afterDispose)}`)

  if (!process.exitCode) log('PASS — generational GC: static clone sharing, skinned isolation, grace window, strict gc(), no mode-flip/shadow thrash, bounded hopping, pooled horde, clean dispose')
} catch (e) {
  fail(e?.stack || e?.message || String(e))
} finally {
  await browser.close()
}
