import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  createOpenTargetService,
  getDefaultLaunchSpawnOptions,
} from '../services/openTargetService.js'

describe('open target launch options', () => {
  it('does not hide external application windows on Windows', () => {
    const options = getDefaultLaunchSpawnOptions() as Record<string, unknown>

    expect(options.windowsHide).toBeUndefined()
    expect(options).toEqual({
      detached: true,
      stdio: 'ignore',
    })
  })

  it.skipIf(process.platform === 'win32')('uses those options in the production launcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-heihei-open-target-launch-'))
    const binDir = join(root, 'bin')
    const targetDir = join(root, 'target')
    const commandPath = join(binDir, 'code')
    const originalPath = process.env.PATH

    await mkdir(binDir)
    await mkdir(targetDir)
    await writeFile(commandPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`

    try {
      const service = createOpenTargetService({
        platform: 'linux',
        commandExists: async (command) => command === 'code',
      })

      await expect(service.openTarget({ targetId: 'vscode', path: targetDir }))
        .resolves.toMatchObject({ ok: true, targetId: 'vscode' })
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
