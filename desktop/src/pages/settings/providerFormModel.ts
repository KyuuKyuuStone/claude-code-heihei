// v1.7.0 结构拆分第①批（providers）：从 pages/Settings.tsx 逐字移出的
// Provider 表单模型层（常量 + 纯函数），供 ./ProviderFormModal.tsx 使用。
// 逻辑零改动；仅为跨文件引用把原模块内声明改为导出。

import { getBaseUrl } from '../../api/client'
import { getDesktopHost } from '../../lib/desktopHost'
import type {
  ApiFormat,
  Model1mSupport,
  ModelMapping,
  ProviderAuthStrategy,
  SavedProvider,
} from '../../types/provider'
import type { ProviderPreset } from '../../types/providerPreset'

export type ProviderFormProps = {
  open: boolean
  onClose: () => void
  mode: 'create' | 'edit'
  provider?: SavedProvider
  presets: ProviderPreset[]
}

export function requirePreset(preset: ProviderPreset | undefined): ProviderPreset {
  if (!preset) {
    throw new Error('Provider presets are not configured')
  }
  return preset
}

export const AUTO_COMPACT_WINDOW_ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
export const MODEL_CONTEXT_WINDOWS_ENV_KEY = 'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS'
const DISABLE_EXPERIMENTAL_BETAS_ENV_KEY = 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'
const MODEL_CONTEXT_WINDOW_MIN = 16000
const MODEL_CONTEXT_WINDOW_MAX = 10000000
const MODEL_1M_CONTEXT_WINDOW = 1000000
export const MODEL_SLOTS = ['main', 'haiku', 'sonnet', 'opus'] as const
const DEFAULT_MODEL_1M_SUPPORT: Model1mSupport = {
  main: false,
  haiku: false,
  sonnet: false,
  opus: false,
}
const DEFAULT_PROVIDER_AUTH_STRATEGY: ProviderAuthStrategy = 'auth_token'
const AUTH_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
export type ModelSlot = typeof MODEL_SLOTS[number]
export type ModelContextInputs = Record<ModelSlot, string>

export function formatContextWindow(value: number): string {
  return value.toLocaleString('en-US')
}

export function getPresetAutoCompactWindow(preset: ProviderPreset): string {
  return preset.defaultEnv?.[AUTO_COMPACT_WINDOW_ENV_KEY] ?? ''
}

export function getPresetAuthStrategy(preset: ProviderPreset): ProviderAuthStrategy {
  return preset.authStrategy ?? DEFAULT_PROVIDER_AUTH_STRATEGY
}

export function omitAuthEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {}
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !AUTH_ENV_KEYS.has(key.toUpperCase())),
  )
}

function getProviderAuthValue(apiKey: string, preset: ProviderPreset): string {
  return apiKey || preset.defaultEnv?.ANTHROPIC_AUTH_TOKEN || preset.defaultEnv?.ANTHROPIC_API_KEY || (preset.needsApiKey ? '(your API key)' : '')
}

export function buildSettingsJsonAuthEnv(
  apiFormat: ApiFormat,
  authStrategy: ProviderAuthStrategy,
  apiKey: string,
  preset: ProviderPreset,
): Record<string, string> {
  if (apiFormat !== 'anthropic') {
    return { ANTHROPIC_API_KEY: 'proxy-managed' }
  }

  const value = getProviderAuthValue(apiKey, preset)
  switch (authStrategy) {
    case 'api_key':
      return value ? { ANTHROPIC_API_KEY: value } : {}
    case 'auth_token':
      return value ? { ANTHROPIC_AUTH_TOKEN: value } : {}
    case 'auth_token_empty_api_key':
      return {
        ANTHROPIC_API_KEY: '',
        ...(value ? { ANTHROPIC_AUTH_TOKEN: value } : {}),
      }
    case 'dual_same_token':
      return value ? { ANTHROPIC_API_KEY: value, ANTHROPIC_AUTH_TOKEN: value } : {}
    case 'dual_dummy':
      return { ANTHROPIC_API_KEY: 'dummy', ANTHROPIC_AUTH_TOKEN: 'dummy' }
  }
}

