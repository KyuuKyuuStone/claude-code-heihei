/**
 * cc-heihei 供应商隔离 env 的装配实现（G2 B-d 批从 `utils/managedEnv.ts` 上提到 L2）。
 *
 * 为什么上提：合并逻辑要用 server 侧的 provider 运行时环境（`providerRuntimeEnv`）与
 * 独立代理（`standaloneProviderProxy`），而调用方 `utils/managedEnv.ts` 是 **L0** ——
 * L0 → server 是层级违规（`layer-L0-no-server-deps`，存量 2 条）。
 * 现在 L0 只保留「取 env 并写入 process.env」的骨架，本模块经注入缝
 * `registerCcHeiheiSettingsEnvProvider` 由 CLI 启动（`entrypoints/init.ts`）接上。
 *
 * 逻辑与原 `managedEnv.getCcHeiheiSettingsEnv` **逐字一致**（含错误吞掉后回退空 env）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  activeProviderNeedsProxy,
  mergeActiveProviderManagedEnv,
} from './providerRuntimeEnv.js'
import { ensureStandaloneProviderProxy } from '../proxy/standaloneProviderProxy.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../../utils/envUtils.js'
import { normalizeLegacyDeepSeekManagedEnv } from '../../utils/providerManagedEnvCompat.js'

/**
 * Read env vars from ~/.claude/cc-heihei/settings.json (Heihei-specific provider
 * config). This file is written by ProviderService.syncToSettings() and
 * contains ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, model defaults, etc.
 * Returns an empty object if the file doesn't exist or is invalid.
 */
export function getCcHeiheiSettingsEnv(): Record<string, string> {
  const configDir = getClaudeConfigHomeDir()
  const serverPort =
    !isEnvTruthy(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) &&
    activeProviderNeedsProxy(configDir)
      ? ensureStandaloneProviderProxy()
      : undefined
  try {
    const ccHeiheiSettings = join(configDir, 'cc-heihei', 'settings.json')
    const raw = readFileSync(ccHeiheiSettings, 'utf-8')
    const parsed = JSON.parse(raw) as { env?: Record<string, string> }
    const settingsEnv = normalizeLegacyDeepSeekManagedEnv(parsed.env ?? {}).env
    return mergeActiveProviderManagedEnv(settingsEnv, configDir, { serverPort })
  } catch {
    return mergeActiveProviderManagedEnv({}, configDir, { serverPort })
  }
}
