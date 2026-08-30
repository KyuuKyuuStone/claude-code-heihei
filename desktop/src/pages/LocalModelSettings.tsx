import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { Switch } from '@/components/ui/Switch'
import { StatusDot } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { SettingsPageHeader, SettingsSection, SettingsPill, SettingsStat } from '@/components/settings/SettingsSection'
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

export type LocalModelTier = 'low' | 'mid' | 'high' | 'super' | 'emperor'

type TierConfig = {
  label: string
  ctxSize: number
  threads: number
  nGpuLayers: string
  batchSize: number
  hint: string
}

const TIER_CONFIGS: Record<LocalModelTier, TierConfig> = {
  low: {
    label: '低配',
    ctxSize: 16384,
    threads: 4,
    nGpuLayers: 'auto',
    batchSize: 512,
    hint: '资源占用最低，纯 CPU 为主',
  },
  mid: {
    label: '中配',
    ctxSize: 32768,
    threads: 4,
    nGpuLayers: 'auto',
    batchSize: 1024,
    hint: 'GPU+CPU 混合，均衡取向',
  },
  high: {
    label: '高配',
    ctxSize: 65536,
    threads: 8,
    nGpuLayers: 'auto',
    batchSize: 2048,
    hint: 'GPU 为主，速度优先',
  },
  super: {
    label: '超级',
    ctxSize: 131072,
    threads: 8,
    nGpuLayers: 'auto',
    batchSize: 2048,
    hint: '大显存取向，适合更大模型',
  },
  emperor: {
    label: '帝王',
    ctxSize: 262144,
    threads: 16,
    nGpuLayers: 'all',
    batchSize: 4096,
    hint: '极限配置，榨干硬件',
  },
}

const TIER_ORDER: LocalModelTier[] = ['low', 'mid', 'high', 'super', 'emperor']

/** 目标生成速度档（token/秒），从 15 开始 */
const SPEED_TARGETS = [15, 20, 25, 30, 35, 40, 50, 60, 80, 100, 150, 200]

/** 上下文选择：从 1M 往下到 8K */
const CONTEXT_CHOICES = [8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576]

/** 硬件使用率档 */
const USAGE_CHOICES = [0.4, 0.5, 0.6, 0.7, 0.8]

const STATE_DOT_TONE = {
  stopped: 'neutral',
  starting: 'info',
  running: 'success',
  error: 'danger',
} as const

