import { createHash } from 'node:crypto'

import type { NewOp, OpHashVersion, OpKind } from './types'

export const LEGACY_OP_HASH_VERSION: OpHashVersion = 1
export const CURRENT_OP_HASH_VERSION: OpHashVersion = 3

/**
 * v2/v3 以固定欄位順序與長度前綴編碼分散式操作語義。
 * 這避免 JSON property insertion order 成為 identity 的一部分。
 */
export function computeHash(input: NewOp): string {
  const version = input.hashVersion ?? CURRENT_OP_HASH_VERSION
  if (version === LEGACY_OP_HASH_VERSION) {
    return computeLegacyHash(input)
  }
  if (version !== 2 && version !== CURRENT_OP_HASH_VERSION) {
    throw new Error(`不支援的操作 hash 版本：${version}`)
  }

  return createHash('sha256').update(canonicalizeV2OrV3(input, version), 'utf8').digest('hex')
}

/** v2 物件必須以其原本的欄位集合驗證，不能被 v3 靜默重新解讀。 */
function canonicalizeV2OrV3(input: NewOp, version: 2 | 3): string {
  const serialized = [
    encodeField('format', 'cairn-op'),
    encodeField('version', String(version)),
    encodeField('id', input.id),
    encodeField('author', input.author),
    encodeList('parentHashes', input.parentHashes),
    encodeField('timestamp', String(input.timestamp)),
    encodeField('filePath', input.filePath),
    encodeOptionalField('kind', input.kind ?? deriveOpKind(input.diff)),
    encodeOptionalField('baseHash', input.baseHash),
    encodeOptionalField('blobHash', input.blobHash),
    encodeOptionalField('size', input.size === undefined ? undefined : String(input.size)),
    ...(version === 3 ? [encodeOptionalField('contentEncoding', input.contentEncoding)] : []),
    encodeField('diff', input.diff),
  ].join('')
  return serialized
}

/** 僅供讀取與驗證已持久化的 v1 操作，禁止用於新操作。 */
function computeLegacyHash(input: NewOp): string {
  const serialized = JSON.stringify([
    input.id,
    input.author,
    [...input.parentHashes].sort(),
    input.timestamp,
    input.filePath,
    input.diff,
  ])

  return createHash('sha256').update(serialized).digest('hex')
}

function encodeField(name: string, value: string): string {
  return `${encodeString(name)}${encodeString(value)}`
}

function encodeOptionalField(name: string, value: string | undefined): string {
  return `${encodeString(name)}${value === undefined ? 'U' : `V${encodeString(value)}`}`
}

function encodeList(name: string, values: string[]): string {
  const sorted = [...values].sort()
  return `${encodeString(name)}L${sorted.length}:${sorted.map(encodeString).join('')}`
}

function encodeString(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`
}

/** 新舊呼叫端省略 kind 時都使用同一個穩定推導規則。 */
export function deriveOpKind(diff: string): OpKind {
  if (diff.includes('--- /dev/null') || diff.includes('new file mode')) {
    return 'created'
  }
  if (diff.includes('+++ /dev/null') || diff.includes('deleted file mode')) {
    return 'deleted'
  }
  return 'modified'
}
