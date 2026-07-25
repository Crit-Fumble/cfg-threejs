/**
 * vtt-viewer-core-doors.browser.mjs — headless-browser TDD for door/window walls.
 *
 * Contract under test (kind/doorState on ViewerWall):
 *  - doors render as visible panels COLOR-CODED apart from walls (wood brown;
 *    locked panels darker), still INSTANCED per style group;
 *  - an OPEN door swings ~75° about its (x1,y1) hinge — the instance transform
 *    pivots on the hinge, not the midpoint;
 *  - every door gets a brass handle knob (instanced spheres, both faces);
 *    LOCKED doors additionally get a lock block under the handle — an open or
 *    closed unlocked door has NO lock;
 *  - windows render translucent (glass: transparent, opacity ≪ 1, depthWrite
 *    off, no shadow casting) in 3D, and translucent flat strips in 2D;
 *  - secretDoor renders as its own purple-coded group (adapter only emits it
 *    for GMs — the core just renders what it's told);
 *  - getSceneGraph().walls[] reports kind + doorState per wall;
 *  - draw calls stay bounded: many doors/windows = one InstancedMesh per style
 *    group, not per segment.
 *
 *   node tests/vtt-viewer-core-doors.browser.mjs   (exit 0 = pass)
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

// 100px segments on a simple floor. Door hinge at (x1,y1).
const SCENE = {
  bounds: { width: 1200, height: 1200 },
  walls: [
    { id: 'wall1', x1: 0, y1: 100, x2: 100, y2: 100, bottom: 0, top: 200, opacity: 0.85 },
    { id: 'wall2', x1: 0, y1: 150, x2: 100, y2: 150, bottom: 0, top: 200, opacity: 0.85 },
    { id: 'door-closed', x1: 200, y1: 100, x2: 300, y2: 100, bottom: 0, top: 200, kind: 'door', doorState: 'closed' },
    { id: 'door-open', x1: 400, y1: 100, x2: 500, y2: 100, bottom: 0, top: 200, kind: 'door', doorState: 'open' },
    { id: 'door-locked', x1: 600, y1: 100, x2: 700, y2: 100, bottom: 0, top: 200, kind: 'door', doorState: 'locked' },
    { id: 'secret', x1: 800, y1: 100, x2: 900, y2: 100, bottom: 0, top: 200, kind: 'secretDoor', doorState: 'closed' },
    { id: 'window1', x1: 1000, y1: 100, x2: 1100, y2: 100, bottom: 0, top: 200, kind: 'window' },
    { id: 'window2', x1: 1000, y1: 300, x2: 1100, y2: 300, bottom: 0, top: 200, kind: 'window' },
  ],
  tokens: [],
}

const log = (...a) => console.log('[viewer-doors-test]', ...a)
const fail = (m) => {
  console.error('[viewer-doors-test] FAIL:', m)
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
  const out = await page.evaluate(async (scene) => {
    const THREE = window.CFGViewer.THREE
    const v = window.CFGViewer.createViewer({ element: document.getElementById('v'), THREE, width: 800, height: 600, mode: '3d' })
    v.loadScene(scene)
    await new Promise((r) => setTimeout(r, 150))
    v.render()

    const dumpInstanced = () => {
      const list = []
      v.scene.traverse((c) => {
        if (!c.isInstancedMesh) return
        const m = new THREE.Matrix4()
        const pos = new THREE.Vector3()
        const q = new THREE.Quaternion()
        const scl = new THREE.Vector3()
        const inst = []
        for (let i = 0; i < c.count; i++) {
          c.getMatrixAt(i, m)
          m.decompose(pos, q, scl)
          const e = new THREE.Euler().setFromQuaternion(q, 'YXZ')
          const color = new THREE.Color()
          if (c.instanceColor) c.getColorAt(i, color)
          inst.push({ x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1), yawDeg: +((e.y * 180) / Math.PI).toFixed(1), sx: +scl.x.toFixed(1), color: '#' + color.getHexString() })
        }
        list.push({
          geo: c.geometry.type,
          geoParams: { w: c.geometry.parameters?.width, d: c.geometry.parameters?.depth, r: c.geometry.parameters?.radius },
          count: c.count,
          transparent: c.material.transparent,
          opacity: c.material.opacity,
          depthWrite: c.material.depthWrite,
          castShadow: c.castShadow,
          inst,
        })
      })
      return list
    }

    const g3d = { meshes: dumpInstanced(), graph: v.getSceneGraph() }

    v.setMode('2d')
    await new Promise((r) => setTimeout(r, 100))
    v.render()
    const g2d = { meshes: dumpInstanced(), graph: v.getSceneGraph() }

    v.dispose()
    return { g3d, g2d }
  }, SCENE)

  const { g3d, g2d } = out
  const panels3d = g3d.meshes.filter((mm) => mm.geo === 'BoxGeometry' && mm.geoParams.d === 8)
  const handles = g3d.meshes.find((mm) => mm.geo === 'SphereGeometry')
  const locks = g3d.meshes.find((mm) => mm.geo === 'BoxGeometry' && mm.geoParams.d === 3)
  log('3d panel groups:', panels3d.length, JSON.stringify(panels3d.map((p) => ({ count: p.count, opacity: p.opacity, color: p.inst[0]?.color }))))
  log('handles:', handles?.count, 'locks:', locks?.count)
  log('graph walls:', JSON.stringify(g3d.graph.walls.map((w) => ({ kind: w.kind, doorState: w.doorState }))))

  // ── Style groups: walls(2), door-closed, door-open, door-locked, secret, windows(2) → 6 panel groups.
  if (panels3d.length !== 6) fail(`expected 6 instanced panel groups (walls/closed/open/locked/secret/windows), got ${panels3d.length}`)
  const groupBy = (pred) => panels3d.find(pred)
  const wallsG = groupBy((p) => p.count === 2 && p.opacity === 0.85)
  const windowsG = groupBy((p) => p.count === 2 && p.transparent && p.opacity < 0.5)
  if (!wallsG) fail('plain-wall group (2 instances @ 0.85) missing')
  if (!windowsG) fail('window group (2 translucent instances) missing')

  // ── Windows are glass: very translucent, no depth-write, no shadow.
  if (windowsG) {
    if (windowsG.depthWrite !== false) fail('window glass writes depth — would occlude what is behind it')
    if (windowsG.castShadow) fail('window glass casts shadow')
  }

  // ── Doors are color-coded apart from walls; locked darker than closed.
  const doorGroups = panels3d.filter((p) => p.count === 1)
  const colors = new Set(doorGroups.map((p) => p.inst[0].color))
  if (doorGroups.length !== 4) fail(`expected 4 single-door groups, got ${doorGroups.length}`)
  if (wallsG && colors.has(wallsG.inst[0].color)) fail('a door renders in the plain-wall color — not visually distinct')
  const closed = doorGroups.find((p) => p.inst[0].x === 250)
  const open = doorGroups.find((p) => Math.abs(p.inst[0].yawDeg) > 10 && Math.abs(p.inst[0].yawDeg) < 170)
  const locked = doorGroups.find((p) => p.inst[0].x === 650)
  const secret = doorGroups.find((p) => p.inst[0].x === 850)
  if (!closed) fail('closed door panel not at its midpoint')
  if (locked && closed && locked.inst[0].color === closed.inst[0].color) fail('locked door panel not visually distinct from closed')
  if (secret && closed && secret.inst[0].color === closed.inst[0].color) fail('secret door panel not visually distinct from a normal door')

  // ── Open door: swung ~75° about the hinge (400,100) — panel center moves off
  // the closed midpoint (450,100) but stays len/2 = 50 from the hinge.
  if (!open) fail('open door panel shows no swing rotation')
  else {
    const { x, z } = open.inst[0]
    const dHinge = Math.hypot(x - 400, z - 100)
    if (Math.abs(dHinge - 50) > 1) fail(`open door center is ${dHinge.toFixed(1)}px from its hinge (expected 50)`)
    if (Math.abs(x - 450) < 5 && Math.abs(z - 100) < 5) fail('open door center still at the closed midpoint — no swing')
  }

  // ── Hardware: 4 doors (closed/open/locked/secret) × 2 faces = 8 handles; only the locked door has locks (2).
  if (!handles || handles.count !== 8) fail(`handle knobs: ${handles?.count ?? 0} != 8 (4 doors × 2 faces)`)
  if (!locks || locks.count !== 2) fail(`lock blocks: ${locks?.count ?? 0} != 2 (locked door only)`)
  if (locks && handles) {
    const lockNearLockedDoor = locks.inst.every((l) => Math.abs(l.z - 100) < 20 && l.x > 600 && l.x < 700)
    if (!lockNearLockedDoor) fail('lock blocks not positioned on the locked door')
  }

  // ── Scene graph reports kinds + states.
  const kinds = g3d.graph.walls.map((w) => `${w.kind}${w.doorState ? ':' + w.doorState : ''}`).sort()
  const expected = ['door:closed', 'door:locked', 'door:open', 'secretDoor:closed', 'wall', 'wall', 'window', 'window'].sort()
  if (JSON.stringify(kinds) !== JSON.stringify(expected)) fail(`graph kinds ${JSON.stringify(kinds)} != ${JSON.stringify(expected)}`)

  // ── 2D: flat strips still style-grouped; windows translucent; no 3D hardware.
  const strips2d = g2d.meshes.filter((mm) => mm.geo === 'PlaneGeometry' && mm.geoParams.d === undefined)
  const win2d = strips2d.find((p) => p.count === 2 && p.transparent && p.opacity < 0.5)
  if (!win2d) fail('2D window strips not translucent')
  if (g2d.meshes.some((mm) => mm.geo === 'SphereGeometry')) fail('2D renders handle knobs — should be 3D-only')
  const open2d = strips2d.flatMap((p) => p.inst).find((i) => Math.abs(Math.hypot(i.x - 400, i.z - 100) - 50) < 1 && !(Math.abs(i.x - 450) < 5 && Math.abs(i.z - 100) < 5))
  if (!open2d) fail('2D open door strip not swung about its hinge')

  if (!process.exitCode) log('PASS — doors color-coded + swinging on hinges with handles/locks, windows glass, secret purple, graph reports kinds, all instanced')
} catch (e) {
  fail(e?.stack || e?.message || String(e))
} finally {
  await browser.close()
}
