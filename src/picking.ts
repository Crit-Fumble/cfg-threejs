/**
 * Screen → scene raycast helpers.
 *
 * These four operations were written three separate times: privately inside this package's
 * `controls.ts` selection raycast, in cfg-core-browser's `useSceneViewerMount` (`ndcAt`,
 * `pickTokenAt`, `groundAt`, `pickNoteAt`), and again in the FoundryVTT plugin's `overlay-3d.js`.
 * Same maths, three maintenance sites, and the divergence was already visible — only one of the
 * three memoised the ground plane.
 *
 * Deliberately stateless apart from the reusable `Raycaster`/scratch vectors a picker owns: a host
 * decides which camera is active (2D orthographic vs 3D perspective) and passes it per call, so a
 * surface that switches camera modes does not need a second picker.
 */

import type * as ThreeNS from 'three'

/** Anything a picker can cast against — the active camera for the current view mode. */
export type PickCamera = ThreeNS.PerspectiveCamera | ThreeNS.OrthographicCamera

/**
 * Viewport (client) px → normalized device coordinates for `element`.
 *
 * Uses `getBoundingClientRect`, so it is correct under CSS transforms and scroll — which is why
 * this must not be reimplemented from `offsetWidth`.
 */
export function ndcFromClient(
  THREE: typeof ThreeNS,
  element: HTMLElement,
  clientX: number,
  clientY: number,
): ThreeNS.Vector2 {
  const r = element.getBoundingClientRect()
  return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
}

export interface Picker {
  /** Viewport px → NDC against the picker's element. */
  ndc(clientX: number, clientY: number): ThreeNS.Vector2 | null
  /**
   * Viewport px → the point where the ray meets the ground plane (y = 0 by default), or null if
   * the ray is parallel to it. Tokens and the grid live on the ground plane.
   */
  ground(camera: PickCamera, clientX: number, clientY: number): ThreeNS.Vector3 | null
  /**
   * Viewport px → the key of the NEAREST entry in `objects` whose subtree is hit.
   *
   * Nearest-wins rather than first-hit: iteration order over a Map is insertion order, which has
   * nothing to do with depth, so a first-hit implementation silently picks the wrong token
   * whenever two overlap.
   */
  nearest<K>(camera: PickCamera, objects: Iterable<[K, ThreeNS.Object3D]>, clientX: number, clientY: number): K | null
  /** Viewport px → the nearest hit `Object3D` from a flat list (map notes, drawings, templates). */
  nearestObject(camera: PickCamera, objects: readonly ThreeNS.Object3D[], clientX: number, clientY: number): ThreeNS.Object3D | null
}

export interface CreatePickerOptions {
  THREE: typeof ThreeNS
  /** The canvas (or its host) that client coordinates are relative to. */
  element: HTMLElement
  /** Ground plane normal + constant. Defaults to the y-up floor at the origin. */
  groundNormal?: ThreeNS.Vector3
  groundConstant?: number
}

export function createPicker(opts: CreatePickerOptions): Picker {
  const { THREE, element, groundNormal, groundConstant = 0 } = opts
  if (!THREE) throw new Error('createPicker: inject `THREE`')
  if (!element) throw new Error('createPicker: `element` is required')

  const ray = new THREE.Raycaster()
  const plane = new THREE.Plane(groundNormal ?? new THREE.Vector3(0, 1, 0), groundConstant)
  const hit = new THREE.Vector3()

  const ndc = (clientX: number, clientY: number) => ndcFromClient(THREE, element, clientX, clientY)

  return {
    ndc(clientX, clientY) {
      return ndc(clientX, clientY)
    },
    ground(camera, clientX, clientY) {
      ray.setFromCamera(ndc(clientX, clientY), camera)
      return ray.ray.intersectPlane(plane, hit) ? hit.clone() : null
    },
    nearest<K>(camera: PickCamera, objects: Iterable<[K, ThreeNS.Object3D]>, clientX: number, clientY: number): K | null {
      ray.setFromCamera(ndc(clientX, clientY), camera)
      let best = Infinity
      let found: K | null = null
      for (const [key, obj] of objects) {
        const h = ray.intersectObject(obj, true)[0]
        if (h && h.distance < best) {
          best = h.distance
          found = key
        }
      }
      return found
    },
    nearestObject(camera, objects, clientX, clientY) {
      ray.setFromCamera(ndc(clientX, clientY), camera)
      let best = Infinity
      let found: ThreeNS.Object3D | null = null
      for (const obj of objects) {
        const h = ray.intersectObject(obj, true)[0]
        if (h && h.distance < best) {
          best = h.distance
          found = obj
        }
      }
      return found
    },
  }
}
