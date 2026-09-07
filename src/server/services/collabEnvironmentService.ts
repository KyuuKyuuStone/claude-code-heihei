/**
 * CollabEnvironmentService — 协作环境体检
 *
 * 回答两个问题（诊断/环境体检与主管履新消息共用）：
 * 1. 本机 shell 是否可用。Windows 缺 Git Bash 时会话内 Bash 工具全部失效，
 *    curl 派活通道瘫痪（2026-09 外部用户事故的根因），必须提前让主管知道并走文件信箱。
 * 2. 桌面即将拉起的 CLI 是否真的内置 work-orchestrator 技能。旧版本 CLI 没有
 *    该技能，履新消息不能空头承诺"该技能已对你生效"，而应内联派活协议兜底。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveClaudeCliLauncher } from '../../utils/desktopBundledCli.js'
import { tryFindGitBashPath } from '../../utils/windowsPaths.js'
import { WORK_ORCHESTRATOR_SKILL_NAME } from '../../collaboration/dispatchProtocol.js'

export type ShellCheck = {
  ok: boolean
  bashPath?: string
  hint?: string
}

/** available: true=已内置 / false=确认缺失 / null=外部 CLI 无法判断 */
export type SkillCheck = {
  available: boolean | null
  cliFile?: string
}

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024

export class CollabEnvironmentService {
  private skillCheckCache: SkillCheck | null = null

  checkShell(): ShellCheck {
    if (process.platform === 'win32') {
      const bashPath = tryFindGitBashPath()
      if (bashPath) {
        return { ok: true, bashPath }
      }
      return {
        ok: false,
        hint: process.env.CLAUDE_CODE_GIT_BASH_PATH
          ? `CLAUDE_CODE_GIT_BASH_PATH points to "${process.env.CLAUDE_CODE_GIT_BASH_PATH}" but it does not exist. Fix the variable or install Git Bash (https://git-scm.com/downloads/win).`
          : 'Git Bash not found. Install Git Bash (https://git-scm.com/downloads/win) or set CLAUDE_CODE_GIT_BASH_PATH to your bash.exe. Session Bash tools and curl dispatch will not work until then.',
      }
    }

    const candidates = [process.env.SHELL, '/bin/bash', '/usr/bin/bash'].filter(
      (value): value is string => Boolean(value),
    )
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return { ok: true, bashPath: candidate }
      } catch {
        // try next candidate
      }
    }
    return { ok: false, hint: 'No usable shell found (checked $SHELL, /bin/bash, /usr/bin/bash).' }
  }

  /**
   * 检查会话实际会用的 CLI 是否内置 work-orchestrator。
   * 判定依据与 conversationService.resolveCliArgs 相同：CLAUDE_CLI_PATH /
   * bundled sidecar 二进制。对二进制/脚本文件做分块字符串扫描（技能名会原样
   * 出现在 CLI 的嵌入 JS 里）。结果按进程缓存——CLI 文件运行期间不会变。
   */
  async checkWorkOrchestratorSkill(options: { force?: boolean } = {}): Promise<SkillCheck> {
    if (!options.force && this.skillCheckCache) {
      return this.skillCheckCache
    }

    const result = await this.resolveSkillCheck()
    this.skillCheckCache = result
    return result
  }

  private async resolveSkillCheck(): Promise<SkillCheck> {
    const launcher = resolveClaudeCliLauncher({
      cliPath: process.env.CLAUDE_CLI_PATH,
      execPath: process.execPath,
    })

    if (launcher) {
      const found = await scanFileForMarker(launcher.command, WORK_ORCHESTRATOR_SKILL_NAME)
      return found
        ? { available: true, cliFile: launcher.command }
        : { available: false, cliFile: launcher.command }
    }

    // 与 resolveCliArgs 的 win32 开发模式分支对应：CLI 从源码运行，
    // 技能源文件存在即视为内置。
    if (process.platform === 'win32') {
      const sourceFile = path.resolve(
        import.meta.dir,
        '../../skills/bundled/workOrchestrator.ts',
      )
      if (fs.existsSync(sourceFile)) {
        return { available: true, cliFile: sourceFile }
      }
    }

    // 外部/未知 CLI：无法判断。调用方按"不承诺技能、内联协议"处理。
    return { available: null }
  }
}

async function scanFileForMarker(filePath: string, marker: string): Promise<boolean> {
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(filePath, 'r')
  } catch {
    return false
  }

  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size < marker.length) return false

    // 分块扫描，块间保留 marker.length-1 字节重叠，避免标记跨块边界漏检。
    const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES)
    let position = 0
    let carry = ''
    while (position < stats.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stats.size - position), position)
      if (bytesRead === 0) break
      const text = carry + chunk.toString('latin1', 0, bytesRead)
      if (text.includes(marker)) return true
      carry = text.slice(Math.max(0, text.length - (marker.length - 1)))
      position += bytesRead
    }
    return false
  } finally {
    await handle.close().catch(() => {})
  }
}

export const collabEnvironmentService = new CollabEnvironmentService()
