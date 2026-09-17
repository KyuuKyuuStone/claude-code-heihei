/**
 * 供应商/模型选项构建 — 从 ModelSelector 抽出的共享逻辑。
 *
 * ModelSelector（聊天输入框）和 ServantSessionModal（协作会话弹窗的
 * 运行配置）需要同一份"可选服务商 + 各自模型清单"数据，抽到这里避免两处漂移。
 */
import type { SavedProvider } from '../types/provider'
import type { ModelInfo } from '../types/settings'

export type ProviderChoice = {
  providerId: string | null
  providerName: string
  isDefault: boolean
  models: ModelInfo[]
}

export type ProviderModelRoleLabels = Record<'main' | 'haiku' | 'sonnet' | 'opus', string>

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
  labels: ProviderModelRoleLabels,
): ProviderChoice[] {
  return providers.map((provider) => ({
    providerId: provider.id,
    providerName: provider.name,
    isDefault: activeId === provider.id,
    models: buildProviderModels(provider, labels),
  }))
}
