import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { BrandSeal } from './BrandSeal'

const SIZES = ['sm', 'md', 'lg', 'xl'] as const

describe('BrandSeal', () => {
  it('is decorative and hidden from assistive tech', () => {
    // The product name always sits beside the mark (sidebar) or under it
    // (empty state); announcing the brand again reads it twice.
    const { container } = render(<BrandSeal />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })

  // fa38af8「更新作者名与软件内 LOGO」把标识从内联 SVG 改成 <img src="app-icon.png">。
  // 以下断言按现实现重写；随实现废止的旧约束（两条 C 笔画计数、按 --color-* token 着色
  // 以便六套主题重着色、按尺寸瘦身、viewBox 裁到墨迹）已不再适用——标识现在直接复用
  // 安装图标位图，主题重着色/分尺寸细节由该资源自身决定，不再由此组件保证。
  it('renders the shared app icon at every size', () => {
    for (const size of SIZES) {
      const { container, unmount } = render(<BrandSeal size={size} />)
      const img = container.querySelector('img')
      expect(img).not.toBeNull()
      expect(img!.getAttribute('src')).toContain('app-icon.png')
      unmount()
    }
  })

  it('keeps the icon decorative with an empty alt', () => {
    const { container } = render(<BrandSeal />)
    const img = container.querySelector('img')!
    expect(img).toHaveAttribute('alt', '')
    expect(img).toHaveAttribute('aria-hidden', 'true')
  })

  it('applies the size box class for each size', () => {
    const boxClass: Record<(typeof SIZES)[number], string> = {
      sm: 'h-6',
      md: 'h-8',
      lg: 'h-[38px]',
      xl: 'h-20',
    }
    for (const size of SIZES) {
      const { container, unmount } = render(<BrandSeal size={size} />)
      expect(container.querySelector('img')).toHaveClass(boxClass[size])
      unmount()
    }
  })

  it('merges a caller className with the size box', () => {
    const { container } = render(<BrandSeal size="lg" className="text-brand" />)
    const img = container.querySelector('img')!
    expect(img).toHaveClass('text-brand')
    expect(img).toHaveClass('h-[38px]')
  })
})
