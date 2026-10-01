#!/usr/bin/env bun
/**
 * 关键路径冒烟脚本（v1.7.0 结构拆分批次验收用）
 * =================================================
 * 用途：每个「结构拆分批次」在验收前，于**隔离实例**上跑一遍关键路径，确认拆分没有破坏主链路。
 *       脚本自带断言与退出码：全部通过 → exit 0；任一失败 → exit 1 并打印可定位证据。
 *
 * 前置条件
 *   - 在仓库根目录执行：`bun run scripts/smoke-critical-paths.ts`
 *   - 需要本机装有 bun；仓库依赖已安装（用到 src/server/index.ts 与 mock CLI fixture）
 *   - 不依赖用户正在运行的桌面实例；**不会**写入用户 ~/.claude/cc-heihei/desktop-server.json
 *
 * 隔离方式
 *   - 独立临时目录（HOME/USERPROFILE、CLAUDE_CONFIG_DIR、工作目录都在 %TEMP% 下自建）
 *   - 端口自动分配（--port 0）；NODE_ENV=test 使服务端跳过端口文件落盘（服务端既有约定）
 *   - CLI 用仓库内 mock（src/server/__tests__/fixtures/mock-sdk-cli.ts），不消耗真实模型额度
 *   - 结束即杀子进程并删除临时目录；脚本还会对比用户端口文件 md5，证明未写入
 *
 * 覆盖路径
 *   1 新建会话  2 发消息+流式输出  3 中断(interrupt)  4 会话复用(resume 语义)
 *   5 协作闭环(派活→汇报→验收)     6 花名册读取       7 设置读写往返
 *
 * 已知边界（不蒙混）
 *   - 仓库没有 HTTP resume 端点，resume 语义用「同一会话再次回合」替代（真实桌面里的 /resume 走 CLI 子进程参数）
 *   - 流式输出来自 mock CLI 的流事件（content_start/content_delta/message_complete），不是真实模型流；链路与解析路径一致
 *
 * 失败取证
 *   - 每个失败步骤打印 detail；同时打印服务端日志尾部（含报错行）
 *   - 如需保留现场：加 `--keep` 运行，脚本会打印临时目录路径并不删除
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.argv.includes('--keep')
const CLI_FIXTURE = join(REPO, 'src/server/__tests__/fixtures/mock-sdk-cli.ts')
const USER_PORT_FILE = join(process.env.USERPROFILE ?? '', '.claude', 'cc-heihei', 'desktop-server.json')

type Step = { name: string; ok: boolean; detail: string }
const steps: Step[] = []
const record = (name: string, ok: boolean, detail: string) => {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const md5 = (p: string) => (existsSync(p) ? createHash('md5').update(readFileSync(p)).digest('hex') : 'absent')

const root = mkdtempSync(join(tmpdir(), 'cc-heihei-smoke-'))
const home = join(root, 'home')
const cfg = join(root, 'cfg')
const work = join(root, 'work')
for (const d of [home, cfg, work]) rmSync(d, { recursive: true, force: true })
const mkdir = (d: string) => spawnSync('cmd', ['/c', 'mkdir', d.replace(/\//g, '\\')], { stdio: 'ignore' })
mkdir(home); mkdir(cfg); mkdir(work)

const launcher = join(root, 'launch.ts')
writeFileSync(launcher, `const m = await import(${JSON.stringify(join(REPO, 'src/server/index.js'))})\nconst s = m.startServer(0, '127.0.0.1')\nconsole.log('SMOKE_PORT=' + s.port)\n`)

const userPortBefore = md5(USER_PORT_FILE)
let log = ''
const child = spawn('bun', ['run', launcher], {
  cwd: REPO,
  env: {
    ...process.env,
    USERPROFILE: home, HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    CC_HEIHEI_SKIP_DOTENV: '1',
    NODE_ENV: 'test', // 服务端据此跳过端口文件落盘
    CC_HEIHEI_WORK_DIR: work,
    CLAUDE_CLI_PATH: CLI_FIXTURE,
    MOCK_SDK_STREAM_DELAY_MS: '600', // 让流式可见、也留出中断窗口
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout!.on('data', (b) => { log += String(b) })
child.stderr!.on('data', (b) => { log += String(b) })

const removeWithRetry = (dir: string, attempts = 8) => {
  for (let i = 0; i < attempts; i += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return true } catch { spawnSync('cmd', ['/c', 'ping', '-n', '1', '-w', '400', '127.0.0.1'], { stdio: 'ignore' }) }
  }
  return false
}
const cleanup = () => {
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
  if (KEEP) { console.log('现场保留在：' + root); return }
  const removed = removeWithRetry(root)
  if (!removed) console.log('提示：临时目录暂被占用，未删除成功（Windows 文件锁），路径：' + root)
}
const die = (why: string) => {
  console.error(`\n冒烟中止：${why}\n--- 服务端日志尾部 ---\n${log.split('\n').slice(-15).join('\n')}`)
  cleanup()
  process.exit(1)
}

async function waitForPort(): Promise<number> {
  const t0 = Date.now()
  while (Date.now() - t0 < 40_000) {
    const m = log.match(/SMOKE_PORT=(\d+)/)
    if (m) return Number(m[1])
    await new Promise((r) => setTimeout(r, 200))
  }
  die('服务端 40s 内未就绪（见下方日志）')
  throw new Error('unreachable')
}

const j = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init)
  const text = await res.text()
  let body: unknown = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}
const post = (url: string, body: unknown) =>
  j(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const put = (url: string, body: unknown) =>
  j(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** 在会话上跑一个回合：返回收到的事件类型序列 */
