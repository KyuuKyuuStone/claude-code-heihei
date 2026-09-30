import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSupervisorOrientation } from '../api/servants.js'
import {
  DISPATCH_PROTOCOL_MD,
  WORK_ORCHESTRATOR_SKILL_NAME,
} from '../../collaboration/dispatchProtocol.js'
import { CollabEnvironmentService } from '../services/collabEnvironmentService.js'
import { DoctorService } from '../services/doctorService.js'

describe('buildSupervisorOrientation', () => {
  test('confirms the skill only when its presence is verified', () => {
    const message = buildSupervisorOrientation({ skillAvailable: true, shellOk: true })
    expect(message).toContain(`遵循 ${WORK_ORCHESTRATOR_SKILL_NAME} 技能`)
    expect(message).toContain('已确认你的 CLI 内置该技能')
    // 不再出现无验证的空头承诺
    expect(message).not.toContain('该技能已对你生效')
    expect(message).not.toContain('内联协议')
  })

  test('inlines the full dispatch protocol when the skill is missing or unverifiable', () => {
    for (const skillAvailable of [false, null] as const) {
      const message = buildSupervisorOrientation({ skillAvailable, shellOk: true })
      expect(message).toContain('无法确认你的 CLI 是否内置')
      expect(message).toContain('内联协议执行')
      // 内联协议必须自包含到能完成派活与汇报
      expect(message).toContain('api/servant-sessions')
      expect(message).toContain('api/session-messages')
      expect(message).toContain('.heihei/dispatch')
    }
  })

  test('the inlined protocol matches the shared text (no drift)', () => {
    const message = buildSupervisorOrientation({ skillAvailable: false, shellOk: true })
    expect(message).toContain(DISPATCH_PROTOCOL_MD)
  })

  test('warns about a missing shell and points to the mailbox channel', () => {
    const message = buildSupervisorOrientation({ skillAvailable: true, shellOk: false })
    expect(message).toContain('未检测到可用的 Bash')
    expect(message).toContain('文件信箱')
    expect(message).toContain('环境体检')

    const healthy = buildSupervisorOrientation({ skillAvailable: true, shellOk: true })
    expect(healthy).not.toContain('未检测到可用的 Bash')
  })
})

