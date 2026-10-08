// check-tsc-baseline.ts —— G9 root 类型关卡（tsc 棘轮）
//
// 规格来源：D:/xxw_p/cc-heihei-plan/方案_G2收官3条与G9类型关卡_规格_2026-10-08.md §②
//
// 用法：
//   bun run lint:types                              # 闸门：spawn node 跑全量 tsc → 签名多重集与基线比对（只紧不松）
//   bun run lint:types -- --baseline-ref origin/main # CI 防倒转：先比工作区基线 total 相对该 ref 是否上调（上调 FAIL，秒级）→ 再跑闸门
//   bun run lint:types -- --update                  # 生成/下调基线（首跑生成；收敛后同提交下调；总数骤降 >50% 拒写，防误用）
//
// 只紧不松四规则（规格 §②.2）：
//   a) 当前签名多重集 ⊆ 基线（每个签名计数 ≤ 基线）⇒ PASS；缺失/减少 = 合法收敛，不拦
//   b) 新增签名 / 同签名计数超 ⇒ FAIL，输出差异清单
//   c) 收敛后同提交下调基线（--update）
//   d) CI 中工作区基线 total 相对 --baseline-ref 上调 ⇒ FAIL（防棘轮倒转；新增 key 允许——伴随旧签名消失的合法移位，total 只许降）
//
// 真空自毁（规格 §②.3）：解析 0 条诊断且 exit≠0 ⇒ 判红「闸门失效」；诊断总数 < 基线 50% ⇒ 判红（防真空检查
// 「错误数 ≤ 基线」式假绿与误删 src 一大片式假绿；合法大修用 --update 重建）。
//
// 归一化规则（签名 = 文件::错误码::归一化 message，行号不入签名——行号漂移不算新增）：
//   1) 取诊断行 message 全文（--pretty false 下单行；续行为 related information，不入签名）
//   2) 数字串全部替换为 N（防同错误因参数个数/行内数字漂移被误判新增；首版宁紧，不做其他折叠）
//   3) 文件路径反斜杠归一为正斜杠，且用户主目录前缀折叠为 ~/（bun-types 等缓存诊断带本机绝对路径，
//      Windows 与 CI Linux 形态不同，不折叠则基线跨机器漂移假红）
//
// 堆上限：全量 tsc 默认堆 OOM（exit 134，架构师实测）⇒ spawn node 自带 --max-old-space-size=12288。
// 7255 存量 = 长期债务，本批只立闸门不清算（规格 §②.6）。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const BASELINE_PATH = join(SCRIPT_DIR, "tsc-baseline.json");
const TSC = join(REPO_ROOT, "node_modules", "typescript", "lib", "tsc.js");
const TSCONFIG = join(REPO_ROOT, "tsconfig.json");
const TSC_HEAP_MB = "12288";
const SANITY_RATIO = 0.5;

export interface TscDiag {
  file: string;
  line: string;
  col: string;
  code: string;
  message: string;
}

// 用户主目录折叠：bun-types 等缓存诊断带本机绝对路径（Windows C:/Users/<名>/... vs CI /home/runner/...），
// 不折叠则基线跨机器必然漂移 ⇒ 统一折叠为 ~/ 前缀（大小写不敏感比对）。
const HOME = homedir().replace(/\\/g, "/");

export function normalizeFilePath(f: string): string {
  const norm = f.replace(/\\/g, "/");
  if (norm.toLowerCase().startsWith(HOME.toLowerCase() + "/")) return "~" + norm.slice(HOME.length);
  return norm;
}

export function parseTscOutput(text: string): TscDiag[] {
  const out: TscDiag[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // 诊断行形态：file(line,col): error TSxxxx: message（config 错误如 tsconfig.json(8,5) 同形态）
    const m = /^(.+?)\((\d+),(\d+)\): (error TS\d+): (.*)$/.exec(raw);
    if (m) out.push({ file: normalizeFilePath(m[1]), line: m[2], col: m[3], code: m[4], message: m[5] });
  }
  return out;
}

