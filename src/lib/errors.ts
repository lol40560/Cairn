import type { TranslateFn, TranslationKey } from '@/i18n'
import type { ErrorCategory, IpcResult, SerializedError } from '@/types/cairn'

export interface NormalizedError {
  category: ErrorCategory
  message: string
  hint?: string
  raw: string
}

/** Local diagnostics must never expose invitation or authentication credentials. */
export function redactErrorDetails(value: string): string {
  return value
    .replace(/\b[A-Z2-7]{26}\b/gi, '[redacted invite]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/g, '[redacted token]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&#](?:code|invite|roomCode|roomSecret|secret|token|access_token|key|password)=)[^\s&#]+/gi, '$1[redacted]')
    .replace(/((?:["']?(?:roomCode|roomSecret|inviteCode|invite|password|authorization|access_token|api[_-]?key|token|secret)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
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
  if (/econnrefused|timeout|超时|socket|enetunreach|ehostunreach|mdns|bonjour|closed before|认证完成前关闭|连接中断|wrong-room|invalid server proof|认证失败|无效.*认证|auth(?:entication)? failed|protocol.*version|version.*mismatch|版本不兼容|协议版本/.test(message)) return 'network'
  if (/请先选择并开始监控一个项目|no active project|invalid room code|invalid invite code|邀请码/.test(message)) return 'config'
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
  'errorProjectRequired', 'errorInvalidAddress', 'errorAuthentication', 'errorVersionMismatch',
  'errorDiscovery', 'errorConnectionClosed',
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
  if (normalized.includes('etimedout') || normalized.includes('timeout') || normalized.includes('超时')) return 'errorTimeout'
  if (normalized.includes('eacces') || normalized.includes('eperm')) return 'errorPermission'
  if (normalized.includes('eaddrinuse') || normalized.includes('port') && normalized.includes('in use')) return 'errorPortInUse'
  if (/protocol.*version|version.*mismatch|版本不兼容|协议版本/.test(normalized)) return 'errorVersionMismatch'
  if (/closed before|认证完成前关闭|连接中断/.test(normalized)) return 'errorConnectionClosed'
  if (/wrong-room|invalid server proof|认证失败|无效.*认证|auth(?:entication)? failed/.test(normalized)) return 'errorAuthentication'
  if (/mdns|bonjour/.test(normalized)) return 'errorDiscovery'
  if (/请先选择并开始监控一个项目|no active project/.test(normalized)) return 'errorProjectRequired'
  if (normalized.includes('enoent')) return 'errorFileGone'
  if (normalized.includes('bad credentials') || normalized.includes('401')) return 'errorGithubExpired'
  if ((normalized.includes('github') || normalized.includes('octokit') || normalized.includes('httperror')) && normalized.includes('404')) return 'errorGithubRepoNotFound'
  if ((normalized.includes('github') || normalized.includes('octokit') || normalized.includes('httperror')) && normalized.includes('403')) return 'errorGithubDenied'
  if (normalized.includes('invalid room code') || normalized.includes('invalid invite code') || normalized.includes('邀请码格式') || normalized.includes('邀请码必须')) return 'errorInvalidCode'
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
      raw: redactErrorDetails(error.raw),
    }
  }

  const category = categoryFromError(error)
  return {
    category,
    message: t(presentationKey(error) ?? (category === 'unknown' ? 'errorGeneric' : errorKey(category))),
    raw: redactErrorDetails(error instanceof Error ? error.stack ?? error.message : String(error)),
  }
}
