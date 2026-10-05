/**
 * v1.4.0/v1.5.0 验收脚本（阶段3 测试基建 · 分组进程版）。
 *
 * 口径：安静双跑连续两轮全绿=PASS；单次红→自动单文件复跑 3 次：
 * **≥2 红=真回归（FAIL）**，恰好 1 红（其余绿）=环境噪声（不阻塞，v1.5.0 审查收紧）。
 * 复跑分布「N绿/M红」随结论打印，全自动、无人工裁决档。
 *
 * ⚠️ 分组独立进程（2026-09-28）：把 15 个目录塞进单个 bun 进程会让 Bun 1.3.14 崩溃
 * （崩点在 e2e/conversations 真实起服务的阶段）。每个域组各自一次进程、各自 junit，
 * 脚本聚合统一结论。
 *
 * ⚠️ 复跑判绿（C1，2026-09-29）：复跑必须「junit 可解析 + 目标用例确实出现 + 未失败」
 * 才算绿；半写/崩溃的 junit（总数 0 或缺目标用例）按红计。同文件同名用例按
 * name+classname 二元组区分（低2）。任何组跑出 0 用例一律判执行失败（低：防假绿）。
 *
 * adapters 域：**本地不作验收口径**（含真实网络/长轮询用例），以 CI 为准。
 * desktop 域（C9②，2026-09-29）：本地用 vitest + junit 真跑（此前 groupsFor 返回空组
 * 会假绿）；CI 的 desktop-tests 仍是桌面发布口径，本地结果作参考。
 *
 * 用法：bun scripts/acceptance.ts [--suite repo|server|extras|adapters|desktop] [--runs N]
 * 退出码 0=PASS，1=FAIL。临时 junit 落 os.tmpdir()。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyFailures,
  classifyRerunDistribution,
  isRerunGreen,
  parseJunit,
  verdict,
  type ClassifiedFailure,
  type JunitCase,
} from './acceptance-lib.ts'

type Group = { name: string; dirs: string[]; kind: 'bun' | 'vitest'; cwd?: string; note?: string }

/** 真全仓拆成域组：每组一个独立进程 */
const REPO_GROUPS: Group[] = [
  { name: 'server', dirs: ['src/server/__tests__'], kind: 'bun' },
  {
    name: 'extras',
    dirs: ['src/utils', 'src/cli', 'src/skills', 'src/services', 'src/server/api'],
    kind: 'bun',
  },
]

const ADAPTERS_GROUP: Group = {
  name: 'adapters',
  dirs: ['adapters'],
  kind: 'bun',
  note: '⚠️ 本地不作验收口径（含真实网络/长轮询用例），以 CI 为准',
}

const DESKTOP_GROUP: Group = {
  name: 'desktop',
  dirs: [],
  kind: 'vitest',
  cwd: join(process.cwd(), 'desktop'),
  note: 'ℹ️ 桌面域本地跑 vitest+junit；发布口径以 CI desktop-tests 为准',
}

type SuiteName = 'repo' | 'server' | 'extras' | 'adapters' | 'desktop'

function groupsFor(suite: SuiteName): Group[] {
  if (suite === 'repo') return REPO_GROUPS
  if (suite === 'adapters') return [ADAPTERS_GROUP]
  if (suite === 'desktop') return [DESKTOP_GROUP]
  if (suite === 'server' || suite === 'extras') return [REPO_GROUPS.find((g) => g.name === suite)!]
  return []
}

function parseArgs(argv: string[]): { suite: SuiteName; runs: number } {
  let suite: SuiteName = 'repo'
  let runs = 2
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--suite' && ['repo', 'server', 'extras', 'adapters', 'desktop'].includes(argv[index + 1] ?? '')) {
      suite = argv[index + 1] as SuiteName
      index++
    } else if (arg === '--runs') {
      const value = Number(argv[index + 1])
      if (Number.isFinite(value) && value >= 1) runs = Math.floor(value)
      index++
    }
  }
  return { suite, runs }
}

async function loadKnownFlaky(): Promise<Array<{ test: string; reason?: string }>> {
  try {
    const raw = JSON.parse(await readFile(new URL('./known-flaky.json', import.meta.url), 'utf-8')) as {
      entries?: Array<{ test: string; reason?: string }>
    }
    return Array.isArray(raw.entries) ? raw.entries : []
  } catch {
    return []
  }
}

