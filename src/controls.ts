import type * as ThreeNS from 'three'
import type { Viewer } from './core.js'

/**
 * controls — the shared camera/input controller for the VTT viewer core. ONE place
 * that owns the Foundry-like control scheme so the platform's offline viewer and the
 * FoundryVTT plugin behave identically (no per-host duplication). Like the core, THREE
 * and OrbitControls are INJECTED by the host — zero direct three/React/Foundry imports.
 *
 * Scheme — each mode is faithful to the genre it resembles:
 *   2D / Top-Down (Foundry): left = select · right drag = PAN · wheel = zoom · arrows = pan
 *   Free / Orbit  (TaleSpire / Tabletop Simulator): left = select · right drag = ORBIT ·
 *                 MIDDLE drag = PAN · W A S D = ground-pan · Q / E = height down/up · wheel = zoom
 *   Character     (MMORPG, view-only): see below — right drag looks, wheel dollies 1st↔3rd person
 *
 * Character view ('character') is a VIEW-ONLY first/third-person camera anchored on a subject
 * token (setSubject): drag looks (azimuth/pitch), wheel dollies between first and third person,
 * left-click still selects. No token MOVEMENT (the offline server can't persist it) — this
 * mirrors the plugin's first-person camera rig without its walk/commit machinery.
 *
 * Orbit pivots on the FOCUS POINT under screen-centre (recomputed when a right-drag
 * orbit begins), so rotation always centres on the current view.
 *
 * Camera framing (straight-down Top-Down, 2D reset) uses the scene bounds the host
 * supplies via getBounds(); the controller never reads scene JSON itself.
 */

// 'tabletop' = the PARTY seat (south side of the table); 'tabletop-gm' = the same constrained
// building camera from the OPPOSITE side (N/S flipped) — the GM's seat across the table. Players get
// the party seat; GMs get both. (Long-term: physical GM/player screens live on this table metaphor.)
export type ViewerCameraMode = '2d' | 'topdown' | 'tabletop' | 'tabletop-gm' | 'free' | 'character'

/** The bounds rect the host's current scene spans (same shape as ViewerScene.bounds). */
export interface ViewerBounds {
  width: number
  height: number
  x?: number
  y?: number
}

/** Structural view of three/examples OrbitControls — only what this controller uses. */
export interface OrbitControlsLike {
  target: ThreeNS.Vector3
  enabled: boolean
  enableRotate: boolean
  enablePan: boolean
  enableZoom: boolean
  /** Dolly toward the cursor instead of the target (Map/RTS zoom-to-cursor). three r150+. */
  zoomToCursor: boolean
  enableDamping: boolean
  dampingFactor: number
  minDistance: number
  maxDistance: number
  minZoom: number
  maxZoom: number
  /** Clamp the vertical orbit angle (radians from straight-up). Tabletop pins these so the
   * camera can never flip under the map or tip fully overhead. */
  minPolarAngle: number
  maxPolarAngle: number
  /** Clamp the horizontal orbit angle (radians; three's θ = atan2(x,z), 0 = +Z). Player seats pin
   * these to a 270° arc so they can never rotate round to the GM's side; the GM leaves them open. */
  minAzimuthAngle: number
  maxAzimuthAngle: number
  getAzimuthalAngle(): number
  screenSpacePanning: boolean
  mouseButtons: { LEFT?: number | null; MIDDLE?: number | null; RIGHT?: number | null }
  // `null` allowed to match three's own TOUCH-or-null typing (a consumer can disable a gesture).
  touches: { ONE?: number | null; TWO?: number | null }
  update(): boolean
  dispose(): void
  addEventListener(type: string, listener: () => void): void
}
export type OrbitControlsCtor = new (camera: ThreeNS.Camera, dom: HTMLElement) => OrbitControlsLike

