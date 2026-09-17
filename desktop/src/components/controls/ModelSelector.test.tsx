import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

const { runtimeMocks } = vi.hoisted(() => ({
  runtimeMocks: { isMobileViewport: false, isDesktopRuntime: false },
}))

vi.mock('../../hooks/useMobileViewport', () => ({
  useMobileViewport: () => runtimeMocks.isMobileViewport,
}))

vi.mock('../../lib/desktopRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/desktopRuntime')>()
  return { ...actual, isDesktopRuntime: () => runtimeMocks.isDesktopRuntime }
})

import { ModelSelector } from './ModelSelector'
import { useChatStore } from '../../stores/chatStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSessionRuntimeStore } from '../../stores/sessionRuntimeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { ModelInfo } from '../../types/settings'

const MODELS: ModelInfo[] = [
  { id: 'alpha', name: 'Alpha', description: 'Fast model', context: '128k' },
  { id: 'beta', name: 'Beta', description: 'Careful model', context: '200k' },
]

async function clickByRole(name: RegExp | string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
    await Promise.resolve()
  })
}

afterEach(() => {
  cleanup()
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  useSessionRuntimeStore.setState(useSessionRuntimeStore.getInitialState(), true)
  useChatStore.setState(useChatStore.getInitialState(), true)
})

