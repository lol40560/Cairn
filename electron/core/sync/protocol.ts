import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'

import type { ProjectIdentity } from '../identity'
import type { Op } from '../oplog'

/** v2 peer 理解新版操作 identity，避免新舊 hash 格式被靜默混用。 */
export const SYNC_PROTOCOL_VERSION = 4
/** 與 Transport 使用同一個 frame hard limit，避免本機產生必定被拒絕的 op。 */
export const MAX_SYNC_MESSAGE_BYTES = 10 * 1024 * 1024
/** 加密 envelope 使用 JSON/base64；此預算保留 tag、sequence 與 framing 空間。 */
export const MAX_APPLICATION_MESSAGE_BYTES = Math.floor((MAX_SYNC_MESSAGE_BYTES - 256) * 3 / 4) - 4
export const TRANSPORT_ENCRYPTION_VERSION = 1
export const TRANSPORT_AEAD_TAG_BYTES = 16
export const ROOM_SECRET_BYTES = 16
export const ROOM_SECRET_LENGTH = 26
/** Blob 分塊遠低於 wire frame 上限，保留 base64 與 JSON framing 餘裕。 */
export const BLOB_CHUNK_SIZE = 64 * 1024
/** 文字 fallback 的硬上限；超過此值不會無限制佔用 receiver 記憶體。 */
export const MAX_TRANSFER_BLOB_BYTES = 50 * 1024 * 1024

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

/** 以 RFC 4648 Base32 格式化 128-bit 房間密鑰，方便安全地複製與人工核對。 */
export function generateRoomSecret(): string {
  return encodeRoomSecret(randomBytes(ROOM_SECRET_BYTES))
}

export function normalizeRoomSecret(value: string): string {
  const normalized = value.replace(/[\s-]/g, '').toUpperCase()
  if (!new RegExp(`^[A-Z2-7]{${ROOM_SECRET_LENGTH}}$`).test(normalized)) {
    throw new Error('邀请码必须是 128-bit Base32 房间密钥')
  }
  const decoded = decodeRoomSecret(normalized)
  if (decoded.length !== ROOM_SECRET_BYTES || encodeRoomSecret(decoded) !== normalized) {
    throw new Error('邀请码格式无效')
  }
  return normalized
}

function encodeRoomSecret(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
  return output
}

