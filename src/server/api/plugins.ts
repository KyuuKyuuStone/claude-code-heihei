import type { PluginScope } from '../../utils/plugins/schemas.js'
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { PluginService } from '../services/pluginService.js'
import { reloadSessionComponents } from '../services/sessionComponentReloadService.js'

const pluginService = new PluginService()

export async function handlePluginsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const sub = segments[2]
    const cwd = url.searchParams.get('cwd') || undefined

    if (method === 'GET' && !sub) {
      return Response.json(await pluginService.listPlugins(cwd))
    }

    if (method === 'GET' && sub === 'detail') {
      const pluginId = url.searchParams.get('id')
      if (!pluginId) {
        throw ApiError.badRequest('Missing required "id" query parameter')
      }
      return Response.json({
        detail: await pluginService.getPluginDetail(pluginId, cwd),
      })
    }

    if (method === 'POST' && sub === 'reload') {
      const sessionId = url.searchParams.get('sessionId') || undefined
      const response = await pluginService.reloadPlugins(cwd)
      if (!sessionId) {
        return Response.json(response)
      }

      return Response.json({
        ...response,
        session: await reloadSessionComponents(sessionId),
      })
    }

    if (method === 'POST' && sub) {
      const body = await parseJsonBody(req)
      const pluginId = asString(body.id)
      if (!pluginId) {
        throw ApiError.badRequest('Missing or invalid "id" in request body')
      }

      assertAllowedBodyKeys(
        body,
        sub === 'uninstall'
          ? ['id', 'scope', 'keepData', 'cwd']
          : ['id', 'scope', 'cwd'],
      )
      const cwd = coerceProjectRoot(body.cwd)

      switch (sub) {
        case 'enable': {
          const scope = coerceScope(body.scope, false)
          return Response.json(await pluginService.enablePlugin(pluginId, scope, cwd))
        }
        case 'disable': {
          const scope = coerceScope(body.scope, false)
          return Response.json(await pluginService.disablePlugin(pluginId, scope, cwd))
        }
        case 'update': {
          const scope = coerceScope(body.scope, true)
          return Response.json(
            await pluginService.updatePlugin(pluginId, scope as PluginScope | undefined, cwd),
          )
        }
        case 'uninstall': {
          const scope = coerceScope(body.scope, false)
          if ('keepData' in body && typeof body.keepData !== 'boolean') {
            throw ApiError.badRequest('"keepData" must be a boolean')
          }
          return Response.json(
            await pluginService.uninstallPlugin(
              pluginId,
              scope,
              body.keepData === true,
              cwd,
            ),
          )
        }
        default:
          throw ApiError.notFound(`Unknown plugins endpoint: ${sub}`)
      }
    }

    throw new ApiError(
      405,
      `Method ${method} not allowed on /api/plugins${sub ? `/${sub}` : ''}`,
      'METHOD_NOT_ALLOWED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json() as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw ApiError.badRequest('JSON body must be an object')
    }
    return body as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 512
    ? normalized
    : undefined
}

function coerceScope(value: unknown, allowManaged: boolean):
  | 'user'
  | 'project'
  | 'local'
  | 'managed'
  | undefined {
  if (value == null) return undefined
  if (
    value === 'user' ||
    value === 'project' ||
    value === 'local' ||
    (allowManaged && value === 'managed')
  ) {
    return value
  }
  throw ApiError.badRequest(
    `Invalid "scope". Expected one of: user, project, local${allowManaged ? ', managed' : ''}`,
  )
}

function coerceProjectRoot(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw ApiError.badRequest('"cwd" must be a non-empty absolute directory path')
  }
  if (!isAbsolute(value)) {
    throw ApiError.badRequest('"cwd" must be an absolute directory path')
  }
  const normalized = resolve(value)
  try {
    if (!statSync(normalized).isDirectory()) {
      throw ApiError.badRequest('"cwd" must reference an existing directory')
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('"cwd" must reference an existing directory')
  }
  return normalized
}

function assertAllowedBodyKeys(
  body: Record<string, unknown>,
  allowed: string[],
): void {
  const allowedKeys = new Set(allowed)
  const unknownKey = Object.keys(body).find((key) => !allowedKeys.has(key))
  if (unknownKey) {
    throw ApiError.badRequest(`Unknown request field: "${unknownKey}"`)
  }
}