// ── v1.4.0 阶段1-B：地址自愈 + 汇报成功判据（协议/注册块文案契约）──
// 背景（v1.3.3 员工反馈 6/7 共同确认）：env 地址启动时注入、app 重启即陈旧；
// 本机 curl 包装器失败时退出码也可能是 0，「curl && rm」会删掉还没发出的 payload。
describe('v1.6.0 protocol & pocket-card copy contract', () => {
  test('manual fallback keeps safe file-based JSON delivery and avoids dangerous shell chaining', () => {
    expect(DISPATCH_PROTOCOL_MD).toContain('curl --data-binary @文件')
    expect(DISPATCH_PROTOCOL_MD).toContain('响应含 messageId 才算派活送达')
    // 语义：明令禁止把 curl 与 rm 用 && 串起来（旧稿写作 `curl && rm` 示例，
    // 但示例字面本身会被下面的正则命中，故改为等价的禁止句，断言不弱化）
    expect(DISPATCH_PROTOCOL_MD).toContain('禁内联中文、heredoc')
    expect(DISPATCH_PROTOCOL_MD).toContain('curl 与 rm 不得 && 串联')
    expect(DISPATCH_PROTOCOL_MD).not.toMatch(/curl[^\n`]*&&\s*rm/)
  })

  // ── v1.6.0 协议瘦身：兜底只覆盖「无工具 / 传输层故障」，不许拿 curl 绕过业务判定 ──
  test('manual fallback states its two trigger conditions and forbids bypassing business errors', () => {
    const start = DISPATCH_PROTOCOL_MD.indexOf('## 安全手动兜底')
    const end = DISPATCH_PROTOCOL_MD.indexOf('## 失败处理与主管职责')
    const fallback = DISPATCH_PROTOCOL_MD.slice(start, end)

    // 触发范围：只在这两种情况
    expect(fallback).toContain('仅未注入工具或传输失败且信箱不可写时使用')
    // 业务错误不得用兜底绕过（逐个列出）
    expect(fallback).toContain('业务拒绝')
    for (const code of [
      'not_on_roster',
      'not_reviewable',
      'task_closed',
      'ledger_unsupported',
      'invalid_target',
      'cross_project',
    ]) {
      expect(fallback).toContain(code)
    }
    expect(fallback).toContain('403')
    expect(fallback).toContain('409')
    // queued 已经写进信箱，补发会重复投递
    expect(fallback).toContain('queued 不补发')
  })

  test('curl appears only inside the manual-fallback section', () => {
    const start = DISPATCH_PROTOCOL_MD.indexOf('## 安全手动兜底')
    const end = DISPATCH_PROTOCOL_MD.indexOf('## 失败处理与主管职责')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const outside = DISPATCH_PROTOCOL_MD.slice(0, start) + DISPATCH_PROTOCOL_MD.slice(end)
    expect(outside).not.toContain('curl')
    expect(DISPATCH_PROTOCOL_MD.slice(start, end)).toContain('curl')
  })

  test('interrupt and the DELETE red line are both present', () => {
    expect(DISPATCH_PROTOCOL_MD).toContain('POST /api/sessions/<id>/interrupt')
    expect(DISPATCH_PROTOCOL_MD).toContain('DELETE /api/sessions/<id>')
    expect(DISPATCH_PROTOCOL_MD).toContain('不可逆')
  })

  test('fallback validates port-file PID, whoami identity, and startedAt', () => {
    expect(DISPATCH_PROTOCOL_MD).toContain('desktop-server.json')
    expect(DISPATCH_PROTOCOL_MD).toContain('pid 存活')
    expect(DISPATCH_PROTOCOL_MD).toContain('/api/whoami')
    expect(DISPATCH_PROTOCOL_MD).toContain('startedAt')
  })

  test('report target is authoritative only from the dispatch footer', () => {
    expect(DISPATCH_PROTOCOL_MD).toContain('汇报目标唯一取该条派活页脚')
    expect(DISPATCH_PROTOCOL_MD).toContain('页脚缺失/不可读即停止并报告派活方')
    expect(DISPATCH_PROTOCOL_MD).not.toContain('照抄主管给的地址')
  })

  test('manual fallback is retained but stays near the approved 300-character size', () => {
    const fallbackStart = DISPATCH_PROTOCOL_MD.indexOf('## 安全手动兜底')
    const fallbackEnd = DISPATCH_PROTOCOL_MD.indexOf('## 失败处理与主管职责')
    expect(fallbackStart).toBeGreaterThanOrEqual(0)
    expect(fallbackEnd).toBeGreaterThan(fallbackStart)
    const fallback = DISPATCH_PROTOCOL_MD.slice(fallbackStart, fallbackEnd)
    expect(Array.from(fallback).length).toBeLessThanOrEqual(550)
  })

  test('protocol plus injected tool prompts does not exceed the pre-tool protocol budget', async () => {
    // 预算口径（架构裁决 2026-09-30）：左 = 协议 + 四工具 description/prompt 之和；
    // 右 = v1.5.1 协议全文 11266 码点。计量 Array.from(text).length。
    // 复现：git show v1.5.1:src/collaboration/dispatchProtocol.ts 取模板串计数。
    const V151_BASELINE_CHARS = 11266
    const { CollabDispatchTool } = await import('../../tools/CollabTools/CollabDispatchTool.js')
    const { CollabReviewTool } = await import('../../tools/CollabTools/CollabReviewTool.js')
    const { CollabListTasksTool } = await import('../../tools/CollabTools/CollabListTasksTool.js')
    const { CollabReportTool } = await import('../../tools/CollabTools/CollabReportTool.js')
    const tools = [CollabDispatchTool, CollabReviewTool, CollabListTasksTool, CollabReportTool]
    const toolChars = (
      await Promise.all(
        tools.map(async (tool) => {
          const [description, prompt] = await Promise.all([tool.description(), tool.prompt()])
          return Array.from(description).length + Array.from(prompt).length
        }),
      )
    ).reduce((sum, n) => sum + n, 0)
    expect(Array.from(DISPATCH_PROTOCOL_MD).length + toolChars).toBeLessThanOrEqual(V151_BASELINE_CHARS)
  })

  test('protocol never claims task status from turn state', () => {
    expect(DISPATCH_PROTOCOL_MD).not.toMatch(/turnInProgress|turnState|running\s*=|turn state/i)
  })

  test('protocol includes native tool names and dispatcher responsibilities', () => {
    for (const name of ['CollabDispatch', 'CollabReview', 'CollabListTasks', 'CollabReport']) {
      expect(DISPATCH_PROTOCOL_MD).toContain(name)
    }
    expect(DISPATCH_PROTOCOL_MD).toContain('主管只负责拆解、按花名册派活、验收和汇总')
  })

  test('pocket card: serverUrl is marked startup-injected, never authoritative', () => {
    const message = buildSupervisorOrientation({
      skillAvailable: true,
      shellOk: true,
      sessionId: 'sup-1',
      serverUrl: 'http://127.0.0.1:12345',
    })
    expect(message).toContain('启动时注入')
    expect(message).toContain('desktop-server.json')
    expect(message).toContain('先校验 pid 存活再信 port')
    expect(message).toContain('/api/whoami')
    expect(message).not.toContain('以它为可靠来源')
  })
})

describe('CollabEnvironmentService.checkWorkOrchestratorSkill', () => {
  let tmpDir: string
  const originalCliPath = process.env.CLAUDE_CLI_PATH

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-collab-env-'))
  })

  afterEach(async () => {
    if (originalCliPath === undefined) delete process.env.CLAUDE_CLI_PATH
    else process.env.CLAUDE_CLI_PATH = originalCliPath
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('detects the skill marker inside a script CLI', async () => {
    const cliFile = path.join(tmpDir, 'cli.js')
    await fs.writeFile(cliFile, `registerBundledSkill({ name: '${WORK_ORCHESTRATOR_SKILL_NAME}' })`, 'utf-8')
    process.env.CLAUDE_CLI_PATH = cliFile

    const service = new CollabEnvironmentService()
    const result = await service.checkWorkOrchestratorSkill({ force: true })

    expect(result).toEqual({ available: true, cliFile })
  })

  test('reports a CLI without the skill marker as missing', async () => {
    const cliFile = path.join(tmpDir, 'cli-old.js')
    await fs.writeFile(cliFile, 'console.log("old cli without collaboration skill")', 'utf-8')
    process.env.CLAUDE_CLI_PATH = cliFile

    const service = new CollabEnvironmentService()
    const result = await service.checkWorkOrchestratorSkill({ force: true })

    expect(result).toMatchObject({ available: false, cliFile })
  })

  test('detects a marker straddling the 4MB scan-chunk boundary', async () => {
    const cliFile = path.join(tmpDir, 'cli-huge.js')
    const boundary = 4 * 1024 * 1024
    const filler = 'A'.repeat(boundary - 8)
    await fs.writeFile(cliFile, `${filler}${WORK_ORCHESTRATOR_SKILL_NAME}`, 'utf-8')
    process.env.CLAUDE_CLI_PATH = cliFile

    const service = new CollabEnvironmentService()
    const result = await service.checkWorkOrchestratorSkill({ force: true })

    expect(result).toMatchObject({ available: true, cliFile })
  })
})

describe('DoctorService collaboration checks', () => {
  test('reports a missing shell and a missing skill as findings with guidance', async () => {
    const service = new DoctorService({
      configDir: await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-doctor-cfg-')),
      collabChecks: {
        checkShell: () => ({
          ok: false,
          hint: 'Git Bash not found. Install Git Bash.',
        }),
        checkSkill: async () => ({ available: false, cliFile: 'C:\\cli\\claude-cli' }),
      },
    })

    const report = await service.getReport()
    const shell = report.items.find((item) => item.id === 'collab-shell')
    const skill = report.items.find((item) => item.id === 'collab-skill')

    expect(shell).toMatchObject({ status: 'missing', kind: 'collab_shell' })
    expect(shell?.error).toContain('Git Bash not found')
    expect(skill).toMatchObject({ status: 'missing', kind: 'collab_skill' })
    expect(skill?.error).toContain('work-orchestrator')
    expect(report.summary.missingCount).toBeGreaterThanOrEqual(2)
  })

  test('treats an external CLI (unverifiable skill) as neutral, not unhealthy', async () => {
    const service = new DoctorService({
      configDir: await fs.mkdtemp(path.join(os.tmpdir(), 'cc-heihei-doctor-cfg2-')),
      collabChecks: {
        checkShell: () => ({ ok: true, bashPath: '/bin/bash' }),
        checkSkill: async () => ({ available: null }),
      },
    })

    const report = await service.getReport()
    const shell = report.items.find((item) => item.id === 'collab-shell')
    const skill = report.items.find((item) => item.id === 'collab-skill')

    expect(shell).toMatchObject({ status: 'ok' })
    expect(skill).toMatchObject({ status: 'not_configured' })
  })
})

describe('collaboration dispatch protocol availability', () => {
  test('the bundled CLI ships the skill source the server checks for', () => {
    // 体检扫描的是 CLI 产物；这里确保源文件与共享协议存在，防止重命名漂移
    const skillSource = fileURLToPath(new URL('../../skills/bundled/workOrchestrator.ts', import.meta.url))
    expect(existsSync(skillSource)).toBe(true)
  })
})
