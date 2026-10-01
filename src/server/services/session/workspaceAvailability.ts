/**
 * 工作区可用性判定（v1.7 结构拆分 · sessionService 第⑦批 · 纯移动）。
 *
 * 从 sessionService.ts 原样搬出的 6 个实例方法，构成一条完整语义链：
 *   pathExists（底层探针）→ createCachedPathExists（按路径去重的探针缓存）
 *   → normalizeWorkspacePath / sameWorkspacePath（路径规范化与比较）
 *   → matchesPersistedWorktree（worktree 标记判定）
 *   → resolveWorkspaceAvailability（对外聚合）
 * 六者体内**均无 this.<字段>**（survey-b6.ts 实跑确认），跨组依赖仅
 * normalizeDriveRootPathForPlatform（./windowsDrivePath.js，公开）与三个类型。
 *
 * 类型处置（沿用第⑥批 MessageEntry 先例）：
 *   · SessionWorkspaceState 是门面 :166 的 **export type**，门面导出面必须不变，
 *     故**不搬**，本模块以 import type 引回（类型擦除，不产生运行时循环）。
 *   · PersistedWorktreeSession（localIndex/types.ts:27）
 *     / PreparedSessionWorkspace（repositoryLaunchService.ts:73）均为公开导出，
 *     直接 import type。二者同时被 session/sessionEntryMetadata.ts（第③批）import，
 *     路径层级一致，无新增风险。
 *
 * 搬移规则：函数体逐字不变，仅两处形式调整——
 *   ① 缩进 −2（原 class 方法体缩进 4，模块级函数体缩进 2）；
 *   ② 组内互调 this.foo( → foo(。
 * 门面里 pathExists / createCachedPathExists / resolveWorkspaceAvailability 三个
 * 有组外调用点的方法改为同名类字段委托，**门面 6 处 this.xxx( 调用点文本一行未改**。
 *
 * 不留委托的三个（matchesPersistedWorktree / sameWorkspacePath / normalizeWorkspacePath）
 * 的唯一调用点全部落在本批搬走的函数体内（实跑调用点清单确认组外为 0），按
 * 第⑤批 resolveParentToolUseId、第⑥批 loadSubagentToolMessages 先例**不留死委托**。
 *
 * 历史死委托排查（主管本批新增要求）：本批 6 个名字在 HEAD 中均为**实体方法**，
 * 不存在第②批式的残留委托行；且新模块为首次出现，无旧账可翻。已由 check-b7.ts
 * 的 historicalDelegateScan 字段机械确认为空。
 *
 * 三向检查（模块级可变状态）：本批**不含任何模块级可变状态**——createCachedPathExists
 * 内的 Map 是**函数局部**变量，每次调用新建，不跨调用共享。6 个函数均为纯函数。
 *
 * 路径依赖预检：本段无 import.meta / __dirname / __filename / process.execPath。
 */

import * as fs from 'node:fs'
import { normalizeDriveRootPathForPlatform } from '../windowsDrivePath.js'
import type { PersistedWorktreeSession } from '../localIndex/types.js'
import type { PreparedSessionWorkspace } from '../repositoryLaunchService.js'
import type { SessionWorkspaceState } from '../sessionService.js'

// 逐字搬移的唯一必要调整（原式 `(targetPath) => this.pathExists(targetPath)`）：
// 裸化后 `pathExists` 会被**同名参数**遮蔽——参数在默认值求值时刻处于 TDZ，
// 引用它得到 undefined，调用即 TypeError。故设模块级别名（函数声明提升，此处安全），
// 默认值改引别名，语义与原 `this.pathExists` 完全一致。
const defaultPathExists = pathExists

export async function pathExists(targetPath: string | null): Promise<boolean> {
  if (!targetPath) return false

  try {
    const stat = await fs.stat(targetPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

export function createCachedPathExists(): (targetPath: string | null) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>()
  return (targetPath) => {
    if (!targetPath) return Promise.resolve(false)
    const key = targetPath.normalize('NFC')
    const cached = cache.get(key)
    if (cached) return cached
    const pending = pathExists(targetPath)
    cache.set(key, pending)
    return pending
  }
}

export async function resolveWorkspaceAvailability({
  workDir,
  projectRoot,
  worktreeSession,
  repository,
  pathExists = (targetPath: string | null) => defaultPathExists(targetPath),
}: {
  workDir: string | null
  projectRoot: string | null
  worktreeSession?: PersistedWorktreeSession | null
  repository?: PreparedSessionWorkspace['repository']
  pathExists?: (targetPath: string | null) => Promise<boolean>
}): Promise<{ workDirExists: boolean; workspaceState: SessionWorkspaceState }> {
  const workDirExists = await pathExists(workDir)
  if (workDirExists) {
    return { workDirExists: true, workspaceState: 'available' }
  }

  const projectRootIsDifferent = !sameWorkspacePath(workDir, projectRoot)
  const projectRootExists = projectRootIsDifferent && await pathExists(projectRoot)
  const removedPersistedWorktree = projectRootExists && matchesPersistedWorktree({
    workDir,
    projectRoot,
    worktreeSession,
    repository,
  })

  return {
    workDirExists: false,
    workspaceState: removedPersistedWorktree ? 'worktree_removed' : 'missing',
  }
}

export function matchesPersistedWorktree({
  workDir,
  projectRoot,
  worktreeSession,
  repository,
}: {
  workDir: string | null
  projectRoot: string | null
  worktreeSession?: PersistedWorktreeSession | null
  repository?: PreparedSessionWorkspace['repository']
}): boolean {
  if (!workDir || !projectRoot) return false
  if (sameWorkspacePath(workDir, worktreeSession?.worktreePath)) return true
  if (
    repository?.worktree &&
    sameWorkspacePath(workDir, repository.worktreePath)
  ) {
    return true
  }

  const normalizedWorkDir = normalizeWorkspacePath(workDir)
  const marker = '/.claude/worktrees/'
  const markerIndex = normalizedWorkDir.indexOf(marker)
  if (markerIndex <= 0) return false
  return sameWorkspacePath(
    normalizedWorkDir.slice(0, markerIndex),
    projectRoot,
  )
}

export function sameWorkspacePath(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false
  return normalizeWorkspacePath(left) === normalizeWorkspacePath(right)
}

export function normalizeWorkspacePath(targetPath: string): string {
  const normalized = normalizeDriveRootPathForPlatform(targetPath)
    .normalize('NFC')
    .replace(/\\/g, '/')
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}
