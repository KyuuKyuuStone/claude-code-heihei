import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Local model benchmark — composite-target driven.
 *
 * The user picks three things: a desired generation speed (t/s), a context
 * size, and a hardware-usage budget (40–80% of GPU layers / CPU threads).
 * We measure real `tg` speed at that exact config (KV filled to the context
 * via `-d`), and if the target is missed we step the usage up until it is met
 * or the machine tops out — reporting honestly either way.
 */

export type BenchmarkRunInput = {
  modelPath: string
  /** 上下文大小（tokens）。Claude Code 真实负载需要 ≥32K */
  ctxSize: number
  threads: number
}

export type BenchmarkStepResult = {
  label: string
  usage: number
  ngl: string
  threads: number
  tgTokensPerSec: number
}

/** 本机最终采用的运行方式：纯 CPU / GPU 全量 / GPU+CPU 混合 */
export type BenchmarkRunMode = 'cpu' | 'gpu' | 'hybrid'

/**
 * 运行方式判定：GPU 探测失败 = 纯 CPU；推荐档把所有层都放上显卡 = GPU 全量；
 * 其余 = 混合。
 *
 * 注意"所有层"有两种表达：显式 '-1'，或已知 GGUF 层数时 100% 档算出的
 * 具体数字（如 28 层模型的 '28'）。只认 '-1' 会把真·全 GPU 误判成
 * "GPU + CPU 混合"（RTX 5070 Ti 实测踩过：108 t/s 全 GPU 却标成混合）。
 */
export function resolveBenchmarkRunMode(
  gpuUsable: boolean,
  recommendedNgl: string | null | undefined,
  ggufLayers: number | null,
): BenchmarkRunMode {
  if (!gpuUsable) return 'cpu'
  if (recommendedNgl === '-1') return 'gpu'
  if (
    ggufLayers !== null
    && ggufLayers > 0
    && /^\d+$/.test(recommendedNgl ?? '')
    && Number(recommendedNgl) >= ggufLayers
  ) {
    return 'gpu'
  }
  return 'hybrid'
}

export type BenchmarkRunResult = {
  modelParamsB: number | null
  modelSizeMB: number | null
  ppTokensPerSec: number
  maxTgTokensPerSec: number
  steps: BenchmarkStepResult[]
  /** 达到目标速度的第一个配置；全程达不到则为 null */
  recommendedStep: BenchmarkStepResult | null
  /** 上下文可行性：KV 缓存能不能装下 */
  contextFit: {
    /** 每 token 的 KV 缓存字节数（f16） */
    kvBytesPerToken: number | null
    /** 所选上下文需要的 KV 缓存（GB） */
    kvCacheGB: number | null
    /** 可用显存（GB，无独显则为 0） */
    availableVramGB: number
    /** 物理内存（GB）——纯 CPU 模式下 KV 缓存落在内存，按它算预算 */
    availableRamGB: number
    /** GPU 可用时按显存预算算，纯 CPU 模式按内存预算算 */
    gpuUsable: boolean
    /** 能不能装下 */
    fits: boolean
  }
  /** 上下文太小装不下 Claude Code 的系统提示词（真实负载）时给出警告 */
  contextTooSmall: boolean
  /** 硬件提示（非致命）：如 GPU 不可用已自动降级到 CPU */
  note: string | null
  /** 本机最终采用的运行方式 */
  mode: BenchmarkRunMode
  error: string | null
}

export type BenchmarkProgress = {
  current: number
  total: number
  label: string
}

export type BenchmarkProgressHandler = (progress: BenchmarkProgress) => void

const BENCH_PROMPT_TOKENS = 128
const BENCH_GEN_TOKENS = 64
/** 每档跑 2 次取平均——单次测量波动能到 ±20%（缓存/调度运气），一次定档不稳 */
const BENCH_REPS = 2
const BENCH_TIMEOUT_MS = 180_000
/** 探测 GPU 能不能真跑——用最小工作量，快 */
const PROBE_TIMEOUT_MS = 30_000

export function resolveLlamaBenchExecutable(desktopRoot: string): string {
  return path.join(desktopRoot, 'src-tauri', 'binaries', 'llama-server-vulkan', 'llama-bench.exe')
}

