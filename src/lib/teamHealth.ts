import type { ConflictRecord, Op, PeerInfo, PeerState } from '@/types/cairn'
import type { WatchStatus } from '@/store/appStore'

export type LocalWatchState = 'watching' | 'stopped'
export type TeamConnectionState = 'not-in-room' | 'room-ready' | 'connected' | 'reconnecting' | 'offline'
export type PrimaryTeamStatus = 'watcher-stopped' | 'identity-mismatch' | 'offline' | 'conflict' | 'reconnecting' | 'connected' | 'room-ready' | 'watching' | 'local-only'

export interface TeamHealth {
  localWatch: LocalWatchState
  connection: TeamConnectionState
  connectedPeerCount: number
  reconnectingPeerCount: number
  offlinePeerCount: number
  sharingEnabled: boolean
  identityMismatchCount: number
  unresolvedConflictCount: number
  isHost: boolean
  connectionMethod: 'direct' | 'lan' | undefined
  lastLocalActivityAt?: number
  lastRemoteActivityAt?: number
}

export interface TeamHealthInput {
  status: WatchStatus
  roomCode: string
  directAddress?: string
  peers: PeerInfo[]
  peerStatuses: Record<string, PeerState>
  isHost: boolean
  isSharing: boolean
  identityMismatchCount: number
  conflicts: ConflictRecord[]
  ops: Op[]
}

/**
 * 唯一的團隊健康推導點。Connected 只代表目前 TCP peer 可見，
 * 不代表所有 op 已被確認套用，因此這裡刻意沒有 "synced" 狀態。
 */
export function deriveTeamHealth(input: TeamHealthInput): TeamHealth {
  const joined = input.roomCode !== '' || input.directAddress !== undefined
  const knownIds = new Set([...input.peers.map((peer) => peer.peerId), ...Object.keys(input.peerStatuses)])
  let connectedPeerCount = 0
  let reconnectingPeerCount = 0
  let offlinePeerCount = 0
  for (const peerId of knownIds) {
    const state = input.peerStatuses[peerId]?.status
    if (state === 'reconnecting') reconnectingPeerCount += 1
    else if (state === 'offline') offlinePeerCount += 1
    else if (input.peers.some((peer) => peer.peerId === peerId)) connectedPeerCount += 1
  }
  const connection: TeamConnectionState = !joined
    ? 'not-in-room'
    : reconnectingPeerCount > 0 ? 'reconnecting'
      : connectedPeerCount > 0 ? 'connected'
        : offlinePeerCount > 0 ? 'offline'
          : 'room-ready'
  const lastLocalActivityAt = latest(input.ops.filter((op) => op.source !== 'remote'))
  const lastRemoteActivityAt = latest(input.ops.filter((op) => op.source === 'remote'))
  return {
    localWatch: input.status === 'watching' ? 'watching' : 'stopped',
    connection,
    connectedPeerCount,
    reconnectingPeerCount,
    offlinePeerCount,
    sharingEnabled: input.isSharing,
    identityMismatchCount: input.identityMismatchCount,
    unresolvedConflictCount: input.conflicts.length,
    isHost: input.isHost,
    connectionMethod: input.directAddress ? 'direct' : input.roomCode ? 'lan' : undefined,
    ...(lastLocalActivityAt ? { lastLocalActivityAt } : {}),
    ...(lastRemoteActivityAt ? { lastRemoteActivityAt } : {}),
  }
}

/** 明確優先序：本地 watcher 問題 > mismatch > 全部離線 > 衝突 > 重連 > 正常。 */
export function derivePrimaryTeamStatus(health: TeamHealth): PrimaryTeamStatus {
  if (health.localWatch === 'stopped') return 'watcher-stopped'
  if (health.identityMismatchCount > 0) return 'identity-mismatch'
  if (health.connection === 'offline') return 'offline'
  if (health.unresolvedConflictCount > 0) return 'conflict'
  if (health.connection === 'reconnecting') return 'reconnecting'
  if (health.connection === 'connected') return 'connected'
  if (health.connection === 'room-ready') return 'room-ready'
  return health.localWatch === 'watching' ? 'watching' : 'local-only'
}

/** 僅白名單目前狀態，避免診斷複製任意 store 或敏感設定。 */
export function formatDiagnostics(health: TeamHealth, roomCode: string): string {
  const connection = health.connection === 'not-in-room' ? 'Local only' : health.connection
  return [
    'Cairn Diagnostics',
    `Local watcher: ${health.localWatch}`,
    `Team: ${connection}`,
    ...(roomCode ? [`Room: ${roomCode}`] : []),
    `Role: ${health.isHost ? 'Host' : 'Guest'}`,
    `Peers: ${health.connectedPeerCount} connected, ${health.reconnectingPeerCount} reconnecting, ${health.offlinePeerCount} offline`,
    `Connection: ${health.connectionMethod ?? '—'}`,
    `Sharing: ${health.sharingEnabled ? 'Enabled' : 'Disabled'}`,
    `Project mismatches: ${health.identityMismatchCount}`,
    `Conflicts: ${health.unresolvedConflictCount}`,
    ...(health.lastLocalActivityAt ? [`Last local activity: ${new Date(health.lastLocalActivityAt).toISOString()}`] : []),
    ...(health.lastRemoteActivityAt ? [`Last remote activity: ${new Date(health.lastRemoteActivityAt).toISOString()}`] : []),
  ].join('\n')
}

function latest(ops: Op[]): number | undefined { return ops.reduce<number | undefined>((value, op) => value === undefined || op.timestamp > value ? op.timestamp : value, undefined) }
