/**
 * Claude Code 桌面端合并 sidecar 入口。
 *
 * 历史上 server / cli / IM adapters 是各自独立的进程。每个 bun-compile
 * 二进制都要带一份 ~55MB 的 bun runtime，光这一项就重复占了 100MB+。
 * 把运行模式合并到同一个二进制里，runtime 只保留一份；调用方通过
 * 第一个 positional 参数选择模式：
 *
 *   claude-sidecar server   --app-root <path> --host 127.0.0.1 --port 12345
 *   claude-sidecar cli      --app-root <path> [其它 CLI 参数...]
 *
 * （IM adapters 模式已随 v1.5.0 C10 移除外部 IM 适配器一并删除。）
 *
 * 任何模式都必须先做 process.env / process.argv 设置，再 await 进入相应的
 * 子模块树。原因：src/server/index.ts、src/entrypoints/cli.tsx 顶层都会
 * 立即读 process.argv / process.env，必须在它们求值前 splice 掉
 * --app-root、mode 这些 launcher-only 参数。
 */

import { parseLauncherArgs, resolveSidecarInvocation } from './launcherRouting'

const rawArgs = process.argv.slice(2)
const invocation = resolveSidecarInvocation(rawArgs)
if (!invocation.mode) {
  console.error('claude-sidecar: missing mode argument (expected "server" or "cli")')
  process.exit(2)
}
const mode = invocation.mode
const restArgs = invocation.restArgs

const { appRoot, args } = parseLauncherArgs(restArgs, invocation.defaultAppRoot)

process.env.CLAUDE_APP_ROOT = appRoot
process.env.CALLER_DIR ||= process.cwd()
process.argv = [process.argv[0]!, process.argv[1]!, ...args]

await import('../../preload.ts')

if (mode === 'server') {
  console.log(`[claude-sidecar] starting server mode (${process.platform}/${process.arch})`)
  const { startServer } = await import('../../src/server/index.ts')
  startServer()
} else if (mode === 'cli') {
  await import('../../src/entrypoints/cli.tsx')
} else {
  console.error(`claude-sidecar: unknown mode "${mode}" (expected "server" or "cli")`)
  process.exit(2)
}
