/**
 * ServantService — 会话协作身份登记
 *
 * 会话级上下级模型的"花名册"：哪些会话可以被其他会话调遣（员工），
 * 各自扮演什么角色（用户自由文本，如"后端""前端""写作"）。
 *
 * 持久化到 ~/.claude/servant_sessions.json（独立于会话 jsonl，
 * 不改动 sessionService 的元数据白名单与索引 schema）。
 * 文件格式: { "schemaVersion": 1, "servants": [ ServantEntry, ... ] }
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { ApiError } from '../middleware/errorHandler.js'
import { diagnosticsService } from './diagnosticsService.js'
import { sessionService } from './sessionService.js'
import { conversationService } from './conversationService.js'

export type ServantEntry = {
  sessionId: string
  role?: string
  /** 角色特性：用户自然语言描述这个角色是什么（如"绘画师，擅长水彩"），派活时随任务注入 */
  description?: string
  /** 是否服务其他会话（员工） */
  enabled: boolean
  /** 是否被用户任命为主管。每个项目（workDir）最多一名 */
  supervisor?: boolean
  /** 约束档位：readonly=只读观察（禁改文件，信箱汇报放行）；whitelist=目录白名单（仅 writeDirs 内可写） */
  constraint?: 'readonly' | 'whitelist'
  /** whitelist 档的可写目录（服务端已 resolve 规范化/去重/拒绝根路径） */
  writeDirs?: string[]
  updatedAt: number
}

/** 对外视图：花名册条目 + 会话实时信息 */
export type ServantInfo = ServantEntry & {
  title: string
  workDir?: string
  /** CLI 是否正在运行 */
  running: boolean
  /** 会话最后一次活动时间（transcript 文件修改时间）——主管用它区分"执行中"与"假活" */
  lastActivityAt?: string
}

type ServantsFile = {
  schemaVersion: number
  servants: ServantEntry[]
}

const SERVANTS_SCHEMA_VERSION = 1
const FILE_WRITE_ATTEMPTS = 2

const WRITE_DIRS_MAX_ENTRIES = 16
const WRITE_DIRS_MAX_LENGTH = 1024

/**
 * whitelist 档可写目录规范化：trim/去空行 → 必须绝对路径 → resolve →
 * 拒绝文件系统根（全盘白名单等于没有白名单）→ 去重。
 */
function normalizeWriteDirs(dirs: readonly string[]): string[] {
  if (dirs.length > WRITE_DIRS_MAX_ENTRIES) {
    throw ApiError.badRequest(`Field "writeDirs" allows at most ${WRITE_DIRS_MAX_ENTRIES} entries`)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of dirs) {
    const dir = raw.trim()
    if (!dir) continue
    if (dir.length > WRITE_DIRS_MAX_LENGTH) {
      throw ApiError.badRequest('writeDirs entries must be at most 1024 characters')
    }
    if (!path.isAbsolute(dir)) {
      throw ApiError.badRequest(`writeDirs entries must be absolute paths: ${dir}`)
    }
    const resolved = path.resolve(dir)
    if (resolved === path.parse(resolved).root) {
      throw ApiError.badRequest(`writeDirs entries must not be filesystem roots: ${resolved}`)
    }
    if (!seen.has(resolved)) {
      seen.add(resolved)
      out.push(resolved)
    }
  }
  return out
}

/**
 * 员工移除的记录（对称 servant_registered；v1.2.3 基调：生命周期事件只进
 * 诊断日志，不注入主管对话流）。身份快照让「删掉的是什么档位/是否主管」
 * 在复盘时可查；reason 区分显式移除与会话死亡自动清理两个静默路径。
 */
function recordServantRemoved(
  entry: ServantEntry,
  reason: 'explicit-delete' | 'session-deleted-auto-cleanup',
  workDir?: string,
): void {
  const roleText = entry.role ? `${entry.role}（${entry.description || '未填写特性'}）` : '未命名角色'
  void diagnosticsService
    .recordEvent({
      type: 'servant_removed',
      severity: 'info',
      summary: `员工已移除：${roleText}`,
      sessionId: entry.sessionId,
      details: {
        sessionId: entry.sessionId,
        role: entry.role,
        description: entry.description,
        ...(workDir ? { workDir } : {}),
        ...(entry.constraint ? { constraint: entry.constraint } : {}),
        ...(entry.supervisor !== undefined ? { supervisor: entry.supervisor } : {}),
        reason,
      },
    })
    .catch(() => {})
}

