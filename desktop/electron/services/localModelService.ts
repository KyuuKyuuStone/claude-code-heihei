import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/**
 * Local model inference engine management.
 *
 * Wraps a bundled llama.cpp `llama-server` binary: the desktop host starts it
 * pointed at a user-chosen GGUF file, polls its `/health` endpoint until the
 * model is loaded, and exposes the resulting localhost port so the renderer can
 * register it as an `anthropic`-format provider.
 */

export type LocalModelStartInput = {
  modelPath: string
  /** Context window size in tokens. */
  ctxSize: number
  /** CPU thread count. */
  threads: number
  /** GPU layer offload: 'auto', 'all', or a numeric string. */
  nGpuLayers: string
  /** Logical batch size. */
  batchSize?: number
  /** KV cache K type (e.g. 'f16', 'q8_0', 'q4_0'). */
  cacheTypeK?: string
  /** KV cache V type. */
  cacheTypeV?: string
  /** Enable Flash Attention. */
  flashAttn?: boolean
  /** Sampling temperature. */
  temperature?: number
  /** top-k sampling. */
  topK?: number
  /** top-p sampling. */
  topP?: number
  /** min-p sampling. */
  minP?: number
  /** Repeat penalty. */
  repeatPenalty?: number
  /** Max tokens to predict (-1 = unlimited). */
  maxPredict?: number
  /** Custom engine directory (e.g. an official CUDA build); empty = bundled engine. */
  engineDir?: string
  /** Multimodal projector (mmproj) GGUF for vision models; empty = text-only. */
  mmprojPath?: string
  /** Reuse cached KV for the unchanged conversation prefix (--cache-reuse). */
  cacheReuse?: boolean
  /** Draft model for speculative decoding (--model-draft). */
  draftModelPath?: string
  /** Keep MoE expert weights on CPU for the first N layers (--n-cpu-moe). */
  nCpuMoe?: string
}

export type LocalModelState = 'stopped' | 'starting' | 'running' | 'error'

export type LocalModelStatus = {
  state: LocalModelState
  port: number | null
  modelPath: string | null
  error: string | null
  logTail: string
  /** Parsed from engine logs, e.g. "33/37" — how many layers actually went to GPU. */
  gpuSplit: string | null
}

const STARTUP_TIMEOUT_MS = 120_000
const HEALTH_POLL_MS = 250
const LOG_TAIL_LINES = 40

