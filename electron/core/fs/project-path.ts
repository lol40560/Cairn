import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'

/** 專案目錄邊界檢查失敗時拋出的明確錯誤。 */
export class UnsafeProjectPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeProjectPathError'
  }
}

/** 邏輯路徑在不分大小寫檔案系統上會覆蓋另一條路徑。 */
export class CaseCollisionError extends UnsafeProjectPathError {
  constructor(message: string) {
    super(message)
    this.name = 'CaseCollisionError'
  }
}

const caseSensitivityCache = new Map<string, Promise<boolean>>()

/** 僅折疊 ASCII 大小寫；Unicode normalization 需要檔案系統特定處理，不能假裝已解決。 */
export function caseCollisionKey(relativePath: string): string {
  return assertSafeProjectRelativePath(relativePath).replace(/[A-Z]/gu, (character) => character.toLowerCase())
}

export function assertNoCaseCollisions(paths: Iterable<string>, caseInsensitive: boolean): void {
  if (!caseInsensitive) return
  const seen = new Map<string, string>()
  for (const path of paths) {
    const safePath = assertSafeProjectRelativePath(path)
    const key = caseCollisionKey(safePath)
    const previous = seen.get(key)
    if (previous !== undefined && previous !== safePath) {
      throw new CaseCollisionError(`Case-colliding project paths are not safe on this filesystem: ${previous} and ${safePath}`)
    }
    seen.set(key, safePath)
  }
}

/**
 * 以同一個 project volume 內的隨機暫存目錄探測大小寫敏感性。
 * 失敗時保守視為不分大小寫，避免 restore/extract 的 silent overwrite。
 */
export async function isCaseInsensitiveFilesystem(projectRoot: string): Promise<boolean> {
  const root = await realpath(projectRoot)
  let cached = caseSensitivityCache.get(root)
  if (!cached) {
    cached = probeCaseInsensitiveFilesystem(root)
    caseSensitivityCache.set(root, cached)
  }
  return cached
}

export async function assertNoCaseCollisionForWrite(
  projectRoot: string,
  relativePath: string,
  options: { caseInsensitive?: boolean } = {},
): Promise<void> {
  const safePath = assertSafeProjectRelativePath(relativePath)
  const caseInsensitive = options.caseInsensitive ?? await isCaseInsensitiveFilesystem(projectRoot)
  if (!caseInsensitive) return

  const root = await realpath(projectRoot)
  let directory = root
  for (const segment of safePath.split('/')) {
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if (isMissingPath(error)) return
      throw error
    }
    const collision = entries.find((entry) => caseCollisionKey(entry) === caseCollisionKey(segment) && entry !== segment)
    if (collision !== undefined) {
      throw new CaseCollisionError(`Case-colliding project path: requested ${safePath}, existing component ${collision}`)
    }
    directory = resolve(directory, segment)
  }
}

/**
 * 驗證分散式資料使用的專案相對路徑。
 * 統一使用 `/` 表示分隔符，並拒絕所有跨平台的絕對與 traversal 路徑。
 */
export function assertSafeProjectRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (
    normalized.length === 0
    || isAbsolute(normalized)
    || win32.isAbsolute(normalized)
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new UnsafeProjectPathError('Unsafe project path: invalid relative path')
  }
  return normalized
}

/**
 * 解析專案內既有或即將建立的路徑，拒絕所有目的路徑上的符號連結。
 * 這是 project-bound filesystem mutation 的共同安全邊界。
 */
export async function resolveSafeProjectPath(projectRoot: string, relativePath: string): Promise<string> {
  const safeRelativePath = assertSafeProjectRelativePath(relativePath)
  const root = await realpath(projectRoot)
  const target = resolve(root, ...safeRelativePath.split('/'))
  const relationship = relative(root, target)
  if (!relationship || relationship === '..' || relationship.startsWith(`..${sep}`) || isAbsolute(relationship)) {
    throw new UnsafeProjectPathError('Unsafe project path: outside project root')
  }

  let current = root
  for (const segment of safeRelativePath.split('/')) {
    current = resolve(current, segment)
    try {
      const details = await lstat(current)
      if (details.isSymbolicLink()) {
        throw new UnsafeProjectPathError('Unsafe project path: symbolic link in destination path')
      }
      if (current !== target && !details.isDirectory()) {
        throw new UnsafeProjectPathError('Unsafe project path: destination ancestor is not a directory')
      }
    } catch (error) {
      if (isMissingPath(error)) break
      throw error
    }
  }

  return target
}

/**
 * 在建立父目錄後重新驗證目的路徑，讓檢查盡可能靠近最終寫入或 rename。
 */
export async function prepareSafeProjectWritePath(projectRoot: string, relativePath: string): Promise<string> {
  await assertNoCaseCollisionForWrite(projectRoot, relativePath)
  const target = await resolveSafeProjectPath(projectRoot, relativePath)
  await mkdir(dirname(target), { recursive: true })
  return resolveSafeProjectPath(projectRoot, relativePath)
}

async function probeCaseInsensitiveFilesystem(root: string): Promise<boolean> {
  // 放在 watcher 已忽略的內部資料夾，避免 capability probe 產生協作 op。
  const cairnDirectory = resolve(root, '.cairn')
  const probeDirectory = resolve(cairnDirectory, `case-probe-${randomUUID()}`)
  const upper = resolve(probeDirectory, 'CairnCaseProbe')
  const lower = resolve(probeDirectory, 'cairncaseprobe')
  try {
    try {
      const details = await lstat(cairnDirectory)
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new UnsafeProjectPathError('Unsafe project path: .cairn is not a real directory')
      }
    } catch (error) {
      if (!isMissingPath(error)) throw error
      await mkdir(cairnDirectory, { recursive: false })
    }
    await mkdir(probeDirectory, { recursive: false })
    await writeFile(upper, 'upper', { flag: 'wx' })
    try {
      await writeFile(lower, 'lower', { flag: 'wx' })
      return false
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') return true
      throw error
    }
  } catch (error) {
    console.warn('[cairn:fs] 無法探測檔案系統大小寫敏感性，採取安全 fallback', error)
    return true
  } finally {
    await rm(probeDirectory, { force: true, recursive: true }).catch(() => undefined)
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
