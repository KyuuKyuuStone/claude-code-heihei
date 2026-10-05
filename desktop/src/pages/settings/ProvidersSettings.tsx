// v1.7.0 结构拆分第①批（providers）：ProvidersSettings（含列表辅助函数与
// SortableProviderCard）从 pages/Settings.tsx 逐字移出（原 212-582 行），
// 逻辑零改动；门面 pages/Settings.tsx 保留为入口。

// ─── Provider Settings ──────────────────────────────────────

import { useState, useEffect, useMemo, type CSSProperties, type ReactNode } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Button } from '@/components/ui/Button'
import { Badge, StatusDot } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/EmptyState'
import { SettingsPageHeader } from '@/components/settings/SettingsSection'
import type { ProviderTestResult, SavedProvider } from '../../types/provider'
import { ProviderFormModal } from './ProviderFormModal'
import { ErrorState } from '@/components/ui/ErrorState'
import { useUIStore } from '../../stores/uiStore'
import { describeApiFailure } from '../../lib/apiErrorMessage'
import type { ApiErrorWithKind } from '../../api/client'

type ProviderListItem = { id: string; kind: 'saved'; provider: SavedProvider }

function defaultProviderOrder(providers: SavedProvider[]): string[] {
  return providers.map((provider) => provider.id)
}