/* ── GGUF 头部解析：拿层数 + KV 头数 + 嵌入维度，算 KV 缓存大小 ── */

type GgufMeta = {
  layers: number | null
  kvHeads: number | null
  headDim: number | null
}

const GGUF_SCALAR_SIZES: Record<number, number> = {
  0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8,
}

async function readGgufMeta(modelPath: string): Promise<GgufMeta> {
  let file
  const meta: GgufMeta = { layers: null, kvHeads: null, headDim: null }
  try {
    file = await open(modelPath, 'r')
    const buf = Buffer.alloc(4 * 1024 * 1024)
    const { bytesRead } = await file.read(buf, 0, buf.length, 0)
    if (bytesRead < 24) return meta
    if (buf.toString('latin1', 0, 4) !== 'GGUF') return meta

    let offset = 24
    const kvCount = Number(buf.readBigUInt64LE(16))
    let embeddingLength: number | null = null
    let headCount: number | null = null

    for (let i = 0; i < kvCount; i++) {
      if (offset + 8 > bytesRead) break
      const keyLen = Number(buf.readBigUInt64LE(offset)); offset += 8
      if (offset + keyLen + 4 > bytesRead) break
      const key = buf.toString('utf8', offset, offset + keyLen); offset += keyLen
      const valueType = buf.readUInt32LE(offset); offset += 4

      if (valueType === 4 || valueType === 5) {
        const value = buf.readUInt32LE(offset)
        if (key.endsWith('.block_count')) meta.layers = value
        else if (key.endsWith('.attention.head_count_kv')) meta.kvHeads = value
        else if (key.endsWith('.embedding_length')) embeddingLength = value
        else if (key.endsWith('.attention.head_count')) headCount = value
      }

      if (valueType === 8) {
        if (offset + 8 > bytesRead) break
        const len = Number(buf.readBigUInt64LE(offset)); offset += 8 + len
      } else if (valueType === 9) {
        if (offset + 12 > bytesRead) break
        const elemType = buf.readUInt32LE(offset); offset += 4
        const count = Number(buf.readBigUInt64LE(offset)); offset += 8
        if (elemType === 8) {
          for (let j = 0; j < count; j++) {
            if (offset + 8 > bytesRead) break
            const len = Number(buf.readBigUInt64LE(offset)); offset += 8 + len
          }
        } else {
          const size = GGUF_SCALAR_SIZES[elemType]
          if (!size) break
          offset += size * count
        }
      } else {
        const size = GGUF_SCALAR_SIZES[valueType]
        if (!size) break
        offset += size
      }
    }
    // head_dim = embedding_length / attention.head_count
    if (embeddingLength !== null && headCount !== null && headCount > 0) {
      meta.headDim = Math.round(embeddingLength / headCount)
    }
    return meta
  } catch {
    return meta
  } finally {
    await file?.close()
  }
}

/**
 * 估算 KV 缓存每 token 占多少字节（f16）。
 * KV cache = layers × kv_heads × head_dim × 2(K+V) × 2bytes(f16)
 */
export function kvBytesPerToken(meta: GgufMeta): number | null {
  if (meta.layers === null || meta.kvHeads === null || meta.headDim === null || meta.headDim <= 0) return null
  return meta.layers * meta.kvHeads * meta.headDim * 2 * 2
}

/* ── 输出解析 ── */

type BenchParse = { tg: number; pp: number; paramsB: number | null; sizeMB: number | null; error: string | null; crashed?: boolean }

