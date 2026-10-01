/**
 * CLI 启动参数构造（v1.7 结构拆分第②批 · 纯移动）。
 *
 * 搬来的两个函数都是纯函数——只用参数、模块级 import，不碰实例状态。
 * 「同一批里本应一起搬」的两个没搬，理由如下（详见汇报）：
 *
 * · resolveCliArgs：函数体内有 3 处 `import.meta.dir`（win32 分支的 preload /
 *   entrypoints 路径、非 win32 分支的 bin/claude-heihei）。`import.meta.dir`
 *   是**相对当前文件**的，搬到子目录后相对层级会变，也就是运行时取到的路径
 *   会变——这不是纯移动，是行为变化。要搬必须先改 `../../../` 的层数，那是
 *   逻辑改动，得单独开提交（补充裁决五：不改签名消除不了的，一律不搬）。
 * · buildSessionCliArgs：它调用 this.resolveCliArgs(...)，而 resolveCliArgs
 *   搬不走，于是它也只能留下——搬走就必须给 resolveCliArgs 传上下文或改签名。
 *
 * 门面里这两个函数的位置改为同名类字段委托，`this.xxx(...)` 调用点一行未改。
 */

import { isOpenAIOfficialProviderId } from '../openaiOfficialProvider.js'

export type SessionStartOptions = {
  permissionMode?: string
  model?: string
  effort?: string
  thinking?: 'enabled' | 'adaptive' | 'disabled'
  providerId?: string | null
  resumeInterruptedTurn?: boolean
}

export function getPermissionArgs(
  mode: string | undefined,
  dangerousMode: boolean,
  servantNonInteractive = false,
): string[] {
  if (dangerousMode) {
    return ['--dangerously-skip-permissions']
  }

  // v1.6.1（契约 §3.3 第 1 条）：员工会话强制免审批——不管元数据或界面选的是
  // 什么模式。这不是新放宽：员工本来就是 bypass（既定设计），此处只是不让
  // 「权限模式漂移」（登记后未重启、界面上切换）把员工改回会等人的模式。
  // 安全边界仍由约束档位负责（CC_HEIHEI_SERVANT_CONSTRAINT，结构性收权，
  // 不是靠逐次审批）。不设开关：这是收紧既定语义，不是可选项。
  if (servantNonInteractive) {
    return ['--dangerously-skip-permissions']
  }

  const resolvedMode = mode || 'default'
  if (resolvedMode === 'bypassPermissions') {
    return ['--dangerously-skip-permissions']
  }

  const args = [
    '--allow-dangerously-skip-permissions',
    '--permission-mode',
    resolvedMode,
  ]
  return args
}

export function getRuntimeArgs(options: SessionStartOptions | undefined): string[] {
  const args: string[] = []

  if (options?.model) {
    args.push('--model', options.model)
  }

  if (options?.effort && !isOpenAIOfficialProviderId(options.providerId)) {
    args.push('--effort', options.effort)
  }

  if (options?.thinking && !isOpenAIOfficialProviderId(options.providerId)) {
    args.push('--thinking', options.thinking)
  }

  return args
}