async function turn(base: string, sessionId: string, text: string, timeoutMs = 30_000): Promise<string[]> {
  return await new Promise((resolvePromise, reject) => {
    const seen: string[] = []
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${sessionId}`)
    const timer = setTimeout(() => { reject(new Error('回合超时：' + seen.join(','))); try { ws.close() } catch {} }, timeoutMs)
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { type?: string }
      if (m.type) seen.push(m.type)
      if (m.type === 'connected') ws.send(JSON.stringify({ type: 'user_message', content: text }))
      if (m.type === 'message_complete') { clearTimeout(timer); try { ws.close() } catch {}; resolvePromise(seen) }
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS 错误：' + seen.join(','))) }
  })
}

async function main() {
  const port = await waitForPort()
  const base = `http://127.0.0.1:${port}`
  console.log(`隔离实例就绪：${base}（临时目录 ${root}）\n`)

  // 1) 新建会话
  const s1 = await post(`${base}/api/sessions`, { workDir: work })
  const sid = (s1.body as { sessionId?: string }).sessionId
  record('1 新建会话', (s1.status === 200 || s1.status === 201) && Boolean(sid), `HTTP ${s1.status} sessionId=${(sid ?? '').slice(0, 8)}`)
  if (!sid) die('新建会话失败，后续步骤无法继续')

  // 2) 发消息 + 流式输出
  try {
    const events = await turn(base, sid, '冒烟：流式输出检查')
    const streamed = events.some((t) => t === 'content_delta' || t === 'content_start')
    record('2 发消息+流式输出', streamed && events.includes('message_complete'), `事件序列=${events.slice(0, 8).join(',')}`)
  } catch (error) {
    record('2 发消息+流式输出', false, String(error))
  }

  // 3) 中断：先发起一个回合（不等待完成），在流进行中调用 interrupt
  const turnStarted = (async () => {
    try { await turn(base, sid, '冒烟：中断检查用长回合', 20_000) } catch { /* 被中断或超时都算预期内 */ }
  })()
  await new Promise((r) => setTimeout(r, 250)) // 让流先跑起来
  const int = await post(`${base}/api/sessions/${sid}/interrupt`, {})
  const intOk = int.status === 200 && typeof (int.body as { ok?: unknown }).ok === 'boolean'
  await turnStarted
  record('3 中断(interrupt)', intOk, `HTTP ${int.status} body=${JSON.stringify(int.body).slice(0, 100)}`)

  // 4) 会话复用（resume 语义：同会话再次回合）
  try {
    const again = await turn(base, sid, '冒烟：复用会话再来一回合')
    record('4 会话复用(resume 语义)', again.includes('message_complete'), `事件序列=${again.slice(0, 6).join(',')}`)
  } catch (error) {
    record('4 会话复用(resume 语义)', false, String(error))
  }

  // 5) 协作闭环：派活 → 汇报 → 验收
  const sup = (await post(`${base}/api/sessions`, { workDir: work })).body as { sessionId?: string }
  const wk = (await post(`${base}/api/sessions`, { workDir: work })).body as { sessionId?: string }
  await put(`${base}/api/servant-sessions/${sup.sessionId}`, { role: '主管', description: '冒烟', enabled: true, supervisor: true })
  await put(`${base}/api/servant-sessions/${wk.sessionId}`, { role: '测试', description: '冒烟', enabled: true })
  const disp = await post(`${base}/api/session-messages`, {
    targetSessionId: wk.sessionId, fromSessionId: sup.sessionId, content: '冒烟派活正文', title: '冒烟任务',
  })
  const taskId = (disp.body as { taskId?: string }).taskId
  if (!taskId) {
    record('5 协作闭环', false, `派活未返回 taskId：HTTP ${disp.status}`)
  } else {
    try { await turn(base, wk.sessionId!, '冒烟：员工开工') } catch { /* 状态推进失败会在下面体现 */ }
    const rep = await post(`${base}/api/collab-tasks/${taskId}/report`, { callerSessionId: wk.sessionId, summary: '冒烟汇报', deliverables: ['smoke.txt'] })
    const rev = await post(`${base}/api/collab-tasks/${taskId}/review`, { verdict: 'pass', callerSessionId: sup.sessionId })
    const task = (await j(`${base}/api/collab-tasks/${taskId}`)).body as { task?: { status?: string } }
    record('5 协作闭环', rep.status === 200 && rev.status === 200 && task.task?.status === 'verified',
      `report=${rep.status} review=${rev.status} 终态=${task.task?.status} taskId=${taskId.slice(0, 8)}`)
  }

  // 6) 花名册读取
  const roster = await j(`${base}/api/servant-sessions?all=1`)
  const servants = (roster.body as { servants?: Array<{ sessionId: string }> }).servants ?? []
  const hasBoth = servants.some((s) => s.sessionId === sup.sessionId) && servants.some((s) => s.sessionId === wk.sessionId)
  record('6 花名册读取', roster.status === 200 && hasBoth, `HTTP ${roster.status} 条目=${servants.length}`)

  // 7) 设置读写往返（改一个已有标量键再还原）
  const readUser = async () => {
    const body = (await j(`${base}/api/settings/user`)).body as { settings?: Record<string, unknown> } | Record<string, unknown>
    return (((body as { settings?: Record<string, unknown> }).settings ?? body) as Record<string, unknown>) ?? {}
  }
  const original = await readUser()
  const probeKey = '__smoke_probe__'
  const probeValue = `smoke-${Date.now()}`
  await put(`${base}/api/settings/user`, { settings: { ...original, [probeKey]: probeValue } })
  const written = (await readUser())[probeKey]
  await put(`${base}/api/settings/user`, { settings: original }) // 还原
  const restored = (await readUser())[probeKey]
  record('7 设置读写往返', written === probeValue && restored === undefined,
    `写入读回=${JSON.stringify(written)} 还原后残留=${JSON.stringify(restored)}（原键数=${Object.keys(original).length}）`)

  // 隔离性证明：用户端口文件未被写入
  const userPortAfter = md5(USER_PORT_FILE)
  record('隔离性：未写用户端口文件', userPortAfter === userPortBefore, `before=${userPortBefore.slice(0, 8)} after=${userPortAfter.slice(0, 8)}`)
}

try {
  await main()
} catch (error) {
  record('脚本执行异常', false, String(error))
}

const failed = steps.filter((s) => !s.ok)
console.log(`\n===== 冒烟摘要：${steps.length - failed.length}/${steps.length} 通过 =====`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
  console.log('--- 服务端日志尾部（取证用）---')
  console.log(log.split('\n').slice(-25).join('\n'))
}
cleanup()
process.exit(failed.length ? 1 : 0)
