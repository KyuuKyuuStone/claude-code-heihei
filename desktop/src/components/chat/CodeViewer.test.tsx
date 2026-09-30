import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CodeViewer, findSafeCodeCut } from './CodeViewer'

describe('CodeViewer', () => {
  it('keeps the same inner padding for highlighted code content', () => {
    const { container } = render(
      <CodeViewer code={'cd testb\nnpm run dev'} language="bash" showLineNumbers />,
    )

    expect(screen.getByText('cd testb')).toBeTruthy()
    expect(screen.getByText('npm run dev')).toBeTruthy()

    const contentWrapper = container.querySelector('[data-code-viewer-content]') as HTMLElement | null
    expect(contentWrapper).toBeTruthy()
    expect(contentWrapper?.style.padding).toBe('0.5rem 12px')
    expect(contentWrapper?.style.whiteSpace).toBe('pre')
    expect(contentWrapper?.style.wordBreak).toBe('normal')

    const codeArea = container.querySelector('.code-viewer-area') as HTMLElement | null
    expect(codeArea?.getAttribute('data-has-line-numbers')).toBe('true')
    expect(container.querySelector('[data-line-number="1"]')).toBeTruthy()
    expect(container.querySelector('[data-line-number="2"]')).toBeTruthy()
  })

  it('can wrap long highlighted code content when requested', () => {
    const { container } = render(
      <CodeViewer code={'{"command":"cat << EOF > /tmp/index.html"}'} language="json" wrapLongLines />,
    )

    const contentWrapper = container.querySelector('[data-code-viewer-content]') as HTMLElement | null
    expect(contentWrapper).toBeTruthy()
    expect(contentWrapper?.style.whiteSpace).toBe('pre-wrap')
    expect(contentWrapper?.style.wordBreak).toBe('break-word')
  })
})

describe('findSafeCodeCut', () => {
  const pad = 'const padding = `' + 'x'.repeat(240) + '`'

  it('cuts after a blank line in lexically clean state', () => {
    const text = `const a = 1;\n\n${pad}`
    expect(findSafeCodeCut(text)).toBe('const a = 1;\n\n'.length)
  })

  it('returns 0 when no blank line exists', () => {
    expect(findSafeCodeCut(`const a = 1;\nconst b = 2;\n${pad}`)).toBe(0)
  })

  it('returns 0 when the remaining tail would be shorter than the minimum', () => {
    expect(findSafeCodeCut('const a = 1;\n\nconst b = 2;')).toBe(0)
  })

  it('never cuts inside a block comment, even across blank lines', () => {
    const text = `/* header\n\nstill comment */\n\n${pad}`
    expect(findSafeCodeCut(text)).toBe('/* header\n\nstill comment */\n\n'.length)
  })

  it('never cuts inside a template literal, cuts after it closes', () => {
    const text = `const s = \`line1\n\nline2 \${1 + 1}\`;\n\n${pad}`
    expect(findSafeCodeCut(text)).toBe('const s = `line1\n\nline2 ${1 + 1}`;\n\n'.length)
  })

  it('never cuts inside a python triple-quoted string', () => {
    const text = `doc = """\nsummary\n\nmore\n"""\n\n${pad}`
    expect(findSafeCodeCut(text)).toBe('doc = """\nsummary\n\nmore\n"""\n\n'.length)
  })
})

describe('CodeViewer streaming segmentation', () => {
  const fullCode = Array.from({ length: 60 }, (_, i) =>
    i % 3 === 2 ? '' : `const value${i} = ${i} + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa'`,
  ).join('\n')

  it('renders the same text as the one-shot highlighter once fully grown', () => {
    const { container: streamed } = render(
      <CodeViewer code={fullCode} language="javascript" maxLines={200} streaming />,
    )
    const { container: oneShot } = render(
      <CodeViewer code={fullCode} language="javascript" maxLines={200} />,
    )

    const streamedText = streamed.querySelector('[data-code-viewer-content]')?.textContent
    const oneShotText = oneShot.querySelector('[data-code-viewer-content]')?.textContent
    expect(streamedText).toBe(oneShotText)
  })

  it('stays consistent while the code grows chunk by chunk', () => {
    const third = Math.floor(fullCode.length / 3)
    const { container, rerender } = render(
      <CodeViewer code={fullCode.slice(0, third)} language="javascript" maxLines={200} streaming />,
    )
    rerender(<CodeViewer code={fullCode.slice(0, third * 2)} language="javascript" maxLines={200} streaming />)
    rerender(<CodeViewer code={fullCode} language="javascript" maxLines={200} streaming />)

    const { container: oneShot } = render(
      <CodeViewer code={fullCode} language="javascript" maxLines={200} />,
    )
    expect(container.querySelector('[data-code-viewer-content]')?.textContent)
      .toBe(oneShot.querySelector('[data-code-viewer-content]')?.textContent)
  })

  it('keeps line numbers continuous across committed segments', () => {
    const { container } = render(
      <CodeViewer code={fullCode} language="javascript" maxLines={200} showLineNumbers streaming />,
    )

    const lineNumbers = Array.from(container.querySelectorAll('[data-line-number]'))
      .map((el) => Number(el.getAttribute('data-line-number')))
    expect(lineNumbers.length).toBe(60)
    expect(lineNumbers[0]).toBe(1)
    expect(lineNumbers[59]).toBe(60)
    for (let i = 1; i < lineNumbers.length; i += 1) {
      expect(lineNumbers[i]).toBe(lineNumbers[i - 1]! + 1)
    }
  })
})
