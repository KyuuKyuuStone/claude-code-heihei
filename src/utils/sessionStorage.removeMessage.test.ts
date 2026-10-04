import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { removeTranscriptMessage, setSessionFileForTesting } from './sessionStorage.js'

/**
 * v1.7.3 #1 回归：`removeMessageByUuid` 的**重写语义**。
 *
 * 背景：原实现用 `fh.truncate(...)`（删末条）或「truncate + 补尾部」（删中间条）。
 * Bun 1.3.14 的 truncate 全家（fs.truncate / fh.truncate / ftruncate，含 sync）
 * **永不返回**（探针 9/9 实证）⇒ 前者直接挂死、后者挂住并丢尾部。
 * 现改为「拼好保留部分 → writeFile 整体写回」（writeFile 天然截断，**不调 truncate**）。
 *
 * 本用例只验证**结果字节**（等价性），**不复现旧挂死**（已证过，别把进程挂死）。
 */

const line = (u: string, label: string) =>
  JSON.stringify({ uuid: u, parentUuid: null, type: 'user', message: { role: 'user', content: label } })

describe('removeMessageByUuid（v1.7.3 #1：截断 → 重写）', () => {
  let cfgDir: string
  let dir: string
  let file: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rm-uuid-cfg-'))
    process.env.CLAUDE_CONFIG_DIR = cfgDir
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rm-uuid-'))
    file = path.join(dir, 's.jsonl')
    setSessionFileForTesting(file)
  })

  afterEach(async () => {
    setSessionFileForTesting('')
    if (originalConfigDir) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(cfgDir, { recursive: true, force: true })
  })

  test('删除最后一条：只剩前两条、无残留字节（旧实现此处直接挂死）', async () => {
    const a = line('u1', 'A')
    const b = line('u2', 'B')
    const c = line('u3', 'C')
    await fs.writeFile(file, [a, b, c].join('\n') + '\n')

    await removeTranscriptMessage('u3')

    expect(await fs.readFile(file, 'utf-8')).toBe([a, b].join('\n') + '\n')
  })

  test('删除中间一条：其余行原样保留、尾部不丢失（旧实现此处丢尾部）', async () => {
    const a = line('u1', 'A')
    const b = line('u2', 'B')
    const c = line('u3', 'C')
    await fs.writeFile(file, [a, b, c].join('\n') + '\n')

    await removeTranscriptMessage('u2')

    expect(await fs.readFile(file, 'utf-8')).toBe([a, c].join('\n') + '\n')
  })
})
