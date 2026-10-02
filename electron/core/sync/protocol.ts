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

export type SyncMessage =
  | { type: 'hello'; peerId: string; roomCode: string; version: 1 }
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
        typeof candidate.roomCode === 'string' &&
        candidate.version === 1
      )
    case 'have':
    case 'want':
      return typeof candidate.hash === 'string'
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

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value)
}
