/**
 * 主管协议升级通知 — 一次性触达存量主管会话
 *
 * 履新消息只在首次任命时注入；协议升级后，延续对话的老主管永远收不到
 * 新规则（2026-09-11 实测：v1.0.7 的"默认派活"硬规则被旧上下文压过，
 * 主管依旧自己干活）。服务端启动时对全部已登记主管投递一次协议更新
 * 消息，marker 文件保证跨重启幂等。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { servantService } from './servantService.js'
import { sessionMessenger } from './sessionMessenger.js'
import { ProviderService } from './providerService.js'
import { diagnosticsService } from './diagnosticsService.js'

/** 每次协议硬规则升级时递增版本号即可重触达一轮 */
const PROTOCOL_NOTICE_VERSION = '1'
const NOTICE_MARKER_FILENAME = `supervisor-protocol-notice-v${PROTOCOL_NOTICE_VERSION}.sent`

function noticeMarkerPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'cc-heihei', NOTICE_MARKER_FILENAME)
}

function buildProtocolNotice(): string {
  return [
    '【系统】协作协议已更新（硬规则，请立即遵守并沿用）：',
    '1. 收到任务的第一反应是拆解并派活。「自己动手」只限两种情况：用户明确点名要你亲自做，或没有合适的员工——动手前向用户说明原因。',
    '2. 用户说"你来实施/你直接干"这类模糊指令时，默认理解为"由你安排实施"（派活）；若确需亲自执行，先向用户确认一句。',
    '3. 机制层面：主管会话的文件修改工具（Edit/Write/NotebookEdit）已被结构性收权——越权写入会被直接拒绝并提示派活。派活协议自身需要的写入（.dispatch-payload.json、report-payload.json、.heihei/dispatch/ 信箱）不受影响。',
    '如需亲自执行某项工作，请用户在会话右键「协作设置…」中取消主管身份。',
  ].join('\n')
}

/**
 * 依赖注入缝（v1.3.0 阶段4：替代跨文件不安全的 mock.module，模式同
 * servantIncidentNotifier 的 setServantIncidentDeps）。传 null 恢复默认。
 */
export type SupervisorNoticeDeps = {
  listServants: typeof servantService.listServants
  deliver: (targetSessionId: string, content: string, serverHost: string) => Promise<boolean>
  /** 本机服务端口：用于拼真实投递地址（裁决二十②，禁止再用端口 0 的假值）。 */
  getServerPort: () => number
  recordEvent: (input: {
    type: string
    severity?: 'info' | 'warn' | 'error'
    summary: string
    sessionId?: string
    details?: unknown
  }) => void
}

const defaultDeps: SupervisorNoticeDeps = {
  listServants: (options) => servantService.listServants(options),
  deliver: (targetSessionId, content, serverHost) =>
    sessionMessenger.deliver(targetSessionId, content, serverHost),
  getServerPort: () => ProviderService.getServerPort(),
  recordEvent: (input) => {
    void diagnosticsService.recordEvent(input).catch(() => {})
  },
}

let noticeDeps: SupervisorNoticeDeps = defaultDeps

export function setSupervisorNoticeDeps(overrides: Partial<SupervisorNoticeDeps> | null): void {
  noticeDeps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps
}

export async function notifySupervisorsOfProtocolUpdate(): Promise<void> {
  const markerPath = noticeMarkerPath()
  try {
    await fs.access(markerPath)
    return // 本轮通知已发过
  } catch {
    // marker 不存在 → 投递
  }

  let supervisors: Awaited<ReturnType<SupervisorNoticeDeps['listServants']>> = []
  try {
    const all = await noticeDeps.listServants({ includeAll: true })
    supervisors = all.filter((s) => s.supervisor)
  } catch (error) {
    console.warn(
      `[SupervisorNotice] Failed to list servants: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }
  if (supervisors.length === 0) {
    // 没有主管也写 marker：避免空转判断每轮启动都读花名册后再判断一遍
    await fs.mkdir(path.dirname(markerPath), { recursive: true }).catch(() => {})
    await fs.writeFile(markerPath, new Date().toISOString(), 'utf-8').catch(() => {})
    return
  }

  const notice = buildProtocolNotice()
  // 裁决二十②：走**真实** host（本机服务端口），不再用 '127.0.0.1:0' 这类假值。
  const serverHost = `127.0.0.1:${noticeDeps.getServerPort()}`
  let delivered = 0
  let skipped = 0
  for (const supervisor of supervisors) {
    // 裁决二十①：本通知是「触达存量对话」的运维性通知——**只对正在运行的主管投递**。
    // 为发一条通知把没运行的主管拉起来，即便地址为真也是错的（凭空创建会话 + 烧 token）。
    // 可达性损失可接受（协议文档才是真源）；跳过者记诊断，不做静默。
    if (!supervisor.running) {
      skipped++
      noticeDeps.recordEvent({
        type: 'supervisor_protocol_notice_skipped',
        severity: 'info',
        summary: '主管会话未运行，跳过协议更新通知（不代为拉起）',
        sessionId: supervisor.sessionId,
        details: { sessionId: supervisor.sessionId, reason: 'not-running' },
      })
      continue
    }
    try {
      const ok = await noticeDeps.deliver(supervisor.sessionId, notice, serverHost)
      if (ok) delivered++
    } catch (error) {
      console.warn(
        `[SupervisorNotice] Failed to notify ${supervisor.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  console.log(
    `[SupervisorNotice] Protocol update notified to ${delivered}/${supervisors.length} supervisor(s)` +
      (skipped > 0 ? `, skipped ${skipped} not-running` : ''),
  )

  await fs.mkdir(path.dirname(markerPath), { recursive: true }).catch(() => {})
  await fs.writeFile(markerPath, new Date().toISOString(), 'utf-8').catch(() => {})
}
