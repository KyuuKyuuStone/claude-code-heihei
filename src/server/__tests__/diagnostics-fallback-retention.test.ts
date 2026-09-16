import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { DiagnosticsService } from '../services/diagnosticsService.js'

/**
 * 降级旁路文件的保留策略（A5b）。
 *
 * 无 mock.module、不读运行者 env（CLAUDE_CONFIG_DIR 只指向本测试的临时目录）；
 * 时钟经构造函数注入固定值，边界天数因此是确定性的。
 */

const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_DAYS = 7
/** 固定「现在」，让窗口边界可精确断言 */
const NOW = Date.parse('2026-09-16T10:00:00.000Z')

let tmpDir: string
let originalConfigDir: string | undefined

function logDir(): string {
  return path.join(tmpDir, 'cc-heihei', 'diagnostics')
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** 造一个旁路文件（名字用日期，mtime 可控——保留策略判的就是 mtime） */
async function makeFile(name: string, mtimeMs: number, content = '{}\n'): Promise<string> {
  const filePath = path.join(logDir(), name)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
  const when = new Date(mtimeMs)
  await fs.utimes(filePath, when, when)
  return filePath
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

/** 走真实生产路径触发清理（getStatus 内部强制跑一次保留扫描） */
async function sweep(): Promise<void> {
  await new DiagnosticsService(() => NOW).getStatus()
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-fallback-retention-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('fallback file retention', () => {
  test('removes fallback files older than the retention window', async () => {
    const staleDiagnostics = await makeFile(
      `diagnostics-fallback-${dayKey(NOW - 30 * DAY_MS)}.jsonl`,
      NOW - 30 * DAY_MS,
    )
    const staleRuntime = await makeFile(
      `runtime-errors-fallback-${dayKey(NOW - 30 * DAY_MS)}.log`,
      NOW - 30 * DAY_MS,
    )

    await sweep()

    expect(await exists(staleDiagnostics)).toBe(false)
    expect(await exists(staleRuntime)).toBe(false)
  })

  test('keeps fallback files inside the retention window', async () => {
    const recent = await makeFile(
      `diagnostics-fallback-${dayKey(NOW - 2 * DAY_MS)}.jsonl`,
      NOW - 2 * DAY_MS,
    )

    await sweep()

    expect(await exists(recent)).toBe(true)
    expect(await fs.readFile(recent, 'utf-8')).toBe('{}\n')
  })

  test('keeps the boundary day and removes anything one minute older', async () => {
    const exactlyAtCutoff = await makeFile(
      `diagnostics-fallback-${dayKey(NOW - RETENTION_DAYS * DAY_MS)}.jsonl`,
      NOW - RETENTION_DAYS * DAY_MS,
    )
    const justOutside = await makeFile(
      `runtime-errors-fallback-${dayKey(NOW - RETENTION_DAYS * DAY_MS)}.log`,
      NOW - RETENTION_DAYS * DAY_MS - 60_000,
    )

    await sweep()

    expect(await exists(exactlyAtCutoff)).toBe(true)
    expect(await exists(justOutside)).toBe(false)
  })

  test('never touches non-fallback files, other directories, or today\'s fallback', async () => {
    const main = await makeFile('diagnostics.jsonl', NOW - 90 * DAY_MS)
    const runtimeErrors = await makeFile('runtime-errors.log', NOW - 90 * DAY_MS)
    // cli 基文件用"近期"mtime：超窗口的 cli 基文件会被【既有】的 CLI 分段回收逻辑隔离，
    // 那是另一条策略，与本用例（本 pruner 的范围）无关。
    const cli = await makeFile('cli-diagnostics.jsonl', NOW - 60_000)
    const electronHost = await makeFile('electron-host.log', NOW - 90 * DAY_MS)
    // 子目录里的同名文件（放中性子目录，避免撞上既有 exports 保留策略）：
    // 本 pruner 只处理 logDir 本层，不得递归删除。
    const nested = await makeFile(path.join('nested', `diagnostics-fallback-${dayKey(NOW - 90 * DAY_MS)}.jsonl`), NOW - 90 * DAY_MS)
    // 当天文件即便 mtime 异常（备份还原/时钟回拨）也不能删：它可能正是当前降级写入目标
    const today = await makeFile(`diagnostics-fallback-${dayKey(NOW)}.jsonl`, NOW - 90 * DAY_MS)

    await sweep()

    for (const filePath of [main, runtimeErrors, cli, electronHost, nested, today]) {
      expect(await exists(filePath), filePath).toBe(true)
    }
  })

  test('caps the number of fallback files per kind', async () => {
    const paths: string[] = []
    // 10 个都在窗口内（mtime 各不相同、逐天变旧），超出每类 7 个的上限
    for (let age = 1; age <= 10; age += 1) {
      paths.push(
        await makeFile(
          `diagnostics-fallback-${dayKey(NOW - age * DAY_MS)}.jsonl`,
          NOW - age * DAY_MS,
        ),
      )
    }

    await sweep()

    // 最新的 7 个保留（age 1..7），最旧的 3 个删除（age 8..10）
    for (const index of [0, 1, 2, 3, 4, 5, 6]) {
      expect(await exists(paths[index]!), `age ${index + 1}`).toBe(true)
    }
    for (const index of [7, 8, 9]) {
      expect(await exists(paths[index]!), `age ${index + 1}`).toBe(false)
    }
  })
})