function decodeRoomSecret(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let accumulator = 0
  const output: number[] = []
  for (const char of value) {
    const index = alphabet.indexOf(char)
    if (index < 0) throw new Error('邀请码格式无效')
    accumulator = (accumulator << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(output)
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
export const AUTH_PROTOCOL_VERSION = 2

/**
 * 将认证字段编码为带长度前缀的二进制 transcript。
 *
 * 不使用分隔符拼接，避免不同字段组合产生相同的认证输入。
 */
function authTranscript(domain: string, roomHash: string, clientNonce: string, serverNonce: string): Buffer {
  const fields = [
    Buffer.from(domain, 'utf8'),
    Buffer.from(String(AUTH_PROTOCOL_VERSION), 'ascii'),
    Buffer.from(roomHash, 'utf8'),
    Buffer.from(clientNonce, 'utf8'),
    Buffer.from(serverNonce, 'utf8'),
  ]

  return Buffer.concat(fields.flatMap((field) => {
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(field.length)
    return [length, field]
  }))
}

export function createServerProof(roomCode: string, roomHash: string, clientNonce: string, serverNonce: string): string {
  return createHmac('sha256', deriveAuthKey(roomCode))
    .update(authTranscript('cairn-auth-server', roomHash, clientNonce, serverNonce))
    .digest('hex')
}

export function createClientProof(roomCode: string, roomHash: string, clientNonce: string, serverNonce: string): string {
  return createHmac('sha256', deriveAuthKey(roomCode))
    .update(authTranscript('cairn-auth-client', roomHash, clientNonce, serverNonce))
    .digest('hex')
}

export interface TransportSessionKeys {
  clientToServerKey: Buffer
  clientToServerNoncePrefix: Buffer
  serverToClientKey: Buffer
  serverToClientNoncePrefix: Buffer
}

/** 認證 transcript 綁定每條連線，HKDF 產生互不相同的雙向金鑰與 nonce prefix。 */
export function deriveTransportSessionKeys(
  roomCode: string,
  roomHash: string,
  clientNonce: string,
  serverNonce: string,
): TransportSessionKeys {
  const salt = createHash('sha256')
    .update(authTranscript('cairn-transport-session-v1', roomHash, clientNonce, serverNonce))
    .digest()
  const derive = (label: string, length: number): Buffer => Buffer.from(hkdfSync(
    'sha256', deriveAuthKey(roomCode), salt, Buffer.from(label, 'utf8'), length,
  ))
  return {
    clientToServerKey: derive('cairn-transport-c2s-v1:key', 32),
    clientToServerNoncePrefix: derive('cairn-transport-c2s-v1:nonce', 4),
    serverToClientKey: derive('cairn-transport-s2c-v1:key', 32),
    serverToClientNoncePrefix: derive('cairn-transport-s2c-v1:nonce', 4),
  }
}

export type TransportDirection = 'client-to-server' | 'server-to-client'

export interface SecureTransportFrame {
  type: 'secure'
  encryptionVersion: typeof TRANSPORT_ENCRYPTION_VERSION
  sequence: string
  ciphertext: string
  tag: string
}

export function encryptTransportMessage(
  keys: TransportSessionKeys,
  direction: TransportDirection,
  sequence: bigint,
  message: SyncMessage,
): SecureTransportFrame {
  if (message.type === 'secure' || message.type.startsWith('auth-')) {
    throw new Error('认证或加密 envelope 不能作为加密应用消息发送')
  }
  const material = selectDirectionMaterial(keys, direction)
  const nonce = transportNonce(material.noncePrefix, sequence)
  const cipher = createCipheriv('aes-256-gcm', material.key, nonce, { authTagLength: TRANSPORT_AEAD_TAG_BYTES })
  cipher.setAAD(transportAad(direction, sequence))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(message), 'utf8')), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    encryptionVersion: TRANSPORT_ENCRYPTION_VERSION,
    sequence: sequence.toString(),
    tag: cipher.getAuthTag().toString('base64'),
    type: 'secure',
  }
}

