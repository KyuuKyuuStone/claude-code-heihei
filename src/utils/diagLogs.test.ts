import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { logForDiagnosticsNoPII } from './diagLogs.js'

let tmpDir: string
let originalPath: string | undefined
let originalSessionId: string | undefined

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-diag-writer-'))
  originalPath = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  originalSessionId = process.env.CC_HEIHEI_SESSION_ID
  process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = path.join(tmpDir, 'cli-diagnostics.jsonl')
})

afterEach(async () => {
  if (originalPath === undefined) delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  else process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = originalPath
  if (originalSessionId === undefined) delete process.env.CC_HEIHEI_SESSION_ID
  else process.env.CC_HEIHEI_SESSION_ID = originalSessionId
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

describe('logForDiagnosticsNoPII', () => {
  test.serial('creates and repairs CLI diagnostic storage with private permissions', async () => {
    if (process.platform === 'win32') return
    const previousUmask = process.umask(0o022)
    const basePath = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE!
    const activePath = `${basePath}.${process.pid}.current.jsonl`
    try {
      fs.chmodSync(tmpDir, 0o755)
      fs.writeFileSync(activePath, 'existing\n', { mode: 0o644 })

      logForDiagnosticsNoPII('info', 'private_mode_probe')

      expect((await fsp.stat(tmpDir)).mode & 0o777).toBe(0o700)
      expect((await fsp.stat(activePath)).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(previousUmask)
    }
  })

  test('owns a per-process segment and rotates it without replacing a shared append target', async () => {
    const basePath = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE!
    const activePath = `${basePath}.${process.pid}.current.jsonl`
    fs.writeFileSync(activePath, 'x'.repeat(1024 * 1024))

    logForDiagnosticsNoPII('error', 'after_rotation', { code: 'ROTATED' })

    expect(fs.existsSync(basePath)).toBe(false)
    expect(fs.readFileSync(activePath, 'utf-8')).toContain('after_rotation')
    const completedSegments = (await fsp.readdir(tmpDir)).filter((name) =>
      name.startsWith(`cli-diagnostics.jsonl.${process.pid}.`) && !name.includes('.current.'),
    )
    expect(completedSegments).toHaveLength(1)
  })

  test('stamps each entry with the session id so investigations can attribute by session', () => {
    process.env.CC_HEIHEI_SESSION_ID = 'sess-abc-123'
    logForDiagnosticsNoPII('info', 'session_scoped_probe', { code: 'X' })

    const line = fs
      .readFileSync(`${process.env.CLAUDE_CODE_DIAGNOSTICS_FILE}.${process.pid}.current.jsonl`, 'utf-8')
      .trim()
      .split('\n')
      .pop()!
    expect(JSON.parse(line)).toMatchObject({
      event: 'session_scoped_probe',
      sessionId: 'sess-abc-123',
    })
  })

  test('omits the session id when the process is not session-scoped', () => {
    delete process.env.CC_HEIHEI_SESSION_ID
    logForDiagnosticsNoPII('info', 'standalone_probe')

    const line = fs
      .readFileSync(`${process.env.CLAUDE_CODE_DIAGNOSTICS_FILE}.${process.pid}.current.jsonl`, 'utf-8')
      .trim()
      .split('\n')
      .pop()!
    expect(JSON.parse(line)).not.toHaveProperty('sessionId')
  })
})
