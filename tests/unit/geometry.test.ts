import * as THREE from 'three'
import { createPentagonalTrapezohedronGeometry } from '@/geometry'

// BufferGeometry construction needs no GL context (only WebGLRenderer does), so the d10 solid is
// fully testable in jsdom. These assertions come across from cfg-core-browser with the module.

describe('createPentagonalTrapezohedronGeometry', () => {
  it('builds the pentagonal-trapezohedron shape: 12 vertices, 20 triangles', () => {
    const g = createPentagonalTrapezohedronGeometry(THREE)
    expect(g.getAttribute('position').count).toBe(12)
    expect(g.getIndex()?.count).toBe(60) // 20 triangles x 3
  })

  it('is a closed 2-manifold — Euler characteristic V - E + F = 2', () => {
    const g = createPentagonalTrapezohedronGeometry(THREE)
    const index = g.getIndex()!
    const edges = new Set<string>()
    for (let i = 0; i < index.count; i += 3) {
      const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
      for (let e = 0; e < 3; e++) {
        const a = tri[e]
        const b = tri[(e + 1) % 3]
        edges.add(a < b ? `${a}-${b}` : `${b}-${a}`)
      }
    }
    const V = g.getAttribute('position').count
    const E = edges.size
    const F = index.count / 3
    expect(E).toBe(30)
    expect(V - E + F).toBe(2)
  })

  it('winds every triangle outward — the star-convex normal test', () => {
    // The hand-picked winding is easy to get backwards for a couple of the 20 triangles, which
    // renders as invisible/inverted facets. ensureOutwardWinding must leave none failing.
    const g = createPentagonalTrapezohedronGeometry(THREE)
    const pos = g.getAttribute('position')
    const index = g.getIndex()!
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    const normal = new THREE.Vector3()
    const centroid = new THREE.Vector3()
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(pos, index.getX(i))
      b.fromBufferAttribute(pos, index.getX(i + 1))
      c.fromBufferAttribute(pos, index.getX(i + 2))
      normal.crossVectors(b.clone().sub(a), c.clone().sub(a))
      centroid.copy(a).add(b).add(c)
      expect(normal.dot(centroid)).toBeGreaterThanOrEqual(0)
    }
  })

  it('scales with radius', () => {
    const small = createPentagonalTrapezohedronGeometry(THREE, 1)
    const big = createPentagonalTrapezohedronGeometry(THREE, 3)
    small.computeBoundingSphere()
    big.computeBoundingSphere()
    expect(big.boundingSphere!.radius).toBeCloseTo(small.boundingSphere!.radius * 3, 5)
  })
})
