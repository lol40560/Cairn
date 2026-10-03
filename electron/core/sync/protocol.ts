import { createHash, createHmac } from 'node:crypto'

import type { ProjectIdentity } from '../identity'
import type { Op } from '../oplog'

export interface PeerInfo {
  peerId: string
  host: string
  port: number
  lastSeen: number
}

export interface SeederInfo {
  peerId: string
  snapshotId: string
  projectName: string
  size: number
}

/** 用于公开发现的短房间标识，绝不暴露邀请码本身。 */
export function deriveRoomHash(roomCode: string): string {
  return createHash('sha256').update(roomCode).digest('hex').slice(0, 16)
}

/** 仅在本地用于认证挑战响应的密钥，不能写入网络消息或日志。 */
export function deriveAuthKey(roomCode: string): Buffer {
  return createHash('sha256').update(`cairn-auth:${roomCode}`).digest()
}

/** 计算认证挑战的 HMAC，供传输层和单元测试共享。 */
export function createAuthHmac(roomCode: string, nonce: string): string {
  return createHmac('sha256', deriveAuthKey(roomCode)).update(nonce).digest('hex')
}

export type SyncMessage =
  | { type: 'hello'; peerId: string; version: 1; identity?: ProjectIdentity }
  | { type: 'auth-request'; roomHash: string; peerId: string }
  | { type: 'auth-challenge'; nonce: string }
  | { type: 'auth-response'; hmac: string }
  | { type: 'auth-ok' }
  | { type: 'auth-fail'; reason: string }
  | { type: 'have'; hash: string }
  | { type: 'want'; hash: string }
  | { type: 'data'; op: Op }
  | { type: 'seeder-available'; snapshotId: string; projectName: string; size: number }
  | { type: 'seeder-gone'; snapshotId: string }
  | { type: 'want-snapshot'; snapshotId: string }
  | { type: 'snapshot-meta'; snapshotId: string; size: number; chunkCount: number; projectName: string }
  | { type: 'want-chunk'; snapshotId: string; index: number }
  | { type: 'chunk'; snapshotId: string; index: number; data: string }
  | { type: 'snapshot-done'; snapshotId: string }
  | { type: 'have-blob'; hash: string; size: number }
  | { type: 'want-blob'; hash: string }
  | { type: 'data-blob'; hash: string; data: string }
  | { type: 'identity-mismatch'; reason: string; hostIdentity: ProjectIdentity; yourIdentity: ProjectIdentity }
  | { type: 'identity-ok' }
  | { type: 'ping' }
  | { type: 'pong' }

export function encodeMessage(message: SyncMessage): string {
  return `${JSON.stringify(message)}\n`
}

export function decodeMessages(
  buffer: string,
  onError: (error: Error) => void = (error) => console.error(error.message),
): { messages: SyncMessage[]; rest: string } {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  const messages: SyncMessage[] = []

  for (const line of lines) {
    if (line.length === 0) {
      continue
    }

    try {
      const message: unknown = JSON.parse(line)
      if (!isSyncMessage(message)) {
        throw new Error('消息格式不合法')
      }
      messages.push(message)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      onError(new Error(`无法解析同步消息：${detail}`))
    }
  }

  return { messages, rest }
}

export function isSyncMessage(message: unknown): message is SyncMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return false
  }

  const candidate = message as Record<string, unknown>

  switch (candidate.type) {
    case 'hello':
      return (
        typeof candidate.peerId === 'string' &&
        candidate.version === 1 &&
        (candidate.identity === undefined || isProjectIdentity(candidate.identity))
      )
    case 'identity-mismatch':
      return (
        typeof candidate.reason === 'string'
        && isProjectIdentity(candidate.hostIdentity)
        && isProjectIdentity(candidate.yourIdentity)
      )
    case 'identity-ok':
      return true
    case 'auth-request':
      return typeof candidate.peerId === 'string' && typeof candidate.roomHash === 'string'
    case 'auth-challenge':
      return typeof candidate.nonce === 'string'
    case 'auth-response':
      return typeof candidate.hmac === 'string'
    case 'auth-ok':
      return true
    case 'auth-fail':
      return typeof candidate.reason === 'string'
    case 'have':
    case 'want':
    case 'want-blob':
      return typeof candidate.hash === 'string'
    case 'have-blob':
      return typeof candidate.hash === 'string' && isNonNegativeNumber(candidate.size)
    case 'data-blob':
      return typeof candidate.hash === 'string' && typeof candidate.data === 'string'
    case 'data':
      return typeof candidate.op === 'object' && candidate.op !== null
    case 'seeder-available':
      return (
        typeof candidate.snapshotId === 'string' &&
        typeof candidate.projectName === 'string' &&
        isNonNegativeNumber(candidate.size)
      )
    case 'seeder-gone':
    case 'want-snapshot':
    case 'snapshot-done':
      return typeof candidate.snapshotId === 'string'
    case 'ping':
    case 'pong':
      return true
    case 'snapshot-meta':
      return (
        typeof candidate.snapshotId === 'string' &&
        typeof candidate.projectName === 'string' &&
        isNonNegativeNumber(candidate.size) &&
        isNonNegativeInteger(candidate.chunkCount)
      )
    case 'want-chunk':
      return typeof candidate.snapshotId === 'string' && isNonNegativeInteger(candidate.index)
    case 'chunk':
      return (
        typeof candidate.snapshotId === 'string' &&
        isNonNegativeInteger(candidate.index) &&
        typeof candidate.data === 'string'
      )
    default:
      return false
  }
}

function isProjectIdentity(value: unknown): value is ProjectIdentity {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.projectName === 'string'
    && typeof candidate.fingerprint === 'string'
    && (candidate.baseCommit === undefined || typeof candidate.baseCommit === 'string')
  )
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value)
}
