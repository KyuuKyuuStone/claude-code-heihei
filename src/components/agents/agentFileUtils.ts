import { constants as fsConstants } from 'fs'
import { lstat, mkdir, open, readFile, realpath, unlink } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { getManagedFilePath } from 'src/utils/settings/managedPath.js'
import { stringify as stringifyYaml } from 'yaml'
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'
import {
  clearAgentDefinitionsCache,
  type AgentDefinition,
  isBuiltInAgent,
  isCustomAgent,
  isPluginAgent,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'
import type { EffortValue } from '../../utils/effort.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import { AGENT_PATHS } from './types.js'

export type AdditionalAgentFrontmatter = Record<string, unknown>

const INHERITED_MODEL = 'inherit'

function modelForFrontmatter(model: string | undefined): string | undefined {
  const trimmed = model?.trim()
  return !trimmed || trimmed.toLowerCase() === INHERITED_MODEL
    ? undefined
    : trimmed
}

function agentFrontmatterExtras(
  agent: AgentDefinition,
): AdditionalAgentFrontmatter {
  return {
    ...(agent.disallowedTools !== undefined
      ? { disallowedTools: agent.disallowedTools }
      : {}),
    ...(agent.skills !== undefined ? { skills: agent.skills } : {}),
    ...(agent.mcpServers !== undefined ? { mcpServers: agent.mcpServers } : {}),
    ...(agent.hooks !== undefined ? { hooks: agent.hooks } : {}),
    ...(agent.permissionMode !== undefined
      ? { permissionMode: agent.permissionMode }
      : {}),
    ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
    ...(agent.background !== undefined ? { background: agent.background } : {}),
    ...(agent.initialPrompt !== undefined
      ? { initialPrompt: agent.initialPrompt }
      : {}),
    ...(agent.isolation !== undefined ? { isolation: agent.isolation } : {}),
  }
}

/**
 * Formats agent data as markdown file content
 */
export function formatAgentAsMarkdown(
  agentType: string,
  whenToUse: string,
  tools: string[] | undefined,
  systemPrompt: string,
  color?: string,
  model?: string,
  memory?: AgentMemoryScope,
  effort?: EffortValue,
  additionalFrontmatter: AdditionalAgentFrontmatter = {},
): string {
  const isAllTools =
    tools === undefined || (tools.length === 1 && tools[0] === '*')
  const normalizedModel = modelForFrontmatter(model)
  const frontmatter: AdditionalAgentFrontmatter = {
    name: agentType,
    description: whenToUse,
    ...(!isAllTools ? { tools } : {}),
    ...(normalizedModel ? { model: normalizedModel } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(color ? { color } : {}),
    ...(memory ? { memory } : {}),
    ...additionalFrontmatter,
  }

  // Callers cannot override the identity or the fields controlled by the CLI.
  frontmatter.name = agentType
  frontmatter.description = whenToUse
  if (isAllTools) delete frontmatter.tools
  if (!normalizedModel) delete frontmatter.model
  if (effort === undefined) delete frontmatter.effort
  if (!color) delete frontmatter.color
  if (!memory) delete frontmatter.memory

  return `---
${stringifyYaml(frontmatter).trimEnd()}
---

${systemPrompt}
`
}

type AgentMarkdownUpdates = {
  description: string
  tools: string[] | undefined
  model: string | undefined
  color: string | undefined
  memory?: AgentMemoryScope
  effort?: EffortValue
}

function stringifyTopLevelField(key: string, value: unknown): string[] {
  return stringifyYaml({ [key]: value }).trimEnd().split('\n')
}

function patchTopLevelFrontmatter(
  source: string,
  updates: Record<string, unknown>,
  newline: string,
): string {
  const lines = source.split(/\r?\n/)
  const keyPattern = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/
  const starts = lines
    .map((line, index) => ({ index, key: keyPattern.exec(line)?.[1] }))
    .filter((entry): entry is { index: number; key: string } => !!entry.key)
  const output: string[] = []
  const written = new Set<string>()
  let cursor = 0

  for (let index = 0; index < starts.length; index++) {
    const current = starts[index]!
    const end = starts[index + 1]?.index ?? lines.length
    output.push(...lines.slice(cursor, current.index))
    if (Object.hasOwn(updates, current.key)) {
      const value = updates[current.key]
      if (value !== undefined) {
        output.push(...stringifyTopLevelField(current.key, value))
      }
      written.add(current.key)
    } else {
      output.push(...lines.slice(current.index, end))
    }
    cursor = end
  }
  output.push(...lines.slice(cursor))

  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key) && value !== undefined) {
      output.push(...stringifyTopLevelField(key, value))
    }
  }

  return output.join(newline)
}