function normalizeProviderOrder(providerOrder: string[] | undefined, providers: SavedProvider[]): string[] {
  const knownIds = new Set<string>(defaultProviderOrder(providers))
  const seen = new Set<string>()
  const order: string[] = []

  const source = providerOrder && providerOrder.length > 0
    ? providerOrder
    : defaultProviderOrder(providers)

  for (const id of source) {
    if (!knownIds.has(id) || seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }

  for (const id of defaultProviderOrder(providers)) {
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }

  return order
}

function buildProviderListItems(
  providers: SavedProvider[],
  providerOrder: string[] | undefined,
): ProviderListItem[] {
  const savedItems = new Map(
    providers.map((provider) => [
      provider.id,
      { id: provider.id, kind: 'saved', provider } satisfies ProviderListItem,
    ]),
  )
  const items = new Map<string, ProviderListItem>(savedItems)

  return normalizeProviderOrder(providerOrder, providers)
    .map((id) => items.get(id))
    .filter((item): item is ProviderListItem => item !== undefined)
}

function providerItemTestId(item: ProviderListItem): string {
  return `provider-${item.provider.id}`
}

export function ProviderSettings() {
  const {
    providers,
    providerOrder,
    activeId,
    presets,
    isLoading,
    error: providersError,
    fetchProviders,
    deleteProvider,
    reorderProviders,
    activateProvider,
    testProvider,
  } = useProviderStore()
  const fetchSettings = useSettingsStore((s) => s.fetchAll)
  const addToast = useUIStore((s) => s.addToast)
  const t = useTranslation()
  const [editingProvider, setEditingProvider] = useState<SavedProvider | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [pendingDeleteProvider, setPendingDeleteProvider] = useState<SavedProvider | null>(null)
  const [isDeletingProvider, setIsDeletingProvider] = useState(false)
  const [testResults, setTestResults] = useState<Record<string, { loading: boolean; result?: ProviderTestResult }>>({})
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  useEffect(() => {
    void fetchProviders()
  }, [fetchProviders])

  const presetMap = useMemo(
    () => new Map(presets.map((preset) => [preset.id, preset])),
    [presets],
  )

  const handleDelete = async (provider: SavedProvider) => {
    if (activeId === provider.id) return
    setPendingDeleteProvider(provider)
  }

  const confirmDelete = async () => {
    if (!pendingDeleteProvider) return
    setIsDeletingProvider(true)
    try {
      await deleteProvider(pendingDeleteProvider.id)
      setPendingDeleteProvider(null)
    } catch (error) {
      // v1.7.3 A1：删除失败不再静默——toast 人话反馈，确认弹窗保留可再试。
      addToast({
        type: 'error',
        message: describeApiFailure((error as ApiErrorWithKind).kind, error instanceof Error ? error.message : String(error), t),
      })
    } finally {
      setIsDeletingProvider(false)
    }
  }

  const handleTest = async (provider: SavedProvider) => {
    setTestResults((r) => ({ ...r, [provider.id]: { loading: true } }))
    try {
      const result = await testProvider(provider.id)
      setTestResults((r) => ({ ...r, [provider.id]: { loading: false, result } }))
    } catch {
      setTestResults((r) => ({ ...r, [provider.id]: { loading: false, result: { connectivity: { success: false, latencyMs: 0, error: t('settings.providers.requestFailed') } } } }))
    }
  }

  const handleActivate = async (id: string) => {
    await activateProvider(id)
    await fetchSettings()
  }

  const providerItems = useMemo(
    () => buildProviderListItems(providers, providerOrder),
    [providerOrder, providers],
  )

  const handleProviderDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const ids = providerItems.map((item) => item.id)
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    if (oldIndex === -1 || newIndex === -1) return

    void reorderProviders(arrayMove(ids, oldIndex, newIndex))
  }

  return (
    <div className="max-w-2xl">
      <SettingsPageHeader
        title={t('settings.providers.title')}
        description={t('settings.providers.description')}
        action={(
          <>
            <Button
              size="base"
              onClick={() => setShowCreateModal(true)}
              icon={<span className="material-symbols-outlined text-[16px]">add</span>}
            >
              {t('settings.providers.addProvider')}
            </Button>
          </>
        )}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleProviderDragEnd}
      >
        <SortableContext
          items={providerItems.map((item) => item.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col gap-2">
            {providerItems.map((item) => {
              const provider = item.provider
              const isActive = activeId === provider.id
              const test = testResults[provider.id]
              const preset = presetMap.get(provider.presetId)

              return (
                <SortableProviderCard
                  key={item.id}
                  item={item}
                  isActive={isActive}
                  dragLabel={t('settings.providers.dragToReorder')}
                  onActivate={!isActive ? () => handleActivate(provider.id) : undefined}
                  title={provider.name}
                  subtitle={<span className="font-mono text-[11.5px]">{`${provider.baseUrl} · ${provider.models.main}`}</span>}
                  badges={(
                    <>
                      {preset && preset.id !== 'custom' && (
                        <Badge tone="neutral">{preset.name}</Badge>
                      )}
                      {provider.apiFormat && provider.apiFormat !== 'anthropic' && (
                        <Badge tone="warning">
                          {provider.apiFormat === 'openai_chat' ? 'OpenAI Chat' : 'OpenAI Responses'}
                        </Badge>
                      )}
                      {isActive && (
                        <Badge tone="brand" bordered>{t('settings.providers.default')}</Badge>
                      )}
                    </>
                  )}
                  result={test && !test.loading && test.result ? (
                    <div className="mt-1 flex flex-col gap-0.5 text-xs">
                      <span className={test.result.connectivity.success ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}>
                        {test.result.connectivity.success
                          ? t('settings.providers.connectivityOk', { latency: String(test.result.connectivity.latencyMs) })
                          : t('settings.providers.connectivityFailed', { error: test.result.connectivity.error || '' })}
                      </span>
                      {test.result.proxy && (
                        <span className={test.result.proxy.success ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}>
                          {test.result.proxy.success
                            ? t('settings.providers.proxyOk', { latency: String(test.result.proxy.latencyMs) })
                            : t('settings.providers.proxyFailed', { error: test.result.proxy.error || '' })}
                        </span>
                      )}
                    </div>
                  ) : null}
                  actions={(
                    <>
                      {!isActive && (
                        <Button variant="ghost" size="sm" onClick={() => handleActivate(provider.id)}>{t('settings.providers.setDefault')}</Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => handleTest(provider)} loading={test?.loading}>{t('settings.providers.test')}</Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditingProvider(provider)}>{t('settings.providers.edit')}</Button>
                      {!isActive && (
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(provider)} className="text-[var(--color-error)] hover:text-[var(--color-error)]">{t('common.delete')}</Button>
                      )}
                    </>
                  )}
                />
              )
            })}
          </div>
        </SortableContext>
      </DndContext>

      {isLoading && providers.length === 0 ? (
        <div className="flex justify-center py-8">
          <Spinner size={20} tone="brand" label={t('common.loading')} />
        </div>
      ) : providersError && providers.length === 0 ? (
        // v1.7.3 A2：拉取失败不再落进「暂无供应商」空态（把失败读成没配过）。
        <ErrorState
          title={t('common.error')}
          detail={providersError}
          onRetry={() => void fetchProviders()}
          retryLabel={t('common.retry')}
        />
      ) : !isLoading && providers.length === 0 ? (
        <div className="py-4">
          <EmptyState
            title={t('settings.providers.emptyTitle')}
            description={t('settings.providers.emptyDescription')}
            action={{
              label: t('settings.providers.add'),
              onClick: () => setShowCreateModal(true),
              variant: 'primary',
            }}
          />
        </div>
      ) : null}

      {/* Create Modal — conditionally rendered so state resets on close */}
      {showCreateModal && (
        <ProviderFormModal open={true} onClose={() => setShowCreateModal(false)} mode="create" presets={presets} />
      )}

      {/* Edit Modal */}
      {editingProvider && (
        <ProviderFormModal key={editingProvider.id} open={true} onClose={() => setEditingProvider(null)} mode="edit" provider={editingProvider} presets={presets} />
      )}

      <ConfirmDialog
        open={pendingDeleteProvider !== null}
        onClose={() => {
          if (isDeletingProvider) return
          setPendingDeleteProvider(null)
        }}
        onConfirm={confirmDelete}
        title={t('common.delete')}
        body={pendingDeleteProvider ? t('settings.providers.confirmDelete', { name: pendingDeleteProvider.name }) : ''}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isDeletingProvider}
      />
    </div>
  )
}

