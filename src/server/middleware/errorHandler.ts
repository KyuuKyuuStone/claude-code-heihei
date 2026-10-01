/**
 * Unified error handling utilities
 */

import { diagnosticsService } from '../services/diagnosticsService.js'
import { isAtomicWriteError } from '../../utils/atomicFs.js'

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }

  static badRequest(message: string) {
    return new ApiError(400, message, 'BAD_REQUEST')
  }

  static notFound(message: string) {
    return new ApiError(404, message, 'NOT_FOUND')
  }

  static conflict(message: string) {
    return new ApiError(409, message, 'CONFLICT')
  }

  static internal(message: string) {
    return new ApiError(500, message, 'INTERNAL_ERROR')
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json(
      { error: error.code || 'ERROR', message: error.message },
      { status: error.statusCode }
    )
  }

  // v1.7.0 D1：写盘被占用（杀软/索引器持锁，重试耗尽）→ 503 可理解说明，
  // 而不是裸 500。只对 atomicWriteKind === 'locked' 生效；真实 IO 失败仍是 500。
  if (isAtomicWriteError(error) && error.atomicWriteKind === 'locked') {
    void diagnosticsService.recordEvent({
      type: 'api_atomic_write_locked',
      severity: 'warn',
      summary: error.message,
      details: { code: error.code },
    })
    return Response.json(
      {
        error: 'TARGET_FILE_BUSY',
        message:
          'The target file is temporarily locked by another process (e.g. antivirus or indexer). ' +
          'The original file was left unchanged — please retry.',
        errno: error.code,
      },
      { status: 503 }
    )
  }

  void diagnosticsService.recordEvent({
    type: 'api_unhandled_error',
    severity: 'error',
    summary: error instanceof Error ? error.message : String(error),
    details: error,
  })
  console.error('[Server] Unexpected error:', error)
  return Response.json(
    { error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    { status: 500 }
  )
}
