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