export function inferAuthStrategyFromEnv(env: Record<string, string>): ProviderAuthStrategy | null {
  if (env.ANTHROPIC_API_KEY === 'dummy' && env.ANTHROPIC_AUTH_TOKEN === 'dummy') return 'dual_dummy'
  if (env.ANTHROPIC_API_KEY === '' && env.ANTHROPIC_AUTH_TOKEN) return 'auth_token_empty_api_key'
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_API_KEY === env.ANTHROPIC_AUTH_TOKEN) return 'dual_same_token'
  if (env.ANTHROPIC_AUTH_TOKEN) return 'auth_token'
  if (env.ANTHROPIC_API_KEY) return 'api_key'
  return null
}

export function parseAutoCompactWindowInput(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed)) return undefined
  if (parsed < MODEL_CONTEXT_WINDOW_MIN || parsed > MODEL_CONTEXT_WINDOW_MAX) return undefined
  return parsed
}

export function getAutoCompactWindowErrorKey(value: string): 'number' | 'range' | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed)) return 'number'
  if (parsed < MODEL_CONTEXT_WINDOW_MIN || parsed > MODEL_CONTEXT_WINDOW_MAX) return 'range'
  return null
}

function parseModelContextWindowsInput(value: string): number | undefined {
  return parseAutoCompactWindowInput(value)
}

export function getModelContextWindowErrorKey(value: string): 'number' | 'range' | null {
  return getAutoCompactWindowErrorKey(value)
}

export function getModelContextInputValue(
  model: string | undefined,
  preset: ProviderPreset,
  provider?: SavedProvider,
): string {
  const trimmedModel = model?.trim()
  if (!trimmedModel) return ''
  const value = provider?.modelContextWindows?.[trimmedModel] ?? preset.modelContextWindows?.[trimmedModel]
  return value !== undefined ? String(value) : ''
}

export function getModelContextInputs(
  models: ModelMapping,
  preset: ProviderPreset,
  provider?: SavedProvider,
): ModelContextInputs {
  const inputs = {} as ModelContextInputs
  for (const slot of MODEL_SLOTS) {
    inputs[slot] = getModelContextInputValue(models[slot], preset, provider)
  }
  return inputs
}

export function buildModelContextWindows(
  models: ModelMapping,
  inputs: ModelContextInputs,
): Record<string, number> {
  const windows: Record<string, number> = {}
  for (const slot of MODEL_SLOTS) {
    const model = models[slot]?.trim()
    const parsed = parseModelContextWindowsInput(inputs[slot])
    if (model && parsed !== undefined) {
      windows[model] = parsed
    }
  }
  return windows
}

export function hasModel1mMarker(model: string): boolean {
  return /\[1m\]$/i.test(model.trim()) || /:1m$/i.test(model.trim())
}

export function stripModel1mMarker(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '').replace(/:1m$/i, '').trim()
}

export function stripModel1mMarkers(models: ModelMapping): ModelMapping {
  return {
    main: stripModel1mMarker(models.main),
    ...(models.fable ? { fable: stripModel1mMarker(models.fable) } : {}),
    haiku: stripModel1mMarker(models.haiku),
    sonnet: stripModel1mMarker(models.sonnet),
    opus: stripModel1mMarker(models.opus),
  }
}

export function getInitialModel1mSupport(
  models: ModelMapping,
  provider?: SavedProvider,
): Model1mSupport {
  return {
    main: provider?.model1mSupport?.main === true || hasModel1mMarker(models.main),
    haiku: provider?.model1mSupport?.haiku === true || hasModel1mMarker(models.haiku),
    sonnet: provider?.model1mSupport?.sonnet === true || hasModel1mMarker(models.sonnet),
    opus: provider?.model1mSupport?.opus === true || hasModel1mMarker(models.opus),
  }
}

function applyModel1mSupport(model: string, enabled: boolean): string {
  const stripped = stripModel1mMarker(model)
  return enabled && stripped ? `${stripped}[1m]` : stripped
}

export function applyModel1mSupportMapping(
  models: ModelMapping,
  model1mSupport: Model1mSupport,
): ModelMapping {
  return {
    main: applyModel1mSupport(models.main, model1mSupport.main),
    ...(models.fable ? { fable: stripModel1mMarker(models.fable) } : {}),
    haiku: applyModel1mSupport(models.haiku, model1mSupport.haiku),
    sonnet: applyModel1mSupport(models.sonnet, model1mSupport.sonnet),
    opus: applyModel1mSupport(models.opus, model1mSupport.opus),
  }
}