export interface ViewerControlsOptions {
  /** The host's three build (same instance injected into createViewer). */
  THREE: typeof ThreeNS
  /** three/examples OrbitControls constructor. */
  OrbitControls: OrbitControlsCtor
  /** Current scene bounds, for framing. Re-read on every setMode/reframe. */
  getBounds: () => ViewerBounds
  /** Initial mode. Default '2d'. */
  mode?: ViewerCameraMode
  /** Modes the user is permitted to enter (role gating). Default all three.
   * setMode to a disallowed mode is a no-op (defence-in-depth beyond hidden buttons). */
  allowedModes?: ViewerCameraMode[]
  /** Left-click token selection. worldPoint is the ray hit on the token. */
  onSelect?: (tokenId: string | null, worldPoint?: ThreeNS.Vector3) => void
  /** Fired after a successful setMode. */
  onModeChange?: (mode: ViewerCameraMode) => void
  /** Show a small marker at the orbit pivot in Free Camera (debug/affordance). Default false. */
  showPivot?: boolean
}

export interface ViewerControls {
  setMode(mode: ViewerCameraMode): void
  getMode(): ViewerCameraMode
  /** Anchor the 'character' camera on a token (by id), or null to detach. Safe to call in any
   * mode — it takes effect when 'character' is active and seeds the look azimuth from the
   * token's facing. */
  setSubject(tokenId: string | null): void
  getSubject(): string | null
  /** Modes currently permitted (for the host to render only allowed buttons). */
  readonly allowedModes: ViewerCameraMode[]
  isAllowed(mode: ViewerCameraMode): boolean
  /** Let a host tool borrow the keyboard: false disables camera WASD/arrow/Q-E pan (e.g. while the
   *  terrain Level Stamp uses those keys), true restores it. */
  setKeyPanEnabled(enabled: boolean): void
  /** Tabletop SEAT: move the camera to an azimuth around the table (radians; 0 = Party/south side,
   *  ±π = GM/north). Clamped to the current seat's allowed arc. No-op outside tabletop modes. */
  setSeat(azimuthRad: number): void
  getSeat(): number
  /** The current seat's allowed azimuth arc (radians) — for a slider. Players get 270°, GM 360°. */
  getSeatRange(): { min: number; max: number }
  /** Re-apply framing for the current mode (call after the scene/bounds change). */
  reframe(): void
  dispose(): void
  /** The active OrbitControls (3D or 2D) for the current mode. */
  readonly orbit3d: OrbitControlsLike
  readonly orbit2d: OrbitControlsLike
}

const ALL_MODES: ViewerCameraMode[] = ['2d', 'topdown', 'tabletop', 'tabletop-gm', 'free', 'character']
const PAN_KEYS = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', 'q', 'e']
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * Attach the shared control scheme to a viewer. Returns a handle for mode switching +
 * teardown. The host still owns createViewer, loadScene, and the mode-switch UI.
 */