export function decryptTransportMessage(
  keys: TransportSessionKeys,
  direction: TransportDirection,
  frame: SecureTransportFrame,
): Exclude<SyncMessage, SecureTransportFrame> {
  if (frame.encryptionVersion !== TRANSPORT_ENCRYPTION_VERSION) throw new Error('不支援的加密傳輸版本')
  const sequence = parseTransportSequence(frame.sequence)
  const material = selectDirectionMaterial(keys, direction)
  try {
    const decipher = createDecipheriv('aes-256-gcm', material.key, transportNonce(material.noncePrefix, sequence), { authTagLength: TRANSPORT_AEAD_TAG_BYTES })
    decipher.setAAD(transportAad(direction, sequence))
    decipher.setAuthTag(Buffer.from(frame.tag, 'base64'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(frame.ciphertext, 'base64')), decipher.final()]).toString('utf8')
    const message: unknown = JSON.parse(plaintext)
    if (!isSyncMessage(message) || message.type === 'secure' || message.type.startsWith('auth-')) {
      throw new Error('加密消息内容无效')
    }
    return message as Exclude<SyncMessage, SecureTransportFrame>
  } catch (error) {
    throw new Error(`加密消息验证失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

export function parseTransportSequence(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error('加密消息序号无效')
  const sequence = BigInt(value)
  if (sequence > 0xffff_ffff_ffff_ffffn) throw new Error('加密消息序号超出范围')
  return sequence
}

function selectDirectionMaterial(keys: TransportSessionKeys, direction: TransportDirection): { key: Buffer; noncePrefix: Buffer } {
  return direction === 'client-to-server'
    ? { key: keys.clientToServerKey, noncePrefix: keys.clientToServerNoncePrefix }
    : { key: keys.serverToClientKey, noncePrefix: keys.serverToClientNoncePrefix }
}

function transportNonce(prefix: Buffer, sequence: bigint): Buffer {
  const nonce = Buffer.alloc(12)
  prefix.copy(nonce, 0)
  nonce.writeBigUInt64BE(sequence, 4)
  return nonce
}

function transportAad(direction: TransportDirection, sequence: bigint): Buffer {
  return Buffer.from(`cairn-transport-v${TRANSPORT_ENCRYPTION_VERSION}\u0000${direction}\u0000${sequence}`, 'utf8')
}

export type SyncMessage =
  | { type: 'hello'; peerId: string; version: typeof SYNC_PROTOCOL_VERSION; identity?: ProjectIdentity }
  | { type: 'auth-request'; authVersion: 2; roomHash: string; peerId: string; clientNonce: string }
  | { type: 'auth-challenge'; authVersion: 2; serverNonce: string; serverProof: string }
  | { type: 'auth-response'; authVersion: 2; clientProof: string }
  | { type: 'auth-ok' }
  | { type: 'auth-fail'; reason: string }
  | SecureTransportFrame
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
  | { type: 'blob-meta'; hash: string; size: number; chunkCount: number }
  | { type: 'blob-chunk'; hash: string; index: number; data: string }
  | { type: 'identity-mismatch'; reason: string; hostIdentity: ProjectIdentity; yourIdentity: ProjectIdentity }
  | { type: 'identity-ok' }
  | { type: 'ping' }
  | { type: 'pong' }

export function encodeMessage(message: SyncMessage): string {
  return `${JSON.stringify(message)}\n`
}

/** 以實際 JSON UTF-8 frame 位元組計算上限，包含 Unicode escaping 與換行。 */
export function encodedMessageByteLength(message: SyncMessage): number {
  return Buffer.byteLength(encodeMessage(message), 'utf8')
}

export function isSyncMessageWithinLimit(message: SyncMessage): boolean {
  return encodedMessageByteLength(message) <= MAX_APPLICATION_MESSAGE_BYTES
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
        candidate.version === SYNC_PROTOCOL_VERSION &&
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
      return candidate.authVersion === AUTH_PROTOCOL_VERSION && typeof candidate.peerId === 'string' && typeof candidate.roomHash === 'string' && typeof candidate.clientNonce === 'string'
    case 'auth-challenge':
      return candidate.authVersion === AUTH_PROTOCOL_VERSION && typeof candidate.serverNonce === 'string' && typeof candidate.serverProof === 'string'
    case 'auth-response':
      return candidate.authVersion === AUTH_PROTOCOL_VERSION && typeof candidate.clientProof === 'string'
    case 'auth-ok':
      return true
    case 'auth-fail':
      return typeof candidate.reason === 'string'
    case 'secure':
      return candidate.encryptionVersion === TRANSPORT_ENCRYPTION_VERSION
        && typeof candidate.sequence === 'string'
        && typeof candidate.ciphertext === 'string'
        && typeof candidate.tag === 'string'
    case 'have':
    case 'want':
    case 'want-blob':
      return typeof candidate.hash === 'string'
    case 'have-blob':
      return typeof candidate.hash === 'string' && isNonNegativeNumber(candidate.size)
    case 'data-blob':
      return typeof candidate.hash === 'string' && typeof candidate.data === 'string'
    case 'blob-meta':
      return typeof candidate.hash === 'string' && isNonNegativeNumber(candidate.size) && isNonNegativeInteger(candidate.chunkCount)
    case 'blob-chunk':
      return typeof candidate.hash === 'string' && isNonNegativeInteger(candidate.index) && typeof candidate.data === 'string'
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