/**
 * Updates only CLI-owned fields in an existing agent file. Unknown and advanced
 * top-level frontmatter blocks are retained byte-for-byte.
 */
export function updateAgentMarkdown(
  markdown: string,
  updates: AgentMarkdownUpdates,
  systemPrompt?: string,
): string {
  const match =
    /^(---[ \t]*(\r?\n))([\s\S]*?)(\r?\n---[ \t]*)(?:\r?\n|$)/.exec(
      markdown,
    )
  if (!match) {
    throw new Error('Cannot update agent file without valid frontmatter')
  }

  const newline = match[2]!
  const tools =
    updates.tools === undefined ||
    (updates.tools.length === 1 && updates.tools[0] === '*')
      ? undefined
      : updates.tools
  const patchedFrontmatter = patchTopLevelFrontmatter(
    match[3]!,
    {
      description: updates.description,
      tools,
      model: modelForFrontmatter(updates.model),
      color: updates.color,
      ...(updates.memory !== undefined ? { memory: updates.memory } : {}),
      ...(updates.effort !== undefined ? { effort: updates.effort } : {}),
    },
    newline,
  )
  const header = `${match[1]}${patchedFrontmatter}${match[4]}${newline}`

  if (systemPrompt === undefined) {
    return header + markdown.slice(match[0].length)
  }
  return `${header}${newline}${systemPrompt}${systemPrompt.endsWith(newline) ? '' : newline}`
}

/**
 * Gets the directory path for an agent location
 */
function getAgentDirectoryPath(location: SettingSource): string {
  switch (location) {
    case 'flagSettings':
      throw new Error(`Cannot get directory path for ${location} agents`)
    case 'userSettings':
      return join(getClaudeConfigHomeDir(), AGENT_PATHS.AGENTS_DIR)
    case 'projectSettings':
      return join(getCwd(), AGENT_PATHS.FOLDER_NAME, AGENT_PATHS.AGENTS_DIR)
    case 'policySettings':
      return join(
        getManagedFilePath(),
        AGENT_PATHS.FOLDER_NAME,
        AGENT_PATHS.AGENTS_DIR,
      )
    case 'localSettings':
      return join(getCwd(), AGENT_PATHS.FOLDER_NAME, AGENT_PATHS.AGENTS_DIR)
  }
}

function getRelativeAgentDirectoryPath(location: SettingSource): string {
  switch (location) {
    case 'projectSettings':
      return join('.', AGENT_PATHS.FOLDER_NAME, AGENT_PATHS.AGENTS_DIR)
    default:
      return getAgentDirectoryPath(location)
  }
}

/**
 * Gets the file path for a new agent based on its name
 * Used when creating new agent files
 */
export function getNewAgentFilePath(agent: {
  source: SettingSource
  agentType: string
}): string {
  const dirPath = getAgentDirectoryPath(agent.source)
  return join(dirPath, `${agent.agentType}.md`)
}

/**
 * Gets the actual file path for an agent (handles filename vs agentType mismatch)
 * Always use this for existing agents to get their real file location
 */
export function getActualAgentFilePath(agent: AgentDefinition): string {
  if (agent.source === 'built-in') {
    return 'Built-in'
  }
  if (agent.source === 'plugin') {
    throw new Error('Cannot get file path for plugin agents')
  }

  const loadedMarkdownFile = getLoadedMarkdownFile(agent)
  if (loadedMarkdownFile) {
    return loadedMarkdownFile.filePath
  }

  const dirPath = getAgentDirectoryPath(agent.source)
  const filename = agent.filename || agent.agentType
  return join(dirPath, `${filename}.md`)
}

/**
 * Gets the relative file path for a new agent based on its name
 * Used for displaying where new agent files will be created
 */
export function getNewRelativeAgentFilePath(agent: {
  source: SettingSource | 'built-in'
  agentType: string
}): string {
  if (agent.source === 'built-in') {
    return 'Built-in'
  }
  const dirPath = getRelativeAgentDirectoryPath(agent.source)
  return join(dirPath, `${agent.agentType}.md`)
}

/**
 * Gets the actual relative file path for an agent (handles filename vs agentType mismatch)
 */
