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
  if (message.includes('econnrefused') || message.includes('timeout') || message.includes('socket') || message.includes('enetunreach') || message.includes('ehostunreach')) return 'network'
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

const presentationKeys = new Set<TranslationKey>([
  'errorTeammateUnreachable', 'errorTeammateClosed', 'errorTimeout', 'errorFileGone',
  'errorPermission', 'errorGithubExpired', 'errorGithubRepoNotFound', 'errorGithubDenied',
  'errorPortInUse', 'errorInvalidCode', 'errorSnapshotTooLarge', 'errorDiskFull',
])

/** 不改变错误分类，只选择对应的本地化展示文案。 */
function presentationKey(error: unknown): TranslationKey | undefined {
  if (isSerializedError(error) && error.code && presentationKeys.has(error.code as TranslationKey)) {
    return error.code as TranslationKey
  }

  const message = error instanceof Error ? error.message : isSerializedError(error) ? error.message : String(error)
  const normalized = message.toLowerCase()
  if (normalized.includes('ehostunreach') || normalized.includes('enetunreach')) return 'errorTeammateUnreachable'
  if (normalized.includes('econnrefused')) return 'errorTeammateClosed'
  if (normalized.includes('etimedout') || normalized.includes('timeout')) return 'errorTimeout'
  if (normalized.includes('enoent')) return 'errorFileGone'
  if (normalized.includes('eacces') || normalized.includes('eperm')) return 'errorPermission'
  if (normalized.includes('bad credentials') || normalized.includes('401')) return 'errorGithubExpired'
  if ((normalized.includes('github') || normalized.includes('octokit') || normalized.includes('httperror')) && normalized.includes('404')) return 'errorGithubRepoNotFound'
  if ((normalized.includes('github') || normalized.includes('octokit') || normalized.includes('httperror')) && normalized.includes('403')) return 'errorGithubDenied'
  if (normalized.includes('eaddrinuse') || normalized.includes('port') && normalized.includes('in use')) return 'errorPortInUse'
  if (normalized.includes('invalid room code') || normalized.includes('invalid invite code') || normalized.includes('邀请码格式')) return 'errorInvalidCode'
  if (normalized.includes('snapshot') && normalized.includes('large') || normalized.includes('项目过大') || normalized.includes('50 mb')) return 'errorSnapshotTooLarge'
  if (normalized.includes('enospc') || normalized.includes('disk full')) return 'errorDiskFull'
  return undefined
}

/** 把 IPC 或普通异常转换为可展示、可本地化的错误信息。 */
export function normalizeError(error: unknown, t: TranslateFn): NormalizedError {
  if (isIpcFailure(error)) {
    return normalizeError(error.error, t)
  }
  if (isSerializedError(error)) {
    return {
      category: error.category,
      message: t(presentationKey(error) ?? (error.category === 'unknown' ? 'errorGeneric' : errorKey(error.category))),
      ...(error.hintKey ? { hint: t(error.hintKey as TranslationKey) } : {}),
      raw: error.raw,
    }
  }

  const category = categoryFromError(error)
  return {
    category,
    message: t(presentationKey(error) ?? (category === 'unknown' ? 'errorGeneric' : errorKey(category))),
    raw: error instanceof Error ? error.stack ?? error.message : String(error),
  }
}
