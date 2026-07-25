/**
 * vtt-controls.browser.mjs — proves the shared ViewerControls (controls.ts) drives the
 * viewer core correctly in a real headless browser: mode switching + framing, allowedModes
 * gating, left-click token selection, and focus-centred orbit pivot. Bundles core + controls
 * FROM SOURCE. Exit 0 = pass.
 *
 *   node tests/vtt-controls.browser.mjs
 */
import { chromium } from '@playwright/test'
import * as esbuild from 'esbuild'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORE = join(__dirname, '../src/core.ts')
const CONTROLS = join(__dirname, '../src/controls.ts')
const CHROME =
  process.env.REVIEW_CHROME ||
  '/Users/personal/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

const log = (...a) => console.log('[controls-test]', ...a)
const fail = (m) => {
  console.error('[controls-test] FAIL:', m)
  process.exitCode = 1
}

const built = await esbuild.build({
  stdin: {
    contents: `import * as THREE from 'three'; import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'; import { createViewer } from ${JSON.stringify(CORE)}; import { createViewerControls } from ${JSON.stringify(CONTROLS)}; globalThis.CFG = { THREE, OrbitControls, createViewer, createViewerControls };`,
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
page.on('pageerror', (e) => {
  if (!/setPointerCapture/.test(e.message)) fail('pageerror: ' + e.message) // synthetic events lack a real pointer
})
try {
  await page.setContent('<!doctype html><html><head><style>#v canvas{width:100%!important;height:100%!important;display:block}</style></head><body style="margin:0"><div id="v" style="position:fixed;inset:0"></div></body></html>')
  await page.addScriptTag({ content: built.outputFiles[0].text })
  const out = await page.evaluate(async () => {
    const { THREE, OrbitControls, createViewer, createViewerControls } = window.CFG
    const bounds = { width: 2000, height: 2000, x: 0, y: 0 }
    const scene = {
      grid: { size: 100, distance: 5 },
      bounds,
      tokens: [{ id: 'hero', x: 950, y: 950, width: 1, height: 1, elevation: 0, color: 0x4caf50 }], // centre token
    }
    const el = document.getElementById('v')
    const viewer = createViewer({ element: el, THREE, width: el.clientWidth, height: el.clientHeight, mode: '2d' })
    viewer.loadScene(scene)

    const selected = []
    const controls = createViewerControls(viewer, {
      THREE,
      OrbitControls,
      getBounds: () => bounds,
      mode: '2d',
      allowedModes: ['2d', 'topdown'], // 'free' intentionally NOT allowed → gating test
      onSelect: (id) => selected.push(id),
    })

    const results = {}
    results.initialMode = controls.getMode()
    results.allowed = controls.allowedModes.slice()

    // Gating: 'free' is not allowed → setMode is a no-op.
    controls.setMode('free')
    results.freeBlocked = controls.getMode() !== 'free'

    // Top-down framing: camera straight above centre, looking down.
    controls.setMode('topdown')
    const cxz = [bounds.width / 2, bounds.height / 2]
    results.topdownMode = controls.getMode()
    results.camAboveCentre = Math.abs(viewer.camera.position.x - cxz[0]) < 1 && Math.abs(viewer.camera.position.z - cxz[1]) < 1 && viewer.camera.position.y > 100
    results.camUpIsHorizontal = Math.abs(viewer.camera.up.y) < 1e-6 // up is a horizontal axis looking straight down

    // Selection: project the token to screen, click it, expect onSelect('hero').
    const grp = viewer.tokens.get('hero')
    const wp = new THREE.Vector3()
    grp.getWorldPosition(wp)
    wp.y += 10
    const p = wp.clone().project(viewer.camera)
    const r = el.getBoundingClientRect()
    const px = r.left + (p.x * 0.5 + 0.5) * r.width
    const py = r.top + (-p.y * 0.5 + 0.5) * r.height
    const dom = viewer.renderer.domElement
    dom.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: px, clientY: py, bubbles: true }))
    dom.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: px, clientY: py, bubbles: true }))
    results.selectedHero = selected.includes('hero')

    // A click far from any token → onSelect(null).
    selected.length = 0
    dom.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: r.left + 5, clientY: r.top + 5, bubbles: true }))
    dom.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: r.left + 5, clientY: r.top + 5, bubbles: true }))
    results.emptyClickNull = selected.length === 1 && selected[0] === null

    // Focus pivot: allow free, enter it, move the camera off-centre, right-press at
    // screen centre → orbit target re-centres (projects to NDC ~0,0).
    const controls2 = createViewerControls(viewer, {
      THREE,
      OrbitControls,
      getBounds: () => bounds,
      mode: 'free',
      allowedModes: ['free'],
    })
    viewer.camera.position.set(300, 900, 2600)
    viewer.camera.updateProjectionMatrix()
    viewer.camera.updateMatrixWorld(true) // the render loop does this each frame in the app
    dom.dispatchEvent(new PointerEvent('pointerdown', { button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }))
    const tproj = controls2.orbit3d.target.clone().project(viewer.camera)
    results.pivotCentred = Math.abs(tproj.x) < 0.05 && Math.abs(tproj.y) < 0.05

    // Dispose the earlier controllers so their render loops don't fight the character camera.
    controls.dispose()
    controls2.dispose()

    // ── Character view: view-only FP/3rd-person anchored on the hero token ──────────
    const c3 = createViewerControls(viewer, { THREE, OrbitControls, getBounds: () => bounds, mode: 'topdown', allowedModes: ['topdown', 'character'] })
    c3.setSubject('hero')
    c3.setMode('character')
    results.charMode = c3.getMode()
    const hp = new THREE.Vector3()
    viewer.tokens.get('hero').getWorldPosition(hp)
    const eye = new THREE.Vector3(hp.x, hp.y + viewer.getGridSize() * 0.9, hp.z)
    // On enter → third person: the camera is dollied back off the eye, subject body visible.
    results.charThirdPerson = viewer.camera.position.distanceTo(eye) > 100
    results.charSubjectVisibleInThird = viewer.tokens.get('hero').visible === true
    // Wheel all the way in → first person: camera ≈ at the eye, subject body hidden.
    for (let i = 0; i < 12; i++) dom.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
    results.charFirstPerson = viewer.camera.position.distanceTo(eye) < 30
    results.charSubjectHiddenInFirst = viewer.tokens.get('hero').visible === false
    // Leaving character view restores the subject's body.
    c3.setMode('topdown')
    results.charSubjectRestored = viewer.tokens.get('hero').visible === true
    c3.dispose()
    return results
  })

  log(JSON.stringify(out))
  if (out.initialMode !== '2d') fail(`initial mode ${out.initialMode} != 2d`)
  if (JSON.stringify(out.allowed) !== JSON.stringify(['2d', 'topdown'])) fail(`allowedModes ${JSON.stringify(out.allowed)}`)
  if (!out.freeBlocked) fail('gating: setMode(free) was NOT blocked when disallowed')
  if (out.topdownMode !== 'topdown') fail('setMode(topdown) did not switch')
  if (!out.camAboveCentre) fail('top-down camera not framed straight above scene centre')
  if (!out.camUpIsHorizontal) fail('top-down camera up is not horizontal (looking straight down)')
  if (!out.selectedHero) fail('left-click on the token did not fire onSelect(hero)')
  if (!out.emptyClickNull) fail('left-click on empty space did not fire onSelect(null)')
  if (!out.pivotCentred) fail('right-press did not re-centre the orbit pivot to screen centre')
  if (out.charMode !== 'character') fail('setMode(character) did not switch')
  if (!out.charThirdPerson) fail('character view did not start in third person (camera not dollied off the eye)')
  if (!out.charSubjectVisibleInThird) fail('subject body should be visible in third person')
  if (!out.charFirstPerson) fail('wheel-in did not dolly the character camera to first person')
  if (!out.charSubjectHiddenInFirst) fail('subject body should be hidden in first person')
  if (!out.charSubjectRestored) fail('leaving character view did not restore the subject body')
  if (!process.exitCode) log('PASS — modes+framing, gating, selection, focus pivot, and character view all verified')
} catch (e) {
  fail(e?.stack || e?.message || String(e))
} finally {
  await browser.close()
}
