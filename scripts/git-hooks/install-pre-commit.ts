#!/usr/bin/env bun
/**
 * install-pre-commit.ts —— 把 scripts/git-hooks/pre-commit 安装到本仓库 git hooks。
 * 与 install.ts（pre-push）同一模式：复制源文件到 `git rev-parse --git-path hooks/pre-commit`。
 * 重复执行幂等；已存在且内容不同时拒绝覆盖（--force 可强制）。
 *
 * 用法：bun run hooks:install:pre-commit [--force]
 */
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const force = process.argv.includes('--force')
const rootDir = resolve(
  new TextDecoder().decode(
    Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { stdout: 'pipe' }).stdout,
  ),
).trim()
const sourcePath = resolve(rootDir, 'scripts/git-hooks/pre-commit')
const hookDir = new TextDecoder()
  .decode(Bun.spawnSync(['git', '-C', rootDir, 'rev-parse', '--git-path', 'hooks'], { stdout: 'pipe' }).stdout)
  .trim()
const hookPath = resolve(rootDir, hookDir, 'pre-commit')

if (!existsSync(sourcePath)) {
  console.error(`[pre-commit] 源文件不存在：${sourcePath}`)
  process.exit(1)
}
if (existsSync(hookPath) && !force && readFileSync(hookPath, 'utf8') !== readFileSync(sourcePath, 'utf8')) {
  console.error(`[pre-commit] 已存在内容不同的 ${hookPath}， refusing to overwrite（确认后加 --force）`)
  process.exit(1)
}
copyFileSync(sourcePath, hookPath)
chmodSync(hookPath, 0o755)
console.log(`[pre-commit] installed: ${hookPath}（来源 ${sourcePath}）`)
