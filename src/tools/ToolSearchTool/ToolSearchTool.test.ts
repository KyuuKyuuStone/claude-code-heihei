import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { buildTool, type Tool, type Tools } from '../../Tool.js'
import { ToolSearchTool } from './ToolSearchTool.js'

// 最小可测工具：select 分支只用 name/shouldDefer/aliases，不触及其余方法
function fakeTool(name: string, opts: { shouldDefer?: boolean } = {}): Tool {
  return buildTool({
    name,
    ...(opts.shouldDefer ? { shouldDefer: true } : {}),
    inputSchema: z.object({}),
    maxResultSizeChars: 1000,
    async call() {
      throw new Error('not under test')
    },
    async description() {
      return ''
    },
    async prompt() {
      return `${name} prompt`
    },
    mapToolResultToToolResultBlockParam(content, toolUseID) {
      return { type: 'tool_result', tool_use_id: toolUseID, content: JSON.stringify(content) }
    },
  }) as Tool
}

const inlineTools: Tools = [
  fakeTool('Bash'),
  fakeTool('Read'),
  fakeTool('Write'),
  fakeTool('Glob'),
  fakeTool('Grep'),
  fakeTool('Skill'),
  fakeTool('ToolSearch'),
]
const deferredTools: Tools = [
  fakeTool('NotebookEdit', { shouldDefer: true }),
  fakeTool('WebFetch', { shouldDefer: true }),
]
const allTools: Tools = [...inlineTools, ...deferredTools]

function makeContext(tools: Tools) {
  return {
    options: { tools },
    getAppState: () => ({ mcp: { clients: [] } }),
  } as Parameters<typeof ToolSearchTool.call>[1]
}

describe('ToolSearchTool select: inline vs deferred semantics', () => {
  test('select: hitting only inline tools returns explicit "already loaded" text, not tool_reference', async () => {
    const { data } = await ToolSearchTool.call(
      { query: 'select:Bash,Read,Write,Glob,Grep,Skill', max_results: 10 },
      makeContext(allTools),
      undefined as never,
      undefined as never,
    )

    expect(data.matches).toEqual(['Bash', 'Read', 'Write', 'Glob', 'Grep', 'Skill'])
    expect(data.inline_loaded).toEqual(['Bash', 'Read', 'Write', 'Glob', 'Grep', 'Skill'])
    expect(data.total_deferred_tools).toBe(2)

    const block = ToolSearchTool.mapToolResultToToolResultBlockParam(
      data,
      'tu_test',
    )
    const text = JSON.stringify(block)
    expect(text).toContain('already loaded inline')
    expect(text).toContain('No loading needed')
    expect(text).not.toContain('tool_reference')
  })

  test('select: hitting a real deferred tool keeps tool_reference behavior (no regression)', async () => {
    const { data } = await ToolSearchTool.call(
      { query: 'select:NotebookEdit,WebFetch', max_results: 5 },
      makeContext(allTools),
      undefined as never,
      undefined as never,
    )

    expect(data.matches).toEqual(['NotebookEdit', 'WebFetch'])
    expect(data.inline_loaded).toBeUndefined()

    const block = ToolSearchTool.mapToolResultToToolResultBlockParam(
      data,
      'tu_test',
    ) as { content: unknown }
    expect(Array.isArray(block.content)).toBe(true)
    const refs = block.content as Array<{ type: string; tool_name: string }>
    expect(refs.map(r => r.tool_name)).toEqual(['NotebookEdit', 'WebFetch'])
    expect(refs.every(r => r.type === 'tool_reference')).toBe(true)
  })

  test('select: mixed hits — matches keeps all names, inline_loaded marks only the inline part', async () => {
    const { data } = await ToolSearchTool.call(
      { query: 'select:Bash,NotebookEdit', max_results: 5 },
      makeContext(allTools),
      undefined as never,
      undefined as never,
    )

    expect(data.matches).toEqual(['NotebookEdit', 'Bash'])
    expect(data.inline_loaded).toEqual(['Bash'])

    // 混合场景：仍有 deferred 命中 → 维持 tool_reference（不回归），
    // inline 部分一并引用是无害 no-op（既有设计）
    const block = ToolSearchTool.mapToolResultToToolResultBlockParam(
      data,
      'tu_test',
    ) as { content: unknown }
    expect(Array.isArray(block.content)).toBe(true)
  })
})

describe('ToolSearchTool empty-result tip', () => {
  test('empty keyword result explains inline core tools and shows deferred-only select example', async () => {
    const { data } = await ToolSearchTool.call(
      { query: 'nonexistent-thing', max_results: 5 },
      makeContext(allTools),
      undefined as never,
      undefined as never,
    )

    expect(data.matches).toEqual([])

    const block = ToolSearchTool.mapToolResultToToolResultBlockParam(
      data,
      'tu_test',
    ) as { content: string }
    const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
    expect(text).toContain('keyword search only covers deferred tools')
    expect(text).toContain('always loaded inline')
    expect(text).toContain('select:NotebookEdit,WebFetch')
    // 不再用核心工具举例，避免教模型反复 select 内联工具
    expect(text).not.toContain('select:Bash')
  })
})
