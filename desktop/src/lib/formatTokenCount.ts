/**
 * Compact token-count formatter shared by the chat UI (session header,
 * streaming indicator, compact summary, background agents) and trace views,
 * so every surface renders token usage with one notation.
 * "847" below 1000, "1.2k" up to 1M, "1.2m" beyond — trailing ".0" dropped
 * ("1k", not "1.0k") to match the CLI's formatTokens.
 */
export function formatTokenCount(n?: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '--'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

/**
 * Window-aware token display for the context meter. The server clamps the
 * context total to the model window (calculateCurrentContextTokenTotal), so a
 * reading that reaches the window really means "at or over the window" —
 * printing the window figure alone reads as "exactly full". Rendering
 * `≥ <window>` keeps the headline total and every per-category figure on one
 * ruler, so a category can never look larger than the window above it.
 */
export function formatTokensAgainstWindow(
  tokens: number | undefined,
  windowTokens: number | undefined,
): string {
  const value = tokens ?? 0
  const window = windowTokens ?? 0
  const formatter = new Intl.NumberFormat()
  if (window > 0 && value >= window) return `≥ ${formatter.format(window)}`
  return formatter.format(value)
}
