// v1.7.0 结构拆分第①批（providers）：ProviderFormModal 从 pages/Settings.tsx
// 逐字移出（原 1074-2028 行），逻辑零改动；模型层 helpers 见 ./providerFormModel。

// ─── Provider Form Modal ──────────────────────────────────────

import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Dropdown } from '@/components/ui/Dropdown'
import { SettingsPill } from '@/components/settings/SettingsSection'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n'
import {
  API_KEY_JSON_PLACEHOLDER,
  maskSettingsJsonSecrets,
  restoreSettingsJsonSecrets,
  stripProviderSettingsJsonEnv,
} from '../../lib/providerSettingsJson'
import { groupProviderModels, providerModelsErrorKey } from '../../lib/providerModels'
import { selectableProviderPresets } from '../../config/providerPresets'
import type {
  ApiFormat,
  Model1mSupport,
  ModelMapping,
  ProviderAuthStrategy,
  ProviderModelInfo,
  ProviderModelsErrorCode,
  ProviderTestResult,
  UpdateProviderInput,
} from '../../types/provider'
import type { ProviderPreset } from '../../types/providerPreset'
import {
  apply1mSupportToContextInput,
  apply1mSupportToContextInputs,
  applyDisableExperimentalBetasEnv,
  applyModel1mSupportMapping,
  applyToolSearchEnv,
  AUTO_COMPACT_WINDOW_ENV_KEY,
  buildFallbackPreset,
  buildModelContextWindows,
  buildSettingsJsonAuthEnv,
  formatContextWindow,
  getAutoCompactWindowErrorKey,
  getInitialModel1mSupport,
  getModelContextInputValue,
  getModelContextInputs,
  getModelContextWindowErrorKey,
  getProviderProxyBaseUrl,
  getPresetAutoCompactWindow,
  getPresetAuthStrategy,
  hasAnyModel1mSupport,
  hasModel1mMarker,
  inferAuthStrategyFromEnv,
  MODEL_CONTEXT_WINDOWS_ENV_KEY,
  MODEL_SLOTS,
  normalizeModelMapping,
  omitAuthEnv,
  openExternalUrl,
  parseAutoCompactWindowInput,
  readDisableExperimentalBetasFromEnv,
  readModelMappingFromSettingsEnv,
  readToolSearchEnabledFromEnv,
  requirePreset,
  stripModel1mMarker,
  stripModel1mMarkers,
  updateSettingsJsonAutoCompactWindow,
  updateSettingsJsonDisableExperimentalBetas,
  updateSettingsJsonModelContextWindows,
  updateSettingsJsonModels,
  updateSettingsJsonProviderConnection,
  updateSettingsJsonToolSearch,
  type ModelContextInputs,
  type ModelSlot,
  type ProviderFormProps,
} from './providerFormModel'
import { SETTINGS_CHECKBOX_INPUT_CLASS, SettingsCheckboxMark } from './settingsShared'