export function normalizeMessage(message: string): string {
  const firstLine = message.split(/\r?\n/)[0] ?? "";
  return firstLine.replace(/\d+/g, "N");
}

export function buildSignatures(diags: TscDiag[]): Map<string, number> {
  const sig = new Map<string, number>();
  for (const d of diags) {
    const key = `${d.file}::${d.code}::${normalizeMessage(d.message)}`;
    sig.set(key, (sig.get(key) ?? 0) + 1);
  }
  return sig;
}

export interface CompareResult {
  pass: boolean;
  added: [string, number][]; // 基线没有的签名 [签名, 当前次数]
  exceeded: [string, number, number][]; // 计数超基线 [签名, 当前, 基线]
  currentTotal: number;
  baselineTotal: number;
}

export function compareSignatures(
  current: Map<string, number>,
  baseline: Map<string, number>,
): CompareResult {
  const added: [string, number][] = [];
  const exceeded: [string, number, number][] = [];
  let currentTotal = 0;
  for (const [k, n] of current) {
    currentTotal += n;
    const b = baseline.get(k);
    if (b === undefined) added.push([k, n]);
    else if (n > b) exceeded.push([k, n, b]);
  }
  let baselineTotal = 0;
  for (const n of baseline.values()) baselineTotal += n;
  return { pass: added.length === 0 && exceeded.length === 0, added, exceeded, currentTotal, baselineTotal };
}

export interface SanityResult {
  ok: boolean;
  reason: string;
}

export function sanityCheck(currentTotal: number, exitCode: number, baselineTotal: number | null): SanityResult {
  if (exitCode !== 0 && currentTotal === 0)
    return { ok: false, reason: `tsc exit=${exitCode} 但解析到 0 条诊断 ⇒ 闸门失效（config 错误/真空检查，0 文件被检）` };
  if (baselineTotal !== null && baselineTotal > 0 && currentTotal < baselineTotal * SANITY_RATIO)
    return { ok: false, reason: `诊断总数 ${currentTotal} < 基线 ${baselineTotal} 的 ${SANITY_RATIO * 100}% ⇒ 疑似真空检查或大面积误删；若为合法大修请 --update 重建基线` };
  return { ok: true, reason: "" };
}

export interface BaselineFile {
  comment: string;
  version: number;
  tsVersion: string;
  total: number;
  signatures: Record<string, number>;
}

export function readBaseline(path: string = BASELINE_PATH): BaselineFile | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
}

function mapToRecord(m: Map<string, number>): Record<string, number> {
  const rec: Record<string, number> = {};
  for (const [k, v] of [...m.entries()].sort()) rec[k] = v;
  return rec;
}

