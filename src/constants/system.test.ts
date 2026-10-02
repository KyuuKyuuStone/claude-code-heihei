import { describe, expect, test } from 'bun:test'
import { getAttributionHeader } from './system.js'

describe('getAttributionHeader', () => {
  test('uses Claude Code compatibility version and always includes CCH placeholder', () => {
    const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    const originalAttributionHeader = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    // 协作宿主会注入 CLAUDE_CODE_ATTRIBUTION_HEADER=0，它会短路
    // isAttributionHeaderEnabled() → 本用例得到空串。此处只做环境隔离，
    // 断言保持原样。
    delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER

    try {
      expect(getAttributionHeader('abc')).toBe(
        'x-anthropic-billing-header: cc_version=2.1.92.abc; cc_entrypoint=cli; cch=00000;',
      )
    } finally {
      if (originalEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
      else process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
      if (originalAttributionHeader === undefined) delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
      else process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = originalAttributionHeader
    }
  })
})
