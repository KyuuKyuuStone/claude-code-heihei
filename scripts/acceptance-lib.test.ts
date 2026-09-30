import { describe, expect, test } from 'bun:test'
import {
  classifyFailures,
  classifyRerunDistribution,
  isRerunGreen,
  matchKnownFlaky,
  parseJunit,
  verdict,
  type JunitCase,
} from './acceptance-lib.ts'

// junit 样例按 bun 1.3.14 的真实输出结构构造（字段：name/classname/file/failures）
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="10" failures="1" skipped="1" time="12.5">
  <testsuite name="src\\server\\__tests__\\demo.test.ts" file="src\\server\\__tests__\\demo.test.ts" tests="3" failures="1" skipped="1" time="1.2">
    <testcase name="green case" classname="demo suite" file="src\\server\\__tests__\\demo.test.ts" time="0.1" />
    <testcase name="broken case &lt;with xml&gt;" classname="demo suite" file="src\\server\\__tests__\\demo.test.ts" time="0.2">
      <failure message="EPERM: operation not permitted, rename">at assertFileIdentity</failure>
    </testcase>
    <testcase name="skipped case" classname="demo suite" file="src\\server\\__tests__\\demo.test.ts" time="0">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`

describe('parseJunit', () => {
  test('统计 pass/fail/skip 并把失败映射到文件', () => {
    const parsed = parseJunit(SAMPLE_XML)
    expect(parsed.total).toBe(3)
    expect(parsed.fail).toBe(1)
    expect(parsed.skipped).toBe(1)
    expect(parsed.pass).toBe(1)
    expect(parsed.durationSec).toBeCloseTo(12.5)
    expect(parsed.failures).toHaveLength(1)
    expect(parsed.failures[0]!.name).toBe('broken case <with xml>')
    expect(parsed.failures[0]!.file).toBe('src/server/__tests__/demo.test.ts')
    expect(parsed.failures[0]!.message).toContain('EPERM')
  })

  test('空输出与坏输入不抛错', () => {
    for (const input of ['', '<not-junit>', '<testsuites></testsuites>']) {
      const parsed = parseJunit(input)
      expect(parsed.failures).toHaveLength(0)
      expect(parsed.total).toBe(0)
      expect(parsed.cases).toHaveLength(0)
    }
  })

  test('vitest 风格（outputFile 在 testcase 上无 file 属性时回退 classname）', () => {
    const vitestXml = `<testsuites tests="1" failures="1" time="3">
      <testsuite name="demo.test.ts" tests="1" failures="1">
        <testcase classname="src/x/a.test.ts &gt; suite" name="red test">
          <failure>expected 1 to be 2</failure>
        </testcase>
      </testsuite>
    </testsuites>`
    const parsed = parseJunit(vitestXml)
    expect(parsed.failures[0]!.name).toBe('red test')
    expect(parsed.failures[0]!.file).toContain('a.test.ts')
    expect(parsed.failures[0]!.message).toContain('expected 1 to be 2')
  })

  test('cases 保留 classname（低2：name+classname 二元组匹配的数据基础）', () => {
    const parsed = parseJunit(SAMPLE_XML)
    expect(parsed.cases).toHaveLength(3)
    expect(parsed.cases[0]!.classname).toBe('demo suite')
    expect(parsed.failures[0]!.classname).toBe('demo suite')
  })
})

describe('matchKnownFlaky（仅标注）', () => {
  const list = [{ test: 'serializes concurrent updates', reason: 'FS 争用型' }]
  test('子串命中返回 reason', () => {
    expect(matchKnownFlaky('Agents API > serializes concurrent updates by target', list)).toBe('FS 争用型')
  })
  test('未命中返回 undefined；空清单不炸', () => {
    expect(matchKnownFlaky('other test', list)).toBeUndefined()
    expect(matchKnownFlaky('other test', [])).toBeUndefined()
  })
})

describe('classifyFailures（复跑判据）', () => {
  const failure = {
    name: 'broken case',
    file: 'src/server/__tests__/demo.test.ts',
    failed: true,
    message: 'boom',
  }
  test('复跑绿 → 环境噪声（可附已知 flaky 标注）', () => {
    const classified = classifyFailures(
      [failure],
      new Map([['src/server/__tests__/demo.test.ts\u0000broken case', true]]),
      [{ test: 'broken case', reason: '负载型' }],
    )
    expect(classified[0]!.kind).toBe('env-noise')
    expect(classified[0]!.knownFlakyReason).toBe('负载型')
  })
  test('复跑红 → 真回归（与是否在清单无关——红线）', () => {
    const classified = classifyFailures(
      [failure],
      new Map([['src/server/__tests__/demo.test.ts\u0000broken case', false]]),
      [{ test: 'broken case', reason: '负载型' }],
    )
    expect(classified[0]!.kind).toBe('real-regression')
  })
  test('缺复跑结果（未跑到）按真回归处理（保守）', () => {
    const classified = classifyFailures([failure], new Map(), [])
    expect(classified[0]!.kind).toBe('real-regression')
  })
})

describe('verdict', () => {
  test('全噪声 → PASS；任一真回归 → FAIL', () => {
    const noise = { kind: 'env-noise' as const, greenOnRerun: true, file: 'a', name: 'n' }
    const real = { kind: 'real-regression' as const, greenOnRerun: false, file: 'b', name: 'r' }
    expect(verdict([noise])).toMatchObject({ result: 'PASS', realRegressions: 0, envNoise: 1 })
    expect(verdict([noise, real])).toMatchObject({ result: 'FAIL', realRegressions: 1 })
    expect(verdict([])).toMatchObject({ result: 'PASS' })
  })
})

describe('classifyRerunDistribution（中1：≥2 红=真回归，恰 1 红=噪声）', () => {
  test('0 红 → 环境噪声', () => {
    expect(classifyRerunDistribution(3, 3)).toBe('env-noise')
  })
  test('恰好 1 红 → 环境噪声（单一偶发窗口可解释）', () => {
    expect(classifyRerunDistribution(2, 3)).toBe('env-noise')
  })
  test('2 红 → 真回归', () => {
    expect(classifyRerunDistribution(1, 3)).toBe('real-regression')
  })
  test('3 红 → 真回归', () => {
    expect(classifyRerunDistribution(0, 3)).toBe('real-regression')
  })
})

describe('isRerunGreen（C1：没跑到 ≠ 跑过了）', () => {
  const failure: JunitCase = {
    name: 'target case',
    classname: 'demo suite',
    file: 'src/server/__tests__/demo.test.ts',
    failed: true,
  }
  const RERUN_JUNIT = (body: string) =>
    `<?xml version="1.0"?><testsuites name="bun test" tests="2" failures="0" time="1"><testsuite name="demo" tests="2" failures="0">${body}</testsuite></testsuites>`

  test('目标用例存在且通过 → 绿', () => {
    const rerun = parseJunit(RERUN_JUNIT(
      '<testcase name="target case" classname="demo suite" file="demo.test.ts" /><testcase name="other" classname="demo suite" file="demo.test.ts" />',
    ))
    expect(isRerunGreen(rerun, failure)).toBe(true)
  })

  test('目标用例存在但失败 → 红', () => {
    const rerun = parseJunit(RERUN_JUNIT(
      '<testcase name="target case" classname="demo suite" file="demo.test.ts"><failure message="boom">x</failure></testcase>',
    ))
    expect(isRerunGreen(rerun, failure)).toBe(false)
  })

  test('崩溃/半写：junit 缺目标用例（别的用例都过了）→ 红（C1 核心场景）', () => {
    const rerun = parseJunit(RERUN_JUNIT(
      '<testcase name="other case" classname="demo suite" file="demo.test.ts" />',
    ))
    expect(isRerunGreen(rerun, failure)).toBe(false)
  })

  test('崩溃/半写：junit 总数为 0（空壳 testsuites）→ 红', () => {
    const rerun = parseJunit('<?xml version="1.0"?><testsuites name="bun test" tests="0" failures="0" time="0"></testsuites>')
    expect(isRerunGreen(rerun, failure)).toBe(false)
  })

  test('同名用例跨 describe：classname 不同 → 不误判为绿（低2）', () => {
    const rerun = parseJunit(RERUN_JUNIT(
      '<testcase name="target case" classname="another suite" file="demo.test.ts" />',
    ))
    expect(isRerunGreen(rerun, failure)).toBe(false)
  })

  test('失败项缺 classname（旧行为兼容）→ 只按 name 匹配', () => {
    const noClassFailure: JunitCase = { ...failure, classname: '' }
    const rerun = parseJunit(RERUN_JUNIT(
      '<testcase name="target case" classname="whatever" file="demo.test.ts" />',
    ))
    expect(isRerunGreen(rerun, noClassFailure)).toBe(true)
  })
})
