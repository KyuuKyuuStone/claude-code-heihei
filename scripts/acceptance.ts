/**
 * v1.4.0 验收脚本（阶段3 测试基建 · 分组进程版）。
 *
 * 口径：安静双跑连续两轮全绿=PASS；单次红→自动单文件复跑：绿=环境噪声（不阻塞），红=真回归（FAIL）。
 *
 * ⚠️ 分组独立进程（2026-09-28）：把 15 个目录塞进单个 bun 进程会让 Bun 1.3.14 崩溃
 * （崩点在 e2e/conversations 真实起服务的阶段；server+utils 两域同进程 2225 用例实测不崩，
 * 最小崩组未定——不论如何，分进程聚合是承载正确姿势）。每个域组各自一次 bun 进程、
 * 各自 junit，脚本聚合统一结论。
 *
 * adapters 域：**本地不作验收口径**（运维证据：含真实网络/长轮询用例，本机 10 分钟跑不完），
 * 以 CI 为准；如需本地跑请显式 `--suite adapters`。
 *
 * 用法：bun scripts/acceptance.ts [--suite repo|server|extras|adapters|desktop] [--runs N]
 * 退出码 0=PASS，1=FAIL。临时 junit 落 os.tmpdir()。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyFailures,
  parseJunit,
  verdict,
  type ClassifiedFailure,
  type JunitCase,
} from './acceptance-lib.ts'

type Group = { name: string; dirs: string[]; note?: string }

/** 真全仓拆成域组：每组一个 bun 进程（单进程承载全部会崩 Bun，见文件头） */
const REPO_GROUPS: Group[] = [
  { name: 'server', dirs: ['src/server/__tests__'] },
  {
    name: 'extras',
    dirs: ['src/utils', 'src/cli', 'src/skills', 'src/services', 'src/server/api'],
  },
]

const ADAPTERS_GROUP: Group = {
  name: 'adapters',
  dirs: ['adapters'],
  note: '⚠️ 本地不作验收口径（含真实网络/长轮询用例），以 CI 为准',
}

type SuiteName = 'repo' | 'server' | 'extras' | 'adapters' | 'desktop'

function groupsFor(suite: SuiteName): Group[] {
  if (suite === 'repo') return REPO_GROUPS
  if (suite === 'adapters') return [ADAPTERS_GROUP]
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

function groupOf(group: Group) {
  return {
    cmd: 'bun',
    args: ['test', ...group.dirs],
    cwd: process.cwd(),
  }
}

/** 跑一个域组：返回 junit 解析结果（套件 stdout 透传终端） */
async function runGroup(group: Group, junitPath: string) {
  const { cmd, args, cwd } = groupOf(group)
  const proc = Bun.spawn([cmd, ...args, '--reporter=junit', `--reporter-outfile=${junitPath}`], {
    cwd,
    stdout: 'inherit',
    stderr: 'pipe',
    env: process.env,
  })
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  try {
    return { parsed: parseJunit(await readFile(junitPath, 'utf-8')), ran: true, stderrTail: undefined as string | undefined }
  } catch {
    return { parsed: emptyRun(), ran: false, stderrTail: stderr.split(/\r?\n/).slice(-8).join('\n') }
  }
}

function emptyRun() {
  return { pass: 0, fail: 0, skipped: 0, total: 0, durationSec: 0, failures: [] as JunitCase[] }
}

function findGroupFor(suiteGroups: Group[], file: string): Group {
  const normalized = file.replaceAll('\\', '/')
  return (
    suiteGroups.find((group) => group.dirs.some((dir) => normalized.startsWith(dir.replaceAll('\\', '/'))))
    ?? suiteGroups[0]!
  )
}

/** 单文件复跑一个失败用例：返回该用例是否转绿 */
async function rerunSingle(group: Group, failure: JunitCase, junitPath: string): Promise<boolean> {
  const { cmd, cwd } = groupOf(group)
  const proc = Bun.spawn([cmd, 'test', failure.file, '--reporter=junit', `--reporter-outfile=${junitPath}`], {
    cwd,
    stdout: 'inherit',
    stderr: 'pipe',
    env: process.env,
  })
  await new Response(proc.stderr).text()
  await proc.exited
  try {
    const rerun = parseJunit(await readFile(junitPath, 'utf-8'))
    return !rerun.failures.some((item) => item.name === failure.name)
  } catch {
    return false
  }
}

async function main() {
  const { suite, runs } = parseArgs(process.argv.slice(2))
  const knownFlaky = await loadKnownFlaky()
  const tmp = await mkdtemp(join(tmpdir(), 'cc-heihei-acceptance-'))
  const suiteGroups = groupsFor(suite)
  const classified: ClassifiedFailure[] = []

  console.log(`\n=== cc-heihei 验收（${suite} 口径：${suiteGroups.map((g) => g.name).join(' + ')}，每组独立进程，共 ${runs} 轮） ===`)
  console.log('⚠️  口径：连续两轮全绿=PASS；单次红自动单文件复跑定类（绿=环境噪声不阻塞，红=真回归 FAIL）')
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
        console.error(`[run ${run}/${runs} · ${group.name}] ✗ 未能取得 junit 结果`)
        if (stderrTail) console.error(stderrTail)
        runAborted = true
        break
      }
      console.log(
        `[run ${run}/${runs} · ${group.name}] ${parsed.pass} pass / ${parsed.fail} fail / ${parsed.skipped} skip，共 ${parsed.total} 用例（${parsed.durationSec.toFixed(1)}s）`,
      )
      if (parsed.failures.length === 0) continue
      console.log(`[run ${run}/${runs} · ${group.name}] 失败 ${parsed.failures.length} 条 → 自动单文件复跑定类：`)
      const owningGroup = findGroupFor(suiteGroups, parsed.failures[0]!.file)
      for (const failure of parsed.failures) {
        // 复跑 3 次：有绿即环境噪声，全红才真回归；分布打印供人工判断——单次复跑
        // 对低频 flaky 必然假阳性（实测 prewarm inspection 约 1/6 频率误判为回归）。
        let greens = 0
        for (let attempt = 1; attempt <= 3; attempt++) {
          const green = await rerunSingle(owningGroup, failure, join(tmp, `rerun-run${run}-${attempt}.xml`))
          if (green) greens++
        }
        const greenOnRerun = greens > 0
        const distribution = `${greens}绿/${3 - greens}红`
        const [item] = classifyFailures([failure], new Map([[`${failure.file}\u0000${failure.name}`, greenOnRerun]]), knownFlaky)
        classified.push(item)
        const kindText = item.kind === 'env-noise'
          ? (item.knownFlakyReason ? `环境噪声（已知 flaky：${item.knownFlakyReason}）` : '环境噪声')
          : '真回归'
        console.log(
          `  复跑 ${distribution} → ${kindText}\n    ${failure.name}\n    @ ${failure.file}${failure.message ? `\n    ${failure.message.slice(0, 160)}` : ''}`,
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
