/**
 * createPentagonalTrapezohedronGeometry — the d10 percentile-die shape
 * (originally cfg-core-browser#90). three.js ships zero built-in geometry for a
 * pentagonal trapezohedron (the solid every physical d10 die actually is),
 * so this builds it directly from the standard construction: two apex
 * vertices on the polar axis, plus a 10-vertex equatorial ring that
 * zigzags above/below the equator (odd indices up, even indices down).
 *
 * Each of the real solid's 10 kite faces decomposes into exactly 2
 * triangles here:
 *   - a "belt" triangle joining three consecutive zigzag vertices, and
 *   - a "cap" triangle joining the two same-phase (both-up or both-down)
 *     vertices two steps apart to whichever pole matches their phase.
 * The belt and cap triangles share the "skip" edge between same-phase
 * vertices, so together they tile the kite. That's 12 vertices, 20
 * triangles, 30 edges — Euler characteristic 12 - 30 + 20 = 2, a closed
 * 2-manifold (pinned by the unit test alongside the raw shape counts).
 *
 * Pure and WebGL-free: BufferGeometry construction needs no GL context —
 * only THREE.WebGLRenderer does — so this (and the caller that builds the
 * dice roster from it) is unit-testable without mocking WebGL.
 *
 * THREE is a parameter, not an import: this package never imports three at runtime, so a host
 * bundling it alongside its own three adds no second copy. See the README charter.
 */

import type * as ThreeNS from 'three'

export function createPentagonalTrapezohedronGeometry(THREE: typeof ThreeNS, radius = 1): ThreeNS.BufferGeometry {
  // How far the zigzag belt sits off the equator, and how far the apexes
  // sit past the belt radius — proportions picked to read as a d10, not a
  // bipyramid (too tall) or a flying saucer (too flat).
  const beltZ = radius * 0.32
  const apexZ = radius * 1.05

  const positions: number[] = []
  for (let i = 0; i < 10; i++) {
    const theta = (i / 10) * Math.PI * 2
    const z = i % 2 === 0 ? -beltZ : beltZ
    positions.push(Math.cos(theta) * radius, Math.sin(theta) * radius, z)
  }
  // Index 10 = top apex, index 11 = bottom apex.
  const TOP = 10
  const BOTTOM = 11
  positions.push(0, 0, apexZ, 0, 0, -apexZ)

  const indices: number[] = []
  for (let i = 0; i < 10; i++) {
    const next = (i + 1) % 10
    const skip = (i + 2) % 10
    // Belt triangle — three consecutive zigzag vertices.
    indices.push(i, next, skip)
    // Cap triangle — shares the "skip" edge with the belt triangle above,
    // closing the gap to whichever pole matches vertex i's phase.
    const apex = i % 2 === 0 ? BOTTOM : TOP
    indices.push(i, skip, apex)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  ensureOutwardWinding(THREE, geometry)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * The hand-picked winding above is easy to get backwards for a couple of
 * the 20 triangles, which would render as invisible/inverted facets (the
 * flat-shaded material lit from inside). The shape is star-convex around
 * the origin, so "does this triangle's normal point away from the origin"
 * is an exact outward-facing test — flip (swap the last two indices of)
 * any triangle that fails it.
 */
function ensureOutwardWinding(THREE: typeof ThreeNS, geometry: ThreeNS.BufferGeometry): void {
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  if (!index) return

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const edge1 = new THREE.Vector3()
  const edge2 = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const centroid = new THREE.Vector3()

  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i)
    const ib = index.getX(i + 1)
    const ic = index.getX(i + 2)
    a.fromBufferAttribute(position, ia)
    b.fromBufferAttribute(position, ib)
    c.fromBufferAttribute(position, ic)
    edge1.subVectors(b, a)
    edge2.subVectors(c, a)
    normal.crossVectors(edge1, edge2)
    centroid.copy(a).add(b).add(c)
    if (normal.dot(centroid) < 0) {
      index.setX(i + 1, ic)
      index.setX(i + 2, ib)
    }
  }
  index.needsUpdate = true
}
