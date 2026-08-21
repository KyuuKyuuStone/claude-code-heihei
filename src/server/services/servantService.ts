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
  updatedAt: number
}

/** 对外视图：花名册条目 + 会话实时信息 */
export type ServantInfo = ServantEntry & {
  title: string
  workDir?: string
  /** CLI 是否正在运行 */
  running: boolean
}

type ServantsFile = {
  schemaVersion: number
  servants: ServantEntry[]
}

const SERVANTS_SCHEMA_VERSION = 1
const FILE_WRITE_ATTEMPTS = 2

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

    // 会话已被删除的条目自动清理
    const alive = candidates.filter((s) => byId.has(s.sessionId))
    if (alive.length !== candidates.length) {
      const aliveIds = new Set(alive.map((s) => s.sessionId))
      data.servants = data.servants.filter((s) => aliveIds.has(s.sessionId) || byId.has(s.sessionId))
      await this.writeFile(data)
    }

    let result = alive
    if (options?.forSessionId) {
      const forWorkDir = byId.get(options.forSessionId)?.workDir
      if (forWorkDir) {
        result = alive.filter(
          (s) => byId.get(s.sessionId)?.workDir === forWorkDir,
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
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 获取单个会话的协作身份（未登记返回 null） */
  async getServant(sessionId: string): Promise<ServantEntry | null> {
    const data = await this.readFile()
    return data.servants.find((s) => s.sessionId === sessionId) ?? null
  }

  /** 设置/更新会话的协作身份 */
  async setServant(
    sessionId: string,
    input: {
      role?: string
      description?: string
      enabled: boolean
      supervisor?: boolean
    },
  ): Promise<ServantEntry> {
    if (!sessionId || !sessionId.trim()) {
      throw ApiError.badRequest('Field "sessionId" is required')
    }
    if (typeof input.enabled !== 'boolean') {
      throw ApiError.badRequest('Field "enabled" must be a boolean')
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
      updatedAt: Date.now(),
    }
    if (index === -1) {
      data.servants.push(entry)
    } else {
      data.servants[index] = entry
    }
    await this.writeFile(data)

    // 员工会话要被主管无人值守地驱动：权限模式必须放行，否则员工会停在
    // 权限确认上无人批准，随后被"等待权限会话"的有界清理策略杀掉
    if (entry.enabled) {
      try {
        const workDir = await sessionService.getSessionWorkDir(sessionId)
        if (workDir) {
          await sessionService.appendSessionMetadata(sessionId, {
            workDir,
            permissionMode: 'bypassPermissions',
          })
        }
      } catch (err) {
        console.error(
          `[ServantService] Failed to set permissionMode for ${sessionId}:`,
          err,
        )
      }
    }

    return entry
  }

  /** 移除会话的协作身份 */
  async removeServant(sessionId: string): Promise<void> {
    const data = await this.readFile()
    const index = data.servants.findIndex((s) => s.sessionId === sessionId)
    if (index === -1) {
      throw ApiError.notFound(`Servant not registered: ${sessionId}`)
    }
    data.servants.splice(index, 1)
    await this.writeFile(data)
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
