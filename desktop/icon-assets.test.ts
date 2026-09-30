import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards on the icon assets, because nothing else does.
 *
 * `scripts/quality-gate/package-smoke/` makes no icon assertions, so a build
 * that ships a stale or half-replaced icon set goes green on every pipeline.
 * The rules below were each learned by breaking them.
 *
 * Windows-only since v1.5.0: the macOS/Linux icon sets were removed along with
 * the rest of the non-Windows platform surface.
 */
const desktopRoot = __dirname
const icons = path.join(desktopRoot, 'src-tauri', 'icons')

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

describe('icon assets', () => {
  it('keeps src-tauri/app-icon.png byte-identical to public/app-icon.png', () => {
    // src-tauri/app-icon.png is the canonical 1024 RGBA source the platform
    // icon set gets regenerated from — a directive that lived only in a commit
    // body, which is exactly why a later rebrand replaced everything except
    // this file and left a stale source primed to overwrite the new set.
    const source = path.join(desktopRoot, 'src-tauri', 'app-icon.png')
    const runtime = path.join(desktopRoot, 'public', 'app-icon.png')
    expect(sha(source)).toBe(sha(runtime))
  })

  it('carries the packaged Windows icons', () => {
    // win.icon in package.json names icon.ico directly; a missing file makes
    // electron-builder silently fall back to the Electron logo. icon.png backs
    // the tray.
    for (const file of ['icon.ico', 'icon.png']) {
      const full = path.join(icons, file)
      expect(existsSync(full)).toBe(true)
      expect(readFileSync(full).byteLength).toBeGreaterThan(1024)
    }
  })

  it('serves a favicon to the H5 client', () => {
    // The same index.html the Electron window loads is what a phone browser
    // gets over H5 remote access, where a missing icon means a blank tab.
    const html = readFileSync(path.join(desktopRoot, 'index.html'), 'utf8')
    expect(html).toMatch(/<link\s+rel="icon"/)
  })
})