function parseBenchOutput(output: string): BenchParse {
  // -r 2 时每个档位输出多行（每 rep 一行），全部收集求平均降噪
  const tgValues: number[] = []
  const ppValues: number[] = []
  for (const line of output.split(/\r?\n/)) {
    // tg/pp 行可能是 `tg128` 或带深度的 `tg128 @ d32768`，都认
    const tgMatch = /\btg\d+(?:\s*@\s*d\d+)?\s*\|\s*([\d.]+)/.exec(line)
    if (tgMatch?.[1]) tgValues.push(parseFloat(tgMatch[1]))
    const ppMatch = /\bpp\d+(?:\s*@\s*d\d+)?\s*\|\s*([\d.]+)/.exec(line)
    if (ppMatch?.[1]) ppValues.push(parseFloat(ppMatch[1]))
  }
  const avg = (values: number[]) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0)
  // 兼容 MiB 和 GiB 两种体积格式（小模型 MiB、大模型 GiB）
  const paramsMatch = /\|\s*([\d.]+)\s*(MiB|GiB)\s*\|\s*([\d.]+)\s*([MB])\s*\|/.exec(output)
  const sizeValue = paramsMatch?.[1] ? parseFloat(paramsMatch[1]) : null
  const sizeUnit = paramsMatch?.[2]
  return {
    tg: avg(tgValues),
    pp: avg(ppValues),
    paramsB: paramsMatch?.[3] ? (paramsMatch[4] === 'B' ? parseFloat(paramsMatch[3]) : parseFloat(paramsMatch[3]) / 1000) : null,
    sizeMB: sizeValue !== null ? (sizeUnit === 'GiB' ? sizeValue * 1024 : sizeValue) : null,
    error: null,
  }
}

/** 把 llama-bench 的 stderr 错误翻成人话 */
function humanizeBenchError(stderr: string): string | null {
  if (/ErrorOutOfDeviceMemory|out of (device )?memory/i.test(stderr)) {
    return '显存不足——当前上下文太大，KV 缓存装不进显存。请换更小的上下文或更低的硬件使用率再试。'
  }
  const errorLine = stderr.split(/\r?\n/).find((line) => /error|failed/i.test(line))
  return errorLine ?? null
}

/* ── 单次跑分 ── */