/** 推荐的大模型（写死：型号/大小/显存需求/上下文/适合场景/下载链接） */
const RECOMMENDED_MODELS = [
  { name: 'Qwen2.5-1.5B-Instruct', size: '1.5B', format: 'Q4_K_M', vram: '约 1 GB', context: '32K', best: '极速问答、学习笔记', download: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF' },
  { name: 'Qwen2.5-3B-Instruct', size: '3B', format: 'Q4_K_M', vram: '约 2.5 GB', context: '32K', best: '日常问答、轻量写代码（推荐）', download: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF' },
  { name: 'Qwen3-4B-Instruct', size: '4B', format: 'Q4_K_M', vram: '约 3 GB', context: '32K', best: '更新的 Qwen 小模型，中文强', download: 'https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507-GGUF' },
  { name: 'Qwen2.5-7B-Instruct', size: '7B', format: 'Q4_K_M', vram: '约 4.5 GB', context: '128K', best: '写代码、长文档理解', download: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF' },
  { name: 'Llama 3.2 3B', size: '3B', format: 'Q4_K_M', vram: '约 2 GB', context: '128K', best: '英文见长、通用问答', download: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF' },
  { name: 'DeepSeek-R1-Distill-Qwen-7B', size: '7B', format: 'Q4_K_M', vram: '约 4.5 GB', context: '32K', best: '推理链思考、数学/逻辑', download: 'https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF' },
] as const

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
}

/** 一套完整的本地模型配置方案：模型文件 + 档位 + 全部参数 */
export type LocalModelConfig = AdvancedConfig & {
  id: string
  name: string
  modelPath: string
  tier: LocalModelTier
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

function recommendTier(hw: LocalModelHardware): LocalModelTier {
  const memGB = hw.memoryGB
  const vramGB = hw.gpu ? hw.gpu.vramMB / 1024 : 0
  if (memGB >= 64 || vramGB >= 24) return 'emperor'
  if (memGB >= 32 || vramGB >= 12) return 'super'
  if (memGB >= 16 || vramGB >= 8) return 'high'
  if (memGB >= 8 || vramGB >= 4) return 'mid'
  return 'low'
}

/** 实测生成速度 → 档位（跑出来的，不是写死的） */
function tierBySpeed(tgTokensPerSec: number): LocalModelTier {
  if (tgTokensPerSec >= 100) return 'emperor'
  if (tgTokensPerSec >= 60) return 'super'
  if (tgTokensPerSec >= 35) return 'high'
  if (tgTokensPerSec >= 15) return 'mid'
  return 'low'
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
function AdvancedFields({ adv, onChange }: { adv: AdvancedConfig; onChange: <K extends keyof AdvancedConfig>(key: K, value: AdvancedConfig[K]) => void }) {
  return (
    <div className="space-y-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--color-text-tertiary)]">
        引擎参数（改完需重启引擎生效）
      </div>
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
  const [draftTier, setDraftTier] = useState<LocalModelTier>('mid')
  const [draftAdv, setDraftAdv] = useState<AdvancedConfig>({ ...DEFAULT_ADVANCED })
  const [draftShowAdvanced, setDraftShowAdvanced] = useState(false)

  const [showModelGuideModal, setShowModelGuideModal] = useState(false)

  // 跑分状态
  const [showBenchmarkModal, setShowBenchmarkModal] = useState(false)
  const [benchmarkModelPath, setBenchmarkModelPath] = useState('')
  const [benchmarkTargetSpeed, setBenchmarkTargetSpeed] = useState(35)
  const [benchmarkCtxSize, setBenchmarkCtxSize] = useState(32768)
  const [benchmarkUsage, setBenchmarkUsage] = useState(0.6)
  const [benchmarkRunning, setBenchmarkRunning] = useState(false)
  const [benchmarkOutput, setBenchmarkOutput] = useState<LocalModelBenchmarkOutput | null>(null)
  const [benchmarkProgress, setBenchmarkProgress] = useState<LocalModelBenchmarkProgress | null>(null)
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null)

  const currentConfig = useMemo(
    () => configs.find((config) => config.id === currentConfigId) ?? null,
    [configs, currentConfigId],
  )
  const running = status.state === 'starting' || status.state === 'running'
  const recommendedTier = hardware ? recommendTier(hardware) : null

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
    setDraftTier(hardware ? recommendTier(hardware) : 'mid')
    setDraftAdv({ ...DEFAULT_ADVANCED })
    setDraftShowAdvanced(false)
    setShowConfigModal(true)
  }

  const openEditConfigModal = (config: LocalModelConfig) => {
    setEditingConfigId(config.id)
    setDraftName(config.name)
    setDraftModelPath(config.modelPath)
    setDraftTier(config.tier)
    const { id: _id, name: _name, modelPath: _m, tier: _t, ...adv } = config
    setDraftAdv({ ...DEFAULT_ADVANCED, ...adv })
    setDraftShowAdvanced(false)
    setShowConfigModal(true)
  }

  const selectDraftTier = (next: LocalModelTier) => {
    setDraftTier(next)
    const config = TIER_CONFIGS[next]
    setDraftAdv((a) => ({
      ...a,
      ctxSize: String(config.ctxSize),
      threads: String(config.threads),
      nGpuLayers: config.nGpuLayers,
      batchSize: String(config.batchSize),
    }))
  }

  const pickDraftModel = async () => {
    const result = await host.dialogs.open({
      title: t('settings.localModel.pickModel'),
      filters: [{ name: 'GGUF', extensions: ['gguf'] }],
    })
    if (typeof result === 'string') setDraftModelPath(result)
  }

  const saveConfig = () => {
    const name = draftName.trim()
    if (!name || !draftModelPath.trim()) return
    const entry: LocalModelConfig = {
      id: editingConfigId ?? `${Date.now()}`,
      name,
      modelPath: draftModelPath.trim(),
      tier: draftTier,
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
        targetSpeed: benchmarkTargetSpeed,
        ctxSize: benchmarkCtxSize,
        usage: benchmarkUsage,
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
    const tier = tierBySpeed(speed)
    const tierConfig = TIER_CONFIGS[tier]
    const entry: LocalModelConfig = {
      id: `${Date.now()}`,
      name: `${modelNameFromPath(benchmarkModelPath)} · ${tierConfig.label} · ${benchmarkCtxSize >= 1048576 ? '1M' : `${Math.round(benchmarkCtxSize / 1024)}K`} · ${Math.round(speed)}t/s`,
      modelPath: benchmarkModelPath,
      tier,
      ...DEFAULT_ADVANCED,
      ctxSize: String(benchmarkCtxSize),
      threads: String(recommended.threads),
      nGpuLayers: recommended.ngl,
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
            按您的硬件推荐「<span className="font-semibold text-[var(--color-text-primary)]">{recommendedTier ? TIER_CONFIGS[recommendedTier].label : '—'}</span>」档
            {benchmarkOutput && benchmarkOutput.modelParamsB !== null
              ? ` · 当前模型实测：${benchmarkOutput.modelParamsB.toFixed(2)}B 参数，生成 ${Math.round(benchmarkOutput.maxTgTokensPerSec)} t/s`
              : ' · 点「跑分」实测这台机器跑当前模型的真实速度'}
          </div>
        </Card>
      )}

      <SettingsSection
        title="配置方案"
        description="一套方案 = 模型文件 + 配置档位（按硬件推测）+ 细节参数"
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
                    <div className="mt-0.5 truncate text-[11.5px] text-[var(--color-text-tertiary)]">
                      {modelNameFromPath(config.modelPath)} · {TIER_CONFIGS[config.tier]?.label ?? ''} · 上下文 {Math.round(parsePositiveInt(config.ctxSize, 32768) / 1024)}K
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
            还没有保存的方案。点「新建方案」建一套（选模型文件 + 配置档位 + 细节参数），保存后点「应用」即可启用。
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
            {currentConfig ? `方案：${currentConfig.name} · ${TIER_CONFIGS[currentConfig.tier]?.label ?? ''}` : '未选择方案'}
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
          <div>
            <div className="mb-2 text-[13px] font-medium text-[var(--color-text-secondary)]">
              配置档位
              {hardware && (
                <span className="ml-2 text-[11px] font-normal text-[var(--color-text-tertiary)]">
                  （根据当前电脑推测：{TIER_CONFIGS[recommendTier(hardware)].label}）
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {TIER_ORDER.map((key) => (
                <SettingsPill key={key} selected={draftTier === key} onClick={() => selectDraftTier(key)}>
                  {TIER_CONFIGS[key].label}
                </SettingsPill>
              ))}
            </div>
            <p className="mt-2 text-[11.5px] text-[var(--color-text-tertiary)]">
              {TIER_CONFIGS[draftTier].hint} · 上下文 {Math.round(TIER_CONFIGS[draftTier].ctxSize / 1024)}K · {TIER_CONFIGS[draftTier].threads} 线程
            </p>
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
                <AdvancedFields adv={draftAdv} onChange={(key, value) => setDraftAdv((a) => ({ ...a, [key]: value }))} />
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

            <div>
              <div className="mb-2 text-[13px] font-medium text-[var(--color-text-secondary)]">目标生成速度（token/秒）</div>
              <div className="flex flex-wrap gap-2">
                {SPEED_TARGETS.map((speed) => (
                  <SettingsPill key={speed} selected={benchmarkTargetSpeed === speed} onClick={() => setBenchmarkTargetSpeed(speed)}>
                    {speed}
                  </SettingsPill>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 text-[13px] font-medium text-[var(--color-text-secondary)]">上下文长度</div>
              <div className="flex flex-wrap gap-2">
                {CONTEXT_CHOICES.map((ctx) => (
                  <SettingsPill key={ctx} selected={benchmarkCtxSize === ctx} onClick={() => setBenchmarkCtxSize(ctx)}>
                    {ctx >= 1048576 ? '1M' : `${Math.round(ctx / 1024)}K`}
                  </SettingsPill>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 text-[13px] font-medium text-[var(--color-text-secondary)]">
                硬件使用率
                <span className="ml-2 text-[11px] font-normal text-[var(--color-text-tertiary)]">（GPU 层数 / CPU 线程的占用比例，留余量给系统）</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {USAGE_CHOICES.map((usage) => (
                  <SettingsPill key={usage} selected={benchmarkUsage === usage} onClick={() => setBenchmarkUsage(usage)}>
                    {Math.round(usage * 100)}%
                  </SettingsPill>
                ))}
              </div>
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
            {benchmarkOutput.modelParamsB !== null && (
              <p className="mb-2 text-[12px] text-[var(--color-text-tertiary)]">
                模型实测：{benchmarkOutput.modelParamsB.toFixed(2)}B 参数
                {benchmarkOutput.modelSizeMB !== null ? `（${Math.round(benchmarkOutput.modelSizeMB)} MB）` : ''}
                · 长文输入 {Math.round(benchmarkOutput.ppTokensPerSec)} t/s · 目标 {benchmarkTargetSpeed} t/s
              </p>
            )}
            {benchmarkOutput.contextFit.kvCacheGB !== null && (
              <div className={`mb-3 rounded-[var(--radius-md)] border px-4 py-3 text-[12.5px] leading-5 ${benchmarkOutput.contextFit.fits ? 'border-[var(--color-border)] bg-[var(--color-surface-container-low)]' : 'border-[var(--color-warning)] bg-[var(--color-surface-container-low)]'}`}>
                <span className="font-semibold">上下文 {benchmarkCtxSize >= 1048576 ? '1M' : `${Math.round(benchmarkCtxSize / 1024)}K`}</span>
                {' 的 KV 缓存约需 '}
                <span className="font-semibold">{benchmarkOutput.contextFit.kvCacheGB.toFixed(2)} GB</span>
                {'，您可用显存 '}
                <span className="font-semibold">{benchmarkOutput.contextFit.availableVramGB > 0 ? `${benchmarkOutput.contextFit.availableVramGB.toFixed(1)} GB` : '无独显（走内存）'}</span>
                {benchmarkOutput.contextFit.fits
                  ? '——装得下。'
                  : '——装不下，会溢出到内存明显变慢。建议选更小的上下文。'}
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
                          达标
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-[var(--color-text-tertiary)]">
                      使用率 {Math.round(step.usage * 100)}% · {step.meetsTarget ? `达到目标 ${benchmarkTargetSpeed} t/s` : '未达目标'}
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
                推荐：<span className="font-semibold text-[var(--color-text-secondary)]">{benchmarkOutput.recommendedStep.label}</span>——这是达到目标速度的最小资源占用配置，再往上就是浪费了。
              </p>
            ) : benchmarkOutput.steps.length > 0 ? (
              <p className="pt-2 text-[12px] leading-5 text-[var(--color-warning)]" role="alert">
                这台机器跑这个模型最快约 {Math.round(benchmarkOutput.maxTgTokensPerSec)} t/s，达不到您的目标 {benchmarkTargetSpeed} t/s——建议降低目标速度、换更小的模型，或开更大的上下文/使用率再试。
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

        {/* 使用大模型说明 */}
        <div className="mb-5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--color-text-tertiary)]">
            拿到 GGUF 后怎么用
          </div>
          <ol className="list-decimal space-y-1.5 pl-5 text-[12.5px] leading-5 text-[var(--color-text-secondary)]">
            <li>去上面任一网站找到模型文件的 <span className="font-medium text-[var(--color-text-primary)]">GGUF 量化版</span>（如 <code className="rounded bg-[var(--color-surface-container-high)] px-1 text-[11px]">*Q4_K_M.gguf</code>），下载到本地文件夹。</li>
            <li>回到「本地模型」点 <span className="font-medium text-[var(--color-text-primary)]">新建方案</span>，在「模型文件」里选中刚下载的 .gguf 文件。</li>
            <li>按你的硬件挑一个配置档位（低配/中配/高配/超级/帝王），也可以点 <span className="font-medium text-[var(--color-text-primary)]">跑分</span> 让程序实测出最优配置。</li>
            <li>保存方案后点 <span className="font-medium text-[var(--color-text-primary)]">应用</span>，再点 <span className="font-medium text-[var(--color-text-primary)]">启动</span> 让引擎跑起来。</li>
            <li>到对话输入框左下角切换成「本地模型」，即可离线使用。</li>
          </ol>
        </div>

        {/* 推荐的大模型 */}
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--color-text-tertiary)]">
          推荐的大模型
        </div>
        <p className="mb-3 text-[13px] leading-6 text-[var(--color-text-secondary)]">
          按您的硬件（{hardware ? `${hardware.memoryGB}GB 内存${hardware.gpu ? ` + ${Math.round(hardware.gpu.vramMB / 1024)}GB 显存` : '、无独显'}` : '检测中'}），以下模型比较合适。点「下载」去对应页面。
        </p>
        <div className="space-y-2">
          {RECOMMENDED_MODELS.map((model) => (
            <div key={model.name} className="flex items-center gap-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold text-[var(--color-text-primary)]">{model.name}</div>
                <div className="mt-0.5 text-[11.5px] text-[var(--color-text-tertiary)]">
                  {model.size} · {model.format} · 显存 {model.vram} · 上下文 {model.context}
                </div>
                <div className="mt-0.5 text-[11.5px] text-[var(--color-text-secondary)]">适合：{model.best}</div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void host.shell.open(model.download)}
                icon={<span className="material-symbols-outlined text-[15px]">open_in_new</span>}
              >
                下载
              </Button>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  )
}
