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
import * as crypto from 'crypto'
import { ApiError } from '../middleware/errorHandler.js'
import { diagnosticsService } from './diagnosticsService.js'
import { sessionService } from './sessionService.js'
import type { SessionListSummary } from './localIndex/types.js'
import { getSessionSnapshot } from './sessionRegistry.js'
import { isSessionTurnInProgress } from './dispatchReceiptService.js'
import { emitCollabPush } from '../../collaboration/collabPushSignals.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

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
  /**
   * 当前是否有进行中回合（真实信号，与假死 watcher/消费回执同源于
   * dispatchReceiptService 的 SDK 消息流观察，非 lastActivityAt 滑动窗口猜测）。
   * 前端状态灯据此判 busy——回合一结束 result 边界即转 false，灯立刻转灰。
   */
  turnInProgress: boolean
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
    // v1.5.0 花名册高危修复：改用与 sessionService 同一个解析器。
    // 以前这里用 `||`（空串回退 ~/.claude），而 sessionService 走
    // getClaudeConfigHomeDir（`??`，空串不回退）。一旦 CLAUDE_CONFIG_DIR 是空串
    // （某些启动方式会这样传），本服务读写真实的 ~/.claude/servant_sessions.json，
    // sessionService 却去 cwd/projects 找 transcript——两边看到的不是同一个世界，
    // 于是「查不到任何会话」被当成「全部会话已删除」，整个花名册被一个 GET 清空。
    return path.join(getClaudeConfigHomeDir(), 'servant_sessions.json')
  }

  /**
   * 进程内写队列（v1.6.0）：所有「读-改-写」花名册的操作串行执行。
   *
   * 花名册是单文件整体重写，并发写会 lost update：A 读到 S 改完写回 S'，
   * B 若在 A 写回前也读到 S，随后写回 S'' 就把 A 的改动覆盖掉。2026-09-30
   * 排查「登记后身份消失」时确认过这条链路（当时还叠加了读路径误清理）。
   * 队列只覆盖单个进程；多进程（理论上只有 sidecar 一个）不在此列。
   *
   * 失败不阻断队列：单个操作抛错由调用方收到，后续操作照常执行。
   */
  private writeQueue: Promise<unknown> = Promise.resolve()

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation)
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
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

    // v1.4.0 加载性能修复：花名册只需要已知的 K 个员工会话，按会话直查列表
    // 摘要（复用 mtime+size 摘要缓存）。原实现 listSessions({ limit: 500 }) 会
    // 先对发现的全部会话文件逐一摘要扫描再切片——冷启动全量扫、活跃会话
    // mtime 一变就整文件重扫；渲染端挂载即拉 + 20s 轮询 × 多客户端把它打成
    // 分钟级事件循环阻塞（实录 /api/servant-sessions?all=1 请求 120s 超时），
    // 冷启动开会话「加载中…」被一并拖长。
    const byId = new Map(
      await Promise.all(
        candidates.map(
          async (s) =>
            [s.sessionId, await sessionService.getSessionListSummaryForSession(s.sessionId)] as const,
        ),
      ),
    )

    // v1.5.0 花名册高危修复：**读操作绝不删数据**。
    //
    // 这里原本有一段「摘要为 null ⇒ 会话已删除 ⇒ writeFile 移除条目」的自动清理。
    // 但摘要为 null 的成因远不止「会话被删」：索引未就绪、扫描/IO 抖动、配置目录
    // 解析不一致（sessionService 用 ?? 而本服务用 ||，空 CLAUDE_CONFIG_DIR 下两者
    // 指向不同的 ~/.claude）都会让它瞬时为 null。实测就是一次 9 条 servant_removed
    // 挤在同一毫秒——整个花名册被一个 GET 请求抹掉，用户的登记 1 秒后必被清。
    // 清理已挪到明确删除事件（pruneForDeletedSessions，由 DELETE /api/sessions 调用）。
    let result = candidates
    if (options?.forSessionId) {
      // 请求方未必是员工（主管不是 enabled 员工），byId 里可能没有——直查其摘要。
      const forSummary =
        byId.get(options.forSessionId) ??
        (await sessionService.getSessionListSummaryForSession(options.forSessionId))
      const forWorkDir = forSummary?.workDir
      if (forWorkDir) {
        // 注意用 result（= 全部候选），不再有「alive」子集：摘要缺失的条目现在
        // 也要参与过滤，只是 workDir 未知（undefined ≠ forWorkDir，会被排除）。
        result = result.filter(
          (s) =>
            // 自排除：请求者不出现在自己的花名册里（防主管把自己当员工自派）
            s.sessionId !== options.forSessionId &&
            byId.get(s.sessionId)?.workDir === forWorkDir,
        )
      }
    }

    return result
      .map((entry) => {
        // 摘要取不到也照常返回条目（要求：花名册条目不能因摘要失败而消失）。
        // title/workDir 退化为兜底值，用户仍能看到员工身份。
        const session = byId.get(entry.sessionId) ?? null
        return {
          ...entry,
          title: session?.title ?? entry.sessionId.slice(0, 8),
          workDir: session?.workDir ?? undefined,
          // v1.3.0 阶段4 · 7a：改读 registry 快照，删除对 conversationService
          // 的静态 import——反向依赖环消失。旧 hasSession（map 含即真）≈
          // starting∪running 都算「在跑」；此处**有意收紧**为仅 running：
          // starting 段 CLI 未 ready，花名册先按未就绪呈现（重启后未登记 →
          // false，同语义）。（v1.3.1 · R3 注释如实修订，行为不变。）
          running: getSessionSnapshot(entry.sessionId)?.phase === 'running',
          turnInProgress: isSessionTurnInProgress(entry.sessionId),
          ...(session?.modifiedAt ? { lastActivityAt: session.modifiedAt } : {}),
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
      /**
       * 约束档位：readonly=只读观察；whitelist=目录白名单（需 writeDirs）。
       * 三态语义（v1.6.0，前端协作设置弹窗契约）：
       * - 传值   → 设为该档位
       * - null   → 清除约束（恢复完全执行），writeDirs 一并清空
       * - undefined（不传）→ 继承旧值
       */
      constraint?: 'readonly' | 'whitelist' | null
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
      input.constraint !== null &&
      input.constraint !== 'readonly' &&
      input.constraint !== 'whitelist'
    ) {
      throw ApiError.badRequest('Field "constraint" must be "readonly", "whitelist" or null')
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

    // 临界区：读-改-写整段进进程内队列（v1.6.0 写-写串行化）。并发登记/
    // 移除若各自读同一份快照再写回，后写者会覆盖先写者的改动（lost update）。
    const { data, index, entry } = await this.enqueueWrite(async () => {
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

      // 约束档位归一（v1.6.0 三态）：显式 null = 清除约束（含白名单），
      // 传值 = 设档，undefined = 继承旧档。清除是「恢复完全执行」的唯一入口，
      // 否则受限档一旦设置，前端无从撤销。
      const clearingConstraint = input.constraint === null
      const nextConstraint = clearingConstraint
        ? undefined
        : input.constraint !== undefined
          ? input.constraint
          : previousConstraint
      let nextWriteDirs: string[] | undefined
      if (clearingConstraint) {
        nextWriteDirs = undefined
      } else if (nextConstraint === 'whitelist') {
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
      return { data, index, entry }
    })
    // v1.5.0 A6：花名册变化广播信号（ws 层订阅后翻成 servant_roster_changed）。
    // fields 取结构性字段全集——前端拿到可据此决定局部 patch 还是全量刷新。
    emitCollabPush({
      kind: 'roster',
      sessionId,
      change: index === -1 ? 'added' : 'updated',
      fields: [
        'role',
        'description',
        'enabled',
        'supervisor',
        'constraint',
        'writeDirs',
      ].filter((field) => field in entry),
    })

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
  /**
   * 明确的会话删除事件钩子（v1.5.0 花名册高危修复）。
   *
   * 花名册条目的移除**只允许**从这里发生：调用方（DELETE /api/sessions/:id）
   * 已经确认这些会话真的被删了。以前这个清理挂在 listServants（GET 路径）上，
   * 靠「摘要为 null」推断删除——一次 IO 抖动就能清空整个花名册。
   *
   * 兜底防线：只要这次移除会导致「N>0 → 0」或「一次移除多条」，就判定可疑，
   * 整批跳过并记 warn 诊断 servant_roster_mass_cleanup_skipped。宁可留脏条目
   * （用户可手动移除），也不让协作身份静默消失。
   *
   * @returns 实际被移除的条目（被兜底拦截时为空数组）
   */
  async pruneForDeletedSessions(sessionIds: readonly string[]): Promise<ServantEntry[]> {
    if (sessionIds.length === 0) return []

    const doomed = await this.enqueueWrite(async () => {
      const data = await this.readFile()
      const targets = new Set(sessionIds)
      const doomed = data.servants.filter((s) => targets.has(s.sessionId))
      if (doomed.length === 0) return []

      const total = data.servants.length
      const remaining = total - doomed.length
      if (doomed.length >= 2 || (total > 0 && remaining === 0)) {
        logForDiagnosticsNoPII('warn', 'servant_roster_mass_cleanup_skipped', {
          requested: doomed.length,
          total,
          remaining,
        })
        return []
      }

      data.servants = data.servants.filter((s) => !targets.has(s.sessionId))
      await this.writeFile(data)
      return doomed
    })
    for (const entry of doomed) {
      recordServantRemoved(entry, 'session-deleted-auto-cleanup')
      emitCollabPush({ kind: 'roster', sessionId: entry.sessionId, change: 'removed', fields: [] })
    }
    return doomed
  }

  async removeServant(sessionId: string): Promise<ServantEntry> {
    const removed = await this.enqueueWrite(async () => {
      const data = await this.readFile()
      const index = data.servants.findIndex((s) => s.sessionId === sessionId)
      if (index === -1) {
        throw ApiError.notFound(`Servant not registered: ${sessionId}`)
      }
      const [entry] = data.servants.splice(index, 1)
      await this.writeFile(data)
      return entry
    })
    // v1.5.0 A6：移除广播（前端据此删条目）
    emitCollabPush({ kind: 'roster', sessionId, change: 'removed', fields: [] })
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
