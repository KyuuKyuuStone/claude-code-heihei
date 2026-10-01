/**
 * 门禁：禁止**新增** `mock.module(...)` 用法（bun 的模块 mock 是进程级替换，
 * 会跨文件泄漏——曾导致 cronTasks 的 .claude symlink 安全用例在重负载全量下假红；
 * 详见 2026-10-01 的分诊）。
 *
 * 规则：测试文件里出现 `mock.module(` 的次数不得超过白名单。默认 0——即**新文件/新用例
 * 一律不得使用**；要替换模块请用 `spyOn(...) + afterEach(() => mock.restore())` 或可注入 seam。
 * 白名单是**存量债**（各自已单独排期收敛），只减不增：把某文件修好后请把它的数字改成 0 或删条目。
 *
 * 统计口径：按行匹配 `^\s*mock\.module\(`，注释行（以 // 或 * 开头）不计。
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 存量白名单（只减不增）。键为相对仓库根的 posix 路径。 */
const LEGACY_ALLOWLIST: Record<string, number> = {
  // 提交 B / 提交 C：高风险、待排期（spyOn 无法直接等价替换）
  'src/hooks/useInboxPoller.test.tsx': 11,
  'src/tools/shared/spawnMultiAgent.callsite.test.ts': 9,
  // 单独排期：该文件的 spyOn 版实测更差（10 跑 3 绿 vs 原版 8 绿），需子进程隔离或产品侧 seam
  'src/history.test.ts': 1,
  // 低危存量（与 B 同批收敛）
  'src/utils/__tests__/imageResizer.test.ts': 1,
  'src/utils/hooks/execPromptHook.test.ts': 1,
  'src/utils/permissions/permissions.autoMode.test.ts': 1,
  'src/utils/processUserInput/processSlashCommand.test.ts': 1,
}

const ROOTS = ['src', 'desktop/src']

function* walkTestFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkTestFiles(full)
    else if (/\.test\.tsx?$/.test(entry.name) && statSync(full).isFile()) yield full
  }
}

function countMockModule(file: string): number {
  return readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .filter((line) => /^\s*mock\.module\(/.test(line)).length
}

describe('测试基础设施门禁：mock.module 只减不增', () => {
  test('未列入白名单的测试文件不得使用 mock.module', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of walkTestFiles(join(process.cwd(), root))) {
        const rel = relative(process.cwd(), file).replace(/\\/g, '/')
        const count = countMockModule(file)
        const allowed = LEGACY_ALLOWLIST[rel] ?? 0
        if (count > allowed) {
          offenders.push(`${rel}: 实际 ${count} 处 > 允许 ${allowed} 处`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
