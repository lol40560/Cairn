import { describe, expect, it } from 'vitest'
import { derivePrimaryTeamStatus, deriveTeamHealth, formatDiagnostics } from './teamHealth'
import type { TeamHealthInput } from './teamHealth'

const base = (overrides: Partial<TeamHealthInput> = {}): TeamHealthInput => ({ status: 'watching', roomCode: '', peers: [], peerStatuses: {}, isHost: false, isSharing: false, identityMismatchCount: 0, conflicts: [], ops: [], ...overrides })
const peer = { peerId: 'alice', host: 'host', port: 1, lastSeen: 1 }

describe('team health', () => {
  it('keeps local watching separate from a room connection', () => {
    const health = deriveTeamHealth(base())
    expect(health).toMatchObject({ localWatch: 'watching', connection: 'not-in-room' })
    expect(derivePrimaryTeamStatus(health)).toBe('watching')
  })
  it('distinguishes a ready empty room, connected peers, reconnecting and offline', () => {
    expect(deriveTeamHealth(base({ roomCode: 'ABC123', isHost: true })).connection).toBe('room-ready')
    expect(deriveTeamHealth(base({ roomCode: 'ABC123', peers: [peer] })).connection).toBe('connected')
    expect(deriveTeamHealth(base({ roomCode: 'ABC123', peers: [peer], peerStatuses: { alice: { peerId: 'alice', status: 'reconnecting', attempt: 1 } } })).connection).toBe('reconnecting')
    expect(deriveTeamHealth(base({ roomCode: 'ABC123', peerStatuses: { alice: { peerId: 'alice', status: 'offline', attempt: 1 } } })).connection).toBe('offline')
  })
  it('has stable safety-first status priority', () => {
    expect(derivePrimaryTeamStatus(deriveTeamHealth(base({ roomCode: 'ABC123', conflicts: [{ filePath: 'a', opHash: 'a'.repeat(64), author: 'A', timestamp: 1, localContent: '' }] })))).toBe('conflict')
    expect(derivePrimaryTeamStatus(deriveTeamHealth(base({ roomCode: 'ABC123', identityMismatchCount: 1, conflicts: [{ filePath: 'a', opHash: 'a'.repeat(64), author: 'A', timestamp: 1, localContent: '' }] })))).toBe('identity-mismatch')
    expect(derivePrimaryTeamStatus(deriveTeamHealth(base({ status: 'stopped', roomCode: 'ABC123', peers: [peer] })))).toBe('watcher-stopped')
  })
  it('regression: creates diagnostics without room authentication material', () => {
    const roomCode = 'ABC123'
    const text = formatDiagnostics(deriveTeamHealth(base({ roomCode, directAddress: '127.0.0.1:1', ops: [{ id: 'x', hash: 'x', author: 'A', parentHashes: [], timestamp: 1, filePath: 'secret.env', diff: 'TOKEN=never-copy' }] })))
    expect(text).not.toContain(roomCode)
    expect(text).not.toContain('Room:')
    expect(text).not.toContain('TOKEN=')
    expect(text).not.toContain('secret.env')
  })
  it('does not attribute legacy provenance to local activity', () => {
    const health = deriveTeamHealth(base({ ops: [{ id: 'legacy', hash: 'legacy', author: 'Old data', parentHashes: [], timestamp: 1, filePath: 'a.ts', diff: '', source: 'unknown' }] }))
    expect(health.lastLocalActivityAt).toBeUndefined()
    expect(health.lastRemoteActivityAt).toBeUndefined()
  })
})
