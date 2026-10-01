#!/usr/bin/env bun
/**
 * check-file-size.ts —— 文件行数门禁（v1.7.0 结构专项前置设施）
 *
 * 依据：架构评估_v1.7.0范围与遗留问题.md §2.3（冲突时以该节为准）。
 * 统计口径：物理行数（wc -l 语义，数换行符），含注释与空行；
 *           排除测试文件（*.test.* / *.spec.* / *.bench.* / __tests__/）、*.d.ts 与 node_modules。
 * 统计范围：src/、desktop/src/、desktop/electron/。
 *
 * 规则：
 *   1) 新文件或当前 ≤2500 行的文件，超过 2500 行 → 失败；
 *   2) 基线表（scripts/file-size-baseline.json）中的文件，当前行数 > 基线值 → 失败（只许减少）；
 *      基线值相对 HEAD 只许下调或持平；基线条目被删除时，该文件当前必须已 ≤2500（防绕过）；
 *   3) 基线文件降到 ≤2500 后应从基线表移除（脚本输出提示，由维护者在同一提交中同步移除）；
 *   4) 豁免（scripts/file-size-allowlist.json）：仅架构师可添加，条目含
 *      reason / decisionRef / expiresInVersion；expiresInVersion ≤ 当前 package.json
 *      版本即视为过期——过期条目本身报失败，且不再豁免对应文件；kind=directory 的条目
 *      用于上游目录整体排除（同样走豁免流程）；豁免文件行数超过 3000 时仍失败。
 *
 * 用法：bun run scripts/check-file-size.ts [--changed]
 *   （默认全量扫描；--changed 只检查 git 变更文件，供需要提速的场景——规则 2 的基线
 *    校验在两种模式下都基于全量基线表执行。实测全量耗时 <2s，pre-commit 直接全量跑。）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOTS = ['src', 'desktop/src', 'desktop/electron']
const LIMIT = 2500
const ALLOWLIST_CAP = 3000
const BASELINE_FILE = 'scripts/file-size-baseline.json'
const ALLOWLIST_FILE = 'scripts/file-size-allowlist.json'
const PKG_FILE = 'desktop/package.json'
const TEST_RE = /(\.test\.|\.spec\.|\.bench\.|__tests__)/
const SRC_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/

const failures: string[] = []
const notices: string[] = []

function wcL(buf: Uint8Array): number {
  let n = 0
  for (const b of buf) if (b === 10) n++
  return n
}

function collect(dir: string, out: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      collect(full, out)
      continue
    }
    if (!SRC_RE.test(e.name)) continue
    const rel = relative('.', full).split(sep).join('/')
    if (TEST_RE.test(rel) || rel.endsWith('.d.ts')) continue
    out.push(rel)
  }
}

/** 版本比较：a >= b 返回 true（按数值段比较，忽略 prerelease 细节） */
function versionGte(a: string, b: string): boolean {
  const pa = a.replace(/-.*$/, '').split('.').map(Number)
  const pb = b.replace(/-.*$/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

function gitShow(path: string): string | null {
  const proc = Bun.spawnSync(['git', 'show', `HEAD:${path}`], { stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) return null
  return new TextDecoder().decode(proc.stdout)
}

// ---------------------------------------------------------------------------
// 载入基线表 / 豁免清单 / 当前版本
// ---------------------------------------------------------------------------

type BaselineEntry = { lines: number; kind: 'own' | 'upstream' }
type Baseline = { files: Record<string, BaselineEntry> }

/**
 * 自有代码（架构评估 §2.1 + 补充裁决二第四条）：v1.7 必须降到 2500 行以下的 6 个文件，
 * 豁免名额最多 1 个。其余超标文件按上游 CLI 代码（upstream）纳入基线，只减不增。
 * --generate 模式按本清单判定 kind；新增自有超标文件须架构师裁决后更新本清单。
 */
const OWN_FILES = new Set([
  'src/server/ws/handler.ts',
  'src/server/services/sessionService.ts',
  'src/server/services/conversationService.ts',
  'desktop/src/stores/chatStore.ts',
  'desktop/src/pages/Settings.tsx',
  'desktop/src/components/chat/MessageList.tsx',
])
type AllowEntry = {
  path: string
  kind?: 'file' | 'directory'
  reason: string
  decisionRef: string
  expiresInVersion: string
  /** 该条目专属的发版行数上限（补充裁决十一）；缺省 3000，只紧不松 */
  cap?: number
}
type Allowlist = { entries: AllowEntry[] }

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

const baseline = loadJson<Baseline>(BASELINE_FILE, { files: {} })
const allowlist = loadJson<Allowlist>(ALLOWLIST_FILE, { entries: [] })
const pkgVersion =
  existsSync(PKG_FILE) ? (JSON.parse(readFileSync(PKG_FILE, 'utf8')) as { version: string }).version : '0.0.0'

// ---------------------------------------------------------------------------
// 规则 2 附则：基线只许下调、条目集合只许缩小（与基准版基线比对）。
// 基准：pre-commit 与本地默认比 `git show HEAD:<baseline>`；CI 传 --baseline-ref
// 与合并基点比；--baseline-file 仅测试/手动核对用。--generate 不做此校验。
// 数值变大、或新增条目，一律失败。
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const changedOnly = args.includes('--changed')
const baselineRefIdx = args.indexOf('--baseline-ref')
const baselineRef = baselineRefIdx >= 0 ? args[baselineRefIdx + 1] : 'HEAD'
const baselineFileIdx = args.indexOf('--baseline-file')
const refDesc =
  baselineFileIdx >= 0 ? `file ${args[baselineFileIdx + 1]}` : `git ${baselineRef}:${BASELINE_FILE}`
const referenceRaw =
  baselineFileIdx >= 0 && existsSync(args[baselineFileIdx + 1])
    ? readFileSync(args[baselineFileIdx + 1], 'utf8')
    : gitShow(`${baselineRef}:${BASELINE_FILE}`)

if (referenceRaw !== null) {
  const ref = JSON.parse(referenceRaw) as Baseline
  for (const [file, entry] of Object.entries(ref.files)) {
    const v = typeof entry === 'number' ? entry : entry.lines
    const now = baseline.files[file]
    const nowLines = now === undefined ? undefined : typeof now === 'number' ? now : now.lines
    if (nowLines === undefined) {
      const cur = existsSync(file) ? wcL(readFileSync(file)) : 0
      failures.push(
        `BASELINE ${file}: 基线条目被删除，但当前 ${cur} 行仍 > ${LIMIT}——不允许通过删条目绕过规则 2（降到期值须同步下调基线并留档）`,
      )
    } else if (nowLines > v) {
      failures.push(`BASELINE ${file}: 基线值被调高（${v} → ${nowLines}）——基线只允许下调（相对基准 ${refDesc}）`)
    }
  }
  for (const file of Object.keys(baseline.files)) {
    if (!(file in ref.files)) {
      failures.push(`BASELINE ${file}: 新增基线条目——基线条目集合只许缩小，新增须架构师经 --generate 或书面裁决`)
    }
  }
}

// ---------------------------------------------------------------------------
// 豁免清单校验：格式、过期（过期条目本身报失败）
// ---------------------------------------------------------------------------

const activeFileAllow = new Map<string, number>()
const activeDirAllow = new Set<string>()
for (const e of allowlist.entries) {
  if (!e.reason || !e.decisionRef || !e.expiresInVersion) {
    failures.push(`ALLOWLIST ${e.path}: 豁免条目缺少 reason / decisionRef / expiresInVersion`)
    continue
  }
  if (versionGte(pkgVersion, e.expiresInVersion)) {
    failures.push(
      `ALLOWLIST ${e.path}: 豁免已于 ${e.expiresInVersion} 过期（当前版本 ${pkgVersion}）——请移除条目或由架构师续期（decisionRef=${e.decisionRef}）`,
    )
    continue
  }
  if (e.kind === 'directory') activeDirAllow.add(e.path)
  else activeFileAllow.set(e.path, e.cap ?? ALLOWLIST_CAP)
}

// ---------------------------------------------------------------------------
// --generate：首次运行生成基线表（kind 按 OWN_FILES 判定），生成后退出
// 生成结果须交架构师确认后再提交；确认前的基线不作为门禁依据的场景不存在——
// 本门禁自基线表入库那次提交起生效。
// ---------------------------------------------------------------------------

if (args.includes('--generate')) {
  const all: string[] = []
  for (const r of ROOTS) {
    if (existsSync(r)) collect(r, all)
  }
  const files: Record<string, BaselineEntry> = {}
  for (const rel of all) {
    const lines = wcL(readFileSync(rel))
    if (lines > LIMIT) {
      files[rel] = { lines, kind: OWN_FILES.has(rel) ? 'own' : 'upstream' }
    }
  }
  const generated: Baseline & { comment: string } = {
    comment:
      '文件行数基线表（v1.7.0 结构专项，架构评估 §2.3 + 补充裁决二第四条）。由 scripts/check-file-size.ts --generate 首次运行生成，经架构师确认后提交。kind=own：自有代码，v1.7 必须降到 2500 行以下（豁免名额最多 1 个）；kind=upstream：上游 CLI 代码，只减不增，不纳入 v1.7 必降范围。基线只许下调；降至 2500 以下应移出本表。豁免走 file-size-allowlist.json（仅架构师可加）。',
    files,
  }
  await Bun.write(BASELINE_FILE, JSON.stringify(generated, null, 2) + '\n')
  const own = Object.values(files).filter((f) => f.kind === 'own').length
  console.log(
    `[file-size] 基线已生成：${Object.keys(files).length} 个超标文件（own ${own} / upstream ${Object.keys(files).length - own}）→ ${BASELINE_FILE}`,
  )
  process.exit(0)
}

let candidates: string[]
if (changedOnly) {
  const st = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe' })
  const lines = new TextDecoder().decode(st.stdout).split('\n').filter(Boolean)
  candidates = lines
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    // 重命名行形如 `R  old -> new`：取新路径；取巧改动（C）同理取新
    .map((p) => (p.includes(' -> ') ? p.split(' -> ').pop()!.trim() : p))
    .filter((p) => ROOTS.some((r) => p === r || p.startsWith(`${r}/`)) && SRC_RE.test(p) && !TEST_RE.test(p))
} else {
  const all: string[] = []
  for (const r of ROOTS) {
    if (existsSync(r)) collect(r, all)
  }
  candidates = all
}

let checked = 0
for (const rel of candidates) {
  if (!existsSync(rel)) continue
  checked++
  let dirAllowed = false
  for (const d of activeDirAllow) {
    if (rel === d || rel.startsWith(`${d}/`)) {
      dirAllowed = true
      break
    }
  }
  if (dirAllowed) continue
  const lines = wcL(readFileSync(rel))
  const baseEntry = baseline.files[rel]
  const base = baseEntry === undefined ? undefined : typeof baseEntry === 'number' ? baseEntry : baseEntry.lines
  const kind = baseEntry === undefined || typeof baseEntry === 'number' ? 'upstream' : baseEntry.kind

  if (base !== undefined) {
    // 超基线一律失败——豁免不放行（豁免只用于发版检查，见下方 RELEASE_CHECK）
    if (lines > base) {
      failures.push(
        `FAIL(${kind}) ${rel}: 当前 ${lines} 行 > 基线 ${base} 行（超出 ${lines - base} 行）——基线文件只许减少`,
      )
      continue
    }
    // 行数降低：必须在本提交同步下调基线，否则文件之后还能长回去
    if (lines < base) {
      const tail =
        lines <= LIMIT
          ? `且已 ≤${LIMIT}，请把条目从基线表移出（改按规则 1 管理）`
          : `请把基线下调到 ${lines}`
      failures.push(`FAIL(${kind}) ${rel}: 当前 ${lines} 行 < 基线 ${base} 行——${tail}`)
      continue
    }
    continue
  }

  if (lines > LIMIT) {
    failures.push(`FAIL ${rel}: 当前 ${lines} 行 > 上限 ${LIMIT} 行（超出 ${lines - LIMIT} 行）——新文件/未超标文件不得超限`)
  }
}

// ---------------------------------------------------------------------------
// 发版检查（v1.7 退出标准的机器执行）：desktop/package.json 版本 ≥1.7.0 起，
// own 文件超过 2500 行即失败；唯一豁口是有效的架构师豁免（且行数 ≤3000）。
// 豁免只在此处生效——平时的规则 1/2 不看豁免。
// ---------------------------------------------------------------------------

const releaseCheck = versionGte(pkgVersion, '1.7.0')
if (releaseCheck) {
  for (const [rel, entry] of Object.entries(baseline.files)) {
    if (entry.kind !== 'own') continue
    if (!existsSync(rel)) continue
    const lines = wcL(readFileSync(rel))
    if (lines <= LIMIT) continue
    const allowed = activeFileAllow.has(rel)
    if (!allowed) {
      failures.push(
        `RELEASE ${rel}: 当前 ${lines} 行 > 2500（v1.7 退出标准：own 文件发版时须 ≤2500）——无有效豁免；拆分或由架构师登记豁免（≤3000 行）`,
      )
    } else if (lines > activeFileAllow.get(rel)!) {
      failures.push(`RELEASE ${rel}: 当前 ${lines} 行 > 豁免上限 ${activeFileAllow.get(rel)} 行`)
    } else {
      notices.push(`RELEASE-PASS(豁免) ${rel}: ${lines} 行 ≤ 豁免上限 ${activeFileAllow.get(rel)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

for (const n of notices) console.log(n)
if (failures.length) {
  console.error(`\n[file-size] ${failures.length} 项失败：`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`\n[file-size] 通过：检查 ${checked} 个文件，0 失败（基线 ${Object.keys(baseline.files).length} 项，豁免 ${allowlist.entries.length} 项）`)