type SortableProviderCardProps = {
  item: ProviderListItem
  isActive: boolean
  dragLabel: string
  title: ReactNode
  subtitle: ReactNode
  badges?: ReactNode
  result?: ReactNode
  actions?: ReactNode
  details?: ReactNode
  onActivate?: () => void
}

function SortableProviderCard({
  item,
  isActive,
  dragLabel,
  title,
  subtitle,
  badges,
  result,
  actions,
  details,
  onActivate,
}: SortableProviderCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={providerItemTestId(item)}
      className={`group relative flex flex-col rounded-[var(--radius-xl)] transition-[background-color,border-color,box-shadow] duration-150 ease-out ${
        isActive
          ? 'border-[1.5px] border-[var(--color-primary-fixed-dim)] bg-[var(--color-surface-container-low)]'
          : 'border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)]'
      } ${isDragging ? 'shadow-[var(--shadow-overlay)] opacity-90' : ''}`}
    >
      <div className="flex items-center gap-2 px-3.5 py-3">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={dragLabel}
          title={dragLabel}
          className="flex h-8 w-8 shrink-0 cursor-grab items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-secondary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] active:cursor-grabbing"
          style={{ touchAction: 'none' }}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onActivate}
          aria-disabled={!onActivate}
          className={`flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-sm)] text-left focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] ${
            onActivate ? 'cursor-pointer' : 'cursor-default'
          }`}
        >
          <StatusDot tone={isActive ? 'success' : 'neutral'} size="lg" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{title}</span>
              {badges}
            </span>
            <span className="mt-1 block truncate text-[12px] text-[var(--color-text-tertiary)]">{subtitle}</span>
            {result}
          </span>
        </button>
        {actions && (
          <div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
            {actions}
          </div>
        )}
      </div>
      {details}
    </div>
  )
}
