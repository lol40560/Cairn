import type { TranslateFn, TranslationKey } from '@/i18n'
import type { ErrorCategory, IpcResult, SerializedError } from '@/types/cairn'

export interface NormalizedError {
  category: ErrorCategory
  message: string
  hint?: string
  raw: string
}

function isSerializedError(error: unknown): error is SerializedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'category' in error &&
    'message' in error &&
    'raw' in error
  )
}

function isIpcFailure(error: unknown): error is Extract<IpcResult<unknown>, { ok: false }> {
  return typeof error === 'object' && error !== null && 'ok' in error && error.ok === false && 'error' in error
}

function categoryFromError(error: unknown): ErrorCategory {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('eacces') || message.includes('eperm')) return 'permission'
  if (message.includes('httperror') || message.includes('octokit') || message.includes('github')) return 'github'
  if (message.includes('econnrefused') || message.includes('timeout') || message.includes('socket') || message.includes('enetunreach')) return 'network'
  if (message.includes('token') || message.includes('配置') || message.includes('config')) return 'config'
  if (message.includes('enoent') || message.includes('not found')) return 'notFound'
  return 'unknown'
}

function errorKey(category: ErrorCategory): 'errorConfig' | 'errorNetwork' | 'errorPermission' | 'errorGithub' | 'errorConflict' | 'errorNotFound' | 'errorUnknown' {
  const keys = {
    config: 'errorConfig',
    conflict: 'errorConflict',
    github: 'errorGithub',
    network: 'errorNetwork',
    notFound: 'errorNotFound',
    permission: 'errorPermission',
    unknown: 'errorUnknown',
  } as const
  return keys[category]
}

/** 把 IPC 或普通异常转换为可展示、可本地化的错误信息。 */
export function normalizeError(error: unknown, t: TranslateFn): NormalizedError {
  if (isIpcFailure(error)) {
    return normalizeError(error.error, t)
  }
  if (isSerializedError(error)) {
    return {
      category: error.category,
      message: t(errorKey(error.category)),
      ...(error.hintKey ? { hint: t(error.hintKey as TranslationKey) } : {}),
      raw: error.raw,
    }
  }

  const category = categoryFromError(error)
  return {
    category,
    message: t(errorKey(category)),
    raw: error instanceof Error ? error.stack ?? error.message : String(error),
  }
}