export class ServantService {
  private getFilePath(): string {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    return path.join(configDir, 'servant_sessions.json')
  }

  /** 列出员工会话（默认仅 enabled 的花名册；includeAll 时含未启用条目） */
  async listServants(options?: {
    includeAll?: boolean
    /** 项目隔离：只返回该会话同项目（workDir）的员工 */
    forSessionId?: string
  }): Promise<ServantInfo[]> {
    const data = await this.readFile()
    const candidates = options?.includeAll
      ? data.servants
      : data.servants.filter((s) => s.enabled)
    if (candidates.length === 0) return []

    const { sessions } = await sessionService.listSessions({ limit: 500 })
    const byId = new Map(sessions.map((s) => [s.id, s]))

    // 会话已被删除的条目自动清理（第二个移除路径，同样要留 servant_removed 痕迹）
    const alive = candidates.filter((s) => byId.has(s.sessionId))
    if (alive.length !== candidates.length) {
      const aliveIds = new Set(alive.map((s) => s.sessionId))
      const removed = data.servants.filter((s) => !aliveIds.has(s.sessionId) && !byId.has(s.sessionId))
      data.servants = data.servants.filter((s) => aliveIds.has(s.sessionId) || byId.has(s.sessionId))
      await this.writeFile(data)
      for (const entry of removed) {
        recordServantRemoved(entry, 'session-deleted-auto-cleanup')
      }
    }

    let result = alive
    if (options?.forSessionId) {
      const forWorkDir = byId.get(options.forSessionId)?.workDir
      if (forWorkDir) {
        result = alive.filter(
          (s) =>
            // 自排除：请求者不出现在自己的花名册里（防主管把自己当员工自派）
            s.sessionId !== options.forSessionId &&
            byId.get(s.sessionId)?.workDir === forWorkDir,
        )
      }
    }

    return result
      .map((entry) => {
        const session = byId.get(entry.sessionId)!
        return {
          ...entry,
          title: session.title,
          workDir: session.workDir,
          running: conversationService.hasSession(entry.sessionId),
          ...(session.modifiedAt ? { lastActivityAt: session.modifiedAt } : {}),
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 获取单个会话的协作身份（未登记返回 null） */
  async getServant(sessionId: string): Promise<ServantEntry | null> {
    const data = await this.readFile()
    return data.servants.find((s) => s.sessionId === sessionId) ?? null
  }

  /** 设置/更新会话的协作身份；runtime* 字段一并写入会话元数据（模型/思考强度） */
  async setServant(
    sessionId: string,
    input: {
      role?: string
      description?: string
      enabled: boolean
      supervisor?: boolean
      runtimeProviderId?: string | null
      runtimeModelId?: string
      effortLevel?: string
      /** 约束档位：readonly=只读观察；whitelist=目录白名单（需 writeDirs） */
      constraint?: 'readonly' | 'whitelist'
      /** whitelist 档可写目录（绝对路径数组；服务端规范化） */
      writeDirs?: string[]
    },
  ): Promise<ServantEntry> {
    if (!sessionId || !sessionId.trim()) {
      throw ApiError.badRequest('Field "sessionId" is required')
    }
    if (typeof input.enabled !== 'boolean') {
      throw ApiError.badRequest('Field "enabled" must be a boolean')
    }
    if (
      input.constraint !== undefined &&
      input.constraint !== 'readonly' &&
      input.constraint !== 'whitelist'
    ) {
      throw ApiError.badRequest('Field "constraint" must be "readonly" or "whitelist"')
    }
    if (
      input.writeDirs !== undefined &&
      (!Array.isArray(input.writeDirs) ||
        input.writeDirs.some((d) => typeof d !== 'string'))
    ) {
      throw ApiError.badRequest('Field "writeDirs" must be an array of strings')
    }
    if (input.role !== undefined && typeof input.role !== 'string') {
      throw ApiError.badRequest('Field "role" must be a string')
    }
    if (input.description !== undefined && typeof input.description !== 'string') {
      throw ApiError.badRequest('Field "description" must be a string')
    }

    // 会话必须真实存在
    const { sessions } = await sessionService.listSessions({ limit: 500 })
    const thisSession = sessions.find((s) => s.id === sessionId)
    if (!thisSession) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const data = await this.readFile()

    // 主管任命：每个项目（workDir）最多一名
    if (input.supervisor) {
      const workDirById = new Map(sessions.map((s) => [s.id, s.workDir]))
      const existing = data.servants.find(
        (s) =>
          s.supervisor &&
          s.sessionId !== sessionId &&
          workDirById.get(s.sessionId) === thisSession.workDir,
      )
      if (existing) {
        throw ApiError.conflict(
          `This project already has a supervisor: ${existing.sessionId}. Unappoint it first.`,
        )
      }
    }

    const index = data.servants.findIndex((s) => s.sessionId === sessionId)
    const previousConstraint = index !== -1 ? data.servants[index].constraint : undefined
    const previousWriteDirs = index !== -1 ? data.servants[index].writeDirs : undefined

    // 约束档位与白名单目录一起归一（未传档位时沿用旧档位）
    const nextConstraint =
      input.constraint !== undefined ? input.constraint : previousConstraint
    let nextWriteDirs: string[] | undefined
    if (nextConstraint === 'whitelist') {
      nextWriteDirs = input.writeDirs !== undefined ? normalizeWriteDirs(input.writeDirs) : previousWriteDirs
      if (!nextWriteDirs || nextWriteDirs.length === 0) {
        throw ApiError.badRequest('whitelist constraint requires at least one write directory')
      }
    }
    // 非 whitelist 档：writeDirs 不落盘（切档自动清除，防脏数据残留）

    const entry: ServantEntry = {
      sessionId,
      role: input.role?.trim() || undefined,
      description: input.description?.trim() || undefined,
      enabled: input.enabled,
      ...(input.supervisor !== undefined
        ? { supervisor: input.supervisor }
        : index !== -1 && data.servants[index].supervisor !== undefined
          ? { supervisor: data.servants[index].supervisor }
          : {}),
      // 约束档位：未传时保留旧值（禁用员工也保留，重新启用不丢设置）
      ...(nextConstraint ? { constraint: nextConstraint } : {}),
      ...(nextWriteDirs ? { writeDirs: nextWriteDirs } : {}),
      updatedAt: Date.now(),
    }
    if (index === -1) {
      data.servants.push(entry)
    } else {
      data.servants[index] = entry
    }
    await this.writeFile(data)

    // 新登记的协作会话：title 按角色生成（custom-title 优先级最高，且之后
    // 用户的 AI title/手动改名仍可覆盖）。只修新会话（index===-1），历史不回填；
    // 若用户先改名再改档位（edit 路径 index!==-1）不会覆盖用户命名。
    // 失败不阻断登记本身（title 是体验项）。
    if (index === -1 && entry.role) {
      await sessionService
        .renameSession(sessionId, entry.role)
        .catch(() => {})
    }

    // 新增时「同项目同 role 且 enabled」重复提醒（日志级不阻断——role 是
    // 自由文本，同名不同分工合法；留痕让"派活给了另一个同名角色"可排查）
    if (index === -1 && entry.role) {
      const workDirById = new Map(sessions.map((s) => [s.id, s.workDir]))
      const duplicate = data.servants.find(
        (s) =>
          s.enabled &&
          s.sessionId !== sessionId &&
          s.role === entry.role &&
          workDirById.get(s.sessionId) === thisSession.workDir,
      )
      if (duplicate) {
        void diagnosticsService
          .recordEvent({
            type: 'servant_duplicate_role',
            severity: 'warn',
            summary: `同项目已有同角色员工「${entry.role}」在册：${sessionId} 与 ${duplicate.sessionId}`,
            sessionId,
            details: {
              newSessionId: sessionId,
              existingSessionId: duplicate.sessionId,
              role: entry.role,
              workDir: thisSession.workDir,
            },
          })
          .catch(() => {})
      }
    }

    // 员工会话要被主管无人值守地驱动：权限模式必须放行，否则员工会停在
    // 权限确认上无人批准，随后被"等待权限会话"的有界清理策略杀掉。
    // 协作弹窗指定的模型/思考强度（runtime* 字段）也在这里写入会话元数据——
    // 必须先落盘再触发履新消息/派活拉起，员工首次启动就用上选定配置。
    const runtimeMetadata: {
      runtimeProviderId?: string | null
      runtimeModelId?: string
      effortLevel?: string
    } = {}
    if (input.runtimeProviderId !== undefined) {
      runtimeMetadata.runtimeProviderId = input.runtimeProviderId
    }
    if (input.runtimeModelId !== undefined) {
      runtimeMetadata.runtimeModelId = input.runtimeModelId
    }
    if (input.effortLevel !== undefined) {
      runtimeMetadata.effortLevel = input.effortLevel
    }
    const hasRuntimeUpdate = Object.keys(runtimeMetadata).length > 0
    if (entry.enabled || hasRuntimeUpdate) {
      try {
        const workDir = await sessionService.getSessionWorkDir(sessionId)
        if (workDir) {
          await sessionService.appendSessionMetadata(sessionId, {
            workDir,
            ...(entry.enabled ? { permissionMode: 'bypassPermissions' as const } : {}),
            ...runtimeMetadata,
          })
        }
      } catch (err) {
        console.error(
          `[ServantService] Failed to set session metadata for ${sessionId}:`,
          err,
        )
      }
    }

    return entry
  }

  /** 移除会话的协作身份；返回被删条目（供调用方发 servant_removed 事件） */
  async removeServant(sessionId: string): Promise<ServantEntry> {
    const data = await this.readFile()
    const index = data.servants.findIndex((s) => s.sessionId === sessionId)
    if (index === -1) {
      throw ApiError.notFound(`Servant not registered: ${sessionId}`)
    }
    const [removed] = data.servants.splice(index, 1)
    await this.writeFile(data)
    return removed
  }

  // ---------------------------------------------------------------------------
  // 内部: 文件读写（与平台其它 JSON 持久化一致的原子写）
  // ---------------------------------------------------------------------------

  private async readFile(): Promise<ServantsFile> {
    try {
      const raw = await fs.readFile(this.getFilePath(), 'utf-8')
      const parsed = JSON.parse(raw) as ServantsFile
      if (!Array.isArray(parsed.servants)) {
        return { schemaVersion: SERVANTS_SCHEMA_VERSION, servants: [] }
      }
      return parsed
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: SERVANTS_SCHEMA_VERSION, servants: [] }
      }
      throw ApiError.internal(
        `Failed to read servant sessions: ${(err as Error).message}`,
      )
    }
  }

  private async writeFile(data: ServantsFile): Promise<void> {
    const filePath = this.getFilePath()
    const dir = path.dirname(filePath)
    const contents =
      JSON.stringify(
        { schemaVersion: SERVANTS_SCHEMA_VERSION, servants: data.servants },
        null,
        2,
      ) + '\n'
    let lastError: Error | undefined

    for (let attempt = 0; attempt < FILE_WRITE_ATTEMPTS; attempt++) {
      const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`
      try {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(tmpFile, contents, 'utf-8')
        await fs.rename(tmpFile, filePath)
        return
      } catch (err) {
        lastError = err as Error
        await fs.unlink(tmpFile).catch(() => {})
        if (
          (err as NodeJS.ErrnoException).code !== 'ENOENT' ||
          attempt === FILE_WRITE_ATTEMPTS - 1
        ) {
          break
        }
      }
    }

    throw ApiError.internal(
      `Failed to write servant sessions: ${lastError?.message ?? 'unknown error'}`,
    )
  }
}

export const servantService = new ServantService()