export function ProviderFormModal({ open, onClose, mode, provider, presets }: ProviderFormProps) {
  const { createProvider, updateProvider, testConfig, fetchModels } = useProviderStore()
  const fetchSettings = useSettingsStore((s) => s.fetchAll)
  const t = useTranslation()

  const fallbackPreset = buildFallbackPreset(provider)
  const loadedPresets = presets.filter((p) => p.id !== 'official')
  // Keeps retired presets, so editing a provider already saved against one still
  // resolves the preset behind its presetId instead of falling back.
  const availablePresets = loadedPresets.length > 0 ? loadedPresets : [fallbackPreset]
  // Retired presets must never be offered when adding a provider.
  const selectablePresets = selectableProviderPresets(availablePresets)
  const regularPresets = selectablePresets.filter((p) => !p.featured)
  const featuredPresets = selectablePresets.filter((p) => p.featured)
  const presetDefaultEnvKeys = useMemo(
    () => presets.flatMap((preset) => Object.keys(preset.defaultEnv ?? {})),
    [presets],
  )
  const initialPreset = provider
    ? availablePresets.find((p) => p.id === provider.presetId) ?? fallbackPreset
    : selectablePresets[0] ?? fallbackPreset
  const initialModels = stripModel1mMarkers(provider?.models ?? initialPreset.defaultModels)
  const initialModel1mSupport = getInitialModel1mSupport(
    provider?.models ?? initialPreset.defaultModels,
    provider,
  )
  const initialModelContextInputs = apply1mSupportToContextInputs(
    getModelContextInputs(initialModels, initialPreset, provider),
    initialModel1mSupport,
  )

  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset>(initialPreset)
  const [name, setName] = useState(provider?.name ?? initialPreset.name)
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? initialPreset.baseUrl)
  const [apiFormat, setApiFormat] = useState<ApiFormat>(provider?.apiFormat ?? initialPreset.apiFormat ?? 'anthropic')
  const [authStrategy, setAuthStrategy] = useState<ProviderAuthStrategy>(provider?.authStrategy ?? getPresetAuthStrategy(initialPreset))
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? '')
  const [showApiKey, setShowApiKey] = useState(false)
  const [notes, setNotes] = useState(provider?.notes ?? '')
  const [models, setModels] = useState<ModelMapping>(initialModels)
  const [model1mSupport, setModel1mSupport] = useState<Model1mSupport>(initialModel1mSupport)
  const [modelContextInputs, setModelContextInputs] = useState<ModelContextInputs>(initialModelContextInputs)
  const [autoCompactWindow, setAutoCompactWindow] = useState(
    provider?.autoCompactWindow !== undefined
      ? String(provider.autoCompactWindow)
      : getPresetAutoCompactWindow(initialPreset),
  )
  const [toolSearchEnabled, setToolSearchEnabled] = useState(provider?.toolSearchEnabled ?? true)
  const [disableExperimentalBetas, setDisableExperimentalBetas] = useState(provider?.disableExperimentalBetas ?? false)
  const [showContextSettings, setShowContextSettings] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null)
  const [isTesting, setIsTesting] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<ProviderModelInfo[] | null>(null)
  const [modelsErrorCode, setModelsErrorCode] = useState<ProviderModelsErrorCode | null>(null)
  const [modelsErrorMessage, setModelsErrorMessage] = useState<string | null>(null)
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const modelsRequestRef = useRef(0)
  const [settingsJson, setSettingsJson] = useState('')
  const [settingsJsonError, setSettingsJsonError] = useState<string | null>(null)
  const jsonPastedRef = useRef(false)
  const providerProxyBaseUrl = useMemo(() => getProviderProxyBaseUrl(), [])

  // Load current settings.json and merge provider env vars
  useEffect(() => {
    // Skip if JSON was just populated by user paste
    if (jsonPastedRef.current) {
      jsonPastedRef.current = false
      return
    }
    import('../../api/providers').then(({ providersApi }) => {
      providersApi.getSettings().then((settings) => {
        const needsProxy = apiFormat !== 'anthropic'
        const autoCompactWindowEnv = autoCompactWindow.trim()
        const modelContextWindows = buildModelContextWindows(models, modelContextInputs)
        const normalizedModels = normalizeModelMapping(models)
        const runtimeModels = applyModel1mSupportMapping(normalizedModels, model1mSupport)
        const existingEnv = (settings.env as Record<string, string>) || {}
        const cleanedEnv = stripProviderSettingsJsonEnv(existingEnv, presetDefaultEnvKeys)
        const mergedEnv: Record<string, unknown> = {
          ...cleanedEnv,
          ...omitAuthEnv(selectedPreset.defaultEnv),
          ...(autoCompactWindowEnv ? { [AUTO_COMPACT_WINDOW_ENV_KEY]: autoCompactWindowEnv } : {}),
          ...(Object.keys(modelContextWindows).length > 0
            ? { [MODEL_CONTEXT_WINDOWS_ENV_KEY]: JSON.stringify(modelContextWindows) }
            : {}),
          ANTHROPIC_BASE_URL: needsProxy ? providerProxyBaseUrl : baseUrl,
          ...buildSettingsJsonAuthEnv(apiFormat, authStrategy, apiKey, selectedPreset),
          ANTHROPIC_MODEL: runtimeModels.main,
          ...(runtimeModels.fable ? { ANTHROPIC_DEFAULT_FABLE_MODEL: runtimeModels.fable } : {}),
          ANTHROPIC_DEFAULT_HAIKU_MODEL: runtimeModels.haiku,
          ANTHROPIC_DEFAULT_SONNET_MODEL: runtimeModels.sonnet,
          ANTHROPIC_DEFAULT_OPUS_MODEL: runtimeModels.opus,
        }
        applyToolSearchEnv(mergedEnv, apiFormat, toolSearchEnabled)
        applyDisableExperimentalBetasEnv(mergedEnv, disableExperimentalBetas)
        const merged = {
          ...settings,
          skipWebFetchPreflight: settings.skipWebFetchPreflight ?? true,
          env: mergedEnv,
        }
        setSettingsJson(JSON.stringify(merged, null, 2))
      }).catch(() => {
        setSettingsJson(JSON.stringify({}, null, 2))
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPreset.id, providerProxyBaseUrl])

  // A fetched list only describes the endpoint and key it came from. cc-switch
  // shipped this without a guard and kept offering the previous provider's
  // models after the user pasted a new key, which reads as the picker lying.
  useEffect(() => {
    // Bumping the token also disowns a probe that is still in flight: it walks
    // up to three candidate endpoints at 15s each, so it can easily outlive the
    // edit and re-fill the picker with the previous credentials' models.
    modelsRequestRef.current += 1
    setFetchedModels(null)
    setModelsErrorCode(null)
    setModelsErrorMessage(null)
    setIsFetchingModels(false)
  }, [baseUrl, apiKey])

  const handlePresetChange = (preset: ProviderPreset) => {
    setSelectedPreset(preset)
    setName(preset.name)
    setBaseUrl(preset.baseUrl)
    setApiFormat(preset.apiFormat ?? 'anthropic')
    setAuthStrategy(getPresetAuthStrategy(preset))
    const nextModels = stripModel1mMarkers(preset.defaultModels)
    const nextModel1mSupport = getInitialModel1mSupport(preset.defaultModels)
    const nextModelContextInputs = apply1mSupportToContextInputs(
      getModelContextInputs(nextModels, preset),
      nextModel1mSupport,
    )
    setModels(nextModels)
    setModel1mSupport(nextModel1mSupport)
    setModelContextInputs(nextModelContextInputs)
    setAutoCompactWindow(getPresetAutoCompactWindow(preset))
    setToolSearchEnabled(true)
    setDisableExperimentalBetas(false)
    setShowContextSettings(false)
    setTestResult(null)
  }

  const isCustom = selectedPreset.id === 'custom'
  const requiresApiKey = selectedPreset.needsApiKey !== false
  const autoCompactWindowErrorKey = getAutoCompactWindowErrorKey(autoCompactWindow)
  const modelContextWindowErrorSlots = MODEL_SLOTS.filter((slot) => getModelContextWindowErrorKey(modelContextInputs[slot]))
  const canSubmit = name.trim() && baseUrl.trim() && (mode === 'edit' || !requiresApiKey || apiKey.trim()) && models.main.trim() && !settingsJsonError && !autoCompactWindowErrorKey && modelContextWindowErrorSlots.length === 0
  const apiKeyUrl = selectedPreset.apiKeyUrl?.trim()
  const promoText = selectedPreset.promoText?.trim()
  const displayedSettingsJson = showApiKey
    ? settingsJson
    : maskSettingsJsonSecrets(settingsJson)
  const apiFormatItems = [
    {
      value: 'anthropic' as const,
      label: t('settings.providers.apiFormatAnthropic'),
      icon: <span className="material-symbols-outlined text-[17px]">hub</span>,
    },
    {
      value: 'openai_chat' as const,
      label: t('settings.providers.apiFormatOpenaiChat'),
      icon: <span className="material-symbols-outlined text-[17px]">forum</span>,
    },
    {
      value: 'openai_responses' as const,
      label: t('settings.providers.apiFormatOpenaiResponses'),
      icon: <span className="material-symbols-outlined text-[17px]">route</span>,
    },
  ]
  const selectedApiFormatLabel = apiFormatItems.find((item) => item.value === apiFormat)?.label ?? t('settings.providers.apiFormatAnthropic')
  const authStrategyItems = [
    {
      value: 'auth_token' as const,
      label: t('settings.providers.authStrategyAuthToken'),
      description: t('settings.providers.authStrategyAuthTokenDesc'),
      icon: <span className="material-symbols-outlined text-[17px]">key</span>,
    },
    {
      value: 'auth_token_empty_api_key' as const,
      label: t('settings.providers.authStrategyAuthTokenEmptyApiKey'),
      description: t('settings.providers.authStrategyAuthTokenEmptyApiKeyDesc'),
      icon: <span className="material-symbols-outlined text-[17px]">key_off</span>,
    },
    {
      value: 'api_key' as const,
      label: t('settings.providers.authStrategyApiKey'),
      description: t('settings.providers.authStrategyApiKeyDesc'),
      icon: <span className="material-symbols-outlined text-[17px]">vpn_key</span>,
    },
    {
      value: 'dual_same_token' as const,
      label: t('settings.providers.authStrategyDualSameToken'),
      description: t('settings.providers.authStrategyDualSameTokenDesc'),
      icon: <span className="material-symbols-outlined text-[17px]">sync_alt</span>,
    },
    {
      value: 'dual_dummy' as const,
      label: t('settings.providers.authStrategyDualDummy'),
      description: t('settings.providers.authStrategyDualDummyDesc'),
      icon: <span className="material-symbols-outlined text-[17px]">construction</span>,
    },
  ] satisfies Array<{ value: ProviderAuthStrategy; label: string; description: string; icon: ReactNode }>
  const selectedAuthStrategyLabel = authStrategyItems.find((item) => item.value === authStrategy)?.label ?? t('settings.providers.authStrategyAuthToken')
  const toolSearchUnsupported = apiFormat !== 'anthropic'
  const toolSearchDescription = toolSearchUnsupported
    ? t('settings.providers.toolSearchUnsupported')
    : t('settings.providers.toolSearchDesc')
  const configuredContextWindows = buildModelContextWindows(models, modelContextInputs)
  const configuredContextSummary = Object.entries(configuredContextWindows)
    .filter(([model], index, entries) => entries.findIndex(([candidate]) => candidate === model) === index)
    .map(([model, value]) => `${model}: ${formatContextWindow(value)}`)
  const parsedFallbackContextWindow = parseAutoCompactWindowInput(autoCompactWindow)
  const fallbackContextSummary = parsedFallbackContextWindow !== undefined
    ? t('settings.providers.contextFallbackSummary', {
      tokens: formatContextWindow(parsedFallbackContextWindow),
    })
    : t('settings.providers.contextFallbackAuto')
  const contextSummary = configuredContextSummary.length > 0
    ? [...configuredContextSummary, fallbackContextSummary].join(' · ')
    : t('settings.providers.contextSummaryAuto')
  const shouldShowContextFields = showContextSettings || modelContextWindowErrorSlots.length > 0 || !!autoCompactWindowErrorKey
  const handleAutoCompactWindowChange = (value: string) => {
    setAutoCompactWindow(value)
    setSettingsJson((current) => updateSettingsJsonAutoCompactWindow(current, value))
  }
  const handleBaseUrlChange = (value: string) => {
    setBaseUrl(value)
    setSettingsJson((current) => updateSettingsJsonProviderConnection(current, apiFormat, authStrategy, apiKey, selectedPreset, value, providerProxyBaseUrl, toolSearchEnabled, disableExperimentalBetas))
  }
  const handleApiKeyChange = (value: string) => {
    setApiKey(value)
    setSettingsJson((current) => updateSettingsJsonProviderConnection(current, apiFormat, authStrategy, value, selectedPreset, baseUrl, providerProxyBaseUrl, toolSearchEnabled, disableExperimentalBetas))
  }
  const handleApiFormatChange = (value: ApiFormat) => {
    setApiFormat(value)
    setSettingsJson((current) => updateSettingsJsonProviderConnection(current, value, authStrategy, apiKey, selectedPreset, baseUrl, providerProxyBaseUrl, toolSearchEnabled, disableExperimentalBetas))
  }
  const handleAuthStrategyChange = (value: ProviderAuthStrategy) => {
    setAuthStrategy(value)
    setSettingsJson((current) => updateSettingsJsonProviderConnection(current, apiFormat, value, apiKey, selectedPreset, baseUrl, providerProxyBaseUrl, toolSearchEnabled, disableExperimentalBetas))
  }
  const handleToolSearchToggle = (enabled: boolean) => {
    if (toolSearchUnsupported) return
    setToolSearchEnabled(enabled)
    setSettingsJson((current) => updateSettingsJsonToolSearch(current, apiFormat, enabled))
  }
  const handleDisableExperimentalBetasToggle = (disabled: boolean) => {
    setDisableExperimentalBetas(disabled)
    setSettingsJson((current) => updateSettingsJsonDisableExperimentalBetas(current, disabled))
  }
  const handleModelChange = (slot: ModelSlot, value: string) => {
    const hasMarker = hasModel1mMarker(value)
    const nextModels = { ...models, [slot]: stripModel1mMarker(value) }
    const nextModel1mSupport = hasMarker
      ? { ...model1mSupport, [slot]: true }
      : model1mSupport
    const nextInputs = {
      ...modelContextInputs,
      [slot]: getModelContextInputValue(nextModels[slot], selectedPreset, provider),
    }
    const nextInputsWith1mSupport = apply1mSupportToContextInput(
      nextInputs,
      slot,
      nextModel1mSupport[slot],
    )
    setModels(nextModels)
    setModel1mSupport(nextModel1mSupport)
    setModelContextInputs(nextInputsWith1mSupport)
    setSettingsJson((current) => updateSettingsJsonModelContextWindows(
      updateSettingsJsonModels(current, normalizeModelMapping(nextModels), nextModel1mSupport),
      buildModelContextWindows(nextModels, nextInputsWith1mSupport),
    ))
  }
  const handleModel1mSupportChange = (slot: ModelSlot, enabled: boolean) => {
    const nextModel1mSupport = { ...model1mSupport, [slot]: enabled }
    const nextInputs = apply1mSupportToContextInput(modelContextInputs, slot, enabled)
    setModel1mSupport(nextModel1mSupport)
    setModelContextInputs(nextInputs)
    setSettingsJson((current) => updateSettingsJsonModelContextWindows(
      updateSettingsJsonModels(current, normalizeModelMapping(models), nextModel1mSupport),
      buildModelContextWindows(models, nextInputs),
    ))
  }
  const handleModelContextWindowChange = (slot: ModelSlot, value: string) => {
    const nextInputs = { ...modelContextInputs, [slot]: value }
    setModelContextInputs(nextInputs)
    setSettingsJson((current) => updateSettingsJsonModelContextWindows(
      current,
      buildModelContextWindows(models, nextInputs),
    ))
  }
  const canFetchModels = Boolean(baseUrl.trim() && apiKey.trim())
  const handleFetchModels = async () => {
    if (!canFetchModels || isFetchingModels) return
    const requestId = modelsRequestRef.current + 1
    modelsRequestRef.current = requestId
    setIsFetchingModels(true)
    setModelsErrorCode(null)
    setModelsErrorMessage(null)
    try {
      // Upstream failures arrive as a resolved `ok: false`, so the catch below
      // only covers our own server being unreachable.
      const result = await fetchModels({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() })
      // The form moved on while we were probing — this answer describes a base
      // URL or key the user no longer has typed in.
      if (modelsRequestRef.current !== requestId) return
      if (result.ok) {
        setFetchedModels(result.models)
      } else {
        setFetchedModels(null)
        setModelsErrorCode(result.errorCode)
        setModelsErrorMessage(result.message?.trim() || null)
      }
    } catch {
      if (modelsRequestRef.current !== requestId) return
      setFetchedModels(null)
      setModelsErrorCode('unknown')
      setModelsErrorMessage(null)
    } finally {
      // The config-change effect already cleared the flag for a discarded
      // request; clearing it again here would race a newer fetch.
      if (modelsRequestRef.current === requestId) setIsFetchingModels(false)
    }
  }
  const modelsErrorText = modelsErrorCode ? t(providerModelsErrorKey(modelsErrorCode)) : null
  // The server keeps the upstream's own wording, which is the only thing that
  // separates a 200-cloaked auth failure (智谱 answers `{"msg":"身份验证失败。"}`
  // with HTTP 200, classified `not-supported`) from a provider that genuinely
  // publishes no model list. Display-only: nothing branches on this text.
  const modelsErrorUpstream = modelsErrorMessage && modelsErrorMessage !== modelsErrorText
    ? modelsErrorMessage
    : null
  const modelPickerItems = useMemo(
    () => groupProviderModels(
      fetchedModels ?? [],
      t('settings.providers.fetchModelsGroupOther'),
    ).flatMap((group) => group.models.map((model) => ({
      value: model.id,
      label: model.id,
      description: group.group,
    }))),
    [fetchedModels, t],
  )
  const renderPresetButton = (preset: ProviderPreset) => (
    <SettingsPill
      key={preset.id}
      tone="terracotta"
      selected={selectedPreset.id === preset.id}
      onClick={() => handlePresetChange(preset)}
    >
      {preset.name}
    </SettingsPill>
  )

  const handleSubmit = async () => {
    if (!canSubmit || isSubmitting) return
    const normalizedModels = normalizeModelMapping(models)
    const parsedAutoCompactWindow = parseAutoCompactWindowInput(autoCompactWindow)
    const parsedModelContextWindows = buildModelContextWindows(models, modelContextInputs)
    const storedModel1mSupport = hasAnyModel1mSupport(model1mSupport)
      ? model1mSupport
      : undefined
    setIsSubmitting(true)
    try {
      // Write the edited cc-heihei settings.json first so provider-specific model
      // settings never conflict with the user's global ~/.claude/settings.json.
      if (settingsJson.trim()) {
        try {
          const parsed = restoreSettingsJsonSecrets(JSON.parse(settingsJson), settingsJson, apiKey)
          const { providersApi } = await import('../../api/providers')
          await providersApi.updateSettings(parsed)
        } catch {
          // JSON validation already prevents this
        }
      }

      if (mode === 'create') {
        await createProvider({
          presetId: selectedPreset.id,
          name: name.trim(),
          apiKey: apiKey.trim(),
          authStrategy,
          baseUrl: baseUrl.trim(),
          apiFormat,
          models: normalizedModels,
          ...(storedModel1mSupport !== undefined && { model1mSupport: storedModel1mSupport }),
          ...(parsedAutoCompactWindow !== undefined && { autoCompactWindow: parsedAutoCompactWindow }),
          ...(Object.keys(parsedModelContextWindows).length > 0 && { modelContextWindows: parsedModelContextWindows }),
          toolSearchEnabled,
          ...(disableExperimentalBetas && { disableExperimentalBetas }),
          notes: notes.trim() || undefined,
        })
      } else if (provider) {
        const input: UpdateProviderInput = {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          authStrategy,
          apiFormat,
          models: normalizedModels,
          model1mSupport: storedModel1mSupport ?? null,
          autoCompactWindow: parsedAutoCompactWindow ?? null,
          modelContextWindows: Object.keys(parsedModelContextWindows).length > 0
            ? parsedModelContextWindows
            : null,
          toolSearchEnabled,
          disableExperimentalBetas,
          notes: notes.trim() || undefined,
        }
        if (apiKey.trim()) input.apiKey = apiKey.trim()
        await updateProvider(provider.id, input)
      }
      await fetchSettings()
      onClose()
    } catch (err) {
      console.error('Failed to save provider:', err)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    if (isSubmitting) return
    onClose()
  }

  const handleTest = async () => {
    if (!baseUrl.trim() || !models.main.trim()) return
    setIsTesting(true)
    setTestResult(null)
    try {
      let result: ProviderTestResult
      const savedConfigUnchanged = mode === 'edit' && provider && !apiKey.trim() &&
        baseUrl.trim() === provider.baseUrl.trim() &&
        apiFormat === provider.apiFormat &&
        authStrategy === provider.authStrategy
      if (savedConfigUnchanged && provider) {
        result = await useProviderStore.getState().testProvider(provider.id, {
          modelId: models.main.trim(),
        })
      } else {
        if (requiresApiKey && !apiKey.trim()) return
        result = await testConfig({
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || selectedPreset.defaultEnv?.ANTHROPIC_AUTH_TOKEN || 'local',
          modelId: models.main.trim(),
          authStrategy,
          apiFormat,
        })
      }
      setTestResult(result)
    } catch {
      setTestResult({ connectivity: { success: false, latencyMs: 0, error: t('settings.providers.requestFailed') } })
    } finally {
      setIsTesting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={mode === 'create' ? t('settings.providers.addTitle') : t('settings.providers.editTitle')}
      width={860}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={isSubmitting}>{t('common.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || isSubmitting} loading={isSubmitting}>
            {mode === 'create' ? t('common.add') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Preset chips */}
        {mode === 'create' && (
          <div>
            <label className="text-sm font-medium text-[var(--color-text-primary)] mb-2 block">{t('settings.providers.preset')}</label>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {regularPresets.map(renderPresetButton)}
              </div>
              {featuredPresets.length > 0 && (
                <div className="flex flex-wrap gap-2 border-t border-[var(--color-border-separator)] pt-2">
                  {featuredPresets.map(renderPresetButton)}
                </div>
              )}
            </div>
          </div>
        )}

        <Input label={t('settings.providers.name')} required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.providers.namePlaceholder')} />

        <Input label={t('settings.providers.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('settings.providers.notesPlaceholder')} />

        <Input label={t('settings.providers.baseUrl')} required value={baseUrl} onChange={(e) => handleBaseUrlChange(e.target.value)} placeholder={t('settings.providers.baseUrlPlaceholder')} className="font-mono text-[13px]" />

        {/* API Format */}
        {(isCustom || mode === 'edit') ? (
          <div>
            <label className="text-sm font-medium text-[var(--color-text-primary)] mb-1 block">{t('settings.providers.apiFormat')}</label>
            <Dropdown<ApiFormat>
              items={apiFormatItems}
              value={apiFormat}
              onChange={handleApiFormatChange}
              width="100%"
              className="block w-full"
              trigger={
                <Button variant="secondary" size="md" block className="h-10 gap-3">
                  <span className="min-w-0 flex-1 truncate text-left">{selectedApiFormatLabel}</span>
                  <span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-text-secondary)]">expand_more</span>
                </Button>
              }
            />
            {apiFormat !== 'anthropic' && (
              <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1">{t('settings.providers.proxyHint')}</p>
            )}
          </div>
        ) : apiFormat !== 'anthropic' ? (
          <div>
            <label className="text-sm font-medium text-[var(--color-text-primary)] mb-1 block">{t('settings.providers.apiFormat')}</label>
            <div className="text-xs text-[var(--color-text-tertiary)] px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] border border-[var(--color-border)]">
              {apiFormat === 'openai_chat' ? t('settings.providers.apiFormatOpenaiChat') : t('settings.providers.apiFormatOpenaiResponses')}
            </div>
          </div>
        ) : null}

        {apiFormat === 'anthropic' && (
          <div>
            <label className="text-sm font-medium text-[var(--color-text-primary)] mb-1 block">{t('settings.providers.authStrategy')}</label>
            <Dropdown<ProviderAuthStrategy>
              items={authStrategyItems}
              value={authStrategy}
              onChange={handleAuthStrategyChange}
              width="100%"
              className="block w-full"
              trigger={
                <Button variant="secondary" size="md" block className="h-auto min-h-10 gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-left">{selectedAuthStrategyLabel}</span>
                  <span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-text-secondary)]">expand_more</span>
                </Button>
              }
            />
          </div>
        )}

        <label
          className={`relative flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-3 transition-colors ${
            toolSearchUnsupported
              ? 'cursor-not-allowed opacity-70'
              : 'cursor-pointer hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)]'
          }`}
        >
          <input
            type="checkbox"
            aria-label={t('settings.providers.toolSearchEnabled')}
            checked={toolSearchEnabled && !toolSearchUnsupported}
            disabled={toolSearchUnsupported}
            onChange={(e) => handleToolSearchToggle(e.target.checked)}
            className={SETTINGS_CHECKBOX_INPUT_CLASS}
          />
          <SettingsCheckboxMark checked={toolSearchEnabled && !toolSearchUnsupported} disabled={toolSearchUnsupported} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.providers.toolSearchEnabled')}
            </div>
            <div className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">
              {toolSearchDescription}
            </div>
          </div>
        </label>

        <label className="relative flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-3 transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)]">
          <input
            type="checkbox"
            aria-label={t('settings.providers.disableExperimentalBetas')}
            checked={disableExperimentalBetas}
            onChange={(e) => handleDisableExperimentalBetasToggle(e.target.checked)}
            className={SETTINGS_CHECKBOX_INPUT_CLASS}
          />
          <SettingsCheckboxMark checked={disableExperimentalBetas} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.providers.disableExperimentalBetas')}
            </div>
            <div className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">
              {t('settings.providers.disableExperimentalBetasDesc')}
            </div>
          </div>
        </label>

        <div className="flex flex-col gap-1">
          <label htmlFor="provider-api-key" className="text-sm font-medium text-[var(--color-text-primary)]">
            {t('settings.providers.apiKey')}
            {mode === 'create' && requiresApiKey && <span className="text-[var(--color-error)] ml-0.5">*</span>}
          </label>
          <div className="relative">
            <input
              id="provider-api-key"
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              placeholder="sk-..."
              className="h-10 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 pr-10 text-sm text-[var(--color-text-primary)] outline-none transition-colors duration-150 placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)]"
            />
            <IconButton
              icon={showApiKey ? 'visibility_off' : 'visibility'}
              label={t(showApiKey ? 'settings.providers.hideApiKey' : 'settings.providers.showApiKey')}
              showTooltip={false}
              size="sm"
              tone="muted"
              onClick={() => setShowApiKey((visible) => !visible)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
            />
          </div>
        </div>

        {(apiKeyUrl || promoText) && (
          <div className="-mt-2 flex flex-col gap-1.5">
            {apiKeyUrl && (
              <button
                type="button"
                onClick={() => openExternalUrl(apiKeyUrl)}
                className="group inline-flex h-6 w-fit cursor-pointer items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1.5 text-[11px] font-medium leading-none text-[var(--color-brand)] transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus:outline-none focus:shadow-[var(--shadow-focus-ring)]"
              >
                <span className="material-symbols-outlined text-[13px]">key</span>
                {t('settings.providers.getApiKey')}
                <span className="material-symbols-outlined text-[9px] opacity-60 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5">arrow_outward</span>
              </button>
            )}
            {promoText && (
              <button
                type="button"
                onClick={() => apiKeyUrl && openExternalUrl(apiKeyUrl)}
                disabled={!apiKeyUrl}
                className="group flex w-full cursor-pointer items-start gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-primary-fixed-dim)] bg-[var(--color-brand-soft)] px-2.5 py-1.5 text-left text-[11px] leading-5 text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-brand)] hover:bg-[var(--color-brand-soft-hover)] focus:outline-none focus:shadow-[var(--shadow-focus-ring)] disabled:cursor-default disabled:hover:border-[var(--color-primary-fixed-dim)] disabled:hover:bg-[var(--color-brand-soft)]"
              >
                <span className="material-symbols-outlined mt-0.5 text-[13px] text-[var(--color-brand)]">tips_and_updates</span>
                <span>{promoText}</span>
                {apiKeyUrl && (
                  <span className="material-symbols-outlined ml-auto mt-1 text-[10px] text-[var(--color-brand)] opacity-45 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5">arrow_outward</span>
                )}
              </button>
            )}
          </div>
        )}

        {/* Model Mapping */}
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <label className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.providers.modelMapping')}</label>
            <Button
              variant="secondary"
              size="base"
              onClick={handleFetchModels}
              disabled={!canFetchModels}
              loading={isFetchingModels}
              icon={<span className="material-symbols-outlined text-[15px]">cloud_download</span>}
            >
              {t('settings.providers.fetchModels')}
            </Button>
          </div>
          {!canFetchModels ? (
            <p className="mb-2 text-[11px] text-[var(--color-text-tertiary)]">{t('settings.providers.fetchModelsHint')}</p>
          ) : modelsErrorCode ? (
            <div role="alert" className="mb-2 flex flex-col gap-0.5">
              <p className="text-[11px] text-[var(--color-error)]">{modelsErrorText}</p>
              {modelsErrorUpstream && (
                <p className="break-words text-[11px] text-[var(--color-text-tertiary)]">
                  {t('settings.providers.fetchModelsErrorUpstream')} {modelsErrorUpstream}
                </p>
              )}
            </div>
          ) : fetchedModels && fetchedModels.length === 0 ? (
            <p className="mb-2 text-[11px] text-[var(--color-text-tertiary)]">{t('settings.providers.fetchModelsEmpty')}</p>
          ) : fetchedModels ? (
            <p className="mb-2 text-[11px] text-[var(--color-text-secondary)]">
              {t('settings.providers.fetchModelsLoaded', { count: fetchedModels.length })}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            {MODEL_SLOTS.map((slot) => {
              const labelKey = slot === 'main'
                ? 'settings.providers.mainModel'
                : slot === 'haiku'
                  ? 'settings.providers.haikuModel'
                  : slot === 'sonnet'
                    ? 'settings.providers.sonnetModel'
                    : 'settings.providers.opusModel'
              const label = t(labelKey)
              const pickLabel = t('settings.providers.fetchModelsPick', { label })
              return (
                <div key={slot} className="min-w-0">
                  <div className="flex items-end gap-1.5">
                    <Input
                      containerClassName="min-w-0 flex-1"
                      label={label}
                      required={slot === 'main'}
                      value={models[slot]}
                      onChange={(e) => handleModelChange(slot, e.target.value)}
                      placeholder={slot === 'main' ? t('settings.providers.modelIdPlaceholder') : t('settings.providers.sameAsMain')}
                    />
                    {/* The picker only supplements the field — the id stays typeable. */}
                    {modelPickerItems.length > 0 && (
                      <Dropdown<string>
                        items={modelPickerItems}
                        value={models[slot]}
                        onChange={(value) => handleModelChange(slot, value)}
                        label={pickLabel}
                        align="right"
                        maxHeight={260}
                        trigger={<IconButton icon="expand_more" label={pickLabel} size="xl" tone="secondary" bordered />}
                      />
                    )}
                  </div>
                  <label className="mt-1 inline-flex h-6 w-fit cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] px-1 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]">
                    <input
                      type="checkbox"
                      checked={model1mSupport[slot]}
                      onChange={(e) => handleModel1mSupportChange(slot, e.target.checked)}
                      aria-label={`1M support: ${slot}`}
                      className="h-3.5 w-3.5 rounded border-[var(--color-border)] text-[var(--color-brand)] accent-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                    />
                    <span>{t('settings.providers.model1mSupportShort')}</span>
                  </label>
                </div>
              )
            })}
          </div>
        </div>

        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
          <button
            type="button"
            onClick={() => setShowContextSettings((visible) => !visible)}
            className="flex w-full items-start gap-3 px-3 py-3 text-left outline-none transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:shadow-[var(--shadow-focus-ring)]"
            aria-expanded={shouldShowContextFields}
          >
            <span className="material-symbols-outlined mt-0.5 text-[18px] text-[var(--color-brand)]">compress</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.providers.contextSettingsTitle')}
              </span>
              <span className="mt-1 block truncate text-xs text-[var(--color-text-secondary)]">
                {contextSummary}
              </span>
              <span className="mt-1 block text-[11px] leading-5 text-[var(--color-text-tertiary)]">
                {t('settings.providers.contextSettingsDesc')}
              </span>
            </span>
            <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-brand)]">
              {shouldShowContextFields
                ? t('settings.providers.contextSettingsHide')
                : t('settings.providers.contextSettingsEdit')}
              <span className="material-symbols-outlined text-[16px]">
                {shouldShowContextFields ? 'expand_less' : 'expand_more'}
              </span>
            </span>
          </button>

          {shouldShowContextFields && (
            <div className="border-t border-[var(--color-border)] px-3 pb-3 pt-3">
              <div>
                <label className="text-sm font-medium text-[var(--color-text-primary)] mb-2 block">{t('settings.providers.modelContextWindows')}</label>
                <div className="grid grid-cols-2 gap-2">
                  {MODEL_SLOTS.map((slot) => {
                    const errorKey = getModelContextWindowErrorKey(modelContextInputs[slot])
                    const labelKey = slot === 'main'
                      ? 'settings.providers.mainContextWindow'
                      : slot === 'haiku'
                        ? 'settings.providers.haikuContextWindow'
                        : slot === 'sonnet'
                          ? 'settings.providers.sonnetContextWindow'
                          : 'settings.providers.opusContextWindow'
                    return (
                      <div key={slot}>
                        <Input
                          label={t(labelKey)}
                          value={modelContextInputs[slot]}
                          onChange={(e) => handleModelContextWindowChange(slot, e.target.value)}
                          placeholder={t('settings.providers.contextWindowPlaceholder')}
                        />
                        {errorKey && (
                          <p className="text-[11px] text-[var(--color-error)] mt-1">
                            {errorKey === 'number'
                              ? t('settings.providers.modelContextWindowNumberError')
                              : t('settings.providers.modelContextWindowRangeError')}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
                <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1">
                  {t('settings.providers.modelContextWindowsDesc')}
                </p>
              </div>

              <div className="mt-3">
                <Input
                  label={t('settings.providers.autoCompactWindow')}
                  value={autoCompactWindow}
                  onChange={(e) => handleAutoCompactWindowChange(e.target.value)}
                  placeholder={t('settings.providers.autoCompactWindowPlaceholder')}
                />
                {autoCompactWindowErrorKey ? (
                  <p className="text-[11px] text-[var(--color-error)] mt-1">
                    {autoCompactWindowErrorKey === 'number'
                      ? t('settings.providers.autoCompactWindowNumberError')
                      : t('settings.providers.autoCompactWindowRangeError')}
                  </p>
                ) : (
                  <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1">
                    {t('settings.providers.autoCompactWindowDesc')}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Test connection */}
        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={handleTest} loading={isTesting} disabled={!baseUrl.trim() || !models.main.trim()}>
            {t('settings.providers.testConnection')}
          </Button>
          {testResult && (
            <div className="flex flex-col gap-0.5">
              <span className={`text-xs ${testResult.connectivity.success ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}>
                {testResult.connectivity.success
                  ? t('settings.providers.connectivityOk', { latency: String(testResult.connectivity.latencyMs) })
                  : t('settings.providers.connectivityFailed', { error: testResult.connectivity.error || '' })}
              </span>
              {testResult.proxy && (
                <span className={`text-xs ${testResult.proxy.success ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}>
                  {testResult.proxy.success
                    ? t('settings.providers.proxyOk', { latency: String(testResult.proxy.latencyMs) })
                    : t('settings.providers.proxyFailed', { error: testResult.proxy.error || '' })}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Settings JSON — editable, shown for all presets including official */}
        <div>
          <label className="text-sm font-medium text-[var(--color-text-primary)] mb-2 block">{t('settings.providers.settingsJson')}</label>
          <textarea
            value={displayedSettingsJson}
            onChange={(e) => {
              const raw = e.target.value
              try {
                const parsed = restoreSettingsJsonSecrets(JSON.parse(raw), settingsJson, apiKey)
                setSettingsJson(JSON.stringify(parsed, null, 2))
                setSettingsJsonError(null)
                // Auto-fill form fields from parsed JSON env
                const env = parsed.env as Record<string, string> | undefined
                if (env) {
                  if (env.ANTHROPIC_BASE_URL) {
                    setBaseUrl(env.ANTHROPIC_BASE_URL)
                    // Auto-switch to matching preset or Custom
                    if (mode === 'create') {
                      const matchedPreset = selectablePresets.find((p) => p.id !== 'custom' && p.baseUrl === env.ANTHROPIC_BASE_URL)
                      const targetPreset = requirePreset(
                        matchedPreset ?? selectablePresets.find((p) => p.id === 'custom'),
                      )
                      if (targetPreset.id !== selectedPreset.id) {
                        jsonPastedRef.current = true
                        setSelectedPreset(targetPreset)
                      }
                    }
                  }
                  const nextApiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY
                  if (nextApiKey && nextApiKey !== '(your API key)' && nextApiKey !== API_KEY_JSON_PLACEHOLDER) {
                    setApiKey(nextApiKey)
                  }
                  const nextAuthStrategy = inferAuthStrategyFromEnv(env)
                  if (nextAuthStrategy) {
                    setAuthStrategy(nextAuthStrategy)
                  }
                  setToolSearchEnabled(readToolSearchEnabledFromEnv(env))
                  setDisableExperimentalBetas(readDisableExperimentalBetasFromEnv(env))
                  if (env[AUTO_COMPACT_WINDOW_ENV_KEY] !== undefined) {
                    setAutoCompactWindow(String(env[AUTO_COMPACT_WINDOW_ENV_KEY]))
                  } else {
                    setAutoCompactWindow('')
                  }
                  let parsedContextWindows: Record<string, number> = {}
                  if (typeof env[MODEL_CONTEXT_WINDOWS_ENV_KEY] === 'string') {
                    try {
                      const parsedContext = JSON.parse(env[MODEL_CONTEXT_WINDOWS_ENV_KEY]) as Record<string, unknown>
                      parsedContextWindows = Object.fromEntries(
                        Object.entries(parsedContext)
                          .filter(([, value]) => typeof value === 'number' && Number.isInteger(value)),
                      ) as Record<string, number>
                    } catch {
                      parsedContextWindows = {}
                    }
                  }
                  const newModels = readModelMappingFromSettingsEnv(env)
                  if (Object.keys(newModels).length > 0) {
                    setModels((prev) => {
                      const mergedModels = { ...prev, ...newModels }
                      const nextModel1mSupport = {
                        main: hasModel1mMarker(mergedModels.main),
                        haiku: hasModel1mMarker(mergedModels.haiku),
                        sonnet: hasModel1mMarker(mergedModels.sonnet),
                        opus: hasModel1mMarker(mergedModels.opus),
                      }
                      const nextModels = stripModel1mMarkers(mergedModels)
                      setModel1mSupport(nextModel1mSupport)
                      setModelContextInputs(apply1mSupportToContextInputs(
                        getModelContextInputs(nextModels, {
                          ...selectedPreset,
                          modelContextWindows: parsedContextWindows,
                        }),
                        nextModel1mSupport,
                      ))
                      return nextModels
                    })
                  } else if (Object.keys(parsedContextWindows).length > 0) {
                    setModelContextInputs(getModelContextInputs(models, {
                      ...selectedPreset,
                      modelContextWindows: parsedContextWindows,
                    }))
                  }
                }
              } catch (err) {
                setSettingsJson(raw)
                setSettingsJsonError(err instanceof Error ? err.message : 'Invalid JSON')
              }
            }}
            rows={16}
            spellCheck={false}
            className={`w-full text-xs px-3 py-3 rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] border font-mono leading-relaxed resize-y text-[var(--color-text-secondary)] outline-none ${
              settingsJsonError
                ? 'border-[var(--color-error)] focus:border-[var(--color-error)]'
                : 'border-[var(--color-border)] focus:border-[var(--color-border-focus)]'
            }`}
          />
          {settingsJsonError && (
            <p className="text-[11px] text-[var(--color-error)] mt-1">{t('settings.providers.jsonError', { error: settingsJsonError })}</p>
          )}
          <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1">{t('settings.providers.settingsJsonDesc')}</p>
        </div>
      </div>
    </Modal>
  )
}
