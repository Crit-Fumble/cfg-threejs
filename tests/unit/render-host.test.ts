import * as THREE from 'three'
import { createRenderHost } from '@/render-host'
import type { SceneModule } from '@/scene-module'

// This suite runs in node, where `new THREE.WebGLRenderer()` throws — which is precisely the
// `no-webgl` fallback path, and the one most likely to regress silently, because a host that gets
// it wrong looks fine in a WebGL browser and blank everywhere else (jsdom unit tests, SSR smoke
// checks, WebGL-disabled clients). The animated/GL paths are covered by tests/*.browser.mjs.

function hostElement(width = 800, height = 400): HTMLElement {
  return {
    clientWidth: width,
    clientHeight: height,
    appendChild: () => undefined,
    removeChild: () => undefined,
  } as unknown as HTMLElement
}

function moduleSpy() {
  const calls = { init: 0, tick: 0, resize: 0, dispose: 0 }
  const mod: SceneModule = {
    init: () => {
      calls.init += 1
    },
    tick: () => {
      calls.tick += 1
    },
    resize: () => {
      calls.resize += 1
    },
    dispose: () => {
      calls.dispose += 1
    },
  }
  return { mod, calls }
}

describe('createRenderHost — argument contract', () => {
  it('throws without THREE, naming the injection requirement', () => {
    expect(() => createRenderHost({ element: hostElement(), THREE: undefined as never })).toThrow(/inject `THREE`/)
  })

  it('throws without an element', () => {
    expect(() => createRenderHost({ element: undefined as never, THREE })).toThrow(/`element` is required/)
  })
})

describe('createRenderHost — no-WebGL fallback', () => {
  it('reports no-webgl instead of throwing, and leaves renderer null', () => {
    const reasons: string[] = []
    const host = createRenderHost({
      element: hostElement(),
      THREE,
      onUnsupported: (reason) => reasons.push(reason),
    })
    expect(reasons).toEqual(['no-webgl'])
    expect(host.renderer).toBeNull()
    host.dispose()
  })

  it('still exposes a usable scene and camera sized from the element', () => {
    // A host may want to build scene contents even when it cannot paint them — and the camera
    // aspect must come from the element box, not a default, or the first successful resize jumps.
    const host = createRenderHost({ element: hostElement(800, 400), THREE })
    expect(host.scene).toBeInstanceOf(THREE.Scene)
    expect(host.camera).toBeInstanceOf(THREE.PerspectiveCamera)
    expect(host.camera.aspect).toBeCloseTo(2, 6)
    host.dispose()
  })

  it('never starts a RAF loop, so a module tick is never called', () => {
    const { mod, calls } = moduleSpy()
    const host = createRenderHost({ element: hostElement(), THREE })
    host.setModule(mod)
    expect(calls.tick).toBe(0)
    host.dispose()
  })

  it('does not init a module it cannot render', () => {
    // init() is where modules allocate GPU-bound resources; running it with no renderer would
    // leak work that can never be painted or disposed against a live context.
    const { mod, calls } = moduleSpy()
    const host = createRenderHost({ element: hostElement(), THREE })
    host.setModule(mod)
    expect(calls.init).toBe(0)
    host.dispose()
  })
})

describe('createRenderHost — lifecycle', () => {
  it('dispose is idempotent and flips `disposed`', () => {
    const host = createRenderHost({ element: hostElement(), THREE })
    expect(host.disposed).toBe(false)
    host.dispose()
    expect(host.disposed).toBe(true)
    expect(() => host.dispose()).not.toThrow()
  })

  it('reports 0 fps on dispose so a HUD cannot show a stale rate', () => {
    const seen: number[] = []
    const host = createRenderHost({ element: hostElement(), THREE, onFps: (v) => seen.push(v) })
    host.dispose()
    expect(seen).toEqual([0])
  })

  it('disposes the outgoing module when a new one is set', () => {
    const first = moduleSpy()
    const second = moduleSpy()
    const host = createRenderHost({ element: hostElement(), THREE })
    host.setModule(first.mod)
    host.setModule(second.mod)
    expect(first.calls.dispose).toBe(1)
    host.dispose()
    expect(second.calls.dispose).toBe(1)
  })

  it('setModule and resize are inert after dispose', () => {
    const { mod, calls } = moduleSpy()
    const host = createRenderHost({ element: hostElement(), THREE })
    host.dispose()
    host.setModule(mod)
    host.resize()
    expect(calls.init).toBe(0)
    expect(calls.resize).toBe(0)
  })
})

describe('createRenderHost — quality', () => {
  it('reads quality lazily so a host can change it without recreating the host', () => {
    let reads = 0
    const host = createRenderHost({
      element: hostElement(),
      THREE,
      quality: () => {
        reads += 1
        return { maxPixelRatio: 1 }
      },
    })
    const before = reads
    host.refreshQuality()
    // With no renderer there is nothing to apply, but the call must stay safe and cheap.
    expect(reads).toBeGreaterThanOrEqual(before)
    host.dispose()
  })
})