export function hasAnyModel1mSupport(model1mSupport: Model1mSupport): boolean {
  return MODEL_SLOTS.some((slot) => model1mSupport[slot])
}

function shouldFill1mContextWindow(value: string): boolean {
  const parsed = parseModelContextWindowsInput(value)
  return parsed === undefined || parsed < MODEL_1M_CONTEXT_WINDOW
}

export function apply1mSupportToContextInput(
  inputs: ModelContextInputs,
  slot: ModelSlot,
  enabled: boolean,
): ModelContextInputs {
  if (!enabled || !shouldFill1mContextWindow(inputs[slot])) return inputs
  return { ...inputs, [slot]: String(MODEL_1M_CONTEXT_WINDOW) }
}

export function apply1mSupportToContextInputs(
  inputs: ModelContextInputs,
  model1mSupport: Model1mSupport,
): ModelContextInputs {
  let nextInputs = inputs
  for (const slot of MODEL_SLOTS) {
    nextInputs = apply1mSupportToContextInput(nextInputs, slot, model1mSupport[slot])
  }
  return nextInputs
}

export function normalizeModelMapping(models: ModelMapping): ModelMapping {
  const main = models.main.trim()
  return {
    main,
    ...(models.fable?.trim() ? { fable: models.fable.trim() } : {}),
    haiku: models.haiku.trim() || main,
    sonnet: models.sonnet.trim() || main,
    opus: models.opus.trim() || main,
  }
}