/** 组的一次运行命令（junit 落指定路径） */
function commandFor(group: Group, target: 'group' | 'file', file: string | undefined, junitPath: string): { cmd: string; args: string[]; cwd: string } {
  if (group.kind === 'vitest') {
    const testTarget = target === 'file' && file ? [file] : []
    return {
      cmd: 'bun',
      args: ['run', 'vitest', 'run', ...testTarget, '--reporter=junit', `--outputFile=${junitPath}`],
      cwd: group.cwd ?? process.cwd(),
    }
  }
  const dirs = target === 'group' ? group.dirs : []
  return {
    cmd: 'bun',
    args: ['test', ...(file && target === 'file' ? [file] : dirs), '--reporter=junit', `--reporter-outfile=${junitPath}`],
    cwd: group.cwd ?? process.cwd(),
  }
}

async function readJunit(group: Group, junitPath: string): Promise<string | null> {
  try {
    return await readFile(junitPath, 'utf-8')
  } catch {
    if (group.kind === 'vitest') {
      try {
        return await readFile(join(group.cwd ?? process.cwd(), 'junit.xml'), 'utf-8')
      } catch {
        return null
      }
    }
    return null
  }
}

/** 跑一个域组：返回 junit 解析结果（套件 stdout 透传终端） */
async function runGroup(group: Group, junitPath: string) {
  const { cmd, args, cwd } = commandFor(group, 'group', undefined, junitPath)
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: 'inherit', stderr: 'pipe', env: process.env })
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  const xml = await readJunit(group, junitPath)
  if (!xml) {
    return { parsed: emptyRun(), ran: false, stderrTail: stderr.split(/\r?\n/).slice(-8).join('\n') }
  }
  const parsed = parseJunit(xml)
  // 0 用例 = 没真正跑起来（路径错/加载崩/半写），一律按执行失败处理，不给假绿
  if (parsed.total === 0) {
    return { parsed, ran: false, stderrTail: stderr.split(/\r?\n/).slice(-8).join('\n') }
  }
  return { parsed, ran: true, stderrTail: undefined as string | undefined }
}

function emptyRun() {
  return { pass: 0, fail: 0, skipped: 0, total: 0, durationSec: 0, failures: [] as JunitCase[], cases: [] as JunitCase[] }
}

function findGroupFor(suiteGroups: Group[], file: string): Group {
  const normalized = file.replaceAll('\\', '/')
  return (
    suiteGroups.find((group) => group.dirs.some((dir) => normalized.startsWith(dir.replaceAll('\\', '/'))))
    ?? suiteGroups[0]!
  )
}

/** 单文件复跑一个失败用例：C1 判绿（junit 可解析+用例存在+未失败），返回是否绿 */
async function rerunSingle(group: Group, failure: JunitCase, junitPath: string): Promise<boolean> {
  const { cmd, args, cwd } = commandFor(group, 'file', failure.file, junitPath)
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: 'inherit', stderr: 'pipe', env: process.env })
  // bun test 的断言 diff 走 stderr；复跑仍红时打印关键行，供 CI 日志直接定位失败原因（只加诊断、不改判定）。
  const stderrText = await new Response(proc.stderr).text()
  await proc.exited
  const xml = await readJunit(group, junitPath)
  const green = xml ? isRerunGreen(parseJunit(xml), failure) : false
  if (!green && stderrText) {
    const key = stderrText
      .split('\n')
      .filter((line) => /(error:|expect\(|Expected|Received|✗|fail\b|\(fail\))/.test(line))
      .slice(0, 60)
    console.log(`  [复跑诊断 · ${failure.file} · ${failure.name}]`)
    for (const line of key) console.log(`    ${line.trim().slice(0, 400)}`)
  }
  return green
}

