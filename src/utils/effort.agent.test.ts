import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  EFFORT_LEVELS,
  getEffortLevelDescription,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
  parseEffortValue,
  resolveAppliedEffort,
  toPersistableEffort,
} from './effort.js'

describe('agent effort values', () => {

  // 环境隔离（v1.4.0 阶段3）：默认模型解析会读本机真实 provider/model 配置
  //（实测把期望的 Claude 模型名读成了机器配置的 GLM/DeepSeek 名）。这里把
  // CLAUDE_CONFIG_DIR 指向一次性临时目录，让解析回落到内置默认——期望值仍是
  // 干净机器真值，不因机器而变。
  let isolatedConfigDir: string | undefined
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  // 本机/会话注入的 ANTHROPIC_* 模型映射（GLM/DeepSeek 代理）会改写默认模型解析，
  // 一并保存清空，解析才真正回落内置默认（期望值=干净机器真值）。
  const modelEnvKeys = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
  ] as const
  const savedModelEnv = new Map<string, string | undefined>()
  beforeEach(async () => {
    savedModelEnv.clear()
    for (const key of modelEnvKeys) {
      savedModelEnv.set(key, process.env[key])
      delete process.env[key]
    }
    isolatedConfigDir = await fs.mkdtemp(join(tmpdir(), 'model-config-iso-'))
    process.env.CLAUDE_CONFIG_DIR = isolatedConfigDir
  })
  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    for (const key of modelEnvKeys) {
      if (savedModelEnv.get(key) === undefined) delete process.env[key]
      else process.env[key] = savedModelEnv.get(key)!
    }
    if (isolatedConfigDir) await fs.rm(isolatedConfigDir, { recursive: true, force: true })
  })
  test('accepts all named agent effort levels including xhigh', () => {
    expect(EFFORT_LEVELS).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])

    for (const level of EFFORT_LEVELS) {
      expect(parseEffortValue(level)).toBe(level)
      expect(getEffortLevelDescription(level)).toBeTruthy()
    }
  })

  test('rejects partially numeric effort strings instead of truncating them', () => {
    expect(parseEffortValue(' 7 ')).toBe(7)
    expect(parseEffortValue('7oops')).toBeUndefined()
    expect(parseEffortValue('7.5')).toBeUndefined()
  })

  test('does not persist agent-only xhigh as a global Claude setting', () => {
    expect(toPersistableEffort('xhigh')).toBeUndefined()
  })

  test('normalizes agent effort against the resolved model capability', () => {
    const originalOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    try {
      expect(modelSupportsXHighEffort('claude-opus-4-7')).toBe(true)
      expect(modelSupportsMaxEffort('claude-opus-4-7')).toBe(true)
      expect(resolveAppliedEffort('claude-opus-4-7', 'xhigh')).toBe('xhigh')
      expect(resolveAppliedEffort('claude-sonnet-4-6', 'xhigh')).toBe('high')
      expect(modelSupportsMaxEffort('claude-sonnet-4-6')).toBe(true)
      expect(resolveAppliedEffort('claude-sonnet-4-6', 'max')).toBe('max')
      expect(resolveAppliedEffort('claude-opus-4-5', 'max')).toBe('high')
      expect(resolveAppliedEffort('gpt-5.6-sol', 'xhigh')).toBe('xhigh')
      expect(resolveAppliedEffort('gpt-5.6-luna', 'max')).toBe('max')
      // Keep the request-scoped value intact. The OpenAI provider catalog
      // skips unsupported max and then uses the transformed high fallback.
      expect(resolveAppliedEffort('gpt-5.5', 'max')).toBe('max')
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CODE_EFFORT_LEVEL
      } else {
        process.env.CLAUDE_CODE_EFFORT_LEVEL = originalOverride
      }
    }
  })

  test('lets request-scoped Agent effort override session env only when marked', () => {
    const originalOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
    try {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'

      expect(resolveAppliedEffort('gpt-5.6-luna', 'xhigh')).toBe('high')
      expect(
        resolveAppliedEffort('gpt-5.6-luna', 'xhigh', {
          effortValueOverridesEnv: true,
        }),
      ).toBe('xhigh')

      process.env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
      expect(resolveAppliedEffort('gpt-5.6-luna', 'xhigh')).toBeUndefined()
      expect(
        resolveAppliedEffort('gpt-5.6-luna', 'xhigh', {
          effortValueOverridesEnv: true,
        }),
      ).toBe('xhigh')
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CLAUDE_CODE_EFFORT_LEVEL
      } else {
        process.env.CLAUDE_CODE_EFFORT_LEVEL = originalOverride
      }
    }
  })

  test('matches the Claude effort capability table', () => {
    const effortModels = [
      'claude-opus-4-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-mythos-preview',
    ]
    const xhighModels = [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-mythos-5',
    ]
    const maxModels = [
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-mythos-preview',
    ]

    for (const model of effortModels) expect(modelSupportsEffort(model)).toBe(true)
    for (const model of xhighModels) expect(modelSupportsXHighEffort(model)).toBe(true)
    for (const model of maxModels) expect(modelSupportsMaxEffort(model)).toBe(true)

    expect(modelSupportsEffort('claude-haiku-4-5')).toBe(false)
    expect(modelSupportsXHighEffort('claude-sonnet-4-6')).toBe(false)
    expect(modelSupportsXHighEffort('claude-mythos-preview')).toBe(false)
    expect(modelSupportsMaxEffort('claude-opus-4-5')).toBe(false)
  })

  test('uses the OpenAI catalog while leaving unknown GPT models provider-owned', () => {
    expect(modelSupportsEffort('gpt-5.6-sol')).toBe(true)
    expect(modelSupportsXHighEffort('gpt-5.6-sol')).toBe(true)
    expect(modelSupportsMaxEffort('gpt-5.6-luna')).toBe(true)
    expect(modelSupportsMaxEffort('gpt-5.5')).toBe(false)

    expect(modelSupportsXHighEffort('o9-experimental')).toBe(true)
    expect(modelSupportsMaxEffort('o9-experimental')).toBe(true)
  })

})
