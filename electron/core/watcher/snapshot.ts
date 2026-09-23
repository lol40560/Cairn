import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve, sep, win32 } from 'node:path'

import { ensureCairnDataDir } from '../data-dir'

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function assertSafeHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`快照 hash 非法：${hash}`)
  }
}

function assertSafeRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/')
  const segments = normalized.split('/')

  if (
    normalized.length === 0 ||
    isAbsolute(normalized) ||
    win32.isAbsolute(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`快照相对路径越界：${relativePath}`)
  }

  return normalized
}

function snapshotPath(
  projectRoot: string,
  hash: string,
  relativePath: string,
): string {
  assertSafeHash(hash)
  const safeRelativePath = assertSafeRelativePath(relativePath)
  const root = resolve(ensureCairnDataDir(projectRoot), 'snapshots', hash)
  const target = resolve(root, ...safeRelativePath.split('/'))

  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`快照相对路径越界：${relativePath}`)
  }

  return target
}

export function writeSnapshot(
  projectRoot: string,
  relativePath: string,
  content: string,
): string {
  const hash = computeContentHash(content)
  const target = snapshotPath(projectRoot, hash, relativePath)

  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    if (!existsSync(target)) {
      writeFileSync(target, content, 'utf8')
    }
  }

  return hash
}

export function readSnapshot(
  projectRoot: string,
  hash: string,
  relativePath: string,
): string | undefined {
  const target = snapshotPath(projectRoot, hash, relativePath)

  if (!existsSync(target)) {
    return undefined
  }

  return readFileSync(target, 'utf8')
}

export function snapshotExists(
  projectRoot: string,
  hash: string,
  relativePath: string,
): boolean {
  return existsSync(snapshotPath(projectRoot, hash, relativePath))
}
