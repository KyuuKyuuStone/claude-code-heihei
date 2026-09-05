import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { Switch } from '@/components/ui/Switch'
import { StatusDot } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { SettingsPageHeader, SettingsSection, SettingsStat } from '@/components/settings/SettingsSection'
import { getDesktopHost } from '../lib/desktopHost'
import { useTranslation } from '../i18n'
import type {
  LocalModelBenchmarkProgress,
  LocalModelHardware,
  LocalModelStatus,
} from '../lib/desktopHost/types'
import type { LocalModelBenchmarkOutput } from '../lib/desktopHost/types'
import { useProviderStore } from '../stores/providerStore'

/** GGUF 下载论坛 / 网站：跳转链接 + 一句话介绍 */
const GGUF_DOWNLOAD_SITES = [
  {
    name: 'Hugging Face',
    intro: '全球最大的开源模型仓库，几乎所有 GGUF 模型都在这里发布，按库名/大小筛选，搜 “GGUF” 即可。',
    url: 'https://huggingface.co/models?library=gguf',
    tag: '最全',
  },
  {
    name: 'ModelScope（魔搭）',
    intro: '阿里云开源社区，国内访问稳定、下载快，中文模型、量化 GGUF 资源丰富。',
    url: 'https://modelscope.cn/models?name=gguf',
    tag: '国内快',
  },
  {
    name: 'Ollama Library',
    intro: 'Ollama 官方模型库，名字就是模型标签，用 `ollama pull` 或 UI 一键下载任意 GGUF。',
    url: 'https://ollama.com/library',
    tag: '一键',
  },
  {
    name: 'LM Studio',
    intro: '图形化模型管理工具，内置模型浏览、GGUF 下载与运行，适合新手。',
    url: 'https://lmstudio.ai/models',
    tag: '易上手',
  },
] as const

const CONFIGS_STORAGE_KEY = 'cc-heihei-local-model-configs'
const CURRENT_CONFIG_STORAGE_KEY = 'cc-heihei-local-model-current'

const STATE_DOT_TONE = {
  stopped: 'neutral',
  starting: 'info',
  running: 'success',
  error: 'danger',
} as const

type AdvancedConfig = {
  ctxSize: string
  threads: string
  nGpuLayers: string
  batchSize: string
  cacheTypeK: string
  cacheTypeV: string
  flashAttn: boolean
  temperature: string
  topK: string
  topP: string
  minP: string
  repeatPenalty: string
  maxPredict: string
  /** 自定义引擎目录（如官方 CUDA 版 llama.cpp），留空用内置引擎 */
  engineDir: string
  /** 多模态投影文件（mmproj .gguf），配了视觉模型才能看图 */
  mmprojPath: string
}

/** 一套完整的本地模型配置方案：模型文件 + 全部参数 */
export type LocalModelConfig = AdvancedConfig & {
  id: string
  name: string
  modelPath: string
}

