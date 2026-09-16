import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    css: true,
    setupFiles: [],
    // 本机全量并行（285 文件）下曾有 5s 默认超时被事件循环争抢击穿的 flake 记录
    // （tokenUsage z-index / MessageList 120 项窗口 / WorkspacePanel Mermaid /
    // ActivitySettings 头像流程），单跑均为毫秒~秒级。提高到 20s 作安全网；不限制并行度。
    testTimeout: 20_000,
    // electron/localModelBenchmark.mode.test.ts 为 `bun test` 写的（import 'bun:test'），
    // 被 vite 的浏览器兼容处理外部化后在 vitest(jsdom) 下无法收集。该文件不属于桌面
    // 前端套件，由 `bun run check:electron`（根 package.json）覆盖，故在此排除。
    exclude: [...configDefaults.exclude, 'electron/localModelBenchmark.mode.test.ts'],
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/types/**',
        'src/mocks/**',
        'src/vite-env.d.ts',
      ],
    },
  },
})
