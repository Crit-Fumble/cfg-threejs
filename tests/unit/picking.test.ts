import * as THREE from 'three'
import { createPicker, ndcFromClient } from '@/picking'

// A stand-in for the canvas host. The suite runs in node (no DOM) on purpose — the picker only
// ever calls getBoundingClientRect, and depending on nothing more than that is what keeps this
// module usable from a Foundry module, a worker, or any non-DOM host. Stubbing the rect is also
// the point of the test: getBoundingClientRect (not offsetWidth) is what makes picking correct
// under CSS transforms and scroll.
function elementAt(left: number, top: number, width: number, height: number): HTMLElement {
  return {
    getBoundingClientRect: () =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect,
  } as unknown as HTMLElement
}

function tokenAt(x: number, y: number, z: number): THREE.Object3D {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  mesh.position.set(x, y, z)
  mesh.updateMatrixWorld(true)
  const group = new THREE.Group()
  group.add(mesh)
  group.updateMatrixWorld(true)
  return group
}

describe('ndcFromClient', () => {
  const el = elementAt(100, 50, 800, 400)

  it('maps the element centre to the NDC origin', () => {
    const ndc = ndcFromClient(THREE, el, 100 + 400, 50 + 200)
    expect(ndc.x).toBeCloseTo(0, 6)
    expect(ndc.y).toBeCloseTo(0, 6)
  })

  it('maps corners to (-1,1) and (1,-1) — y is flipped', () => {
    const topLeft = ndcFromClient(THREE, el, 100, 50)
    expect(topLeft.x).toBeCloseTo(-1, 6)
    expect(topLeft.y).toBeCloseTo(1, 6)
    const bottomRight = ndcFromClient(THREE, el, 900, 450)
    expect(bottomRight.x).toBeCloseTo(1, 6)
    expect(bottomRight.y).toBeCloseTo(-1, 6)
  })

  it('accounts for the element offset — not just its size', () => {
    // The bug this pins: using clientX directly (ignoring rect.left) puts every pick off by the
    // element's page offset, which only shows up once the canvas is not at the origin.
    const offset = ndcFromClient(THREE, elementAt(0, 0, 800, 400), 400, 200)
    const shifted = ndcFromClient(THREE, el, 500, 250)
    expect(shifted.x).toBeCloseTo(offset.x, 6)
    expect(shifted.y).toBeCloseTo(offset.y, 6)
  })
})

describe('createPicker', () => {
  const el = elementAt(0, 0, 800, 400)
  // Straight-down top-down camera. ⛔ `up` MUST be re-pointed first: the default up is (0,1,0),
  // which is parallel to the view direction from (0,10,0) to the origin, and lookAt() is
  // degenerate when they are parallel — the camera ends up in an arbitrary orientation and the
  // centre-screen ray does not go where you expect. This is the same trap that bites top-down
  // OrbitControls setups.
  const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 100)
  camera.up.set(0, 0, -1)
  camera.position.set(0, 10, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)

  it('intersects the ground plane under the cursor', () => {
    const picker = createPicker({ THREE, element: el })
    const hit = picker.ground(camera, 400, 200)
    expect(hit).not.toBeNull()
    expect(hit!.y).toBeCloseTo(0, 5)
    expect(hit!.x).toBeCloseTo(0, 5)
    expect(hit!.z).toBeCloseTo(0, 5)
  })

  it('returns a fresh vector per call — not a shared scratch', () => {
    // A shared scratch would make the second call mutate the first result, which is the kind of
    // aliasing bug that only shows up once a caller holds a ruler's start point.
    const picker = createPicker({ THREE, element: el })
    const a = picker.ground(camera, 200, 100)!
    const b = picker.ground(camera, 600, 300)!
    expect(a).not.toBe(b)
    expect(a.equals(b)).toBe(false)
  })

  it('picks the NEAREST object when two overlap, regardless of iteration order', () => {
    // Nearest-wins, not first-hit: Map iteration is insertion order, which has nothing to do with
    // depth. Inserting the far token first is exactly the case a first-hit implementation fails.
    const picker = createPicker({ THREE, element: el })
    const far = tokenAt(0, 1, 0)
    const near = tokenAt(0, 6, 0)
    const objects = new Map<string, THREE.Object3D>([
      ['far', far],
      ['near', near],
    ])
    expect(picker.nearest(camera, objects, 400, 200)).toBe('near')
  })

  it('returns null when nothing is under the cursor', () => {
    const picker = createPicker({ THREE, element: el })
    const objects = new Map<string, THREE.Object3D>([['t', tokenAt(50, 0, 50)]])
    expect(picker.nearest(camera, objects, 400, 200)).toBeNull()
    expect(picker.nearestObject(camera, [], 400, 200)).toBeNull()
  })

  it('nearestObject returns the hit Object3D itself', () => {
    const picker = createPicker({ THREE, element: el })
    const note = tokenAt(0, 2, 0)
    expect(picker.nearestObject(camera, [note], 400, 200)).toBe(note)
  })

  it('honours a custom ground plane', () => {
    const picker = createPicker({ THREE, element: el, groundConstant: -2 })
    // Plane(normal (0,1,0), constant -2) is the y = 2 plane.
    const hit = picker.ground(camera, 400, 200)
    expect(hit!.y).toBeCloseTo(2, 5)
  })
})