export function getActualRelativeAgentFilePath(agent: AgentDefinition): string {
  if (isBuiltInAgent(agent)) {
    return 'Built-in'
  }
  if (isPluginAgent(agent)) {
    return `Plugin: ${agent.plugin || 'Unknown'}`
  }
  if (agent.source === 'flagSettings') {
    return 'CLI argument'
  }

  const loadedMarkdownFile = getLoadedMarkdownFile(agent)
  if (loadedMarkdownFile) {
    const displayBaseDir =
      agent.source === 'projectSettings' || agent.source === 'localSettings'
        ? relative(getCwd(), loadedMarkdownFile.baseDir)
        : loadedMarkdownFile.baseDir
    return join(displayBaseDir || '.', loadedMarkdownFile.relativePath)
  }

  const dirPath = getRelativeAgentDirectoryPath(agent.source)
  const filename = agent.filename || agent.agentType
  return join(dirPath, `${filename}.md`)
}

/**
 * `sourceFilePath` is assigned only by the Markdown loader. Require its
 * loader-provided base directory and keep it contained there before using it
 * for file mutations, so ad-hoc JSON definitions continue through the legacy
 * source/filename path resolution.
 */
function getLoadedMarkdownFile(
  agent: AgentDefinition,
): { filePath: string; baseDir: string; relativePath: string } | undefined {
  if (!isCustomAgent(agent) || !agent.sourceFilePath || !agent.baseDir) {
    return undefined
  }

  const baseDir = resolve(agent.baseDir)
  const filePath = resolve(agent.sourceFilePath)
  const relativePath = relative(baseDir, filePath)
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`)
  ) {
    return undefined
  }

  return { filePath, baseDir, relativePath }
}

function isRepositoryAgentSource(source: AgentDefinition['source']): boolean {
  return source === 'projectSettings' || source === 'localSettings'
}

async function assertSafeRepositoryAgentMutation(
  agent: AgentDefinition,
  filePath: string,
): Promise<boolean> {
  if (!isRepositoryAgentSource(agent.source)) {
    return false
  }

  const fileStats = await lstat(filePath)
  if (fileStats.isSymbolicLink()) {
    throw new Error(
      `Cannot update project agent through a symbolic link: ${filePath}`,
    )
  }

  const loadedMarkdownFile = getLoadedMarkdownFile(agent)
  const baseDir =
    loadedMarkdownFile?.baseDir ?? getAgentDirectoryPath(agent.source)
  const [canonicalBaseDir, canonicalFilePath] = await Promise.all([
    realpath(baseDir),
    realpath(filePath),
  ])
  const canonicalRelativePath = relative(
    canonicalBaseDir,
    canonicalFilePath,
  )
  if (
    !canonicalRelativePath ||
    isAbsolute(canonicalRelativePath) ||
    canonicalRelativePath === '..' ||
    canonicalRelativePath.startsWith(`..${sep}`)
  ) {
    throw new Error(
      `Cannot update project agent outside its agents directory: ${filePath}`,
    )
  }

  return true
}

/**
 * Ensures the directory for an agent location exists
 */
async function ensureAgentDirectoryExists(
  source: SettingSource,
): Promise<string> {
  const dirPath = getAgentDirectoryPath(source)
  await mkdir(dirPath, { recursive: true })
  return dirPath
}

/**
 * Saves an agent to the filesystem
 * @param checkExists - If true, throws error if file already exists
 */
export async function saveAgentToFile(
  source: SettingSource | 'built-in',
  agentType: string,
  whenToUse: string,
  tools: string[] | undefined,
  systemPrompt: string,
  checkExists = true,
  color?: string,
  model?: string,
  memory?: AgentMemoryScope,
  effort?: EffortValue,
  additionalFrontmatter: AdditionalAgentFrontmatter = {},
): Promise<void> {
  if (source === 'built-in') {
    throw new Error('Cannot save built-in agents')
  }

  await ensureAgentDirectoryExists(source)
  const filePath = getNewAgentFilePath({ source, agentType })

  const content = formatAgentAsMarkdown(
    agentType,
    whenToUse,
    tools,
    systemPrompt,
    color,
    model,
    memory,
    effort,
    additionalFrontmatter,
  )
  try {
    await writeFileAndFlush(filePath, content, checkExists ? 'wx' : 'w')
  } catch (e: unknown) {
    if (getErrnoCode(e) === 'EEXIST') {
      throw new Error(`Agent file already exists: ${filePath}`)
    }
    throw e
  }
  clearAgentDefinitionsCache()
}

/**
 * Updates an existing agent file
 */
export async function updateAgentFile(
  agent: AgentDefinition,
  newWhenToUse: string,
  newTools: string[] | undefined,
  newSystemPrompt: string | undefined,
  newColor?: string,
  newModel?: string,
  newMemory?: AgentMemoryScope,
  newEffort?: EffortValue,
): Promise<void> {
  if (agent.source === 'built-in') {
    throw new Error('Cannot update built-in agents')
  }

  const filePath = getActualAgentFilePath(agent)
  const rejectFinalSymlink = await assertSafeRepositoryAgentMutation(
    agent,
    filePath,
  )
  const currentContent = await readFile(filePath, 'utf-8')
  const content = updateAgentMarkdown(
    currentContent,
    {
      description: newWhenToUse,
      tools: newTools,
      model: newModel,
      color: newColor,
      ...(newMemory !== undefined ? { memory: newMemory } : {}),
      ...(newEffort !== undefined ? { effort: newEffort } : {}),
    },
    newSystemPrompt,
  )

  await writeFileAndFlush(filePath, content, 'w', rejectFinalSymlink)
  clearAgentDefinitionsCache()
}

export function getPersistedAgentFrontmatter(
  agent: AgentDefinition,
): AdditionalAgentFrontmatter {
  return agentFrontmatterExtras(agent)
}

/**
 * Markdown agents expose the exact persisted tool selection separately from
 * runtime additions such as the Read/Edit/Write tools required by memory.
 * Other agent sources keep their existing runtime representation.
 */
export function getPersistedAgentTools(
  agent: AgentDefinition,
): string[] | undefined {
  return Object.hasOwn(agent, 'rawTools') ? agent.rawTools : agent.tools
}

/**
 * Deletes an agent file
 */
export async function deleteAgentFromFile(
  agent: AgentDefinition,
): Promise<void> {
  if (agent.source === 'built-in') {
    throw new Error('Cannot delete built-in agents')
  }

  const filePath = getActualAgentFilePath(agent)

  try {
    await unlink(filePath)
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      throw e
    }
  }
  clearAgentDefinitionsCache()
}

async function writeFileAndFlush(
  filePath: string,
  content: string,
  flag: 'w' | 'wx' = 'w',
  rejectFinalSymlink = false,
): Promise<void> {
  // 平台分叉（v1.7.0 真缺陷修复：Windows 上「保存仓储 agent 编辑」必失败）。
  //
  // 本机实测（Bun/Node on win32）：
  //   · `fs.constants.O_NOFOLLOW` 在 win32 上是 **undefined**（该平台无此语义），
  //     所以 `O_WRONLY|O_TRUNC|O_NOFOLLOW` 求值实为 513 = O_WRONLY|O_TRUNC；
  //   · 513 在 Windows 上被 open 直接拒为 **EINVAL**（数值 flag 带 O_TRUNC 却不带
  //     O_CREAT）；而 O_WRONLY|O_TRUNC|O_CREAT(769) 与字符串 'w' 都正常写入。
  //   → 失败真因是「win32 上这条数值 flag 组合本身不可用」，O_NOFOLLOW 只是把代码
  //     引到了这条数值路径。updateAgentFile 的正常路径恒有 rejectFinalSymlink=true
  //     （仓储 agent 且 assertSafeRepositoryAgentMutation 预检全过 → 返回 true），
  //     故 Windows 用户保存项目/本地 agent 必失败；createAgent 走字符串 'wx'/'w'、
  //     不传该参数，不受影响。
  //
  // 处置：
  //   · win32  ：退回**字符串 flag**（等价 O_WRONLY|O_CREAT|O_TRUNC，语义不变：创建
  //     或截断写）。防符号链接由 assertSafeRepositoryAgentMutation 的预检承担——
  //     lstat 发现符号链接即 throw、realpath 越出 agents 目录即 throw；语义损失仅剩
  //     「预检与 open 之间的极窄 TOCTOU 窗口」，本机单用户场景风险极低。
  //   · 非 win32：维持原状，继续带 O_NOFOLLOW（lstat 之后、open 之前的 TOCTOU 二次
  //     防线），安全语义整体保留。
  // 备注：换 utils/atomicFs 的 tmp+rename 对 symlink 天然安全但会换 inode，属更大
  // 改动，列 v1.7.1 候选，不在本批。
  const openFlag =
    rejectFinalSymlink && process.platform !== 'win32'
      ? fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW
      : flag
  const handle = await open(filePath, openFlag)
  try {
    await handle.writeFile(content, { encoding: 'utf-8' })
    await handle.datasync()
  } finally {
    await handle.close()
  }
}
