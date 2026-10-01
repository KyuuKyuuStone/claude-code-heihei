/**
 * 会话条目元数据解析（v1.7 结构拆分 · sessionService 第③批 · 纯移动）。
 *
 * 从 sessionService.ts 原样搬出的 13 个方法 + 1 个常量：
 *   · 11 个 resolveXxxFromEntries / canonicalizeProjectPath / countTranscriptMessages
 *     —— 从 RawEntry[] 提取 workDir / repository / permissionMode / modifiedAt /
 *     runtimeContext / worktreeSession / projectRoot / 消息计数；
 *   · latestTimestamp、desanitizePath —— 只被上述方法使用的纯辅助；
 *   · VALID_SESSION_PERMISSION_MODES —— 只被 resolvePermissionModeFromEntries 使用。
 *
 * 选段理由：与第①/②批同属转录解析域，且这 13 个方法**全部不读实例状态**——
 * 体内 this. 仅出现在组内互调上（共 7 处）；不含缓存字段、列表/索引/轮询逻辑。
 * desanitizePath 虽为门面 public 方法，但门面另有 3 处组外调用点，搬走后以
 * 同名类字段委托保留（调用点文本未改）。
 *
 * 搬移规则（T1-T4，与补充裁决二一致）：
 *   T1 缩进 −2；T2 组内 this.foo( → foo(（7 处）；T3 门面加委托行 13 行；
 *   T4 import/export 增减见下。
 *
 * 伴随搬移的类型：ProviderContextWindowHint（原门面本地未导出类型，搬走后
 * 门面以 import type 引回，门面导出面不变）。
 *
 * 路径依赖预检：本段无 import.meta / __dirname / process.execPath（全文预检亦为零）。
 *
 * 有意未随本批搬走（留在门面）：
 *   · metadataMatchesLaunchInfo、sanitizePath —— 分别带列表域耦合与实例路径方法依赖；
 *   · readJsonlFile / streamJsonlFile / scanSessionListSummary / entryToMessage 等
 *     —— 文件 IO 或依赖实例状态，按裁决五不搬。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { findCanonicalGitRoot } from '../../../utils/git.js'
import { normalizeDriveRootPathForPlatform } from '../windowsDrivePath.js'
import type { PreparedSessionWorkspace } from '../repositoryLaunchService.js'
import type { PersistedWorktreeSession } from '../localIndex/types.js'
import type { RawEntry } from './transcriptAgents.js'
import type { SessionLaunchInfo } from '../sessionService.js'

type ProviderContextWindowHint = Pick<SessionLaunchInfo, 'runtimeProviderId' | 'runtimeModelId'>

export const VALID_SESSION_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
])

function latestTimestamp(current: string | null, candidate: unknown): string | null {
  if (typeof candidate !== 'string') return current
  const candidateTime = Date.parse(candidate)
  if (!Number.isFinite(candidateTime)) return current
  if (!current) return candidate
  const currentTime = Date.parse(current)
  return !Number.isFinite(currentTime) || candidateTime > currentTime
    ? candidate
    : current
}

/**
 * Convert a sanitized directory name back to the original absolute path.
 * Reverses sanitizePath(): `-Users-nanmi-workspace` → `/Users/nanmi/workspace`.
 */
export function desanitizePath(sanitized: string): string {
  // The sanitized form replaces all non-alphanumeric characters with '-'.
  // This fallback is necessarily lossy, but old Windows transcripts without
  // session-meta still need the drive separator restored well enough to resume.
  const windowsDrivePath = sanitized.match(/^([a-zA-Z])--(.+)$/)
  if (windowsDrivePath) {
    return `${windowsDrivePath[1]}:${path.win32.sep}${windowsDrivePath[2].replace(/-/g, path.win32.sep)}`
  }

  const windowsDriveRoot = sanitized.match(/^([a-zA-Z])--$/)
  if (windowsDriveRoot) {
    return `${windowsDriveRoot[1]}:${path.win32.sep}`
  }

  // On POSIX the original path starts with '/', so the sanitized form starts with '-'.
  // UNC-style Windows paths also recover to a leading double separator on Windows.
  return sanitized.replace(/-/g, path.sep)
}

export function resolveWorkDirFromEntries(
  entries: RawEntry[],
  fallbackProjectDir?: string,
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.type === 'session-meta' && typeof (entry as Record<string, unknown>).workDir === 'string') {
      return normalizeDriveRootPathForPlatform((entry as Record<string, unknown>).workDir as string)
    }
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const cwd = entries[i]?.cwd
    if (typeof cwd === 'string' && cwd.trim()) {
      return normalizeDriveRootPathForPlatform(cwd)
    }
  }

  return fallbackProjectDir ? desanitizePath(fallbackProjectDir) : null
}