async function main() {
  const { suite, runs } = parseArgs(process.argv.slice(2))
  const knownFlaky = await loadKnownFlaky()
  const tmp = await mkdtemp(join(tmpdir(), 'cc-heihei-acceptance-'))
  const suiteGroups = groupsFor(suite)
  const classified: ClassifiedFailure[] = []

  console.log(`\n=== cc-heihei 验收（${suite} 口径：${suiteGroups.map((g) => g.name).join(' + ')}，每组独立进程，共 ${runs} 轮） ===`)
  console.log('⚠️  口径：连续两轮全绿=PASS；单次红自动单文件复跑 3 次定类（≤1 红=环境噪声不阻塞，≥2 红=真回归 FAIL）')
  if (suite === 'repo') {
    console.log('ℹ️ adapters 不在本地口径内（真实网络/长轮询，以 CI 为准）')
  }
  for (const group of suiteGroups) {
    if (group.note) console.log(group.note)
  }
  if (knownFlaky.length > 0) {
    console.log(`已知 flaky 清单：${knownFlaky.length} 条（仅标注，不改变复跑判据）`)
  }

  let runAborted = false
  for (let run = 1; run <= runs && !runAborted; run++) {
    for (const group of suiteGroups) {
      const junitPath = join(tmp, `run${run}-${group.name}.xml`)
      console.log(`\n[run ${run}/${runs} · ${group.name}] 运行中…`)
      const { parsed, ran, stderrTail } = await runGroup(group, junitPath)
      if (!ran) {
        console.error(`[run ${run}/${runs} · ${group.name}] ✗ 未能取得有效测试结果（junit 缺失或 0 用例）`)
        if (stderrTail) console.error(stderrTail)
        runAborted = true
        break
      }
      console.log(
        `[run ${run}/${runs} · ${group.name}] ${parsed.pass} pass / ${parsed.fail} fail / ${parsed.skipped} skip，共 ${parsed.total} 用例（${parsed.durationSec.toFixed(1)}s）`,
      )
      if (parsed.failures.length === 0) continue
      console.log(`[run ${run}/${runs} · ${group.name}] 失败 ${parsed.failures.length} 条 → 自动单文件复跑定类：`)
      for (const failure of parsed.failures) {
        // 低4：归属组按每条失败自己的 file 逐条求（跨组失败同轮时不再配错）
        const owningGroup = findGroupFor(suiteGroups, failure.file)
        let greens = 0
        for (let attempt = 1; attempt <= 3; attempt++) {
          const green = await rerunSingle(owningGroup, failure, join(tmp, `rerun-run${run}-${attempt}.xml`))
          if (green) greens++
        }
        const distribution = `${greens}绿/${3 - greens}红`
        // 中1（v1.5.0 审查收紧）：≥2 红即真回归；恰好 1 红才按环境噪声放行
        const greenOnRerun = classifyRerunDistribution(greens, 3) === 'env-noise'
        const [item] = classifyFailures(
          [failure],
          new Map([[`${failure.file}\u0000${failure.name}\u0000${failure.classname}`, greenOnRerun]]),
          knownFlaky,
        )
        classified.push(item)
        const kindText = item.kind === 'env-noise'
          ? (item.knownFlakyReason ? `环境噪声（已知 flaky：${item.knownFlakyReason}）` : '环境噪声')
          : '真回归'
        console.log(
          `  复跑 ${distribution} → ${kindText}${item.kind === 'real-regression' ? '（≥2 红即判真回归）' : ''}\n    ${failure.name}\n    @ ${failure.file}${failure.message ? `\n    ${failure.message.slice(0, 160)}` : ''}`,
        )
      }
    }
  }

  const result = verdict(classified)
  console.log('\n──────────── 分类汇总（跨组聚合） ────────────')
  if (classified.length === 0) {
    console.log('环境噪声 0 条；真回归 0 条')
  } else {
    for (const item of classified) {
      console.log(`[${item.kind === 'env-noise' ? '环境噪声' : '真回归'}] ${item.name} @ ${item.file}`)
    }
    console.log(`环境噪声 ${result.envNoise} 条（不阻塞）；真回归 ${result.realRegressions} 条（阻塞）`)
  }
  if (result.result === 'PASS' && result.envNoise > 0) {
    console.log('ℹ️ 存在环境噪声：严格口径（连续两轮全绿）建议另择安静窗口再跑一轮确认。')
  }
  console.log(`\nVERDICT: ${runAborted ? 'FAIL（执行中断）' : result.result}`)
  await rm(tmp, { recursive: true, force: true })
  process.exit(runAborted || result.result !== 'PASS' ? 1 : 0)
}

main().catch(async (error) => {
  console.error('验收脚本自身异常：', error)
  process.exit(1)
})
