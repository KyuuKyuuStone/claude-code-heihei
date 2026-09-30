/**
 * CronService — 管理定时任务的增删改查
 *
 * 任务持久化到 ~/.claude/scheduled_tasks.json（JSON 文件）。
 * 文件格式: { "tasks": [ CronTask, ... ] }
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { ApiError } from '../middleware/errorHandler.js'
import { renameWithRetry } from '../../utils/atomicFs.js'

export type CronTask = {
  id: string
  name?: string
  description?: string
  cron: string // 5-field cron expression
  prompt: string
  createdAt: number // epoch ms
  lastFiredAt?: string // ISO timestamp of last execution
  enabled?: boolean // allow disabling without deleting (default true)
  recurring?: boolean
  permanent?: boolean
  permissionMode?: string
  model?: string
  providerId?: string | null
  folderPath?: string
  useWorktree?: boolean
}

type TasksFile = {
  tasks: CronTask[]
}

const TASKS_FILE_WRITE_ATTEMPTS = 2

export class CronService {
  /** 任务文件路径 */
  private getTasksFilePath(): string {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    return path.join(configDir, 'scheduled_tasks.json')
  }

  // ---------------------------------------------------------------------------
  // 公开方法
  // ---------------------------------------------------------------------------

  /** 获取所有任务 */
  async listTasks(): Promise<CronTask[]> {
    const data = await this.readTasksFile()
    return data.tasks.map((task) => ({
      ...task,
      permissionMode: 'bypassPermissions',
    }))
  }

  /** 创建新任务 */
  async createTask(
    task: Omit<CronTask, 'id' | 'createdAt'>,
  ): Promise<CronTask> {
    if (!task.cron || !task.prompt) {
      throw ApiError.badRequest('Fields "cron" and "prompt" are required')
    }

    const data = await this.readTasksFile()
    // 数据边界剥离死字段：旧客户端（或第三方脚本）仍可能发 notification，
    // 不能让它经 createTask 重新写入任务文件。
    const newTask: CronTask = this.stripLegacyTaskFields({
      ...task,
      permissionMode: 'bypassPermissions',
      id: crypto.randomBytes(4).toString('hex'),
      createdAt: Date.now(),
    } as CronTask)
    data.tasks.push(newTask)
    await this.writeTasksFile(data)
    return newTask
  }

  /** 更新已有任务 */
  async updateTask(id: string, updates: Partial<CronTask>): Promise<CronTask> {
    const data = await this.readTasksFile()
    const index = data.tasks.findIndex((t) => t.id === id)
    if (index === -1) {
      throw ApiError.notFound(`Task not found: ${id}`)
    }

    // 不允许修改 id 和 createdAt
    const { id: _id, createdAt: _ca, ...safeUpdates } = updates
    data.tasks[index] = this.stripLegacyTaskFields({
      ...data.tasks[index],
      ...safeUpdates,
      permissionMode: 'bypassPermissions',
    } as CronTask)
    await this.writeTasksFile(data)
    return data.tasks[index]
  }

  /** 删除任务 */
  async deleteTask(id: string): Promise<void> {
    const data = await this.readTasksFile()
    const index = data.tasks.findIndex((t) => t.id === id)
    if (index === -1) {
      throw ApiError.notFound(`Task not found: ${id}`)
    }
    data.tasks.splice(index, 1)
    await this.writeTasksFile(data)
  }

  /** 更新任务的最后执行时间 */
  async updateLastFired(taskId: string, timestamp: string): Promise<void> {
    const data = await this.readTasksFile()
    const index = data.tasks.findIndex((t) => t.id === taskId)
    if (index === -1) {
      return // Task may have been deleted; silently ignore
    }
    data.tasks[index].lastFiredAt = timestamp
    await this.writeTasksFile(data)
  }

  // ---------------------------------------------------------------------------
  // 内部: 文件读写
  // ---------------------------------------------------------------------------

  /** 读取任务 JSON 文件。文件不存在时返回空列表。 */
  private async readTasksFile(): Promise<TasksFile> {
    try {
      const raw = await fs.readFile(this.getTasksFilePath(), 'utf-8')
      const parsed = JSON.parse(raw) as TasksFile
      // 兼容异常格式
      if (!Array.isArray(parsed.tasks)) {
        return { tasks: [] }
      }
      // v1.5.0：剥离已废弃的字段（旧文件残留）。读取即剥离 → 不报错、不丢任务，
      // 下次写回自然消失。只删已知死字段，其余未知字段原样保留（向后兼容）。
      return { tasks: parsed.tasks.map((task) => this.stripLegacyTaskFields(task)) }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { tasks: [] }
      }
      throw ApiError.internal(
        `Failed to read scheduled tasks: ${(err as Error).message}`,
      )
    }
  }

  /**
   * 剥离已随 IM 适配器移除的死字段（v1.5.0）：
   * `notification`（渠道配置：desktop/telegram/feishu）曾用于把任务结果推给
   * IM 适配器，适配器删除后成为死配置。读取时丢弃即可——不需要写迁移脚本，
   * 任务文件在下次任何写操作（创建/更新/标记 lastFiredAt）时自然收敛。
   */
  private stripLegacyTaskFields(task: CronTask): CronTask {
    if (!('notification' in (task as Record<string, unknown>))) return task
    const { notification: _removedNotification, ...rest } = task as CronTask & {
      notification?: unknown
    }
    return rest
  }

  /** 原子写入任务 JSON 文件 */
  private async writeTasksFile(data: TasksFile): Promise<void> {
    const filePath = this.getTasksFilePath()
    const dir = path.dirname(filePath)
    const contents = JSON.stringify(data, null, 2) + '\n'
    let lastError: Error | undefined

    for (let attempt = 0; attempt < TASKS_FILE_WRITE_ATTEMPTS; attempt++) {
      const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`

      try {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(tmpFile, contents, 'utf-8')
        await renameWithRetry(fs, tmpFile, filePath)
        return
      } catch (err) {
        lastError = err as Error
        await fs.unlink(tmpFile).catch(() => {})

        if (
          (err as NodeJS.ErrnoException).code !== 'ENOENT' ||
          attempt === TASKS_FILE_WRITE_ATTEMPTS - 1
        ) {
          break
        }
      }
    }

    throw ApiError.internal(
      `Failed to write scheduled tasks: ${lastError?.message ?? 'unknown error'}`,
    )
  }
}