const DEFAULT_ADVANCED: AdvancedConfig = {
  ctxSize: '32768',
  threads: '4',
  nGpuLayers: 'auto',
  batchSize: '1024',
  cacheTypeK: 'f16',
  cacheTypeV: 'f16',
  flashAttn: true,
  temperature: '0.8',
  topK: '40',
  topP: '0.95',
  minP: '0.05',
  repeatPenalty: '1.0',
  maxPredict: '-1',
  engineDir: '',
  mmprojPath: '',
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseFloatOr(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function modelNameFromPath(modelPath: string): string {
  const base = modelPath.split(/[\\/]/).pop() ?? 'local-model'
  return base.replace(/\.gguf$/i, '') || 'local-model'
}

/**
 * 从模型文件名估算能力档，管理用户预期：小模型聊天没问题，但工具调用
 * （agentic）是另一回事——不提前说清，用户会把"模型笨"误解成"软件不行"。
 * 文件名认不出参数规模时如实说"未知"，让跑分数据说话。
 */
function describeModelCapability(modelPath: string): { label: string; hint: string } {
  const base = modelNameFromPath(modelPath)
  const name = base.toLowerCase()
  // 去掉量化标签（Q4_K_M / IQ3_XS 等）再认参数规模
  const cleaned = base.replace(/-?q\d[_a-z0-9]*|-?iq\d[_a-z0-9]*/gi, '')
  const paramsMatch = /(\d+(?:\.\d+)?)\s*[eE]?[bB](?![a-zA-Z])/.exec(cleaned)
  const paramsB = paramsMatch?.[1] ? parseFloat(paramsMatch[1]) : null

  let label: string
  let hint: string
  if (paramsB === null) {
    label = '能力未知'
    hint = '没从文件名认出参数规模，请以跑分实测为准'
  } else if (paramsB < 4) {
    label = '适合聊天 · 轻任务'
    hint = '日常问答够用，复杂工具调用容易翻车'
  } else if (paramsB < 14) {
    label = /coder|code/.test(name) ? '能扛工具调用' : '可尝试工具调用'
    hint = /coder|code/.test(name)
      ? '代码/工具调用方向的小钢炮'
      : '简单工具任务可以，多步任务不要太指望'
  } else {
    label = '能扛工具调用'
    hint = '参数够大，工具调用和多步任务比较稳'
  }
  // 多模态家族：本地看图需要 mmproj 投影文件，没配就是"看不见图"
  if (/-vl|vision|llava|minicpm-v|gemma-3n|\d+e\d+b/i.test(base)) {
    hint += '；疑似多模态模型，本地看图需要配套 mmproj 投影文件，否则看不见图片'
  }
  return { label, hint }
}

/** 按当前硬件给新建方案的参数起点（67% 线程甜点比例；无独显直接纯 CPU） */
function hardwareStartPoint(hardware: LocalModelHardware | null): AdvancedConfig {
  const cores = hardware?.cpuCores ?? 4
  return {
    ...DEFAULT_ADVANCED,
    threads: String(Math.max(1, Math.round(cores * 0.67))),
    nGpuLayers: hardware?.gpu ? 'auto' : '0',
  }
}

/**
 * 按机器实际内存/显存规划上下文推荐值，不是写死的。
 *
 * Claude Code 的真实负载（系统提示 + 工具定义 + Skills）需要 ≥32K 上下文，
 * 所以 32K 是默认推荐；但 KV 缓存 + 模型权重必须装进预算——GPU 可用时按显存
 * 算，纯 CPU 模式按内存算。装不下 32K 就按 4K 步进下调，下限 8K（低于 8K 连
 * 引擎启动校验都过不了）。
 */
function planContextSize(
  kvBytesPerToken: number | null,
  modelSizeMB: number | null,
  memoryGB: number,
  vramMB: number,
): number {
  const RECOMMENDED_CTX = 32768
  const FLOOR_CTX = 8192
  if (!kvBytesPerToken || kvBytesPerToken <= 0) return RECOMMENDED_CTX
  const budgetBytes = vramMB > 0
    ? vramMB * 1024 * 1024 * 0.9
    : memoryGB * 1024 ** 3 * 0.67
  const modelBytes = (modelSizeMB ?? 0) * 1024 * 1024
  const availableTokens = Math.floor((budgetBytes - modelBytes) / kvBytesPerToken)
  const planned = Math.floor(availableTokens / 4096) * 4096
  return Math.max(FLOOR_CTX, Math.min(RECOMMENDED_CTX, planned))
}

function loadConfigs(): LocalModelConfig[] {
  try {
    const raw = localStorage.getItem(CONFIGS_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persistConfigs(configs: LocalModelConfig[]) {
  try {
    localStorage.setItem(CONFIGS_STORAGE_KEY, JSON.stringify(configs))
  } catch { /* ignore */ }
}

function loadCurrentConfigId(): string | null {
  try {
    return localStorage.getItem(CURRENT_CONFIG_STORAGE_KEY)
  } catch {
    return null
  }
}

function persistCurrentConfigId(id: string | null) {
  try {
    if (id) localStorage.setItem(CURRENT_CONFIG_STORAGE_KEY, id)
    else localStorage.removeItem(CURRENT_CONFIG_STORAGE_KEY)
  } catch { /* ignore */ }
}

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[170px_1fr] items-center gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-[var(--color-text-secondary)]">{label}</div>
        {hint ? <div className="mt-0.5 text-[11px] leading-4 text-[var(--color-text-tertiary)]">{hint}</div> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** 细节参数编辑区（新建/修改方案 Modal 共用） */
function AdvancedFields({ adv, onChange, onPickMmproj }: { adv: AdvancedConfig; onChange: <K extends keyof AdvancedConfig>(key: K, value: AdvancedConfig[K]) => void; onPickMmproj: () => void }) {
  return (
    <div className="space-y-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--color-text-tertiary)]">
        引擎参数（改完需重启引擎生效）
      </div>
      <FieldRow label="引擎目录" hint="留空用内置引擎。NVIDIA 显卡可从 llama.cpp 官方 Releases 下载 CUDA 版（见「下载模型」里的指引），填其解压目录">
        <Input value={adv.engineDir} onChange={(e) => onChange('engineDir', e.target.value)} placeholder="默认内置引擎" />
      </FieldRow>
      <FieldRow label="视觉投影文件" hint="多模态模型看图必需（mmproj-*.gguf，和模型在同一个下载页）。留空 = 纯文本对话；配了它，带视觉的模型就能看图">
        <div className="flex items-center gap-2">
          <Input value={adv.mmprojPath} onChange={(e) => onChange('mmprojPath', e.target.value)} placeholder="纯文本对话（不看图）" className="flex-1" />
          <Button size="sm" variant="ghost" onClick={onPickMmproj}>选择文件</Button>
        </div>
      </FieldRow>
      <FieldRow label="上下文窗口" hint="模型能记住的对话长度，越大越占内存">
        <Input type="number" value={adv.ctxSize} onChange={(e) => onChange('ctxSize', e.target.value)} min={16000} max={1000000} />
      </FieldRow>
      <FieldRow label="CPU 线程数" hint="纯 CPU 算时的核数">
        <Input type="number" value={adv.threads} onChange={(e) => onChange('threads', e.target.value)} min={1} max={256} />
      </FieldRow>
      <FieldRow label="GPU 层数" hint="auto 为按显存自动分配，GPU+CPU 混合">
        <Input value={adv.nGpuLayers} onChange={(e) => onChange('nGpuLayers', e.target.value)} />
      </FieldRow>
      <FieldRow label="批处理大小" hint="一次前向计算的 token 批大小">
        <Input type="number" value={adv.batchSize} onChange={(e) => onChange('batchSize', e.target.value)} min={1} max={8192} />
      </FieldRow>
      <FieldRow label="KV cache K 类型" hint="f16 / q8_0 / q4_0（省显存）">
        <Input value={adv.cacheTypeK} onChange={(e) => onChange('cacheTypeK', e.target.value)} />
      </FieldRow>
      <FieldRow label="KV cache V 类型" hint="f16 / q8_0 / q4_0">
        <Input value={adv.cacheTypeV} onChange={(e) => onChange('cacheTypeV', e.target.value)} />
      </FieldRow>
      <FieldRow label="Flash Attention" hint="注意力加速">
        <Switch checked={adv.flashAttn} onChange={(v) => onChange('flashAttn', v)} label="Flash Attention" labelHidden />
      </FieldRow>

      <div className="border-t border-[var(--color-border)] pt-4 text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--color-text-tertiary)]">
        采样参数（影响生成质量与随机性）
      </div>
      <FieldRow label="温度（temperature）" hint="越高越随机，越低越稳定">
        <Input type="number" step="0.1" value={adv.temperature} onChange={(e) => onChange('temperature', e.target.value)} min={0} max={2} />
      </FieldRow>
      <FieldRow label="top-k" hint="只在前 k 个候选里选">
        <Input type="number" value={adv.topK} onChange={(e) => onChange('topK', e.target.value)} min={0} max={500} />
      </FieldRow>
      <FieldRow label="top-p" hint="累积概率截断">
        <Input type="number" step="0.01" value={adv.topP} onChange={(e) => onChange('topP', e.target.value)} min={0} max={1} />
      </FieldRow>
      <FieldRow label="min-p" hint="最小概率阈值">
        <Input type="number" step="0.01" value={adv.minP} onChange={(e) => onChange('minP', e.target.value)} min={0} max={1} />
      </FieldRow>
      <FieldRow label="重复惩罚" hint="抑制复读">
        <Input type="number" step="0.05" value={adv.repeatPenalty} onChange={(e) => onChange('repeatPenalty', e.target.value)} min={0} max={2} />
      </FieldRow>
      <FieldRow label="最大生成长度" hint="-1 = 不限">
        <Input type="number" value={adv.maxPredict} onChange={(e) => onChange('maxPredict', e.target.value)} min={-1} max={1000000} />
      </FieldRow>
    </div>
  )
}

export function LocalModelSettings() {
  const t = useTranslation()
  const host = getDesktopHost()
  const { providers, createProvider, updateProvider, activateProvider } = useProviderStore()

  const [configs, setConfigs] = useState<LocalModelConfig[]>([])
  const [currentConfigId, setCurrentConfigId] = useState<string | null>(null)
  const [hardware, setHardware] = useState<LocalModelHardware | null>(null)
  const [status, setStatus] = useState<LocalModelStatus>({
    state: 'stopped',
    port: null,
    modelPath: null,
    error: null,
    logTail: '',
  })
  const [busy, setBusy] = useState(false)

  // 新建/修改方案 Modal 状态
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftModelPath, setDraftModelPath] = useState('')
  const [draftAdv, setDraftAdv] = useState<AdvancedConfig>({ ...DEFAULT_ADVANCED })
  const [draftShowAdvanced, setDraftShowAdvanced] = useState(false)

  const [showModelGuideModal, setShowModelGuideModal] = useState(false)

  // 跑分状态
  const [showBenchmarkModal, setShowBenchmarkModal] = useState(false)
  const [benchmarkModelPath, setBenchmarkModelPath] = useState('')
  const [benchmarkRunning, setBenchmarkRunning] = useState(false)
  const [benchmarkOutput, setBenchmarkOutput] = useState<LocalModelBenchmarkOutput | null>(null)
  const [benchmarkProgress, setBenchmarkProgress] = useState<LocalModelBenchmarkProgress | null>(null)
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null)

  // 跑分结果 + 当前硬件 → 按内存/显存规划的上下文推荐值（GPU 不可用时 KV 落在内存，按内存预算）
  const plannedContext = useMemo(() => {
    if (!benchmarkOutput) return null
    return planContextSize(
      benchmarkOutput.contextFit.kvBytesPerToken,
      benchmarkOutput.modelSizeMB,
      benchmarkOutput.contextFit.availableRamGB,
      benchmarkOutput.contextFit.gpuUsable ? (hardware?.gpu?.vramMB ?? 0) : 0,
    )
  }, [benchmarkOutput, hardware])

  // KV 缓存预算：GPU 可用按显存 90%（留 10% 余量），纯 CPU 按内存 67%（甜点比例，与引擎侧一致）
  const contextBudgetGB = benchmarkOutput
    ? (benchmarkOutput.contextFit.gpuUsable
        ? benchmarkOutput.contextFit.availableVramGB * 0.9
        : benchmarkOutput.contextFit.availableRamGB * 0.67)
    : null

  const currentConfig = useMemo(
    () => configs.find((config) => config.id === currentConfigId) ?? null,
    [configs, currentConfigId],
  )
  const running = status.state === 'starting' || status.state === 'running'

  useEffect(() => {
    setConfigs(loadConfigs())
    setCurrentConfigId(loadCurrentConfigId())
    void host.localModel.status().then(setStatus).catch(() => undefined)
    void host.localModel.detectHardware().then(setHardware).catch(() => undefined)
    let unlisten: (() => void) | null = null
    void host.localModel.onBenchmarkProgress((progress) => setBenchmarkProgress(progress))
      .then((unsub) => { unlisten = unsub })
      .catch(() => undefined)
    return () => unlisten?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openNewConfigModal = () => {
    setEditingConfigId(null)
    setDraftName('')
    setDraftModelPath('')
    setDraftAdv(hardwareStartPoint(hardware))
    setDraftShowAdvanced(false)
    setShowConfigModal(true)
  }

  const openEditConfigModal = (config: LocalModelConfig) => {
    setEditingConfigId(config.id)
    setDraftName(config.name)
    setDraftModelPath(config.modelPath)
    const { id: _id, name: _name, modelPath: _m, ...adv } = config
    setDraftAdv({ ...DEFAULT_ADVANCED, ...adv })
    setDraftShowAdvanced(false)
    setShowConfigModal(true)
  }

  const pickDraftModel = async () => {
    const result = await host.dialogs.open({
      title: t('settings.localModel.pickModel'),
      filters: [{ name: 'GGUF', extensions: ['gguf'] }],
    })
    if (typeof result === 'string') setDraftModelPath(result)
  }

  const pickDraftMmproj = async () => {
    const result = await host.dialogs.open({
      title: '选择 mmproj 视觉投影文件',
      filters: [{ name: 'GGUF', extensions: ['gguf'] }],
    })
    if (typeof result === 'string') setDraftAdv((a) => ({ ...a, mmprojPath: result }))
  }

  const saveConfig = () => {
    const name = draftName.trim()
    if (!name || !draftModelPath.trim()) return
    const entry: LocalModelConfig = {
      id: editingConfigId ?? `${Date.now()}`,
      name,
      modelPath: draftModelPath.trim(),
      ...draftAdv,
    }
    const next = editingConfigId
      ? configs.map((item) => (item.id === editingConfigId ? entry : item))
      : [...configs.filter((item) => item.name !== name), entry]
    setConfigs(next)
    persistConfigs(next)
    if (!editingConfigId || currentConfigId === editingConfigId) {
      setCurrentConfigId(entry.id)
      persistCurrentConfigId(entry.id)
    }
    setShowConfigModal(false)
  }

  const applyConfig = (config: LocalModelConfig) => {
    setCurrentConfigId(config.id)
    persistCurrentConfigId(config.id)
  }

  const deleteConfig = (id: string) => {
    const next = configs.filter((item) => item.id !== id)
    setConfigs(next)
    persistConfigs(next)
    if (currentConfigId === id) {
      setCurrentConfigId(next[0]?.id ?? null)
      persistCurrentConfigId(next[0]?.id ?? null)
    }
  }

  const pickBenchmarkModel = async () => {
    const result = await host.dialogs.open({
      title: '选择要跑分的模型',
      filters: [{ name: 'GGUF', extensions: ['gguf'] }],
    })
    if (typeof result === 'string') setBenchmarkModelPath(result)
  }

  const runBenchmark = async () => {
    if (!benchmarkModelPath) return
    setBenchmarkRunning(true)
    setBenchmarkOutput(null)
    setBenchmarkError(null)
    setBenchmarkProgress(null)
    try {
      const output = await host.localModel.benchmark({
        modelPath: benchmarkModelPath,
        ctxSize: 32768,
        threads: hardware?.cpuCores ?? 4,
      })
      if (output.error) {
        setBenchmarkError(output.error)
      } else {
        setBenchmarkOutput(output)
      }
    } catch (error) {
      setBenchmarkError(error instanceof Error ? error.message : String(error))
    } finally {
      setBenchmarkRunning(false)
      setBenchmarkProgress(null)
    }
  }

  const applyBenchmarkResult = () => {
    if (!benchmarkOutput || !benchmarkModelPath) return
    const recommended = benchmarkOutput.recommendedStep ?? benchmarkOutput.steps[benchmarkOutput.steps.length - 1]
    if (!recommended) return
    const speed = recommended.tgTokensPerSec
    // 跑分标注了 GPU 降级（note 非空）说明 KV 缓存会落在内存里，按内存预算规划
    const ctx = plannedContext ?? 32768
    const modeLabel = benchmarkOutput.mode === 'gpu' ? 'GPU 全量' : benchmarkOutput.mode === 'hybrid' ? 'GPU+CPU 混合' : '纯 CPU'
    const entry: LocalModelConfig = {
      id: `${Date.now()}`,
      name: `${modelNameFromPath(benchmarkModelPath)} · ${modeLabel} · ${Math.round(ctx / 1024)}K · ${Math.round(speed)}t/s`,
      modelPath: benchmarkModelPath,
      // 与跑分实测一致：推荐档的线程/GPU 层数；Flash Attention 只在 GPU 路径有意义
      ...hardwareStartPoint(hardware),
      ctxSize: String(ctx),
      threads: String(recommended.threads),
      nGpuLayers: recommended.ngl,
      flashAttn: benchmarkOutput.mode !== 'cpu',
    }
    const next = [...configs, entry]
    setConfigs(next)
    persistConfigs(next)
    setCurrentConfigId(entry.id)
    persistCurrentConfigId(entry.id)
    setShowBenchmarkModal(false)
  }

  const registerLocalModelProvider = async (port: number, config: LocalModelConfig) => {
    const modelName = modelNameFromPath(config.modelPath)
    const ctx = parsePositiveInt(config.ctxSize, 32768)
    const baseUrl = `http://127.0.0.1:${port}`
    const models = { main: modelName, haiku: modelName, sonnet: modelName, opus: modelName }
    const existing = providers.find((provider) => provider.notes === 'local-model')
    const provider = existing
      ? await updateProvider(existing.id, { apiKey: 'local-model', baseUrl, models, modelContextWindows: { [modelName]: ctx } })
      : await createProvider({
          presetId: 'custom',
          name: '本地模型',
          apiKey: 'local-model',
          authStrategy: 'auth_token_empty_api_key',
          baseUrl,
          apiFormat: 'anthropic',
          models,
          modelContextWindows: { [modelName]: ctx },
          notes: 'local-model',
        })
    await activateProvider(provider.id)
  }

  const start = async () => {
    if (!currentConfig || !currentConfig.modelPath.trim()) return
    setBusy(true)
    try {
      const next = await host.localModel.start({
        modelPath: currentConfig.modelPath.trim(),
        ctxSize: parsePositiveInt(currentConfig.ctxSize, 32768),
        threads: parsePositiveInt(currentConfig.threads, 4),
        nGpuLayers: currentConfig.nGpuLayers.trim() || 'auto',
        batchSize: parsePositiveInt(currentConfig.batchSize, 1024),
        cacheTypeK: currentConfig.cacheTypeK.trim() || undefined,
        cacheTypeV: currentConfig.cacheTypeV.trim() || undefined,
        flashAttn: currentConfig.flashAttn,
        temperature: parseFloatOr(currentConfig.temperature, 0.8),
        topK: parsePositiveInt(currentConfig.topK, 40),
        topP: parseFloatOr(currentConfig.topP, 0.95),
        minP: parseFloatOr(currentConfig.minP, 0.05),
        repeatPenalty: parseFloatOr(currentConfig.repeatPenalty, 1.0),
        maxPredict: parseInt(currentConfig.maxPredict, 10),
        engineDir: currentConfig.engineDir?.trim() || undefined,
        mmprojPath: currentConfig.mmprojPath?.trim() || undefined,
      })
      setStatus(next)
      if (next.state === 'running' && next.port !== null) {
        await registerLocalModelProvider(next.port, currentConfig)
      }
    } catch (error) {
      setStatus((current) => ({
        ...current,
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    try {
      await host.localModel.stop()
      setStatus(await host.localModel.status())
    } catch (error) {
      setStatus((current) => ({
        ...current,
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setBusy(false)
    }
  }

  const downloadGuide = () => {
    setShowModelGuideModal(true)
  }

  return (
    <div className="max-w-2xl">
      <SettingsPageHeader
        title={t('settings.localModel.title')}
        description={t('settings.localModel.subtitle')}
        action={(
          <>
            <Button size="base" variant="ghost" onClick={() => setShowBenchmarkModal(true)} icon={<span className="material-symbols-outlined text-[16px]">speed</span>}>
              跑分
            </Button>
            <Button size="base" onClick={downloadGuide} icon={<span className="material-symbols-outlined text-[16px]">download</span>}>
              {t('settings.localModel.downloadGuide')}
            </Button>
          </>
        )}
      />

      {hardware && (
        <Card className="mb-8">
          <div className="grid grid-cols-3 gap-6">
            <SettingsStat label="CPU 核数" value={hardware.cpuCores} />
            <SettingsStat label="内存" value={`${hardware.memoryGB} GB`} />
            {hardware.gpu
              ? <SettingsStat label="显存" value={`${Math.round(hardware.gpu.vramMB / 1024)} GB`} hint={hardware.gpu.name} />
              : <SettingsStat label="显卡" value="无独显" hint="纯 CPU 运行" />}
          </div>
          <div className="mt-4 border-t border-[var(--color-border)] pt-4 text-[13px] leading-6 text-[var(--color-text-secondary)]">
            {hardware?.gpu
              ? '检测到独立显卡，引擎会实测确认可用后再用 GPU，跑不动自动退回纯 CPU。'
              : '无独立显卡，纯 CPU 运行。'}
            {plannedContext !== null
              ? ` · 按内存规划的上下文：${Math.round(plannedContext / 1024)}K`
              : ' · 点「跑分」实测这台机器跑当前模型的真实速度'}
            {benchmarkOutput && benchmarkOutput.modelParamsB !== null
              ? ` · 当前模型实测：${benchmarkOutput.modelParamsB.toFixed(2)}B 参数，生成 ${Math.round(benchmarkOutput.maxTgTokensPerSec)} t/s`
              : ''}
          </div>
        </Card>
      )}

      <SettingsSection
        title="配置方案"
        description="一套方案 = 模型文件 + 参数。参数起点按硬件自动填，跑分后一键应用实测最优值"
        action={(
          <Button size="base" onClick={openNewConfigModal} icon={<span className="material-symbols-outlined text-[16px]">add</span>}>
            新建方案
          </Button>
        )}
      >
        {configs.length > 0 ? (
          <div className="space-y-2">
            {configs.map((config) => {
              const isActive = config.id === currentConfigId
              return (
                <div
                  key={config.id}
                  className={`flex items-center gap-3 rounded-[var(--radius-md)] border px-3 py-2.5 text-[13px] ${
                    isActive
                      ? 'border-[var(--color-primary-fixed-dim)] bg-[var(--color-brand-soft)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-container-low)]'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-[var(--color-text-primary)]">{config.name}</span>
                      {isActive && (
                        <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--color-brand)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-surface)]">
                          使用中
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 truncate text-[11.5px] text-[var(--color-text-tertiary)]">
                      <span className="truncate">
                        {modelNameFromPath(config.modelPath)} · 上下文 {Math.round(parsePositiveInt(config.ctxSize, 32768) / 1024)}K · {config.threads} 线程
                      </span>
                      <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--color-surface-container-high)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
                        {describeModelCapability(config.modelPath).label}
                      </span>
                    </div>
                  </div>
                  <button className="text-xs text-[var(--color-text-accent)] hover:underline" onClick={() => applyConfig(config)} type="button" disabled={isActive}>
                    应用
                  </button>
                  <button className="text-xs text-[var(--color-text-secondary)] hover:underline" onClick={() => openEditConfigModal(config)} type="button">
                    修改
                  </button>
                  <button className="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-error)]" onClick={() => deleteConfig(config.id)} type="button">
                    删除
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-[12px] text-[var(--color-text-tertiary)]">
            还没有保存的方案。点「新建方案」建一套（选模型文件，参数起点自动按硬件填好），保存后点「应用」即可启用。
          </p>
        )}
      </SettingsSection>

      <Card>
        <div className="flex items-center gap-3">
          <StatusDot tone={STATE_DOT_TONE[status.state]} />
          <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
            {t(`settings.localModel.state.${status.state}`)}
          </span>
          <span className="text-[12px] text-[var(--color-text-tertiary)]">
            {currentConfig ? `方案：${currentConfig.name}` : '未选择方案'}
            {status.port !== null && status.state === 'running' && ` · 127.0.0.1:${status.port}`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {busy && <Spinner size={16} />}
            {running ? (
              <Button size="base" onClick={() => void stop()} disabled={busy}>
                {t('settings.localModel.stop')}
              </Button>
            ) : (
              <Button size="base" onClick={() => void start()} disabled={busy || !currentConfig} icon={<span className="material-symbols-outlined text-[16px]">play_arrow</span>}>
                {t('settings.localModel.start')}
              </Button>
            )}
          </div>
        </div>
        {status.error && (
          <p className="mt-3 text-[13px] text-[var(--color-error)]" role="alert">{status.error}</p>
        )}
        {status.logTail && (
          <pre className="mt-3 max-h-40 overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--color-text-secondary)]">
            {status.logTail}
          </pre>
        )}
      </Card>

      {/* 新建/修改方案 Modal */}
      <Modal
        open={showConfigModal}
        onClose={() => setShowConfigModal(false)}
        title={editingConfigId ? '修改配置方案' : '新建配置方案'}
        width={680}
        footer={(
          <>
            <Button size="base" variant="ghost" onClick={() => setShowConfigModal(false)}>
              取消
            </Button>
            <Button size="base" onClick={saveConfig} disabled={!draftName.trim() || !draftModelPath.trim()}>
              保存
            </Button>
          </>
        )}
      >
        <div className="space-y-5">
          <FieldRow label="方案名称" hint="给它一个能认出来的名字">
            <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="比如：写代码用 7B / 聊天用 4B" autoFocus />
          </FieldRow>
          <FieldRow label="模型文件" hint="选择 GGUF 模型文件">
            <div className="flex items-center gap-2">
              <Input readOnly value={draftModelPath} placeholder={t('settings.localModel.modelPathPlaceholder')} className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => void pickDraftModel()}>
                {t('settings.localModel.pickModel')}
              </Button>
            </div>
          </FieldRow>
          {draftModelPath.trim() && (
            <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 text-[12.5px] leading-5">
              <span className="font-semibold text-[var(--color-text-primary)]">{describeModelCapability(draftModelPath).label}</span>
              <span className="text-[var(--color-text-tertiary)]">——{describeModelCapability(draftModelPath).hint}</span>
            </div>
          )}
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 text-[12.5px] leading-5 text-[var(--color-text-secondary)]">
            已按当前硬件填好参数起点：{hardware ? `${Math.max(1, Math.round(hardware.cpuCores * 0.67))} 线程（67% 甜点比例）` : '默认参数'}、{hardware?.gpu ? 'GPU 自动分配' : '纯 CPU'}、32K 上下文。
            想要更准的配置，保存后点 <span className="font-medium text-[var(--color-text-primary)]">跑分</span>，实测结果一键应用到方案。
          </div>

          <div className="border-t border-[var(--color-border)] pt-4">
            <button
              className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-text-accent)]"
              onClick={() => setDraftShowAdvanced((v) => !v)}
              type="button"
            >
              细节参数
              <span className="material-symbols-outlined text-[18px] transition-transform duration-150" style={{ transform: draftShowAdvanced ? 'rotate(180deg)' : 'none' }}>
                expand_more
              </span>
            </button>
            {draftShowAdvanced && (
              <div className="mt-4">
                <AdvancedFields adv={draftAdv} onChange={(key, value) => setDraftAdv((a) => ({ ...a, [key]: value }))} onPickMmproj={() => void pickDraftMmproj()} />
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* 跑分 Modal：设置 → 进度 → 报告 */}
      <Modal
        open={showBenchmarkModal}
        onClose={() => { if (!benchmarkRunning) setShowBenchmarkModal(false) }}
        title="跑分"
        width={720}
        footer={benchmarkRunning ? undefined : (
          <>
            <Button size="base" variant="ghost" onClick={() => setShowBenchmarkModal(false)}>
              关闭
            </Button>
            {benchmarkOutput && (
              <Button size="base" onClick={applyBenchmarkResult} disabled={benchmarkOutput.steps.length === 0}>
                应用推荐配置
              </Button>
            )}
          </>
        )}
      >
        {!benchmarkRunning && !benchmarkOutput && !benchmarkError && (
          <div className="space-y-5">
            <FieldRow label="模型文件" hint="选择要跑分的 GGUF 模型">
              <div className="flex items-center gap-2">
                <Input readOnly value={benchmarkModelPath} placeholder="选择 .gguf 模型文件" className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => void pickBenchmarkModel()}>
                  选择模型
                </Button>
              </div>
            </FieldRow>

            <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3 text-[12.5px] leading-5 text-[var(--color-text-secondary)]">
              跑分会自动测出这台机器的真实速度，按软件需求（Claude Code 需要 32K 上下文）推荐一个能用的配置。
            </div>

            <div className="flex justify-end pt-2">
              <Button size="base" onClick={() => void runBenchmark()} disabled={!benchmarkModelPath} icon={<span className="material-symbols-outlined text-[16px]">play_arrow</span>}>
                开始跑分
              </Button>
            </div>
          </div>
        )}

        {benchmarkRunning && (
          <div className="py-4">
            <div className="flex items-center gap-3">
              <Spinner size={18} />
              <span className="text-[13px] text-[var(--color-text-secondary)]">
                {benchmarkProgress
                  ? `正在实测第 ${benchmarkProgress.current}/${benchmarkProgress.total} 档（${benchmarkProgress.label}）…`
                  : '正在加载模型，准备实测…'}
              </span>
            </div>
            {benchmarkProgress && (
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-container-high)]">
                <div
                  className="h-full rounded-full bg-[var(--color-brand)] transition-[width] duration-300"
                  style={{ width: `${Math.round((benchmarkProgress.current / benchmarkProgress.total) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}

        {benchmarkError && (
          <p className="text-[13px] text-[var(--color-error)]" role="alert">{benchmarkError}</p>
        )}

        {!benchmarkRunning && benchmarkOutput && (
          <div className="space-y-2">
            <div
              className="mb-3 flex items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-primary-fixed-dim)] bg-[var(--color-brand-soft)] px-4 py-3 text-[13px] leading-5"
              role="status"
            >
              <span className="material-symbols-outlined text-[18px] text-[var(--color-brand)]">memory</span>
              <span>
                本机采用
                <span className="font-semibold text-[var(--color-text-primary)]">
                  {benchmarkOutput.mode === 'gpu' ? 'GPU 全量' : benchmarkOutput.mode === 'hybrid' ? 'GPU + CPU 混合' : '纯 CPU'}
                </span>
                {' '}运行
                {benchmarkOutput.mode === 'gpu' && '——模型全部层放显卡，速度最快。'}
                {benchmarkOutput.mode === 'hybrid' && '——部分模型层放显卡、其余在 CPU，兼顾速度与显存。'}
                {benchmarkOutput.mode === 'cpu' && (hardware?.gpu ? '——你的显卡跑不动这个模型，全部计算由 CPU 完成。' : '——无独显，全部计算由 CPU 完成。')}
              </span>
            </div>
            {benchmarkOutput.note && (
              <div className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-warning)] bg-[var(--color-surface-container-low)] px-4 py-3 text-[12.5px] leading-5" role="status">
                {benchmarkOutput.note}
              </div>
            )}
            {benchmarkOutput.modelParamsB !== null && (
              <p className="mb-2 text-[12px] text-[var(--color-text-tertiary)]">
                模型实测：{benchmarkOutput.modelParamsB.toFixed(2)}B 参数
                {benchmarkOutput.modelSizeMB !== null ? `（${Math.round(benchmarkOutput.modelSizeMB)} MB）` : ''}
                · 长文输入 {Math.round(benchmarkOutput.ppTokensPerSec)} t/s
              </p>
            )}
            {(() => {
              const capability = describeModelCapability(benchmarkModelPath)
              return (
                <p className="mb-2 text-[12px] text-[var(--color-text-tertiary)]">
                  能力档：<span className="font-semibold text-[var(--color-text-secondary)]">{capability.label}</span>——{capability.hint}
                </p>
              )
            })()}
            {(() => {
              const pp = benchmarkOutput.ppTokensPerSec
              if (pp <= 0) return null
              // Claude Code 真实负载的系统提示词 + 工具定义约 30K tokens，首字延迟由它决定
              const seconds = 30000 / pp
              const text = seconds >= 90 ? `约 ${Math.round(seconds / 60)} 分钟` : `约 ${Math.round(seconds)} 秒`
              return (
                <div className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-warning)] bg-[var(--color-surface-container-low)] px-4 py-3 text-[12.5px] leading-5" role="status">
                  <span className="font-semibold">首字延迟预估：{text}</span>
                  ——Claude Code 每次请求带约 30K tokens 提示词（系统提示 + 工具定义），按长文输入 {Math.round(pp)} t/s 实测推算。
                  {benchmarkOutput.mode === 'cpu' && ' 这是纯 CPU 的主要瓶颈；续轮对话引擎会复用已算过的 KV 缓存、只处理新增内容，会快很多。'}
                </div>
              )
            })()}
            {benchmarkOutput.contextFit.kvCacheGB !== null && contextBudgetGB !== null && (
              <div className={`mb-3 rounded-[var(--radius-md)] border px-4 py-3 text-[12.5px] leading-5 ${benchmarkOutput.contextFit.fits ? 'border-[var(--color-border)] bg-[var(--color-surface-container-low)]' : 'border-[var(--color-warning)] bg-[var(--color-surface-container-low)]'}`}>
                {benchmarkOutput.contextFit.gpuUsable
                  ? (
                    <>
                      上下文 32K 的 KV 缓存约需 <span className="font-semibold">{benchmarkOutput.contextFit.kvCacheGB.toFixed(2)} GB</span>，放在显存里：可用显存 {benchmarkOutput.contextFit.availableVramGB > 0 ? `${benchmarkOutput.contextFit.availableVramGB.toFixed(1)} GB` : '未知'}，其中约 <span className="font-semibold">{contextBudgetGB.toFixed(1)} GB</span> 可用（留 10% 余量）。
                    </>
                  )
                  : (
                    <>
                      上下文 32K 的 KV 缓存约需 <span className="font-semibold">{benchmarkOutput.contextFit.kvCacheGB.toFixed(2)} GB</span>。纯 CPU 模式下，KV 缓存放在内存里：物理内存 {benchmarkOutput.contextFit.availableRamGB.toFixed(1)} GB，其中约 <span className="font-semibold">{contextBudgetGB.toFixed(1)} GB</span> 可用（67% 预算，其余留给系统和其他应用）。
                    </>
                  )}
                {benchmarkOutput.contextFit.fits
                  ? '装得下，可以放心用 32K 上下文。'
                  : '装不下，会溢出变慢。建议换更小的模型，应用方案时上下文会自动下调。'}
              </div>
            )}
            {benchmarkOutput.contextTooSmall && (
              <div className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-warning)] bg-[var(--color-surface-container-low)] px-4 py-3 text-[12.5px] leading-5" role="alert">
                <span className="font-semibold">上下文 32K 是软件需求的最小值</span>
                ——Claude Code 的系统提示词 + 工具定义就要 ~30K tokens。这个上下文装不下，模型启动成功但真实请求会被拒。建议选至少 32K。
              </div>
            )}
            <p className="mb-3 text-[11px] text-[var(--color-text-tertiary)]">
              生成速度在 8K 上下文下实测（大上下文只影响 KV 缓存装不装得下，速度差异不大；跑大上下文速度测试会把缓存填满卡死）。
            </p>
            {benchmarkOutput.steps.map((step) => {
              const isRecommended = benchmarkOutput.recommendedStep !== null && step === benchmarkOutput.recommendedStep
              return (
                <div key={`${step.ngl}-${step.threads}`} className={`flex items-center gap-4 rounded-[var(--radius-md)] border px-4 py-3 ${isRecommended ? 'border-[var(--color-primary-fixed-dim)] bg-[var(--color-brand-soft)]' : 'border-[var(--color-border)] bg-[var(--color-surface-container-low)]'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-semibold text-[var(--color-text-primary)]">{step.label}</span>
                      {isRecommended && (
                        <span className="inline-flex items-center rounded-full bg-[var(--color-brand)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-surface)]">
                          最快
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-[var(--color-text-tertiary)]">
                      使用率 {Math.round(step.usage * 100)}%
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[18px] font-semibold text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>
                      {step.tgTokensPerSec > 0 ? Math.round(step.tgTokensPerSec) : '—'}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)]">token/秒</div>
                  </div>
                </div>
              )
            })}
            {benchmarkOutput.recommendedStep ? (
              <p className="pt-2 text-[12px] leading-5 text-[var(--color-text-tertiary)]">
                推荐：<span className="font-semibold text-[var(--color-text-secondary)]">{benchmarkOutput.recommendedStep.label}</span>——这是这台机器最快的配置。
                {plannedContext !== null && (
                  <>
                    {'点「应用方案」将按你的内存规划 '}
                    <span className="font-semibold text-[var(--color-text-secondary)]">{Math.round(plannedContext / 1024)}K</span>
                    {' 上下文'}
                    {plannedContext < 32768 ? '（不足 32K，Claude Code 真实负载可能放不下，建议换更小的模型）' : ''}。
                  </>
                )}
              </p>
            ) : benchmarkOutput.steps.length > 0 ? (
              <p className="pt-2 text-[12px] leading-5 text-[var(--color-warning)]" role="alert">
                这台机器跑这个模型最快约 {Math.round(benchmarkOutput.maxTgTokensPerSec)} t/s。
              </p>
            ) : null}
          </div>
        )}
      </Modal>

      {/* 下载模型中心 Modal */}
      <Modal
        open={showModelGuideModal}
        onClose={() => setShowModelGuideModal(false)}
        title="下载模型"
        width={760}
        footer={(
          <Button size="base" onClick={() => setShowModelGuideModal(false)}>
            关闭
          </Button>
        )}
      >
        {/* 下载源网站 */}
        <div className="mb-5">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--color-text-tertiary)]">
            去哪里下 GGUF 模型
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {GGUF_DOWNLOAD_SITES.map((site) => (
              <div key={site.name} className="flex flex-col rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13.5px] font-semibold text-[var(--color-text-primary)]">{site.name}</span>
                  <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--color-brand-soft)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
                    {site.tag}
                  </span>
                </div>
                <p className="mt-1 flex-1 text-[11.5px] leading-4 text-[var(--color-text-tertiary)]">{site.intro}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2 self-start"
                  onClick={() => void host.shell.open(site.url)}
                  icon={<span className="material-symbols-outlined text-[15px]">open_in_new</span>}
                >
                  打开网站
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* NVIDIA CUDA 引擎指引（官方下载，不随应用打包——体积 1GB+） */}
        <div className="mb-5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--color-text-tertiary)]">
            NVIDIA 显卡加速（可选，CUDA 版引擎）
          </div>
          <p className="mb-2 text-[12.5px] leading-5 text-[var(--color-text-secondary)]">
            有 NVIDIA 显卡且跑分显示 GPU 可用时，CUDA 版引擎比内置 Vulkan 版更快。体积较大（约 1 GB+），不随应用打包，请从官方下载：
          </p>
          <ol className="list-decimal space-y-1.5 pl-5 text-[12.5px] leading-5 text-[var(--color-text-secondary)]">
            <li>打开 llama.cpp 官方 Releases 页，找名字形如 <code className="rounded bg-[var(--color-surface-container-high)] px-1 text-[11px]">llama-xxxx-bin-win-cuda-x64.zip</code> 的最新版，下载并解压。</li>
            <li>回到「本地模型」，新建或修改方案，在「细节参数 → 引擎目录」填入解压出来的文件夹路径。</li>
            <li>照常启动即可——应用会用你指定的引擎；删掉该路径随时回到内置引擎。</li>
          </ol>
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            onClick={() => void host.shell.open('https://github.com/ggml-org/llama.cpp/releases')}
            icon={<span className="material-symbols-outlined text-[15px]">open_in_new</span>}
          >
            打开 llama.cpp Releases
          </Button>
        </div>

        {/* 使用大模型说明 */}
        <div className="mb-5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--color-text-tertiary)]">
            拿到 GGUF 后怎么用
          </div>
          <ol className="list-decimal space-y-1.5 pl-5 text-[12.5px] leading-5 text-[var(--color-text-secondary)]">
            <li>去上面任一网站找到模型文件的 <span className="font-medium text-[var(--color-text-primary)]">GGUF 量化版</span>（如 <code className="rounded bg-[var(--color-surface-container-high)] px-1 text-[11px]">*Q4_K_M.gguf</code>），下载到本地文件夹。</li>
            <li>回到「本地模型」点 <span className="font-medium text-[var(--color-text-primary)]">新建方案</span>，在「模型文件」里选中刚下载的 .gguf 文件——参数起点会按你的硬件自动填好。</li>
            <li>点 <span className="font-medium text-[var(--color-text-primary)]">跑分</span> 让程序实测出这台机器的最优配置，一键应用到方案。</li>
            <li>保存方案后点 <span className="font-medium text-[var(--color-text-primary)]">应用</span>，再点 <span className="font-medium text-[var(--color-text-primary)]">启动</span> 让引擎跑起来。</li>
            <li>到对话输入框左下角切换成「本地模型」，即可离线使用。</li>
          </ol>
        </div>

      </Modal>
    </div>
  )
}
