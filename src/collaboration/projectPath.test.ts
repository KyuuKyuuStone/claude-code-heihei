import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { normalizeProjectPath, sameProject } from './projectPath.js'

/**
 * 统一 workDir 比较口径（架构裁决四顺带发现的低危问题）。
 *
 * 基准取自既有的台账语义：path.resolve + 反斜杠转正斜杠 + 小写。
 * 关键不变量有两条，方向相反、都要守住：
 *   ① 同一目录的不同写法（大小写 / 正反斜杠 / 尾部分隔符）必须判为同一项目；
 *   ② 真正不同的目录、以及「只有一侧有值」的情形仍判为不同项目——归一**不得**
 *      放宽项目隔离。
 */

// 用 path.resolve 构造基准，保证在任何平台都是绝对路径（本仓库主跑 Windows）。
const BASE = path.resolve('/cc-heihei-proj-alpha')
const OTHER = path.resolve('/cc-heihei-proj-beta')

describe('normalizeProjectPath', () => {
  test('统一为正斜杠 + 小写', () => {
    const normalized = normalizeProjectPath(BASE)
    expect(normalized).toBe(normalized.toLowerCase())
    expect(normalized).not.toContain('\\')
  })

  test('幂等：归一后的结果再归一仍是自身', () => {
    const once = normalizeProjectPath(BASE)
    expect(normalizeProjectPath(once)).toBe(once)
  })
})

describe('sameProject：同项目的写法差异判为同一项目', () => {
  test('大小写差异', () => {
    expect(sameProject(BASE.toUpperCase(), BASE.toLowerCase())).toBe(true)
  })

  test('正反斜杠差异', () => {
    const withBackslashes = BASE.replace(/\//g, '\\')
    expect(sameProject(BASE, withBackslashes)).toBe(true)
  })

  test('尾部分隔符差异', () => {
    expect(sameProject(`${BASE}${path.sep}`, BASE)).toBe(true)
    expect(sameProject(`${BASE}/`, `${BASE}\\`)).toBe(true)
  })

  test('大小写 + 反斜杠 + 尾部分隔符叠加', () => {
    const messy = `${BASE.toUpperCase().replace(/\//g, '\\')}\\`
    expect(sameProject(messy, BASE)).toBe(true)
  })

  test('完全相同的字符串（含两侧都为 undefined）判为同一项目', () => {
    // 与历史行为一致：workDir 未知的会话之间仍按同项目处理，
    // 「每项目最多一名主管」的约束不因归一面放宽。
    expect(sameProject(BASE, BASE)).toBe(true)
    expect(sameProject(undefined, undefined)).toBe(true)
    expect(sameProject(null, null)).toBe(true)
  })
})

describe('sameProject：不得放宽隔离', () => {
  test('真正不同的目录仍判为不同项目', () => {
    expect(sameProject(BASE, OTHER)).toBe(false)
    // 大小写归一不会把两个不同目录混为一个
    expect(sameProject(BASE.toUpperCase(), OTHER.toLowerCase())).toBe(false)
  })

  test('前缀相同的目录不算同一项目（不是前缀匹配）', () => {
    expect(sameProject(BASE, `${BASE}-sibling`)).toBe(false)
  })

  test('只有一侧有值 → 不同项目', () => {
    expect(sameProject(BASE, undefined)).toBe(false)
    expect(sameProject(undefined, BASE)).toBe(false)
    expect(sameProject(BASE, null)).toBe(false)
    expect(sameProject('', BASE)).toBe(false)
    expect(sameProject(undefined, '')).toBe(false)
  })
})
