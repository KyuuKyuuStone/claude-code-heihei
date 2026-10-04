import { describe, expect, it } from 'vitest'

import { describeApiFailure, technicalDetailFrom } from './apiErrorMessage'
import { t as translateKey } from '../i18n'
import { useSettingsStore } from '../stores/settingsStore'

// 文案断言（含中文字面量）要求 locale 确定化——getInitialLocale 依赖浏览器环境
useSettingsStore.setState({ locale: 'zh' })

describe('describeApiFailure（v1.7.3 #320s 超时误导性报错）', () => {
  it('timeout 呈现为「任务可能仍在后台运行」的超时语义，而非业务失败', () => {
    const rendered = describeApiFailure('timeout', 'Request timed out after 320s', translateKey)
    // 语义断言：不得再出现「重试」类失败暗示，必须给「后台仍在跑/可查看」的出路
    expect(rendered).toBe(translateKey('api.error.timeout'))
    expect(rendered).not.toBe('Request timed out after 320s')
    expect(rendered).not.toContain('重试')
    expect(rendered).toContain('后台运行')
    // 出路：给「稍后刷新查看」
    expect(rendered).toContain('刷新')
  })

  it('非 timeout（network）仍走既有网络文案；business 契约原样直出', () => {
    const network = describeApiFailure('network', 'Failed to fetch', translateKey)
    expect(network).toBe(translateKey('api.error.network'))

    const business = 'Cross-project dispatch is not allowed: sender workDir could not be resolved'
    // KNOWN_SERVER_MESSAGES 表对 business 与 undefined 分支共享：已知串映射人话，
    // 未知串维持业务直出契约原样。
    const unknown = 'Some unknown business failure'
    expect(describeApiFailure('business', business, translateKey)).toBe(
      translateKey('api.error.crossProjectDispatch'),
    )
    expect(describeApiFailure(undefined, business, translateKey)).toBe(
      translateKey('api.error.crossProjectDispatch'),
    )
    expect(describeApiFailure('business', unknown, translateKey)).toBe(unknown)
    expect(describeApiFailure(undefined, unknown, translateKey)).toBe(unknown)
  })

  it('technicalDetailFrom：business 与 undefined 不补原始错误块；timeout 透出原串', () => {
    expect(technicalDetailFrom('business', '业务提示')).toBeUndefined()
    expect(technicalDetailFrom(undefined, 'raw')).toBeUndefined()
    expect(technicalDetailFrom('timeout', 'Request timed out after 320s')).toEqual({
      message: 'Request timed out after 320s',
      kind: 'timeout',
    })
  })
})
