export type ErrorCategory =
  | 'config'
  | 'network'
  | 'permission'
  | 'github'
  | 'conflict'
  | 'notFound'
  | 'unknown'

export class AppError extends Error {
  category: ErrorCategory
  code?: string
  hint?: string
  override cause?: unknown

  constructor(
    message: string,
    category: ErrorCategory,
    options: { cause?: unknown; code?: string; hint?: string } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'AppError'
    this.category = category
    this.code = options.code
    this.hint = options.hint
    this.cause = options.cause
  }
}

export interface SerializedAppError {
  category: ErrorCategory
  message: string
  code?: string
  hintKey?: string
  raw: string
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SerializedAppError }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function errorRaw(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

/** 将底层异常归类，并保留原始异常以便排查。 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error
  }

  const message = errorMessage(error)
  const normalized = `${error instanceof Error ? error.name : ''} ${message}`.toLowerCase()
  const code = errorCode(error)
  const isGithub = normalized.includes('httperror') || normalized.includes('octokit') || normalized.includes('github')
  const isTokenFailure = normalized.includes('bad credentials') || normalized.includes('token invalid') || normalized.includes('token expired')
  const isRepoMissing = isGithub && (normalized.includes('404') || normalized.includes('not found'))
  const isFolderMissing =
    (normalized.includes('folder') || normalized.includes('项目路径')) &&
    (normalized.includes('enoent') || normalized.includes('not found') || normalized.includes('不存在'))
  const isMdnsOrSocket = normalized.includes('mdns') || normalized.includes('socket')

  if (isRepoMissing) {
    return new AppError(message, 'github', { cause: error, code, hint: 'hintCheckRepo' })
  }
  if (isTokenFailure) {
    return new AppError(message, isGithub ? 'github' : 'config', {
      cause: error,
      code,
      hint: 'hintRegenerateToken',
    })
  }
  if (isFolderMissing || normalized.includes('enoent') || normalized.includes('not found')) {
    return new AppError(message, 'notFound', {
      cause: error,
      code,
      hint: isFolderMissing ? 'hintReselectFolder' : undefined,
    })
  }
  if (normalized.includes('eacces') || normalized.includes('eperm')) {
    return new AppError(message, 'permission', { cause: error, code })
  }
  if (isGithub) {
    return new AppError(message, 'github', {
      cause: error,
      code,
      hint: isTokenFailure ? 'hintRegenerateToken' : 'hintCheckGithubSettings',
    })
  }
  if (
    normalized.includes('econnrefused') ||
    normalized.includes('timeout') ||
    isMdnsOrSocket ||
    normalized.includes('enetunreach')
  ) {
    return new AppError(message, 'network', {
      cause: error,
      code,
      hint: isMdnsOrSocket ? 'hintCheckFirewall' : undefined,
    })
  }
  if (normalized.includes('token') || normalized.includes('配置') || normalized.includes('config')) {
    return new AppError(message, 'config', {
      cause: error,
      code,
      hint: isTokenFailure ? 'hintRegenerateToken' : undefined,
    })
  }
  if (normalized.includes('conflict') || normalized.includes('冲突')) {
    return new AppError(message, 'conflict', { cause: error, code })
  }
  return new AppError(message, 'unknown', { cause: error, code })
}

export function serializeAppError(error: unknown): SerializedAppError {
  const appError = toAppError(error)
  return {
    category: appError.category,
    message: appError.message,
    ...(appError.code ? { code: appError.code } : {}),
    ...(appError.hint ? { hintKey: appError.hint } : {}),
    raw: errorRaw(error),
  }
}

/** 统一 IPC 结果格式，fn 不接收 Electron 的 event 参数。 */
export function wrapIpcHandler<Args extends unknown[], Result>(
  fn: (...args: Args) => Result | Promise<Result>,
): (_event: unknown, ...args: Args) => Promise<IpcResult<Result>> {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (error) {
      return { ok: false, error: serializeAppError(error) }
    }
  }
}