function readSettingsEnvString(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

export function readModelMappingFromSettingsEnv(env: Record<string, unknown>): Partial<ModelMapping> {
  const hasModelEnv = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
  ].some((key) => Object.prototype.hasOwnProperty.call(env, key))
  const fable = readSettingsEnvString(env, 'ANTHROPIC_DEFAULT_FABLE_MODEL')
  const haiku = readSettingsEnvString(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL')
  const sonnet = readSettingsEnvString(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL')
  const opus = readSettingsEnvString(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL')
  const main = readSettingsEnvString(env, 'ANTHROPIC_MODEL') ?? sonnet ?? haiku ?? opus

  return {
    ...(main ? { main } : {}),
    ...(hasModelEnv ? { fable } : {}),
    ...(haiku ? { haiku } : {}),
    ...(sonnet ? { sonnet } : {}),
    ...(opus ? { opus } : {}),
  }
}

export function applyToolSearchEnv(
  env: Record<string, unknown>,
  apiFormat: ApiFormat,
  toolSearchEnabled: boolean,
): void {
  delete env.ENABLE_TOOL_SEARCH
  if (apiFormat === 'anthropic') {
    env.ENABLE_TOOL_SEARCH = toolSearchEnabled ? 'true' : 'false'
  }
}

export function applyDisableExperimentalBetasEnv(
  env: Record<string, unknown>,
  disableExperimentalBetas: boolean,
): void {
  if (disableExperimentalBetas) {
    env[DISABLE_EXPERIMENTAL_BETAS_ENV_KEY] = '1'
  } else {
    delete env[DISABLE_EXPERIMENTAL_BETAS_ENV_KEY]
  }
}

export function updateSettingsJsonToolSearch(
  raw: string,
  apiFormat: ApiFormat,
  toolSearchEnabled: boolean,
): string {
  try {
    const parsed = JSON.parse(raw || '{}') as { env?: Record<string, unknown> }
    const existingEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {}
    const env = { ...existingEnv }
    applyToolSearchEnv(env, apiFormat, toolSearchEnabled)
    parsed.env = env
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

export function updateSettingsJsonDisableExperimentalBetas(
  raw: string,
  disableExperimentalBetas: boolean,
): string {
  try {
    const parsed = JSON.parse(raw || '{}') as { env?: Record<string, unknown> }
    const existingEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {}
    const env = { ...existingEnv }
    applyDisableExperimentalBetasEnv(env, disableExperimentalBetas)
    parsed.env = env
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

export function readToolSearchEnabledFromEnv(env: Record<string, unknown>): boolean {
  const value = env.ENABLE_TOOL_SEARCH
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['0', 'false', 'off', 'no'].includes(normalized)) return false
    if (['1', 'true', 'on', 'yes', 'auto'].includes(normalized) || normalized.startsWith('auto:')) {
      return true
    }
  }
  return true
}

export function readDisableExperimentalBetasFromEnv(env: Record<string, unknown>): boolean {
  const value = env[DISABLE_EXPERIMENTAL_BETAS_ENV_KEY]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['0', 'false', 'off', 'no'].includes(normalized)) return false
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true
  }
  return false
}

export function updateSettingsJsonAutoCompactWindow(raw: string, value: string): string {
  try {
    const parsed = JSON.parse(raw || '{}') as { env?: Record<string, unknown> }
    const existingEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {}
    const env = { ...existingEnv }
    const trimmed = value.trim()
    if (trimmed) {
      env[AUTO_COMPACT_WINDOW_ENV_KEY] = trimmed
    } else {
      delete env[AUTO_COMPACT_WINDOW_ENV_KEY]
    }
    parsed.env = env
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

export function updateSettingsJsonModelContextWindows(
  raw: string,
  modelContextWindows: Record<string, number>,
): string {
  try {
    const parsed = JSON.parse(raw || '{}') as { env?: Record<string, unknown> }
    const existingEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {}
    const env = { ...existingEnv }
    if (Object.keys(modelContextWindows).length > 0) {
      env[MODEL_CONTEXT_WINDOWS_ENV_KEY] = JSON.stringify(modelContextWindows)
    } else {
      delete env[MODEL_CONTEXT_WINDOWS_ENV_KEY]
    }
    parsed.env = env
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

export function updateSettingsJsonModels(
  raw: string,
  models: ModelMapping,
  model1mSupport: Model1mSupport = DEFAULT_MODEL_1M_SUPPORT,
): string {
  try {
    const parsed = JSON.parse(raw || '{}') as { env?: Record<string, unknown> }
    const existingEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {}
    const runtimeModels = applyModel1mSupportMapping(models, model1mSupport)
    const env = { ...existingEnv }
    delete env.ANTHROPIC_DEFAULT_FABLE_MODEL
    delete env.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION
    delete env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME
    delete env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES
    parsed.env = {
      ...env,
      ANTHROPIC_MODEL: runtimeModels.main,
      ...(runtimeModels.fable ? { ANTHROPIC_DEFAULT_FABLE_MODEL: runtimeModels.fable } : {}),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: runtimeModels.haiku,
      ANTHROPIC_DEFAULT_SONNET_MODEL: runtimeModels.sonnet,
      ANTHROPIC_DEFAULT_OPUS_MODEL: runtimeModels.opus,
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

export function updateSettingsJsonProviderConnection(
  raw: string,
  apiFormat: ApiFormat,
  authStrategy: ProviderAuthStrategy,
  apiKey: string,
  preset: ProviderPreset,
  baseUrl: string,
  proxyBaseUrl: string,
  toolSearchEnabled = true,
  disableExperimentalBetas = false,
): string {
  try {
    const parsed = JSON.parse(raw || '{}') as { env?: Record<string, unknown> }
    const existingEnv = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {}
    const env = { ...existingEnv }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    applyToolSearchEnv(env, apiFormat, toolSearchEnabled)
    applyDisableExperimentalBetasEnv(env, disableExperimentalBetas)
    env.ANTHROPIC_BASE_URL = apiFormat !== 'anthropic' ? proxyBaseUrl : baseUrl
    Object.assign(env, buildSettingsJsonAuthEnv(apiFormat, authStrategy, apiKey, preset))
    parsed.env = env
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

export function getProviderProxyBaseUrl(): string {
  return `${getBaseUrl().replace(/\/$/, '')}/proxy`
}

export function buildFallbackPreset(provider?: SavedProvider): ProviderPreset {
  return {
    id: provider?.presetId ?? 'custom',
    name: provider?.name ?? 'Custom',
    baseUrl: provider?.baseUrl ?? '',
    apiFormat: provider?.apiFormat ?? 'anthropic',
    authStrategy: provider?.authStrategy,
    defaultModels: provider?.models ?? { main: '', haiku: '', sonnet: '', opus: '' },
    modelContextWindows: provider?.modelContextWindows,
    defaultEnv: provider?.autoCompactWindow !== undefined
      ? { [AUTO_COMPACT_WINDOW_ENV_KEY]: String(provider.autoCompactWindow) }
      : undefined,
    needsApiKey: true,
    websiteUrl: '',
  }
}

export function openExternalUrl(url: string) {
  void getDesktopHost().shell.open(url)
    .catch(() => window.open(url, '_blank', 'noopener,noreferrer'))
}
