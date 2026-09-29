/**
 * v1.4.0 验收脚本 —— 纯逻辑层（解析 junit / 分类 / 结论）。
 *
 * 设计依据＝批次9 分诊结论（cc-heihei-交接/批次9_全量不稳定分诊_进度_20260928.md）：
 * 三类环境 flaky（负载型超时 / 订阅污染型[已根治] / FS 争用型）在「单文件复跑」下都会转绿，
 * 只有真回归复跑仍红——这就是自动化分类的判据。
 *
 * 本模块不碰网络、不跑进程；进程编排在 acceptance.ts。
 */

export type JunitCase = {
  /** 完整用例名（bun junit：describe > test 的 test 部分；vitest：含 describe 前缀） */
  name: string
  /** 所属测试文件（junit 的 file 属性，相对仓库根） */
  file: string
  failed: boolean
  /** 失败信息首行（失败时才有） */
  message?: string
}

export type ParsedRun = {
  pass: number
  fail: number
  skipped: number
  total: number
  durationSec: number
  failures: JunitCase[]
}

export type RerunOutcome = {
  file: string
  name: string
  /** 单文件复跑后该用例转绿 */
  greenOnRerun: boolean
  /** 命中已知 flaky 清单时的标注 */
  knownFlakyReason?: string
}

export type ClassifiedFailure = RerunOutcome & {
  kind: 'env-noise' | 'real-regression'
}

const TESTCASE_RE = /<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g
const ATTR_RE = /\b([a-zA-Z]+)="([^"]*)"/g

function extractAttrs(block: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of block.matchAll(ATTR_RE)) {
    attrs[match[1]!] = decodeXml(match[2]!)
  }
  return attrs
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function firstFailureMessage(block: string): string | undefined {
  const match = /<(?:failure|error)\b[^>]*message="([^"]*)"/.exec(block)
    ?? /<(?:failure|error)\b[^>]*>([\s\S]*?)<\/(?:failure|error)>/.exec(block)
  if (!match) return undefined
  const text = decodeXml(match[1]!).trim()
  return text.split(/\r?\n/)[0]
}

/** 解析 bun/vitest 的 junit 输出（只关心 testcase 与 failure/error） */
export function parseJunit(xml: string): ParsedRun {
  const failures: JunitCase[] = []
  let pass = 0
  let skipped = 0

  for (const match of xml.matchAll(TESTCASE_RE)) {
    const block = match[0]
    const attrs = extractAttrs(block)
    const name = attrs.name ?? ''
    const file = (attrs.file ?? attrs.classname ?? '').replaceAll('\\', '/')
    if (!name) continue
    const failed = /<(failure|error)\b/.test(block)
    const isSkipped = /<skipped\b/.test(block)
    if (failed) {
      failures.push({ name, file, failed: true, message: firstFailureMessage(block) })
    } else if (isSkipped) {
      skipped++
    } else {
      pass++
    }
  }

  const totals = extractTotals(xml)
  return {
    pass: totals.pass ?? pass,
    fail: totals.fail ?? failures.length,
    skipped: totals.skipped ?? skipped,
    total: totals.total ?? (pass + failures.length + skipped),
    durationSec: totals.time ?? 0,
    failures,
  }
}

function extractTotals(xml: string): { pass?: number; fail?: number; skipped?: number; total?: number; time?: number } {
  // 取最外层 <testsuites> 汇总；bun 的 pass 数 = tests - failures - skipped
  const match = /<testsuites\b[^>]*>/.exec(xml)
  if (!match) return {}
  const attrs = extractAttrs(match[0])
  const tests = Number(attrs.tests ?? Number.NaN)
  const failuresAttr = Number(attrs.failures ?? Number.NaN)
  const skipped = Number(attrs.skipped ?? Number.NaN)
  const time = Number(attrs.time ?? Number.NaN)
  const result: { pass?: number; fail?: number; skipped?: number; total?: number; time?: number } = {}
  if (Number.isFinite(tests)) {
    result.total = tests
    if (Number.isFinite(failuresAttr) && Number.isFinite(skipped)) {
      result.pass = tests - failuresAttr - skipped
    }
  }
  if (Number.isFinite(failuresAttr)) result.fail = failuresAttr
  if (Number.isFinite(skipped)) result.skipped = skipped
  if (Number.isFinite(time)) result.time = time
  return result
}

/** 已知 flaky 清单匹配（子串匹配完整用例名）；仅用于标注，绝不改变复跑判据 */
export function matchKnownFlaky(
  fullName: string,
  list: Array<{ test: string; reason?: string }>,
): string | undefined {
  for (const entry of list) {
    if (entry.test && fullName.includes(entry.test)) return entry.reason ?? 'known-flaky'
  }
  return undefined
}

/**
 * 对一轮的失败做分类（结合单文件复跑结果）。
 * 规则（验收口径）：复跑绿＝环境噪声（不阻塞）；复跑红＝真回归（FAIL）。
 */
export function classifyFailures(
  failures: JunitCase[],
  rerunResults: Map<string, boolean>,
  knownFlaky: Array<{ test: string; reason?: string }>,
): ClassifiedFailure[] {
  return failures.map((failure) => {
    const rerunKey = `${failure.file}\u0000${failure.name}`
    const greenOnRerun = rerunResults.get(rerunKey) ?? false
    return {
      file: failure.file,
      name: failure.name,
      greenOnRerun,
      knownFlakyReason: matchKnownFlaky(failure.name, knownFlaky),
      kind: greenOnRerun ? 'env-noise' : 'real-regression',
    }
  })
}

/** 最终结论：任何真回归 → FAIL；否则 PASS（含纯环境噪声的轮次也判 PASS，但附提醒） */
export function verdict(
  classified: ClassifiedFailure[],
): { result: 'PASS' | 'FAIL'; realRegressions: number; envNoise: number } {
  const realRegressions = classified.filter((item) => item.kind === 'real-regression').length
  const envNoise = classified.filter((item) => item.kind === 'env-noise').length
  return { result: realRegressions > 0 ? 'FAIL' : 'PASS', realRegressions, envNoise }
}