describe('ModelSelector', () => {
  it('uses controlled model selection without mutating settings directly', async () => {
    const onChange = vi.fn()
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
    })

    render(<ModelSelector value="alpha" onChange={onChange} />)

    await clickByRole(/alpha/i)
    await clickByRole(/Beta/)

    expect(onChange).toHaveBeenCalledWith('beta')
  })

  it('routes uncontrolled model changes through settings actions', async () => {
    const setModel = vi.fn(async () => {})
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      effortLevel: 'max',
      setModel,
    })

    render(<ModelSelector />)

    await clickByRole(/alpha/i)
    await clickByRole(/Beta/)
    expect(setModel).toHaveBeenCalledWith('beta')
  })

  it('selects provider-scoped runtime models and mirrors session selections', async () => {
    const setSessionRuntime = vi.fn()
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      activeProviderName: 'Provider A',
    })
    useProviderStore.setState({
      providers: [{
        id: 'provider-a',
        presetId: 'custom',
        name: 'Provider A',
        apiKey: '***',
        baseUrl: 'https://api.example.com',
        apiFormat: 'anthropic',
        models: {
          main: 'provider-main',
          haiku: 'provider-fast',
          sonnet: 'provider-main',
          opus: '',
        },
      }],
      activeId: 'provider-a',
      hasLoadedProviders: true,
      isLoading: true,
    })
    useChatStore.setState({
      setSessionRuntime,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    render(<ModelSelector runtimeKey="session-1" />)

    await clickByRole(/provider-main/i)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /provider-fast/ }))
      await Promise.resolve()
    })

    expect(useSessionRuntimeStore.getState().selections['session-1']).toEqual({
      providerId: 'provider-a',
      modelId: 'provider-fast',
      effortLevel: 'max',
    })
    expect(setSessionRuntime).toHaveBeenCalledWith('session-1', {
      providerId: 'provider-a',
      modelId: 'provider-fast',
      effortLevel: 'max',
    })
  })

  it('defaults blank provider-scoped runtime selections to the active provider main model', async () => {
    useSettingsStore.setState({
      locale: 'en',
      availableModels: [
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', description: 'Main Model · Haiku Model', context: '' },
        { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', description: 'Sonnet Model · Opus Model', context: '' },
      ],
      currentModel: { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', description: 'Sonnet Model · Opus Model', context: '' },
      activeProviderName: 'Custom-DeepSeek-OpenAI',
    })
    useProviderStore.setState({
      providers: [{
        id: 'deepseek-provider',
        presetId: 'custom',
        name: 'Custom-DeepSeek-OpenAI',
        apiKey: '***',
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'openai_chat',
        models: {
          main: 'deepseek-v4-flash',
          haiku: 'deepseek-v4-flash',
          sonnet: 'deepseek-v4-pro',
          opus: 'deepseek-v4-pro',
        },
      }],
      activeId: 'deepseek-provider',
      hasLoadedProviders: true,
      isLoading: true,
    })

    render(<ModelSelector runtimeKey="blank-session" />)

    const trigger = screen.getByRole('button', { name: /deepseek-v4-flash/i })
    await act(async () => {
      fireEvent.click(trigger)
      await Promise.resolve()
    })

    const flashOption = screen
      .getAllByRole('button', { name: /deepseek-v4-flash/i })
      .find((button) => button.textContent?.includes('Main Model'))
    expect(flashOption).toBeDefined()
    expect(flashOption?.className).toContain('border-[var(--color-model-option-selected-border)]')
  })

  it('closes the focus ring on both halves of the segmented control', () => {
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      activeProviderName: 'Provider A',
      effortLevel: 'max',
    })
    useSessionRuntimeStore.getState().setSelection('session-ring', {
      providerId: null,
      modelId: 'alpha',
      effortLevel: 'max',
    })

    const { container } = render(<ModelSelector runtimeKey="session-ring" />)
    const [modelHalf, effortHalf] = [...container.querySelectorAll('button')]

    // The ring traces `border-radius`. Each half is rounded on one side only,
    // so without this the focused half drew a box that was round down one edge
    // and square down the other.
    expect(modelHalf).toHaveClass('rounded-l-[var(--radius-md)]', 'focus-visible:rounded-[var(--radius-md)]')
    expect(effortHalf).toHaveClass('rounded-r-[var(--radius-md)]', 'focus-visible:rounded-[var(--radius-md)]')
  })

  // On the phone composer this control sits between two 44px buttons and opens
  // a bottom sheet. `compact` cannot drive the height: the desktop composer
  // also sets it, and there it narrows for the right panel, not for touch.
  it.each([
    ['browser H5', { isMobileViewport: true, isDesktopRuntime: false }, true],
    ['desktop compact composer', { isMobileViewport: false, isDesktopRuntime: false }, false],
    ['narrow Electron window', { isMobileViewport: true, isDesktopRuntime: true }, false],
  ])('stretches both halves to the 44px touch target only on %s', (_name, runtime, expected) => {
    Object.assign(runtimeMocks, runtime)
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      activeProviderName: 'Provider A',
      effortLevel: 'max',
    })
    useSessionRuntimeStore.getState().setSelection('session-touch', {
      providerId: null,
      modelId: 'alpha',
      effortLevel: 'max',
    })

    const { container } = render(<ModelSelector runtimeKey="session-touch" compact />)
    const segmented = container.querySelector('[data-testid="model-selector-shell"] > div')

    expect(segmented).toHaveClass('items-stretch')
    expect(segmented?.classList.contains('min-h-11')).toBe(expected)
  })

  it('keeps runtime effort scoped to the selected session', async () => {
    const setSessionRuntime = vi.fn()
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
      activeProviderName: 'Provider A',
      effortLevel: 'max',
    })
    useProviderStore.setState({
      providers: [{
        id: 'provider-a',
        presetId: 'custom',
        name: 'Provider A',
        apiKey: '***',
        baseUrl: 'https://api.example.com',
        apiFormat: 'anthropic',
        models: {
          main: 'provider-main',
          haiku: 'provider-fast',
          sonnet: 'provider-main',
          opus: '',
        },
      }],
      activeId: 'provider-a',
      hasLoadedProviders: true,
      isLoading: true,
    })
    useSessionRuntimeStore.getState().setSelection('session-2', {
      providerId: 'provider-a',
      modelId: 'provider-main',
      effortLevel: 'max',
    })
    useChatStore.setState({
      setSessionRuntime,
    } as Partial<ReturnType<typeof useChatStore.getState>>)

    render(<ModelSelector runtimeKey="session-1" />)

    await clickByRole('Effort: Max')
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Effort' }), { key: 'ArrowLeft' })

    expect(useSessionRuntimeStore.getState().selections['session-1']).toEqual({
      providerId: 'provider-a',
      modelId: 'provider-main',
      effortLevel: 'high',
    })
    expect(useSessionRuntimeStore.getState().selections['session-2']).toEqual({
      providerId: 'provider-a',
      modelId: 'provider-main',
      effortLevel: 'max',
    })
    expect(setSessionRuntime).toHaveBeenCalledWith('session-1', {
      providerId: 'provider-a',
      modelId: 'provider-main',
      effortLevel: 'high',
    })
    expect(useSettingsStore.getState().effortLevel).toBe('max')
  })

  it('portals the dropdown outside clipping containers and positions it below the trigger', async () => {
    useSettingsStore.setState({
      locale: 'en',
      availableModels: MODELS,
      currentModel: MODELS[0],
    })

    const { container } = render(
      <div data-testid="scroll-container" className="overflow-hidden">
        <ModelSelector value="alpha" onChange={vi.fn()} />
      </div>,
    )

    const trigger = screen.getByRole('button', { name: /alpha/i })
    Object.defineProperty(trigger.parentElement, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 120,
        right: 520,
        bottom: 150,
        left: 240,
        width: 280,
        height: 30,
        x: 240,
        y: 120,
        toJSON: () => {},
      }),
    })

    await act(async () => {
      fireEvent.click(trigger)
      await Promise.resolve()
    })

    const dropdown = screen.getByTestId('model-selector-dropdown')
    expect(container.contains(dropdown)).toBe(false)
    expect(document.body.contains(dropdown)).toBe(true)
    expect(dropdown.className).toContain('fixed')
    expect(dropdown.style.top).toBe('158px')
    expect(dropdown.style.left).toBe('160px')
    expect(dropdown.style.width).toBe('360px')
  })
})