function runBenchOnce(
  modelPath: string,
  benchExePath: string,
  ngl: string,
  threads: number,
  ctxSize: number,
  timeoutMs: number = BENCH_TIMEOUT_MS,
): Promise<BenchParse> {
  return new Promise((resolve) => {
    const args = [
      '-m', modelPath,
      '-ngl', ngl,
      '-t', String(threads),
      '-p', String(BENCH_PROMPT_TOKENS),
      '-n', String(BENCH_GEN_TOKENS),
      '-d', String(ctxSize),
      '-r', String(BENCH_REPS),
    ]

    let stdout = ''
    let stderr = ''
    let child: ChildProcess | null = null
    let finished = false

    const finish = (result: BenchParse) => {
      if (finished) return
      finished = true
      if (child && child.exitCode === null) child.kill()
      resolve(result)
    }

    try {
      child = spawn(benchExePath, args, {
        cwd: path.dirname(benchExePath),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      return finish({ tg: 0, pp: 0, paramsB: null, sizeMB: null, error: 'llama-bench 启动失败' })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    const timeout = setTimeout(() => finish({ tg: 0, pp: 0, paramsB: null, sizeMB: null, error: '跑分超时（模型或上下文太大）' }), timeoutMs)
    child.once('close', (code) => {
      clearTimeout(timeout)
      const parsed = parseBenchOutput(stdout)
      if (parsed.tg === 0) {
        // 进程崩溃（如 STATUS_STACK_BUFFER_OVERRUN）会给出非零退出码且无输出。
        // 用 crashed 标记，让主流程能降级到 CPU 重测而不是当成「没有产出结果」。
        if (code !== 0 && code !== null) parsed.crashed = true
        parsed.error = humanizeBenchError(stderr) ?? 'llama-bench 没有产出结果'
      }
      finish(parsed)
    })
    child.once('error', () => {
      clearTimeout(timeout)
      finish({ tg: 0, pp: 0, paramsB: null, sizeMB: null, error: 'llama-bench 进程出错' })
    })
  })
}

function detectGpuFromBench(benchExePath: string): boolean {
  try {
    const result = spawnSync(benchExePath, ['--list-devices'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    return /(?:Vulkan|CUDA)\d+:/i.test(result.stdout ?? '')
  } catch {
    return false
  }
}

/**
 * 真跑一次 GPU 推理，探测这张卡能不能真扛住（不是只列出来）。
 * GTX 750 这类无 fp16 的老卡，`--list-devices` 能列出，但真跑大深度就崩。
 * 用实际要用的 ngl 和深度探测，返回 true = GPU 可用。
 */
export async function probeGpuUsable(modelPath: string, benchExePath: string, ngl: string, threads: number, depth: number): Promise<boolean> {
  const result = await runBenchOnce(modelPath, benchExePath, ngl, threads, depth, PROBE_TIMEOUT_MS)
  return result.tg > 0 && !result.crashed
}

/* ── 主流程：按用户复合目标（速度 + 上下文 + 使用率）实测，达不到就上调使用率 ── */

export async function runBenchmark(
  input: BenchmarkRunInput,
  benchExePath: string,
  onProgress?: BenchmarkProgressHandler,
): Promise<BenchmarkRunResult> {
  const empty: BenchmarkRunResult = {
    modelParamsB: null,
    modelSizeMB: null,
    ppTokensPerSec: 0,
    maxTgTokensPerSec: 0,
    steps: [],
    recommendedStep: null,
    contextFit: { kvBytesPerToken: null, kvCacheGB: null, availableVramGB: 0, availableRamGB: 0, gpuUsable: false, fits: true },
    contextTooSmall: false,
    note: null,
    mode: 'cpu',
    error: null,
  }
  if (!existsSync(benchExePath)) {
    return { ...empty, error: `Benchmark binary not found: ${benchExePath}` }
  }
  if (!existsSync(input.modelPath)) {
    return { ...empty, error: `Model file not found: ${input.modelPath}` }
  }

  const hasGpu = detectGpuFromBench(benchExePath)
  const ggufMeta = await readGgufMeta(input.modelPath)
  const layers = ggufMeta.layers

  // Claude Code 的系统提示词 + 工具定义 + Skills 就要 ~30K tokens。
  // 上下文小于这个值，模型启动成功但真实请求会被拒（29975 tokens 的请求在 8K 里放不下）。
  const MIN_USABLE_CONTEXT = 32768
  const contextTooSmall = input.ctxSize < MIN_USABLE_CONTEXT

  // 速度测试用小深度，够测出真实的 token 生成速度，又不会把弱硬件卡死。
  // 上下文可行性不依赖这里——它用下面的内存账算。
  const benchDepth = 512

  // 跑分固定测两档：67% 与 100%。不需要用户选目标速度。
  // 67% 是实测甜点档（作者经验值）：线程/层数拉满并不一定最快——SMT 超线程
  // 和显存/内存带宽会在 100% 附近拖后腿，2/3 处往往才是每瓦每周期最优点。
  // 两档都实测，取快的那个推荐，不押注任何一档。
  const usageSteps: number[] = [2 / 3, 1.0]

  // 先用 CPU 探测一次，看这张卡能不能真跑（不是只列出来）。
  // GTX 750 这类无 fp16 的老卡，`--list-devices` 能列出，但真跑大深度就崩——探测失败就全程用 CPU。
  const probeThreads = Math.max(1, Math.round(input.threads * 0.5))
  const probeNgl = layers && layers > 0 ? String(Math.max(1, Math.round(layers * 0.5))) : '1'
  const gpuUsable = hasGpu && await probeGpuUsable(input.modelPath, benchExePath, probeNgl, probeThreads, benchDepth)
  const gpuNote = hasGpu && !gpuUsable
    ? '检测到你的显卡跑不动这个模型（GPU 推理崩溃），已自动改用纯 CPU 测速。'
    : null

  // 上下文可行性：KV 缓存大小 vs 预算。GPU 可用时 KV 落在显存，纯 CPU 模式
  // 落在内存——拿显存说事会误导（GTX 750 显存 4GB 却跑不动 GPU 推理）。
  const kvBytes = kvBytesPerToken(ggufMeta)
  const kvCacheGB = kvBytes !== null ? (input.ctxSize * kvBytes) / (1024 ** 3) : null
  let availableVramGB = 0
  if (hasGpu) {
    try {
      const result = spawnSync(benchExePath, ['--list-devices'], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      })
      const match = /\((\d+)\s*MiB/.exec(result.stdout ?? '')
      if (match?.[1]) availableVramGB = parseInt(match[1], 10) / 1024
    } catch { /* 无显存信息就当 0 */ }
  }
  const availableRamGB = os.totalmem() / 1024 ** 3
  // 预算与渲染端 planContextSize 对齐：显存留 10% 余量；内存按 67% 算（作者实测甜点比例，
  // 55% 过于保守——16GB 机器明明装得下 32K 却被误判偏小）
  const contextBudgetGB = gpuUsable ? availableVramGB * 0.9 : availableRamGB * 0.67
  const contextFit = {
    kvBytesPerToken: kvBytes,
    kvCacheGB,
    availableVramGB,
    availableRamGB,
    gpuUsable,
    fits: kvCacheGB !== null ? kvCacheGB <= contextBudgetGB : true,
  }

  const results: BenchmarkStepResult[] = []
  let pp = 0
  let modelParamsB: number | null = null
  let modelSizeMB: number | null = null
  // 推荐 = 最快的那个档（不是按目标速度，是按机器实测的最快档）
  let recommendedStep: BenchmarkStepResult | null = null

  for (let i = 0; i < usageSteps.length; i++) {
    const usage = usageSteps[i]!
    let ngl: string
    let threads: number
    let label: string
    if (gpuUsable) {
      threads = Math.max(1, Math.round(input.threads * usage))
      if (layers && layers > 0) {
        ngl = String(Math.max(1, Math.round(layers * usage)))
      } else {
        ngl = usage >= 1 ? '-1' : String(Math.max(1, Math.round(usage * 99)))
      }
      label = `GPU ${Math.round(usage * 100)}%`
    } else {
      ngl = '0'
      threads = Math.max(1, Math.round(input.threads * usage))
      label = `CPU ${Math.round(usage * 100)}%（${threads} 线程）`
    }

    onProgress?.({ current: i + 1, total: usageSteps.length, label })

    const run = await runBenchOnce(input.modelPath, benchExePath, ngl, threads, benchDepth)
    if (run.pp > 0) pp = run.pp
    if (run.paramsB !== null) modelParamsB = run.paramsB
    if (run.sizeMB !== null) modelSizeMB = run.sizeMB

    // GPU 档崩溃（进程以非零码退出且无输出）：改用纯 CPU 重测这一档，别让跑分卡死。
    // GTX 750 这类无 fp16 的老显卡跑大深度 + 高 GPU 层会触发 llama.cpp 崩溃。
    if (run.crashed && gpuUsable) {
      const cpuRun = await runBenchOnce(input.modelPath, benchExePath, '0', threads, benchDepth)
      if (cpuRun.tg > 0) {
        // CPU 能跑——把这一档记为 CPU 实测。
        run.tg = cpuRun.tg
        run.pp = cpuRun.pp
      }
    }

    // 硬错误（显存不足/超时/崩溃后 CPU 仍失败）：立即停，把原因告诉用户，别再把后面的档位挨个跑一遍
    if (run.tg === 0 && run.error) {
      return {
        modelParamsB,
        modelSizeMB,
        ppTokensPerSec: pp,
        maxTgTokensPerSec: Math.max(0, ...results.map((r) => r.tgTokensPerSec)),
        steps: results,
        recommendedStep: null,
        contextFit,
        contextTooSmall,
        note: gpuNote,
        mode: resolveBenchmarkRunMode(gpuUsable, recommendedStep?.ngl, ggufMeta.layers),
        error: run.error,
      }
    }

    const stepResult: BenchmarkStepResult = {
      label,
      usage,
      ngl,
      threads,
      tgTokensPerSec: run.tg,
    }
    results.push(stepResult)
    // 推荐 = 最快的那个档
    if (recommendedStep === null || run.tg > recommendedStep.tgTokensPerSec) {
      recommendedStep = stepResult
    }

    // 跑完一档就停（只测 CPU 50% 和 100%，不需要更多）
    if (i === 1) break
  }

  const maxTg = Math.max(0, ...results.map((r) => r.tgTokensPerSec))

  return {
    modelParamsB,
    modelSizeMB,
    ppTokensPerSec: pp,
    maxTgTokensPerSec: maxTg,
    steps: results,
    recommendedStep,
    contextFit,
    contextTooSmall,
    note: gpuNote,
    mode: resolveBenchmarkRunMode(gpuUsable, recommendedStep?.ngl, ggufMeta.layers),
    error: maxTg === 0 ? '跑分没有产出结果，请检查模型文件是否有效' : null,
  }
}