export function runTsc(tsconfigPath: string = TSCONFIG, tscPath: string = TSC): { exitCode: number; stdout: string } {
  // 必须用系统 node 跑 tsc：本脚本经 bun 执行，process.execPath 是 bun.exe（JavaScriptCore，不认 V8 堆旗标）
  const r = spawnSync("node", [tscPath, "-p", tsconfigPath, "--noEmit", "--pretty", "false"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${TSC_HEAP_MB}` },
  });
  return { exitCode: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

function gitShowBaseline(ref: string): BaselineFile | null {
  const r = spawnSync("git", ["show", `${ref}:scripts/tsc-baseline.json`], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout) as BaselineFile;
  } catch {
    return null;
  }
}

function fail(msg: string, detail: string[] = []): never {
  console.error(`[tsc-baseline] FAIL ${msg}`);
  for (const line of detail) console.error(`  ${line}`);
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  const update = args.includes("--update");
  const refIdx = args.indexOf("--baseline-ref");
  const baselineRef = refIdx >= 0 ? args[refIdx + 1] : null;

  // 规则 d：CI 防倒转（秒级，不跑 tsc）——工作区基线 total 相对 ref 只许降
  if (baselineRef) {
    const work = readBaseline();
    const ref = gitShowBaseline(baselineRef);
    if (!work) fail(`工作区无 ${BASELINE_PATH}，防倒转无法执行`);
    if (ref) {
      if (work.total > ref.total)
        fail(`基线 total 上调（${ref.total} → ${work.total}）⇒ 棘轮倒转，禁止（相对 ${baselineRef}）`, [
          "新增签名 key 若伴随旧签名消失（合法移位）应体现为 total 不升；如确需上调请联系架构师重裁。",
        ]);
      console.log(`[tsc-baseline] 防倒转 PASS：基线 total ${ref.total} → ${work.total}（相对 ${baselineRef} 未上调）`);
    } else {
      console.log(`[tsc-baseline] 防倒转跳过：${baselineRef} 无基线文件（首次接入期）`);
    }
  }

  const t0 = Date.now();
  const { exitCode, stdout } = runTsc();
  const diags = parseTscOutput(stdout);
  const current = buildSignatures(diags);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const baseline = readBaseline();

  // 真空自毁 + sanity 下限
  const sanity = sanityCheck(diags.length, exitCode, baseline ? baseline.total : null);
  if (!sanity.ok) fail(sanity.reason);

  if (update) {
    if (baseline && diags.length < baseline.total * SANITY_RATIO)
      fail(`拒绝写入：新 total ${diags.length} < 旧基线 ${baseline.total} 的 50%（疑似真空/误删；确为大修请人工确认后重试）`);
    const file: BaselineFile = {
      comment: "root tsc 棘轮基线（G9）。只紧不松：签名计数只许降；新增签名或计数超即 FAIL。存量诊断数为长期债务，本批只立闸门不清算。",
      version: 1,
      tsVersion: "6.0.3",
      total: diags.length,
      signatures: mapToRecord(current),
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(file, null, 2) + "\n", "utf8");
    console.log(`[tsc-baseline] 基线已写入：total=${diags.length}，签名数=${current.size}（tsc ${elapsed}s，exit=${exitCode}）`);
    if (baseline) console.log(`[tsc-baseline] 旧基线 total=${baseline.total}（同提交下调，规则 c）`);
    return;
  }

  if (!baseline) fail(`基线文件不存在：${BASELINE_PATH}（首跑请 bun run lint:types -- --update 生成）`);

  // 基线 JSON 的 signatures 即「签名串→次数」，直接还原为 Map 比对
  const cmp = compareSignatures(current, new Map(Object.entries(baseline.signatures)));
  const detail: string[] = [];
  for (const [k, n] of cmp.added.slice(0, 20)) detail.push(`新增签名 x${n}: ${k}`);
  for (const [k, n, b] of cmp.exceeded.slice(0, 20)) detail.push(`计数超基线 x${n}（基线 ${b}）: ${k}`);
  if (cmp.added.length > 20) detail.push(`…另有 ${cmp.added.length - 20} 条新增签名未列出`);
  if (cmp.exceeded.length > 20) detail.push(`…另有 ${cmp.exceeded.length - 20} 条计数超未列出`);

  if (!cmp.pass)
    fail(`类型签名棘轮被触发（tsc ${elapsed}s，exit=${exitCode}）`, [
      `当前 total=${cmp.currentTotal} vs 基线 total=${cmp.baselineTotal}`,
      `新增签名 ${cmp.added.length} 条 / 计数超 ${cmp.exceeded.length} 条`,
      ...detail,
      "处置：修掉新增/超量类型错误（棘轮只紧不松）；或若属合法重构移位，--update 下调基线并同提交。",
    ]);

  console.log(`[tsc-baseline] PASS：total=${cmp.currentTotal}（基线 ${cmp.baselineTotal}），签名数=${current.size}，新增 0 / 计数超 0（tsc ${elapsed}s，exit=${exitCode}）`);
}

if (import.meta.main) main();
