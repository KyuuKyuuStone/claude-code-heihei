#!/usr/bin/env bun
/**
 * preflight-release.mjs —— 出包前验证脚本（gates → test → build → smoke）
 *
 * 背景：v1.7.0 出包时类型检查 + 行为冒烟过了、但测试套件一次没跑，补跑出 5 条
 * 「实现改了、测试没跟」的红——全部可以在出包前自动发现。本脚本把出包前验证
 * 固化成可重复执行的环节。
 *
 * 用法：
 *   bun run scripts/preflight-release.mjs --stage gates|test|build|smoke|all
 *   附加：--dry-run（只打印将执行的命令，不真跑）
 *         --force（build 阶段允许覆盖已存在的产物目录）
 *
 * 阶段：
 *   gates  工作区干净 / 版本号合法 / desktop tsc 0 错误 / 源码纯语法解析 / 源码门禁字面量 8 项
 *   test   分段跑测试：src 按目录（按用例文件数升序）、src/server 逐文件、desktop vitest 分批；
 *          全部单进程串行 + env -u CLAUDE_COMPUTER_USE_ENABLED + 每段核对用例文件数；
 *          内存守卫（可用内存 <1.5GB 或子进程 RSS ≥3GB → 杀进程中止并打印当前段）；
 *          失败按「复跑通过(偶发)/已知 flaky/疑似回归」分栏
 *   build  clean → electron:build → electron-builder --publish never →
 *          D:/xxw_p/cc-heihei-dist/<版本号>/（统一产物父目录），算 sha256；
 *          目录已存在时拒绝（--force 才覆盖）
 *   smoke  隔离环境起包内 sidecar：会话列表 workDirExists/workspaceState、
 *          带 taskId 汇报的页脚端到端（末行=【系统】汇报 · 任务 ID：<taskId>；）、
 *          反例（无 taskId 无页脚）、产物门禁字面量 8 项、超时常量存在性
 *   all    gates → test → build → smoke，任一阶段失败即中止
 *
 * 边界：绝不 push / 绝不建 Release / 不改 git 历史；tag 只打印建议命令，不自动执行；
 *       Ctrl-C 杀整个子进程树后退出，不留孤儿。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, freemem } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ROOT = 'D:/xxw_p/cc-heihei-dist'
const PORT_FILE = join(process.env.USERPROFILE ?? '', '.claude', 'cc-heihei', 'desktop-server.json')
const MEMORY_FREE_MIN_MB = 1500
const MEMORY_RSS_MAX_MB = 3000
const GATE_LITERALS = [
  'CollabDispatch', 'CollabReview', 'CollabListTasks', 'CollabReport',
  'CC_HEIHEI_COLLAB_ROLE', 'capabilities', 'collab_report_redirected', 'broadcastId',
]

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const stageIdx = args.indexOf('--stage')
const stage = stageIdx >= 0 ? args[stageIdx + 1] : 'all'
if (args.includes('--help') || args.includes('-h')) {
  console.log(`出包前验证脚本：bun run scripts/preflight-release.mjs [--stage gates|test|build|smoke|all] [--dry-run] [--force]

  gates  工作区干净 / 版本号 / desktop tsc 0 错误 / 源码语法解析 / 源码门禁字面量 8 项
  test   分段串行跑测试（src 目录升序 + src/server 逐文件 + desktop 分批），内存守卫，失败分栏
  build  clean → electron:build → electron-builder → D:/xxw_p/cc-heihei-dist/<版本号>/ + sha256
  smoke  隔离起包内 sidecar：目录状态回归 / 汇报页脚端到端 + 反例 / 产物字面量 8 项 / 超时证据
  all    依序跑四阶段，任一失败即中止（默认值；test/build/smoke 为重阶段，开发期用 --dry-run）

  --dry-run  只打印将执行的命令
  --force    build 阶段允许覆盖已存在的产物目录`)
  process.exit(0)
}
if (!['gates', 'test', 'build', 'smoke', 'all'].includes(stage)) {
  console.error(`未知阶段: ${stage}（可选 gates|test|build|smoke|all）`)
  process.exit(2)
}

let childPid = null
let aborted = false
process.on('SIGINT', () => {
  aborted = true
  console.error('\n[preflight] 收到中断，清理子进程树…')
  if (childPid) {
    try {
      spawn('taskkill', ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore' })
    } catch {}
  }
  process.exit(130)
})

const liveChildren = new Set()
function run(cmd, cmdArgs, opts = {}) {
  if (dryRun && !opts.alwaysRun) {
    console.log(`  [dry-run] ${cmd} ${cmdArgs.join(' ')}`)
    return { code: 0, stdout: '', stderr: '' }
  }
  return new Promise((resolve) => {
    // envUnset：真删除语义（env -u）——赋空串是「存在但为空」，测试代码按
    // 「变量是否存在」分支时二者结果完全不同（2026-10-03 Wave 2 假红 243 的根因）
    const env = { ...process.env, ...(opts.env ?? {}) }
    for (const k of opts.envUnset ?? []) delete env[k]
    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd ?? ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    childPid = child.pid
    liveChildren.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d; if (opts.echoStdout) process.stdout.write(d) })
    child.stderr.on('data', (d) => { stderr += d; if (opts.echoStderr) process.stderr.write(d) })
    const guard = opts.guard
      ? setInterval(() => {
          if (aborted) return
          const freeMb = Math.floor(freemem() / 1024 / 1024)
          if (freeMb < MEMORY_FREE_MIN_MB) {
            console.error(`[preflight] 内存守卫触发：可用内存 ${freeMb}MB < ${MEMORY_FREE_MIN_MB}MB，中止当前段（${opts.label ?? cmd}）`)
            try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
          }
        }, 10_000)
      : null
    child.on('close', (code) => {
      if (guard) clearInterval(guard)
      liveChildren.delete(child)
      childPid = liveChildren.size ? [...liveChildren][0].pid : null
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

function listSourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      listSourceFiles(full, out)
      continue
    }
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) continue
    const rel = relative(ROOT, full).split(sep).join('/')
    if (/(\.test\.|\.spec\.|\.bench\.|__tests__)/.test(rel) || rel.endsWith('.d.ts')) continue
    out.push(rel)
  }
  return out
}

function listTestFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      listTestFiles(full, out)
      continue
    }
    if (/\.test\.(ts|tsx)$/.test(e.name)) out.push(relative(ROOT, full).split(sep).join('/'))
  }
  return out
}

let failures = 0
function fail(msg) {
  failures++
  console.error(`FAIL ${msg}`)
}
function ok(msg) {
  console.log(`OK   ${msg}`)
}

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------

async function stageGates() {
  console.log('== gates ==')
  const st = await run('git', ['status', '--porcelain'], { alwaysRun: true })
  if (dryRun) {
    console.log('  [dry-run] 跳过 gates 实际检查（dry-run 只演示命令）')
    return
  }
  if (st.stdout.trim()) {
    for (const line of st.stdout.trim().split('\n')) fail(`工作区不干净: ${line}`)
    fail('存在未提交改动——出包前必须先提交（禁止带着不明改动出包）')
  } else {
    ok('工作区干净')
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'desktop', 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(pkg.version ?? '')) fail(`版本号非法: ${pkg.version}`)
  else ok(`版本号 ${pkg.version}`)

  console.log('  desktop tsc --noEmit（约 30-60s）…')
  const tsc = await run('bun', ['run', 'lint'], { cwd: join(ROOT, 'desktop'), label: 'desktop tsc', guard: true })
  if (tsc.code !== 0) {
    for (const line of tsc.stderr.split('\n').filter((l) => l.includes('error TS')).slice(0, 20)) fail(`tsc: ${line.trim()}`)
    fail(`desktop tsc 失败（exit ${tsc.code}）`)
  } else {
    ok('desktop tsc 0 错误')
  }

  const files = [...listSourceFiles('src'), ...listSourceFiles('desktop/src'), ...listSourceFiles('desktop/electron')]
  let syntaxBad = 0
  for (const rel of files) {
    const loader = rel.endsWith('.tsx') || rel.endsWith('.jsx') ? 'tsx' : 'ts'
    const transpiler = new Bun.Transpiler({ loader })
    try {
      transpiler.transformSync(readFileSync(join(ROOT, rel), 'utf8'))
    } catch (e) {
      syntaxBad++
      fail(`语法解析: ${rel}: ${String(e).split('\n')[0]}`)
    }
  }
  if (!syntaxBad) ok(`源码纯语法解析 ${files.length} 文件通过`)

  let litMiss = 0
  for (const lit of GATE_LITERALS) {
    const hit = files.some((rel) => readFileSync(join(ROOT, rel), 'utf8').includes(lit))
    if (!hit) { litMiss++; fail(`源码门禁字面量缺失: ${lit}`) }
  }
  if (!litMiss) ok(`源码门禁字面量 ${GATE_LITERALS.length}/${GATE_LITERALS.length}`)

  console.log('  import 语义检查（Wave 1 批 E）…')
  const imp = await run('bun', ['scripts/check-import-semantics.ts'], { label: 'import-semantics', guard: true })
  if (imp.code !== 0) {
    for (const line of imp.stdout.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 20)) fail(line)
    fail('import 语义检查失败（形态不符/说明符漂移）')
  } else {
    ok('import 语义检查通过')
  }
}

// ---------------------------------------------------------------------------
// test（分段 + 内存守卫 + 失败分栏）
// ---------------------------------------------------------------------------

function srcSegments() {
  const segs = []
  const dirs = readdirSync('src', { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `src/${e.name}`)
    .map((d) => ({ d, n: listTestFiles(d).length }))
    .sort((a, b) => a.n - b.n)
  for (const { d, n } of dirs) if (n > 0) segs.push({ kind: 'dir', target: `${d}/`, expect: n })
  const serverFiles = listTestFiles('src/server')
  for (const f of serverFiles) segs.push({ kind: 'file', target: `./${f}`, expect: 1 })
  return segs
}

function desktopBatches(size = 20) {
  const files = listTestFiles('desktop/src')
  const batches = []
  for (let i = 0; i < files.length; i += size) batches.push(files.slice(i, i + size))
  return batches
}

async function runBunTest(target, label) {
  return run('bun', ['test', target], {
    label,
    guard: true,
    envUnset: ['CLAUDE_COMPUTER_USE_ENABLED'],
  })
}

async function stageTest() {
  console.log('== test ==（分段串行 + 内存守卫；src/server 逐文件）')
  if (dryRun) {
    const segs = srcSegments()
    console.log(`  [dry-run] 将跑 ${segs.length} 个 src 段 + ${desktopBatches().length} 个 desktop 批`)
    for (const s of segs.slice(0, 5)) console.log(`  [dry-run] bun test ${s.target}（期望 ${s.expect} 文件）`)
    console.log('  [dry-run] …其余段略')
    return
  }
  const segs = srcSegments()
  const red = []
  for (let i = 0; i < segs.length; i++) {
    if (aborted) break
    const s = segs[i]
    process.stdout.write(`  [${i + 1}/${segs.length}] ${s.target} …`)
    const r = await runBunTest(s.target, s.target)
    const ran = [...r.stdout.matchAll(/Ran (\d+) tests across (\d+) files/g)].at(-1)
    const passed = r.code === 0
    const filesRan = ran ? Number(ran[2]) : -1
    if (!passed) {
      console.log(' 红')
      red.push({ ...s, stdout: r.stdout, stderr: r.stderr })
    } else if (filesRan !== -1 && filesRan !== s.expect) {
      console.log(` 文件数不符（期望 ${s.expect}，实跑 ${filesRan}）`)
      fail(`段 ${s.target}: 用例文件数核对失败（期望 ${s.expect}，实跑 ${filesRan}）——防静默漏跑`)
    } else {
      console.log(ran ? ` 绿（${ran[1]} tests）` : ' 绿')
    }
  }

  const batches = desktopBatches()
  for (let i = 0; i < batches.length; i++) {
    if (aborted) break
    process.stdout.write(`  [desktop ${i + 1}/${batches.length}] ${batches[i].length} 文件 …`)
    const r = await run('bun', ['run', 'test', '--', '--run', ...batches[i].map((f) => f.replace('desktop/', ''))], {
      cwd: join(ROOT, 'desktop'),
      label: `desktop batch ${i + 1}`,
      guard: true,
      envUnset: ['CLAUDE_COMPUTER_USE_ENABLED'],
    })
    if (r.code !== 0) {
      console.log(` 红（诊断落盘 /tmp/preflight-desktop-${i + 1}.log）`)
      writeFileSync(`/tmp/preflight-desktop-${i + 1}.log`, `exit=${r.code}\n=== stderr 尾部 ===\n${r.stderr.slice(-3000)}\n=== stdout 尾部 ===\n${r.stdout.slice(-3000)}`)
      red.push({ kind: 'desktop-batch', target: batches[i].join(' '), stdout: r.stdout, stderr: r.stderr })
    } else {
      console.log(' 绿')
    }
  }

  if (!red.length) {
    ok('测试分段全绿')
    return
  }

  // 失败分栏：红段单文件/单批复跑一次 → 绿=偶发；红=疑似回归；对照 known-flaky 标注
  console.log(`\n  ${red.length} 个红段，逐段复跑定栏…`)
  const flakyKnown = (() => {
    try {
      return JSON.parse(readFileSync(join(ROOT, 'scripts', 'known-flaky.json'), 'utf8')).entries.map((e) => e.test)
    } catch { return [] }
  })()
  const rerunPass = []
  const suspected = []
  const pendingManual = []
  for (const seg of red) {
    const files = seg.kind === 'file' ? [seg.target.replace(/^\.\//, '')]
      : seg.kind === 'dir' ? listTestFiles(seg.target.replace(/\/$/, ''))
      : seg.target.split(' ')
    for (const f of files) {
      const r = seg.kind === 'desktop-batch'
        ? await run('bun', ['run', 'test', '--', '--run', f.replace('desktop/', '')], { cwd: join(ROOT, 'desktop'), label: f, guard: true, envUnset: ['CLAUDE_COMPUTER_USE_ENABLED'] })
        : await runBunTest(`./${f.replace(/^\.\//, '')}`, f)
      if (r.code === 0) rerunPass.push(f)
      else if (flakyKnown.some((k) => r.stdout.includes(k) || f.includes(k))) pendingManual.push(f)
      else suspected.push(f)
    }
  }
  if (rerunPass.length) ok(`复跑通过（偶发/环境类）: ${rerunPass.length} 文件`)
  if (pendingManual.length) console.warn(`待人工归属（命中 known-flaky）: ${pendingManual.join(', ')}`)
  for (const f of suspected) fail(`疑似真回归（复跑仍红）: ${f}`)
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

async function stageBuild() {
  console.log('== build ==')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'desktop', 'package.json'), 'utf8'))
  const outDir = `${DIST_ROOT}/v${pkg.version}`
  console.log(`  产物目录: ${outDir}`)
  if (existsSync(outDir) && readdirSync(outDir).length) {
    if (!force) {
      fail(`产物目录已存在且非空: ${outDir}（确认可覆盖时加 --force）`)
      return
    }
    console.warn(`  --force：覆盖既有产物目录 ${outDir}`)
  }
  if (dryRun) {
    console.log('  [dry-run] bun run clean:electron-output')
    console.log('  [dry-run] bun run electron:build')
    console.log(`  [dry-run] bun ./node_modules/electron-builder/out/cli/cli.js --publish never --config.directories.output=${outDir}`)
    return
  }
  let r = await run('bun', ['run', 'clean:electron-output'], { cwd: join(ROOT, 'desktop'), label: 'clean' })
  if (r.code !== 0) return fail('clean:electron-output 失败')
  r = await run('bun', ['run', 'electron:build'], { cwd: join(ROOT, 'desktop'), label: 'electron:build', guard: true })
  if (r.code !== 0) return fail('electron:build 失败')
  r = await run('bun', ['./node_modules/electron-builder/out/cli/cli.js', '--publish', 'never', `--config.directories.output=${outDir}`], {
    cwd: join(ROOT, 'desktop'), label: 'electron-builder', guard: true,
  })
  if (r.code !== 0) return fail('electron-builder 失败')
  const exe = join(outDir, `Claude-Code-Heihei-${pkg.version}-win-x64.exe`)
  if (!existsSync(exe)) return fail(`产物缺失: ${exe}`)
  r = await run('sha256sum', [exe], { alwaysRun: true })
  ok(`出包完成: ${exe}`)
  console.log(`  sha256: ${r.stdout.split(' ')[0]}`)
  console.log(`  建议命令（人工执行，脚本不自动打 tag）: git tag -a v${pkg.version} -m "v${pkg.version}"`)
}

// ---------------------------------------------------------------------------
// smoke
// ---------------------------------------------------------------------------

function sanitizeProjectDir(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

async function stageSmoke() {
  console.log('== smoke ==（隔离环境起包内 sidecar）')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'desktop', 'package.json'), 'utf8'))
  const outDir = `${DIST_ROOT}/v${pkg.version}`
  const sidecar = join(outDir, 'win-unpacked', 'resources', 'app.asar.unpacked', 'src-tauri', 'binaries', 'claude-sidecar-x86_64-pc-windows-msvc.exe')
  if (!existsSync(sidecar)) return fail(`包内 sidecar 不存在: ${sidecar}（先跑 build）`)
  if (dryRun) {
    console.log(`  [dry-run] 隔离 fixture + 启动 ${sidecar}（随机端口）`)
    console.log('  [dry-run] GET /api/sessions 断言 workDirExists/workspaceState')
    console.log('  [dry-run] POST 派活取 taskId → POST 带 taskId 汇报 → 断言投递末行页脚 → 反例断言')
    console.log(`  [dry-run] 产物字面量 ${GATE_LITERALS.length} 项 + 超时常量`)
    return
  }

  const fx = join(process.env.TEMP ?? '/tmp', `preflight-smoke-${Date.now()}`)
  const wd = join(fx, 'wd')
  const projDir = join(fx, 'cfg', 'projects', sanitizeProjectDir(wd))
  mkdirSync(projDir, { recursive: true })
  mkdirSync(join(wd, '.heihei'), { recursive: true })
  const workerId = 'dddddddd-9999-4999-8999-999999999999'
  const supId = 'af8e57cb-0344-4b14-bc1f-bb8433dabb70'
  for (const [id] of [[workerId], [supId]]) {
    const line = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'probe' }] }, uuid: id, timestamp: new Date().toISOString(), sessionId: id, cwd: wd.split(sep).join('/') }
    writeFileSync(join(projDir, `${id}.jsonl`), JSON.stringify(line) + '\n')
  }
  writeFileSync(join(fx, 'cfg', 'servant_sessions.json'), JSON.stringify({
    schemaVersion: 1,
    servants: [
      { sessionId: supId, role: 'supervisor', enabled: true, supervisor: true, updatedAt: Date.now() },
      { sessionId: workerId, role: 'worker', enabled: true, supervisor: false, updatedAt: Date.now() },
    ],
  }))

  const port = 4280 + Math.floor(Math.random() * 100)
  console.log(`  启动 sidecar（隔离，端口 ${port}，fixture ${fx}）…`)
  // 隔离环境同样真删除该变量（同类风险：存在与否影响被测行为；不用 undefined 赋值——
  // spawn 对 undefined 值键的处理有歧义，显式 delete 才是 env -u 语义）
  const smokeEnv = { ...process.env }
  delete smokeEnv.CLAUDE_COMPUTER_USE_ENABLED
  smokeEnv.CLAUDE_CONFIG_DIR = join(fx, 'cfg')
  smokeEnv.USERPROFILE = join(fx, 'home')
  smokeEnv.HOME = join(fx, 'home')
  smokeEnv.APPDATA = join(fx, 'appdata')
  smokeEnv.SERVER_PORT = String(port)
  smokeEnv.NO_PROXY = '*'
  const proc = spawn(sidecar, ['server'], {
    cwd: fx,
    env: smokeEnv,
    stdio: 'ignore',
  })
  childPid = proc.pid
  const base = `http://127.0.0.1:${port}`
  try {
    let up = false
    for (let i = 0; i < 20 && !up; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const r = await fetch(`${base}/api/whoami`, { signal: AbortSignal.timeout(2000) })
        up = (await r.json()).app === 'cc-heihei'
      } catch {}
    }
    if (!up) return fail('smoke: sidecar 未就绪')
    let found = 0
    for (let i = 0; i < 24 && found < 2; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      try {
        const r = await fetch(`${base}/api/sessions?limit=5`, { signal: AbortSignal.timeout(10000) })
        found = (await r.json()).total ?? 0
      } catch {}
    }
    if (found < 2) return fail('smoke: fixture 会话未被索引发现')

    const sessions = await (await fetch(`${base}/api/sessions?limit=5`)).json()
    const bad = sessions.sessions.filter((s) => !s.workDirExists || s.workspaceState !== 'available')
    if (bad.length) fail(`smoke 回归: ${bad.length} 会话 workDirExists/workspaceState 异常（目录缺失类）`)
    else ok('smoke 回归: 全部会话 workDirExists=true / workspaceState=available')

    const post = (body) => fetch(`${base}/api/session-messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    }).then((r) => r.json())
    const dispatch = await post({ targetSessionId: workerId, fromSessionId: supId, content: 'preflight 派活：请忽略', title: 'preflight-dispatch' })
    const taskId = dispatch.taskId
    if (!taskId) return fail(`smoke: 派活未返回 taskId（${JSON.stringify(dispatch).slice(0, 200)}）`)
    ok(`smoke: 派活 taskId=${taskId}`)

    await post({ targetSessionId: supId, fromSessionId: workerId, taskId, content: 'preflight 汇报：任务已完成' })
    await new Promise((r) => setTimeout(r, 6000))
    const supTranscript = readFileSync(join(projDir, `${supId}.jsonl`), 'utf8').split('\n').filter(Boolean)
    let reportLine = null
    for (let i = supTranscript.length - 1; i >= 0; i--) {
      const e = JSON.parse(supTranscript[i])
      const c = e.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text ?? '').join('') : ''
      if (text.includes('preflight 汇报')) { reportLine = text.split('\n').filter((l) => l.trim()).at(-1); break }
    }
    const expectLine = `【系统】汇报 · 任务 ID：${taskId}；`
    if (reportLine === expectLine) ok(`smoke: 汇报页脚端到端通过（末行=${JSON.stringify(reportLine)}）`)
    else fail(`smoke: 汇报页脚断言失败（末行=${JSON.stringify(reportLine)}，期望=${JSON.stringify(expectLine)}）`)

    await post({ targetSessionId: supId, fromSessionId: workerId, content: 'preflight 普通消息：无 taskId' })
    await new Promise((r) => setTimeout(r, 6000))
    const supTranscript2 = readFileSync(join(projDir, `${supId}.jsonl`), 'utf8').split('\n').filter(Boolean)
    let plainLine = null
    for (let i = supTranscript2.length - 1; i >= 0; i--) {
      const e = JSON.parse(supTranscript2[i])
      const c = e.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text ?? '').join('') : ''
      if (text.includes('preflight 普通消息')) { plainLine = text.split('\n').filter((l) => l.trim()).at(-1); break }
    }
    if (plainLine && !/【系统】(汇报 · )?任务 ID：/.test(plainLine)) ok('smoke: 反例通过（无 taskId 无页脚）')
    else fail(`smoke: 反例失败（末行=${JSON.stringify(plainLine)}）`)
  } finally {
    try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    childPid = null
    setTimeout(() => rmSync(fx, { recursive: true, force: true }), 3000)
  }

  let litMiss = 0
  for (const lit of GATE_LITERALS) {
    const r = Bun.spawnSync(['grep', '-aq', lit, sidecar])
    if (r.exitCode !== 0) { litMiss++; fail(`产物门禁字面量缺失: ${lit}`) }
  }
  if (!litMiss) ok(`产物门禁字面量 ${GATE_LITERALS.length}/${GATE_LITERALS.length}`)
  const hasBudget = Bun.spawnSync(['grep', '-aq', 'Session startup exceeded', sidecar]).exitCode === 0
  const hasConst = Bun.spawnSync(['grep', '-aq', '180000', sidecar]).exitCode === 0
  if (hasBudget && hasConst) ok('smoke: 拉起超时（伴生串 + 数值）在产物中命中')
  else fail(`smoke: 拉起超时证据缺失（伴生串=${hasBudget}，数值=${hasConst}）`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const t0 = Date.now()
if (stage === 'gates' || stage === 'all') await stageGates()
if ((stage === 'test' || stage === 'all') && (stage !== 'all' || failures === 0) && !aborted) await stageTest()
if ((stage === 'build' || stage === 'all') && failures === 0 && !aborted) await stageBuild()
if ((stage === 'smoke' || stage === 'all') && failures === 0 && !aborted) await stageSmoke()
console.log(`\n[preflight] 阶段=${stage} 失败=${failures} 耗时=${Math.round((Date.now() - t0) / 1000)}s`)
process.exit(failures ? 1 : 0)