export function resolveRepositoryFromEntries(entries: RawEntry[]): PreparedSessionWorkspace['repository'] | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const repository = (entries[i] as Record<string, unknown>)?.repository
    if (repository && typeof repository === 'object') {
      return repository as PreparedSessionWorkspace['repository']
    }
  }
  return undefined
}

export function resolvePermissionModeFromEntries(entries: RawEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.type !== 'session-meta') continue
    const permissionMode = entry.permissionMode
    if (
      typeof permissionMode === 'string' &&
      VALID_SESSION_PERMISSION_MODES.has(permissionMode)
    ) {
      return permissionMode
    }
  }
  return undefined
}

export function resolveTranscriptModifiedAtFromEntries(entries: RawEntry[]): string | null {
  let modifiedAt: string | null = null
  for (const entry of entries) {
    if (
      !entry.isMeta &&
      (entry.type === 'user' || entry.type === 'assistant') &&
      entry.message?.role
    ) {
      modifiedAt = latestTimestamp(modifiedAt, entry.timestamp)
    }
  }
  return modifiedAt
}

export function resolveRuntimeContextMetadataFromEntries(entries: RawEntry[]): ProviderContextWindowHint {
  let runtimeProviderId: string | null | undefined
  let runtimeModelId: string | undefined

  for (const entry of entries) {
    if (entry.type !== 'session-meta') continue
    const record = entry as Record<string, unknown>
    if (record.runtimeProviderId === null || typeof record.runtimeProviderId === 'string') {
      runtimeProviderId = record.runtimeProviderId as string | null
    }
    if (typeof record.runtimeModelId === 'string') {
      runtimeModelId = record.runtimeModelId
    }
  }

  return {
    ...(runtimeProviderId !== undefined ? { runtimeProviderId } : {}),
    ...(runtimeModelId ? { runtimeModelId } : {}),
  }
}

export function applyRuntimeContextMetadata(
  hint: ProviderContextWindowHint,
  entry: RawEntry,
): ProviderContextWindowHint {
  if (entry.type !== 'session-meta') return hint

  const record = entry as Record<string, unknown>
  const nextHint: ProviderContextWindowHint = { ...hint }
  if (record.runtimeProviderId === null || typeof record.runtimeProviderId === 'string') {
    nextHint.runtimeProviderId = record.runtimeProviderId as string | null
  }
  if (typeof record.runtimeModelId === 'string') {
    nextHint.runtimeModelId = record.runtimeModelId
  }
  return nextHint
}

export function resolveWorktreeSessionFromEntries(entries: RawEntry[]): PersistedWorktreeSession | null | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.type !== 'worktree-state') continue

    const worktreeSession = entry.worktreeSession
    if (worktreeSession === null) return null
    if (
      worktreeSession &&
      typeof worktreeSession === 'object' &&
      typeof worktreeSession.worktreePath === 'string' &&
      typeof worktreeSession.worktreeName === 'string'
    ) {
      return worktreeSession
    }
  }
  return undefined
}

export async function resolveProjectRootFromEntries(
  entries: RawEntry[],
  workDir: string | null,
  fallbackProjectDir?: string,
): Promise<string | null> {
  const worktreeSession = resolveWorktreeSessionFromEntries(entries)
  const repository = resolveRepositoryFromEntries(entries)
  return resolveProjectRootFromSessionMetadata({
    worktreeSession,
    repository,
    workDir,
    fallbackProjectDir,
  })
}

export async function resolveProjectRootFromSessionMetadata({
  worktreeSession,
  repository,
  workDir,
  fallbackProjectDir,
}: {
  worktreeSession?: PersistedWorktreeSession | null
  repository?: PreparedSessionWorkspace['repository']
  workDir: string | null
  fallbackProjectDir?: string
}): Promise<string | null> {
  const candidate = worktreeSession?.originalCwd ||
    repository?.repoRoot ||
    workDir ||
    (fallbackProjectDir ? desanitizePath(fallbackProjectDir) : null)

  if (!candidate) return null

  const canonicalCandidate = await canonicalizeProjectPath(candidate)
  const gitRoot = findCanonicalGitRoot(canonicalCandidate)
  if (gitRoot) return gitRoot

  if (workDir) {
    const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`
    const markerIndex = canonicalCandidate.indexOf(marker)
    if (markerIndex > 0) return canonicalCandidate.slice(0, markerIndex)
  }

  return canonicalCandidate
}

export async function canonicalizeProjectPath(projectPath: string): Promise<string> {
  try {
    return normalizeDriveRootPathForPlatform(await fs.realpath(projectPath)).normalize('NFC')
  } catch {
    return projectPath.normalize('NFC')
  }
}

export function countTranscriptMessages(entries: RawEntry[]): number {
  return entries.filter((entry) =>
    !entry.isMeta &&
    !!entry.message?.role &&
    (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system')
  ).length
}
