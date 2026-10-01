import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ApiError, errorResponse } from '../errorHandler.js'
import { AtomicWriteError } from '../../../utils/atomicFs.js'

/**
 * v1.7.0 D1：写盘被占用时 HTTP 层的可理解响应。
 *
 * 关键约束：只对 `atomicWriteKind === 'locked'` 给 503；真实 IO 失败（io）
 * 与其它非 ApiError 仍旧 500——**不得改变既有非原子错误的语义**。
 */

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-errhandler-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('errorResponse — AtomicWriteError 分类', () => {
  test('locked（文件被占用）→ 503 TARGET_FILE_BUSY，附 errno 与可读说明', async () => {
    const error = new AtomicWriteError('Atomic write failed: busy (EPERM)', {
      kind: 'locked',
      code: 'EPERM',
      cause: new Error('EPERM'),
    })

    const res = errorResponse(error)
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; message: string; errno: string }
    expect(body.error).toBe('TARGET_FILE_BUSY')
    expect(body.errno).toBe('EPERM')
    // 说明要能让人看懂「是被占用、且原文件没被破坏、可以重试」
    expect(body.message).toContain('locked by another process')
    expect(body.message).toContain('left unchanged')
    expect(body.message).toContain('retry')
  })

  test('io（真实 IO 失败）仍是 500——既有语义不变', async () => {
    const error = new AtomicWriteError('Atomic write failed: EACCES', {
      kind: 'io',
      code: 'EACCES',
      cause: new Error('EACCES'),
    })

    const res = errorResponse(error)
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('INTERNAL_ERROR')
  })

  test('普通 Error 仍是 500', async () => {
    const res = errorResponse(new Error('boom'))
    expect(res.status).toBe(500)
  })

  test('ApiError 分支不受影响', async () => {
    const res = errorResponse(ApiError.conflict('nope'))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('CONFLICT')
    expect(body.message).toBe('nope')
  })
})