function isRunningStatus(state: LocalModelState): boolean {
  return state === 'starting' || state === 'running'
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate a local port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function healthProbe(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      (response) => {
        response.resume()
        resolve(response.statusCode === 200)
      },
    )
    request.on('error', () => resolve(false))
    request.on('timeout', () => {
      request.destroy()
      resolve(false)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function resolveLlamaServerExecutable(desktopRoot: string): string {
  return path.join(desktopRoot, 'src-tauri', 'binaries', 'llama-server', 'llama-server.exe')
}

export function resolveVulkanExecutable(desktopRoot: string): string {
  return path.join(desktopRoot, 'src-tauri', 'binaries', 'llama-server-vulkan', 'llama-server.exe')
}

/** Detect a discrete GPU via the Vulkan build's `--list-devices` output (NVIDIA / AMD / Intel). */
export function detectGpu(vulkanExePath: string): boolean {
  if (!existsSync(vulkanExePath)) return false
  try {
    const result = spawnSync(vulkanExePath, ['--list-devices'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    return /(?:Vulkan|CUDA)\d+:/i.test(result.stdout ?? '')
  } catch {
    return false
  }
}

export type LocalModelHardware = {
  cpuCores: number
  memoryGB: number
  gpu: { name: string; vramMB: number } | null
}

/**
 * Collect the machine's performance envelope so the UI can recommend a tier:
 * CPU cores + total RAM, plus the discrete GPU's name and VRAM when present.
 */
export function detectHardware(vulkanExePath: string): LocalModelHardware {
  const cpuCores = os.cpus().length
  const memoryGB = Math.round(os.totalmem() / 1024 / 1024 / 1024)
  const gpu = detectGpuInfo(vulkanExePath)
  return { cpuCores, memoryGB, gpu }
}

function detectGpuInfo(vulkanExePath: string): { name: string; vramMB: number } | null {
  if (!existsSync(vulkanExePath)) return null
  try {
    const result = spawnSync(vulkanExePath, ['--list-devices'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    // e.g. "Vulkan0: NVIDIA GeForce RTX 3050 (6216 MiB, 5439 MiB free)"
    const match = (result.stdout ?? '').match(/(?:Vulkan|CUDA)\d+:\s*(.+?)\s*\((\d+)\s*MiB/i)
    if (!match) return null
    const name = match[1]?.trim() ?? ''
    const vramMB = parseInt(match[2] ?? '0', 10)
    if (!name || !Number.isFinite(vramMB)) return null
    return { name, vramMB }
  } catch {
    return null
  }
}

export class LocalModelService {
  private child: ChildProcess | null = null
  private port: number | null = null
  private state: LocalModelState = 'stopped'
  private modelPath: string | null = null
  private error: string | null = null
  private logLines: string[] = []
  private gpuSplit: string | null = null

  status(): LocalModelStatus {
    return {
      state: this.state,
      port: this.port,
      modelPath: this.modelPath,
      error: this.error,
      logTail: this.logLines.slice(-LOG_TAIL_LINES).join('\n'),
      gpuSplit: this.gpuSplit,
    }
  }

  isRunning(): boolean {
    return isRunningStatus(this.state)
  }

  async start(input: LocalModelStartInput, serverExePath: string, note?: string): Promise<LocalModelStatus> {
    if (this.isRunning()) {
      throw new Error('A local model engine is already running')
    }
    if (!existsSync(serverExePath)) {
      return this.fail(`Local model engine binary not found: ${serverExePath}`)
    }
    if (!existsSync(input.modelPath)) {
      return this.fail(`Model file not found: ${input.modelPath}`)
    }

    this.state = 'starting'
    this.modelPath = input.modelPath
    this.error = null
    this.logLines = note ? [`[cc-heihei] ${note}`] : []
    this.gpuSplit = null

    // 内存不足自动降档：启动阶段进程直接退出（显存/内存装不下）时按梯度重试，
    // 而不是把错误甩给用户——GPU 配置先退纯 CPU，再不够就砍半上下文。
    // 超时（模型太大加载慢）不重试，重试只会更慢。
    const attempts: Array<{ input: LocalModelStartInput, note: string | null }> = [{ input, note: null }]
    if (input.nGpuLayers !== '0') {
      attempts.push({
        input: { ...input, nGpuLayers: '0' },
        note: 'GPU 配置启动失败（多为显存装不下），已自动改用纯 CPU 重试。',
      })
    }
    if (input.ctxSize > 8192) {
      const halvedCtx = Math.max(8192, Math.floor(input.ctxSize / 2))
      const base = attempts[attempts.length - 1]!.input
      attempts.push({
        input: { ...base, ctxSize: halvedCtx },
        note: `仍然失败，已自动把上下文降到 ${Math.round(halvedCtx / 1024)}K 重试。`,
      })
    }

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i]!
      if (attempt.note) this.logLines.push(`[cc-heihei] ${attempt.note}`)
      const outcome = await this.launchOnce(attempt.input, serverExePath)
      if (outcome.ok) return this.status()
      if (!outcome.retryable) break
    }
    return this.fail(this.error ?? 'Local model engine failed to start')
  }

  private async launchOnce(input: LocalModelStartInput, serverExePath: string): Promise<{ ok: true } | { ok: false, retryable: boolean }> {
    let port: number
    try {
      port = await findFreePort()
    } catch (error) {
      this.error = `Failed to allocate a port: ${error instanceof Error ? error.message : String(error)}`
      return { ok: false, retryable: false }
    }
    this.port = port

    const args = [
      '-m', input.modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--ctx-size', String(input.ctxSize),
      '--threads', String(input.threads),
      '--n-gpu-layers', input.nGpuLayers,
      '--jinja',
    ]
    if (input.batchSize !== undefined) args.push('--batch-size', String(input.batchSize))
    if (input.mmprojPath) args.push('--mmproj', input.mmprojPath)
    if (input.cacheReuse) args.push('--cache-reuse', '256')
    if (input.draftModelPath) args.push('--model-draft', input.draftModelPath)
    if (input.nCpuMoe) args.push('--n-cpu-moe', input.nCpuMoe)
    if (input.cacheTypeK) args.push('--cache-type-k', input.cacheTypeK)
    if (input.cacheTypeV) args.push('--cache-type-v', input.cacheTypeV)
    if (input.flashAttn) args.push('--flash-attn', 'on')
    if (input.temperature !== undefined) args.push('--temp', String(input.temperature))
    if (input.topK !== undefined) args.push('--top-k', String(input.topK))
    if (input.topP !== undefined) args.push('--top-p', String(input.topP))
    if (input.minP !== undefined) args.push('--min-p', String(input.minP))
    if (input.repeatPenalty !== undefined) args.push('--repeat-penalty', String(input.repeatPenalty))
    if (input.maxPredict !== undefined) args.push('--n-predict', String(input.maxPredict))

    const child = spawn(serverExePath, args, {
      cwd: path.dirname(serverExePath),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.logLines.push(...text.split(/\r?\n/).filter((line) => line.length > 0))
      if (this.logLines.length > LOG_TAIL_LINES * 4) {
        this.logLines = this.logLines.slice(-LOG_TAIL_LINES * 2)
      }
      // e.g. "offloaded 33/37 layers to GPU" — surfaces the real GPU/CPU split in the UI
      const splitMatch = /offloaded\s+(\d+)\/(\d+)\s+layers?\s+to\s+GPU/i.exec(text)
      if (splitMatch) this.gpuSplit = `${splitMatch[1]}/${splitMatch[2]}`
    })

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        this.error = `Local model engine exited during startup (code ${child.exitCode})`
        return { ok: false, retryable: true }
      }
      const healthy = await healthProbe(port, HEALTH_POLL_MS * 4)
      if (healthy) {
        this.state = 'running'
        return { ok: true }
      }
      await sleep(HEALTH_POLL_MS)
    }

    this.error = `Local model engine timed out after ${STARTUP_TIMEOUT_MS / 1000}s`
    return { ok: false, retryable: false }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.port = null
    this.state = 'stopped'
    this.modelPath = null
    this.error = null
    this.gpuSplit = null

    if (!child || child.exitCode !== null) return

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
      }, 5000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      child.kill()
    })
  }

  private fail(message: string): LocalModelStatus {
    this.state = 'error'
    this.error = message
    return this.status()
  }
}
