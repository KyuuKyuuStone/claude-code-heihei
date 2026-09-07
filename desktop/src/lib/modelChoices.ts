/**
 * 供应商/模型选项构建 — 从 ModelSelector 抽出的共享逻辑。
 *
 * ModelSelector（聊天输入框）和 ServantSessionModal（协作会话弹窗的
 * 运行配置）需要同一份"可选服务商 + 各自模型清单"数据，抽到这里避免两处漂移。
 */
import { OFFICIAL_MODELS } from '../constants/modelCatalog'
import {
  OPENAI_OFFICIAL_MODELS,
  OPENAI_OFFICIAL_PROVIDER_ID,
} from '../constants/openaiOfficialProvider'
import {
  GROK_OFFICIAL_MODELS,
  GROK_OFFICIAL_PROVIDER_ID,
} from '../constants/grokOfficialProvider'
import type { SavedProvider } from '../types/provider'
import type { ModelInfo } from '../types/settings'

export type ProviderChoice = {
  providerId: string | null
  providerName: string
  isDefault: boolean
  models: ModelInfo[]
}

export type ProviderModelRoleLabels = Record<'main' | 'haiku' | 'sonnet' | 'opus', string>

function officialChoices(
  providerId: string | null,
  models: ModelInfo[],
  isDefault: boolean,
  officialName: string,
): ProviderChoice {
  return {
    providerId,
    providerName: officialName,
    isDefault,
    models,
  }
}

function mergeOfficialModels(availableModels: ModelInfo[]): ModelInfo[] {
  const merged = [...OFFICIAL_MODELS]
  const knownIds = new Set(merged.map(model => model.id))
  for (const model of availableModels) {
    if (!knownIds.has(model.id)) {
      knownIds.add(model.id)
      merged.push(model)
    }
  }
  return merged
}

export function buildProviderModels(
  provider: SavedProvider,
  labels: ProviderModelRoleLabels,
): ModelInfo[] {
  const entries: Array<{ id: string; label: string }> = [
    { id: provider.models.main.trim(), label: labels.main },
    { id: provider.models.haiku.trim(), label: labels.haiku },
    { id: provider.models.sonnet.trim(), label: labels.sonnet },
    { id: provider.models.opus.trim(), label: labels.opus },
  ]

  const byId = new Map<string, { id: string; labels: string[] }>()
  for (const entry of entries) {
    if (!entry.id) continue
    const existing = byId.get(entry.id)
    if (existing) {
      if (!existing.labels.includes(entry.label)) {
        existing.labels.push(entry.label)
      }
      continue
    }
    byId.set(entry.id, { id: entry.id, labels: [entry.label] })
  }

  return [...byId.values()].map((entry) => ({
    id: entry.id,
    name: entry.id,
    description: entry.labels.join(' · '),
    context: '',
  }))
}

export function buildProviderChoices(
  providers: SavedProvider[],
  activeId: string | null,
  availableModels: ModelInfo[],
  officialName: string,
  openAIOfficialName: string,
  grokOfficialName: string,
  labels: ProviderModelRoleLabels,
  claudeOfficialLoggedIn: boolean,
  openAIOfficialLoggedIn: boolean,
  grokOfficialLoggedIn: boolean,
): ProviderChoice[] {
  const claudeOfficialModels = activeId === null && availableModels.length > 0
    ? mergeOfficialModels(availableModels)
    : OFFICIAL_MODELS
  const openAIOfficialModels = activeId === OPENAI_OFFICIAL_PROVIDER_ID && availableModels.length > 0
    ? availableModels
    : OPENAI_OFFICIAL_MODELS
  const grokOfficialModels = activeId === GROK_OFFICIAL_PROVIDER_ID && availableModels.length > 0
    ? availableModels
    : GROK_OFFICIAL_MODELS

  const choices: ProviderChoice[] = []

  if (claudeOfficialLoggedIn) {
    choices.push(officialChoices(null, claudeOfficialModels, activeId === null, officialName))
  }
  if (openAIOfficialLoggedIn) {
    choices.push(officialChoices(
      OPENAI_OFFICIAL_PROVIDER_ID,
      openAIOfficialModels,
      activeId === OPENAI_OFFICIAL_PROVIDER_ID,
      openAIOfficialName,
    ))
  }
  if (grokOfficialLoggedIn) {
    choices.push(officialChoices(
      GROK_OFFICIAL_PROVIDER_ID,
      grokOfficialModels,
      activeId === GROK_OFFICIAL_PROVIDER_ID,
      grokOfficialName,
    ))
  }

  for (const provider of providers) {
    choices.push({
      providerId: provider.id,
      providerName: provider.name,
      isDefault: activeId === provider.id,
      models: buildProviderModels(provider, labels),
    })
  }

  return choices
}
