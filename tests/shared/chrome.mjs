/**
 * chrome.mjs — resolve a Chrome binary for the headless viewer tests.
 *
 * These tests drive a REAL browser (they need WebGL, and the render core is meaningless without
 * it), so they launch Chrome directly instead of going through a Playwright config. Resolution
 * order:
 *
 *   1. `$REVIEW_CHROME` — explicit override
 *   2. the maintainer's local Chrome-for-Testing — the fast path on the dev machine
 *   3. `undefined` → Playwright launches its OWN bundled chromium — the CI path
 *
 * Falling through to `undefined` is the load-bearing part: passing an `executablePath` that does
 * not exist fails the launch outright, so while every test hardcoded a macOS-absolute path these
 * suites could not run anywhere but one laptop — which is why the GM-seat regression reached a
 * published package. Keep this list ordered dev-fast-path first, portable fallback last.
 */
import { existsSync } from 'node:fs'

const LOCAL_MAC =
  '/Users/personal/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

/** An existing Chrome path, or undefined to let Playwright pick its bundled build. */
export function resolveChrome() {
  for (const p of [process.env.REVIEW_CHROME, LOCAL_MAC]) {
    if (p && existsSync(p)) return p
  }
  return undefined
}

/** Launch args that make WebGL work on a GPU-less runner (swiftshader software rasteriser). */
export const CHROME_ARGS = ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-webgl']
