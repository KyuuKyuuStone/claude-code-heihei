import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getSupportedEffortLevelsForModel } from '../../utils/effort.js'
import { ModelInfoSchema } from './coreSchemas.js'

describe('ModelInfoSchema effort capabilities', () => {
  // 环境隔离（不改断言）：协作宿主注入 ANTHROPIC_BASE_URL 指向非 Anthropic 主机时，
  // isFirstPartyAnthropicBaseUrl() 为假 → hasAnthropicCompatibleThirdPartyConfig() 为真
  // → shouldTrustBuiltInClaudeCapabilityList() 为假 → 内置模型能力表不被信任
  // → getSupportedEffortLevelsForModel() 返回空数组。这里只清掉这些变量，让内置表可被信任。
  const PROVIDER_ENV_KEYS = [
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_AZURE_OPENAI',
  ] as const
  const savedProviderEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of PROVIDER_ENV_KEYS) {
      savedProviderEnv.set(key, process.env[key])
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of PROVIDER_ENV_KEYS) {
      const value = savedProviderEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    savedProviderEnv.clear()
  })

  test('accepts model-specific effort levels emitted by CLI initialization', () => {
    const cases = [
      {
        value: 'sonnet',
        model: 'claude-sonnet-4-6',
        expected: ['low', 'medium', 'high', 'max'],
      },
      {
        value: 'fable',
        model: 'claude-fable-5',
        expected: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ]

    for (const { value, model, expected } of cases) {
      const supportedEffortLevels = getSupportedEffortLevelsForModel(model)
      expect(supportedEffortLevels).toEqual(expected)
      expect(
        ModelInfoSchema().safeParse({
          value,
          displayName: value,
          description: `${value} model`,
          supportsEffort: true,
          supportedEffortLevels,
        }).success,
      ).toBe(true)
    }
  })

  test('rejects unknown effort capabilities', () => {
    expect(
      ModelInfoSchema().safeParse({
        value: 'fable',
        displayName: 'Fable',
        description: 'Most capable for complex agent tasks',
        supportsEffort: true,
        supportedEffortLevels: ['extreme'],
      }).success,
    ).toBe(false)
  })
})
