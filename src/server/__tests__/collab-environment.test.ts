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
describe('v1.4.0 P1-B protocol & pocket-card copy contract', () => {
  test('protocol: success criterion is messageId, not exit code; curl carries --max-time', () => {
    expect(DISPATCH_PROTOCOL_MD).toContain('--max-time')
    expect(DISPATCH_PROTOCOL_MD).toContain('成功判据 = 响应体含')
    expect(DISPATCH_PROTOCOL_MD).toContain('禁止把 rm 与 curl')
    // 危险模式根除：协议全文不得再出现「curl … && rm」连用（退出码 0 也可能失败）
    expect(DISPATCH_PROTOCOL_MD).not.toMatch(/curl[^\n`]*&&\s*rm/)
  })

  test('protocol: stale-env self-heal points to desktop-server.json with pid-liveness rule and whoami', () => {
    expect(DISPATCH_PROTOCOL_MD).toContain('~/.claude/cc-heihei/desktop-server.json')
    expect(DISPATCH_PROTOCOL_MD).toContain('先校验 `pid` 存活再信 `port`')
    expect(DISPATCH_PROTOCOL_MD).toContain('/api/whoami')
    // 旧状态文件路径已被阶段1-A 新契约取代，协议里不得再指路旧文件
    expect(DISPATCH_PROTOCOL_MD).not.toContain('desktop-server-state.json')
  })

  test('protocol: dispatch template carries an explicit server address instead of relying on worker env', () => {
    // 员工汇报命令的地址占位必须显式（主管写入），不得再指向员工自身 env
    expect(DISPATCH_PROTOCOL_MD).toContain('<当前服务地址>')
    expect(DISPATCH_PROTOCOL_MD).toContain('服务地址来源优先级')
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
    // 旧文案主动宣称 env 地址可靠——正是误导根源，必须消失
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