export function createViewerControls(viewer: Viewer, opts: ViewerControlsOptions): ViewerControls {
  const { THREE, OrbitControls, getBounds, onSelect, onModeChange } = opts
  const dom = viewer.renderer.domElement as HTMLElement
  const allowed = (opts.allowedModes ?? ALL_MODES).filter((m) => ALL_MODES.includes(m))
  const MOUSE = THREE.MOUSE
  const TOUCH = THREE.TOUCH

  let mode: ViewerCameraMode = opts.mode && allowed.includes(opts.mode) ? opts.mode : allowed[0] || '2d'
  let dirty = true
  let hovered = false
  // A tool (e.g. the terrain Level Stamp) can borrow WASD/Q-E/arrows for itself by turning off the
  // camera's keyboard pan while it's armed — the host restores it when the tool is put away.
  let keyPanEnabled = true
  // Tabletop SEAT azimuth (radians around the table; 0 = Party/+Z south, ±π = GM/-Z north). Players
  // are clamped to a 180° arc centred on their south home (±90°) so they can never orbit far enough to
  // see the GM's screen on the far side; the GM roams the full table. Seeded from the INITIAL mode so a
  // viewer that opens straight into GM View starts on the GM's (north) side, not the default south.
  let seatAzimuth = mode === 'tabletop-gm' ? Math.PI : 0
  const PLAYER_HALF_ARC = Math.PI / 2 // players see a 180° arc (their half of the table); GM's side stays behind them
  // The GM sits at π (north) and may sweep the WHOLE table — but bounded, so the camera can't wind
  // round and round forever. Note the range must be expressed within [-π, π]: OrbitControls normalises
  // min/max into that window, so a literal [0, 2π] collapses to [0, 0] and pins the GM facing south.
  const seatRangeFor = (m: ViewerCameraMode) =>
    m === 'tabletop-gm' ? { min: -Math.PI, max: Math.PI } : { min: -PLAYER_HALF_ARC, max: PLAYER_HALF_ARC }
  const applySeatPosition = () => {
    const { cx, cz, span } = frame()
    const dist = span * 0.9
    const horiz = dist * 0.57
    viewer.camera.position.set(cx + horiz * Math.sin(seatAzimuth), dist * 0.82, cz + horiz * Math.cos(seatAzimuth))
    viewer.camera.lookAt(cx, 0, cz)
    viewer.camera.updateProjectionMatrix()
    orbit3d.target.set(cx, 0, cz)
    orbit3d.update()
    dirty = true
  }

  // ── Character-view state (view-only first/third-person anchored on a subject token) ──
  let subjectId: string | null = null
  let charAzimuth = 0 // radians; 0 faces -Z (Foundry "north")
  let charPitch = 0 // radians; + looks up
  let charDist = 0 // px from the subject eye; < gridSize/2 → first person (subject body hidden)
  let lastPointer: { x: number; y: number } | null = null
  const charEye = new THREE.Vector3()
  const charDir = new THREE.Vector3()

  const frame = () => {
    const b = getBounds()
    return { cx: (b.x ?? 0) + b.width / 2, cz: (b.y ?? 0) + b.height / 2, span: Math.max(b.width, b.height) }
  }

  // ── OrbitControls: one for the perspective camera (2D/3D share the 3D one for
  // topdown/free), one for the ortho camera (2D). ──────────────────────────────────
  // OrbitControls captures its orbit FRAME from `camera.up` once, in its constructor
  // (`_quat = setFromUnitVectors(object.up, +Y)`) — it never recomputes it. Top-Down parks a
  // HORIZONTAL up on the perspective camera (0,0,-1; required when looking straight down), so a
  // controller built while the camera sits in Top-Down would measure every azimuth in a tilted
  // frame — tabletop seats and character facing silently break, with nothing to hint why. Restore
  // world-up BEFORE constructing so the frame is always upright; the modes that need a different
  // up (Top-Down) set it themselves afterwards, and their polar angle is pinned so the orbit frame
  // never enters into it. Hosts previously had to know this and work around it externally.
  viewer.camera.up.set(0, 1, 0)
  const orbit3d = new OrbitControls(viewer.camera, dom)
  orbit3d.enableDamping = true
  orbit3d.dampingFactor = 0.08
  orbit3d.screenSpacePanning = true
  orbit3d.zoomToCursor = true // dolly toward the cursor — the Map/RTS feel, shared by tabletop/topdown/free
  orbit3d.minDistance = 50
  orbit3d.maxDistance = 20000
  orbit3d.enabled = false
  orbit3d.addEventListener('change', () => (dirty = true))

  const orbit2d = new OrbitControls(viewer.camera2d, dom)
  orbit2d.enableRotate = false
  orbit2d.screenSpacePanning = true
  orbit2d.minZoom = 0.2
  orbit2d.maxZoom = 10
  orbit2d.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN }
  orbit2d.enabled = false
  orbit2d.addEventListener('change', () => (dirty = true))

  const active = (): OrbitControlsLike => (mode === '2d' ? orbit2d : orbit3d)

  // ── Optional pivot marker ────────────────────────────────────────────────────────
  const pivotMarker = opts.showPivot
    ? new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xff3b6b, depthTest: false, transparent: true, opacity: 0.85 }),
      )
    : null
  if (pivotMarker) {
    pivotMarker.userData.isPivot = true
    pivotMarker.renderOrder = 999
    pivotMarker.visible = false
    viewer.scene.add(pivotMarker)
  }

  // ── Left-click token selection ─────────────────────────────────────────────────
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const CENTER = new THREE.Vector2(0, 0)
  let down: { x: number; y: number } | null = null
  const skip = (o: ThreeNS.Object3D | undefined) => !!o?.userData?.isPivot || /Line|Helper|Points|Sprite/.test(o?.type || '')
  const cam = () => (mode === '2d' ? viewer.camera2d : viewer.camera)

  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 0) down = { x: e.clientX, y: e.clientY }
  }
  const onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0 || !down) return
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
    down = null
    if (moved > 5 || !onSelect) return // a drag, not a click
    const r = dom.getBoundingClientRect()
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, cam())
    let id: string | null = null
    let best = Infinity
    let point: ThreeNS.Vector3 | undefined
    for (const [tid, group] of viewer.tokens) {
      const hit = ray.intersectObject(group, true)[0]
      if (hit && hit.distance < best) {
        best = hit.distance
        id = tid
        point = hit.point
      }
    }
    onSelect(id, point)
  }

  // Orbit pivots on the point under the CURSOR (falls back to screen-centre) so rotation
  // always centres on what you're pointing at — the intuitive Map/RTS feel. The new target
  // sits on the pick ray so the view never jumps; only the orbit radius changes.
  const pivotNdc = new THREE.Vector2()
  const refocusOrbit = (clientX?: number, clientY?: number) => {
    if (clientX != null && clientY != null) {
      const r = dom.getBoundingClientRect()
      pivotNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(pivotNdc, viewer.camera)
    } else {
      ray.setFromCamera(CENTER, viewer.camera)
    }
    let dist = orbit3d.target.distanceTo(viewer.camera.position)
    for (const h of ray.intersectObjects(viewer.scene.children, true)) {
      if (skip(h.object)) continue
      dist = h.distance
      break
    }
    orbit3d.target.copy(viewer.camera.position).addScaledVector(ray.ray.direction, dist)
    if (mode === 'tabletop' || mode === 'tabletop-gm') orbit3d.target.y = 0 // keep the pivot on the ground plane
  }
  const onContextMenu = (e: Event) => e.preventDefault()
  // Capture phase → runs before OrbitControls' own pointerdown, so the re-centred
  // target is in place before the rotate starts. Both orbiting modes recentre on the cursor.
  const onCapturePointerDown = (e: PointerEvent) => {
    if (e.button === 2 && orbit3d.enableRotate && (mode === 'free' || mode === 'tabletop' || mode === 'tabletop-gm')) refocusOrbit(e.clientX, e.clientY)
  }

  // ── Keyboard: arrows pan (all modes), WASD fly + Q/E elevation (Free only) ────────
  const keys = new Set<string>()
  const onPointerEnter = () => (hovered = true)
  const onPointerLeave = () => {
    hovered = false
    keys.clear()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (!hovered) return
    const k = e.key.toLowerCase()
    if (PAN_KEYS.includes(k)) {
      keys.add(k)
      e.preventDefault()
    }
  }
  const onKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.key.toLowerCase())
  }

  const fwd = new THREE.Vector3()
  const right = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const move = new THREE.Vector3()
  const tickKeys = (): boolean => {
    if (!keys.size || !keyPanEnabled) return false
    if (mode === 'character') {
      // Anchored view — the camera never MOVES here. Arrow keys TURN the look (Foundry parity:
      // the plugin maps canvas-pan binds to yaw/pitch in first-person). Left/Right = azimuth,
      // Up/Down = pitch. W/A/S/D (token walk) and Q/E (elevation) are movement → inert offline.
      const yaw = 0.03 // rad/frame (~1.7°) while held — smooth turn
      const tilt = 0.02
      let turned = false
      if (keys.has('arrowleft')) { charAzimuth -= yaw; turned = true }
      if (keys.has('arrowright')) { charAzimuth += yaw; turned = true }
      if (keys.has('arrowup')) { charPitch = clamp(charPitch + tilt, -1.45, 1.45); turned = true }
      if (keys.has('arrowdown')) { charPitch = clamp(charPitch - tilt, -1.45, 1.45); turned = true }
      return turned
    }
    move.set(0, 0, 0)
    if (mode === '2d') {
      // Arrow-key pan of the ortho camera (X = right, Z = up-on-map).
      const step = 40 / (viewer.camera2d.zoom || 1)
      if (keys.has('arrowup')) move.z -= step
      if (keys.has('arrowdown')) move.z += step
      if (keys.has('arrowleft')) move.x -= step
      if (keys.has('arrowright')) move.x += step
      if (!move.lengthSq()) return false
      viewer.camera2d.position.add(move)
      orbit2d.target.add(move)
      return true
    }
    const step = 6 + viewer.camera.position.distanceTo(orbit3d.target) * 0.012 // scale with zoom
    viewer.camera.getWorldDirection(fwd)
    fwd.y = 0
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1)
    fwd.normalize()
    right.crossVectors(fwd, up).normalize()
    if (keys.has('arrowup')) move.add(fwd)
    if (keys.has('arrowdown')) move.addScaledVector(fwd, -1)
    if (keys.has('arrowright')) move.add(right)
    if (keys.has('arrowleft')) move.addScaledVector(right, -1)
    if (mode === 'free' || mode === 'tabletop' || mode === 'tabletop-gm') {
      // WASD ground-pans on X/Z (fwd is already flattened to the ground plane above).
      if (keys.has('w')) move.add(fwd)
      if (keys.has('s')) move.addScaledVector(fwd, -1)
      if (keys.has('d')) move.add(right)
      if (keys.has('a')) move.addScaledVector(right, -1)
    }
    let changed = false
    if (move.lengthSq()) {
      move.normalize().multiplyScalar(step)
      viewer.camera.position.add(move)
      orbit3d.target.add(move)
      changed = true
    }
    if (mode === 'free') {
      let dy = 0
      if (keys.has('e')) dy += step
      if (keys.has('q')) dy -= step
      if (dy) {
        viewer.camera.position.y += dy
        orbit3d.target.y += dy
        changed = true
      }
    }
    return changed
  }

  // ── Character view: position the camera from the subject token + look angles ──────
  // View-only. Eye ~0.9 grids above the subject's group origin (token centre + elevation).
  // First person (charDist small) sits the camera AT the eye and hides the subject body;
  // third person dollies back along the look direction and looks at the eye.
  function applyCharacter() {
    if (!subjectId) return
    const g = viewer.tokens.get(subjectId)
    if (!g) return
    const gridSize = viewer.getGridSize()
    charEye.set(g.position.x, g.position.y + gridSize * 0.9, g.position.z)
    const cp = Math.cos(charPitch)
    charDir.set(Math.sin(charAzimuth) * cp, Math.sin(charPitch), -Math.cos(charAzimuth) * cp)
    const firstPerson = charDist < gridSize * 0.5
    if (firstPerson) {
      viewer.camera.position.copy(charEye)
      viewer.camera.lookAt(charEye.x + charDir.x, charEye.y + charDir.y, charEye.z + charDir.z)
    } else {
      viewer.camera.position.copy(charEye).addScaledVector(charDir, -charDist)
      viewer.camera.lookAt(charEye)
    }
    g.visible = !firstPerson // hide own body in first person so it doesn't fill the view
  }

  // RIGHT-drag = look, matching Foundry (right-drag pans/looks the canvas). Left-click/-drag stays
  // free for token selection. `e.buttons & 2` is the right-button bit. Resets between drags.
  const onPointerMove = (e: PointerEvent) => {
    if (mode !== 'character' || (e.buttons & 2) === 0) {
      lastPointer = null
      return
    }
    if (lastPointer) {
      charAzimuth += (e.clientX - lastPointer.x) * 0.006
      charPitch = clamp(charPitch - (e.clientY - lastPointer.y) * 0.006, -1.45, 1.45)
      dirty = true
    }
    lastPointer = { x: e.clientX, y: e.clientY }
  }

  // Wheel = dolly between first and third person along the look axis.
  const onWheel = (e: WheelEvent) => {
    if (mode !== 'character') return
    e.preventDefault()
    const gridSize = viewer.getGridSize()
    charDist = clamp(charDist + Math.sign(e.deltaY) * gridSize * 0.5, 0, gridSize * 8)
    dirty = true
  }

  // Double-click = FOCUS: pan the orbit camera so the clicked point becomes the pivot, keeping the
  // view orientation (a translate, not a rotate). The easy "navigate to my work area" gesture the
  // Tabletop/Free cameras need. Ground-locked in Tabletop so double-click can't lift the pivot.
  const focusHit = new THREE.Vector3()
  const focusDelta = new THREE.Vector3()
  const onDblClick = (e: MouseEvent) => {
    if (mode !== 'free' && mode !== 'tabletop' && mode !== 'tabletop-gm') return
    const r = dom.getBoundingClientRect()
    pivotNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(pivotNdc, viewer.camera)
    let got = false
    for (const h of ray.intersectObjects(viewer.scene.children, true)) {
      if (skip(h.object)) continue
      focusHit.copy(h.point)
      got = true
      break
    }
    if (!got) return
    if (mode === 'tabletop' || mode === 'tabletop-gm') focusHit.y = 0
    focusDelta.copy(focusHit).sub(orbit3d.target)
    viewer.camera.position.add(focusDelta)
    orbit3d.target.add(focusDelta)
    orbit3d.update()
    dirty = true
  }

  function setSubject(id: string | null) {
    if (subjectId && subjectId !== id) {
      const old = viewer.tokens.get(subjectId)
      if (old) old.visible = true // restore the previous subject's body
    }
    subjectId = id
    // Seed the look azimuth from the token's facing (group.userData.rotation, degrees).
    const g = id ? viewer.tokens.get(id) : null
    charAzimuth = ((Number(g?.userData?.rotation) || 0) * Math.PI) / 180
    charPitch = 0
    if (mode === 'character') dirty = true
  }

  // ── Per-mode configuration ───────────────────────────────────────────────────────
  function applyMode() {
    const { cx, cz, span } = frame()
    // Restore the subject's body whenever we're NOT in character view (first person hid it).
    if (mode !== 'character' && subjectId) {
      const g = viewer.tokens.get(subjectId)
      if (g) g.visible = true
    }
    // Character view drives the perspective camera itself; every other mode uses OrbitControls.
    viewer.camera.fov = mode === 'character' ? 78 : 50
    viewer.camera.updateProjectionMatrix()
    orbit3d.enabled = mode !== '2d' && mode !== 'character'
    orbit2d.enabled = mode === '2d'
    if (mode === 'character') {
      viewer.setMode('3d')
      viewer.camera.up.set(0, 1, 0)
      applyCharacter()
      dirty = true
      return
    }
    if (mode === '2d') {
      viewer.setMode('2d')
      // left = select, right = pan (Foundry-canvas feel). Wheel = zoom.
      orbit2d.mouseButtons = { LEFT: null, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }
      viewer.camera2d.zoom = 1
      viewer.camera2d.updateProjectionMatrix()
      orbit2d.target.set(cx, 0, cz)
      orbit2d.update()
    } else if (mode === 'topdown') {
      // TRUE top-down: straight overhead, rotation hard-locked (polar pinned to 0), so it reads
      // like 2D but 3D-lit — height shows as shading. Only pan + zoom.
      viewer.setMode('3d')
      orbit3d.enableRotate = false
      orbit3d.enablePan = true
      orbit3d.screenSpacePanning = true // reset (tabletop turns this off)
      orbit3d.minPolarAngle = 0
      orbit3d.maxPolarAngle = 0.0001 // pinned overhead; nothing can tilt it
      orbit3d.mouseButtons = { LEFT: null, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }
      orbit3d.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN }
      // Straight down, north-up (up must be a horizontal axis when looking vertical).
      viewer.camera.up.set(0, 0, -1)
      viewer.camera.position.set(cx, span * 1.3, cz)
      viewer.camera.lookAt(cx, 0, cz)
      viewer.camera.updateProjectionMatrix()
      orbit3d.target.set(cx, 0, cz)
      orbit3d.update()
    } else if (mode === 'tabletop' || mode === 'tabletop-gm') {
      // TABLETOP — the constrained building camera (the middle ground between locked Top-Down and
      // free-fly). An angled orbit that CAN'T get lost: pitch clamped so it never flips under the map
      // or tips fully overhead, target pinned to the ground plane (screen-space panning OFF pans along
      // the ground), zoom-to-cursor. No focused token needed. RIGHT-drag orbits (pivots under cursor),
      // MIDDLE-drag pans, wheel zooms, WASD ground-pans; LEFT stays free for the host (sculpt/select).
      viewer.setMode('3d')
      orbit3d.enableRotate = true
      orbit3d.enablePan = true
      orbit3d.screenSpacePanning = false // pan across the ground, not the screen plane
      orbit3d.minPolarAngle = 0.30 // ~17° from overhead — a healthy top-ish tilt
      orbit3d.maxPolarAngle = 1.30 // ~74° — never dips to the horizon / under the map
      orbit3d.mouseButtons = { LEFT: null, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE }
      orbit3d.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }
      viewer.camera.up.set(0, 1, 0)
      orbit3d.target.set(cx, 0, cz)
      // SEAT: players are clamped to a 270° arc (can never orbit round to the GM's reserved side); the
      // GM roams the whole table. seatAzimuth places the camera; right-drag orbit stays within the clamp.
      const range = seatRangeFor(mode)
      orbit3d.minAzimuthAngle = range.min
      orbit3d.maxAzimuthAngle = range.max
      applySeatPosition()
    } else {
      // Free / Orbit — the TaleSpire / Tabletop Simulator table camera (their whole camera model),
      // so it matches what 3D-VTT players already know: RIGHT-drag orbits, MIDDLE-drag pans, WASD
      // ground-pans, wheel zooms, Q/E raise/lower height. (2D/Top-Down keep Foundry's right-drag pan;
      // Character view keeps its MMORPG rig.) Middle-pan is the missing piece — pan used to be
      // arrow-keys-only here, which is what made the free camera feel uncontrollable.
      viewer.setMode('3d')
      orbit3d.enableRotate = true
      orbit3d.enablePan = true
      orbit3d.screenSpacePanning = true // reset: free-fly pans on the screen plane
      orbit3d.minPolarAngle = 0 // reset: unclamped pitch (tabletop/topdown pin these)
      orbit3d.maxPolarAngle = Math.PI
      orbit3d.minAzimuthAngle = -Infinity // reset: free-fly has no seat clamp
      orbit3d.maxAzimuthAngle = Infinity
      orbit3d.mouseButtons = { LEFT: null, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE }
      orbit3d.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }
      viewer.camera.up.set(0, 1, 0)
      orbit3d.update()
    }
    // Top-Down also shares orbit3d — clear any leftover seat azimuth clamp there.
    if (mode === 'topdown') {
      orbit3d.minAzimuthAngle = -Infinity
      orbit3d.maxAzimuthAngle = Infinity
    }
    dirty = true
  }

  function setMode(next: ViewerCameraMode) {
    if (!allowed.includes(next) || next === mode) return
    // Entering character view fresh → start in third person so the subject is in frame.
    if (next === 'character' && mode !== 'character') charDist = viewer.getGridSize() * 3
    // Entering a tabletop seat fresh → sit at that seat's home azimuth (Party south, GM north).
    if (next === 'tabletop' && mode !== 'tabletop') seatAzimuth = 0
    if (next === 'tabletop-gm' && mode !== 'tabletop-gm') seatAzimuth = Math.PI
    mode = next
    applyMode()
    onModeChange?.(mode)
  }

  // ── Render loop: render only when something actually changes ─────────────────────
  let raf = 0
  const loop = () => {
    const moved = tickKeys()
    let changed = false
    if (mode === 'character') {
      // Character view drives the camera ITSELF from the subject + look angles. Do NOT call
      // orbit3d.update(): OrbitControls.update() repositions the camera onto its own spherical/target
      // even while `enabled` is false, which fights the anchor — the camera appears to fly around on
      // drag and the wheel dolly-to-first-person is instantly overwritten. Re-apply every frame so the
      // camera stays locked to the subject (cheap + deterministic; the render below is still gated).
      applyCharacter()
    } else {
      changed = active().update() // drives damping; true while the camera is moving
      if (mode === 'tabletop' || mode === 'tabletop-gm') orbit3d.target.y = 0 // keep the pivot ground-locked (zoom-to-cursor can nudge it)
    }
    if (pivotMarker) {
      pivotMarker.visible = mode === 'free'
      if (pivotMarker.visible) {
        pivotMarker.position.copy(orbit3d.target)
        pivotMarker.scale.setScalar(Math.max(3, viewer.camera.position.distanceTo(orbit3d.target) * 0.012))
      }
    }
    if (moved || changed || dirty) {
      viewer.render()
      dirty = false
    }
    raf = requestAnimationFrame(loop)
  }

  // ── Wire listeners ───────────────────────────────────────────────────────────────
  dom.addEventListener('contextmenu', onContextMenu)
  dom.addEventListener('pointerdown', onCapturePointerDown, { capture: true })
  dom.addEventListener('pointerdown', onPointerDown)
  dom.addEventListener('pointerup', onPointerUp)
  dom.addEventListener('pointermove', onPointerMove)
  dom.addEventListener('wheel', onWheel, { passive: false })
  dom.addEventListener('dblclick', onDblClick)
  dom.addEventListener('pointerenter', onPointerEnter)
  dom.addEventListener('pointerleave', onPointerLeave)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  applyMode()
  raf = requestAnimationFrame(loop)

  return {
    setMode,
    getMode: () => mode,
    setSubject,
    getSubject: () => subjectId,
    allowedModes: allowed,
    isAllowed: (m) => allowed.includes(m),
    setKeyPanEnabled: (enabled: boolean) => {
      keyPanEnabled = enabled
      if (!enabled) keys.clear() // drop any held pan keys so the camera doesn't drift after handing off
    },
    setSeat: (rad: number) => {
      if (mode !== 'tabletop' && mode !== 'tabletop-gm') return
      const { min, max } = seatRangeFor(mode)
      seatAzimuth = mode === 'tabletop-gm' ? Math.atan2(Math.sin(rad), Math.cos(rad)) : clamp(rad, min, max)
      applySeatPosition()
    },
    getSeat: () => (mode === 'tabletop' || mode === 'tabletop-gm' ? orbit3d.getAzimuthalAngle() : seatAzimuth),
    getSeatRange: () => seatRangeFor(mode),
    reframe: () => applyMode(),
    orbit3d,
    orbit2d,
    dispose() {
      cancelAnimationFrame(raf)
      dom.removeEventListener('contextmenu', onContextMenu)
      dom.removeEventListener('pointerdown', onCapturePointerDown, { capture: true } as EventListenerOptions)
      dom.removeEventListener('pointerdown', onPointerDown)
      dom.removeEventListener('pointerup', onPointerUp)
      dom.removeEventListener('pointermove', onPointerMove)
      dom.removeEventListener('wheel', onWheel)
      dom.removeEventListener('dblclick', onDblClick)
      dom.removeEventListener('pointerenter', onPointerEnter)
      dom.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      if (pivotMarker) {
        viewer.scene.remove(pivotMarker)
        pivotMarker.geometry.dispose()
        ;(pivotMarker.material as ThreeNS.Material).dispose()
      }
      orbit3d.dispose()
      orbit2d.dispose()
    },
  }
}
