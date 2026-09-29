import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getAgentModel } from './agent.js'

const originalSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL

afterEach(() => {
  if (originalSubagentModel === undefined) {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  } else {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = originalSubagentModel
  }
})

describe('getAgentModel', () => {

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
  test('treats CLAUDE_CODE_SUBAGENT_MODEL=inherit as normal parent resolution', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'inherit'

    expect(
      getAgentModel('haiku', 'claude-sonnet-4-6', undefined, 'default'),
    ).toBe('claude-haiku-4-5-20251001')
    expect(
      getAgentModel('inherit', 'claude-sonnet-4-6', undefined, 'default'),
    ).toBe('claude-sonnet-4-6')
  })

  test('treats the inherit sentinel case-insensitively', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'INHERIT'

    expect(
      getAgentModel('inherit', 'claude-opus-4-7', undefined, 'default'),
    ).toBe('claude-opus-4-7')
  })

  test('trims the inherit sentinel before applying normal Agent resolution', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = '  InHeRiT  '

    expect(
      getAgentModel('inherit', 'claude-sonnet-4-6', undefined, 'default'),
    ).toBe('claude-sonnet-4-6')
  })

  test('keeps a concrete environment override authoritative', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = '  provider-owned-model  '

    expect(
      getAgentModel('inherit', 'claude-opus-4-7', undefined, 'default'),
    ).toBe('provider-owned-model')
  })

  test('uses normal agent resolution for an empty environment override', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = ''

    expect(
      getAgentModel('inherit', 'claude-sonnet-4-6', undefined, 'default'),
    ).toBe('claude-sonnet-4-6')
  })
})
