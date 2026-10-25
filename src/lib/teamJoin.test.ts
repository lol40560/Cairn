import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initializeDownloadTarget, joinTeam, parseDirectEndpoint, showDownloadedProject } from './teamJoin'
import { useAppStore } from '@/store/appStore'
import type { IpcResult } from '@/types/cairn'

const initialState = useAppStore.getState()
const code = 'A'.repeat(26)
const endpoint = { host: '192.168.1.10', port: 49500 }
const refused = { category: 'network' as const, code: 'errorTeammateClosed', message: 'Connection refused', raw: 'ECONNREFUSED' }

beforeEach(() => useAppStore.setState({ ...initialState, folder: '/tmp/receiving', status: 'watching', locale: 'en' }, true))
afterEach(() => useAppStore.setState(initialState, true))

function api() {
  return {
    joinRoom: vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined })),
    listPeers: vi.fn(async () => ({ ok: true as const, data: [] })),
  }
}

describe('team join and receiving folder recovery', () => {
  it('validates a direct endpoint before any network operation', () => {
    expect(parseDirectEndpoint(' 192.168.1.10:49500 ')).toEqual(endpoint)
    expect(parseDirectEndpoint('')).toBeUndefined()
    for (const address of ['1.2.3:80', '256.2.3.4:80', '1.2.3.4:0', '1.2.3.4:65536', '1.2.3.4:80x']) {
      expect(() => parseDirectEndpoint(address)).toThrow(expect.objectContaining({ code: 'errorInvalidAddress' }))
    }
  })

  it('prevents a join without a monitored receiving project', async () => {
    const backend = api()
    useAppStore.setState({ folder: '', status: 'idle' })
    await expect(joinTeam(code, endpoint, backend)).rejects.toMatchObject({ code: 'errorProjectRequired' })
    expect(backend.joinRoom).not.toHaveBeenCalled()
    useAppStore.setState({ folder: '/tmp/receiving', status: 'stopped' })
    await expect(joinTeam(code, endpoint, backend)).rejects.toMatchObject({ code: 'errorProjectRequired' })
    expect(backend.joinRoom).not.toHaveBeenCalled()
  })

  it('keeps the join form available until the direct handshake succeeds', async () => {
    let finish!: (result: IpcResult<void>) => void
    const backend = api()
    backend.joinRoom.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const joining = joinTeam(code, endpoint, backend)
    expect(useAppStore.getState().roomCode).toBe('')
    expect(useAppStore.getState().directAddress).toBeUndefined()
    finish({ ok: true, data: undefined })
    await joining
    expect(backend.joinRoom).toHaveBeenCalledWith(code, endpoint)
    expect(useAppStore.getState()).toMatchObject({ roomCode: code, directAddress: '192.168.1.10:49500', isHost: false })
  })

  it('preserves the actual failure and clears stale room state so joining can be retried', async () => {
    const backend = api()
    useAppStore.setState({ roomCode: 'OLD', directAddress: '127.0.0.1:1', isHost: true, isSharing: true })
    backend.joinRoom.mockResolvedValue({ ok: false, error: refused })
    await expect(joinTeam(code, endpoint, backend)).rejects.toBe(refused)
    expect(useAppStore.getState()).toMatchObject({ roomCode: '', directAddress: undefined, isHost: false, isSharing: false })
    expect(backend.listPeers).not.toHaveBeenCalled()
    backend.joinRoom.mockResolvedValue({ ok: true, data: undefined })
    await joinTeam(code, endpoint, backend)
    expect(useAppStore.getState().roomCode).toBe(code)
  })

  it('does not misreport a successful join when refreshing peers fails', async () => {
    const backend = api()
    backend.listPeers.mockRejectedValue(new Error('refresh unavailable'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(joinTeam(code, undefined, backend)).resolves.toBeUndefined()
      expect(useAppStore.getState().roomCode).toBe(code)
    } finally { log.mockRestore() }
  })

  it('retains mismatch and connection events emitted during the handshake', async () => {
    const backend = api()
    backend.joinRoom.mockImplementation(async () => {
      useAppStore.getState().setPeerStatus({ peerId: 'host', status: 'connected', attempt: 0 })
      useAppStore.getState().addIdentityMismatch({
        peerId: 'host',
        hostIdentity: { projectName: 'receiving', fingerprint: 'one' },
        guestIdentity: { projectName: 'shared', fingerprint: 'two' },
      })
      return { ok: true, data: undefined }
    })
    await joinTeam(code, endpoint, backend)
    expect(useAppStore.getState().peerStatuses.host?.status).toBe('connected')
    expect(useAppStore.getState().identityMismatches).toHaveLength(1)
  })

  it('clears direct connection state for leave/project changes but preserves the receiving choice', () => {
    useAppStore.setState({ roomCode: code, directAddress: '192.168.1.10:49500', downloadTargetDir: '/tmp/selected', isSharing: true, pendingAutoDownload: true })
    useAppStore.getState().resetTeamState()
    expect(useAppStore.getState()).toMatchObject({ roomCode: '', directAddress: undefined, isSharing: false, pendingAutoDownload: false, downloadTargetDir: '/tmp/selected' })
  })

  it('defaults downloads to the monitored project and preserves a chosen folder across remounts', () => {
    expect(initializeDownloadTarget()).toBe('/tmp/receiving')
    useAppStore.getState().setDownloadTargetDir('/tmp/explicit')
    expect(initializeDownloadTarget()).toBe('/tmp/explicit')
  })

  it('shows a downloaded copy in Projects without moving live sync or losing edits during delayed IPC', async () => {
    const downloaded = { id: 'downloaded', name: 'Downloaded', path: '/tmp/downloaded', lastOpenedAt: 1, isFavorite: false }
    useAppStore.setState({ roomCode: code, directAddress: '192.168.1.10:49500', lastDownloadPath: downloaded.path })
    let finish!: (result: IpcResult<typeof downloaded>) => void
    const backend = {
      addProject: vi.fn(() => new Promise<IpcResult<typeof downloaded>>((resolve) => { finish = resolve })),
      listProjects: vi.fn(async () => ({ ok: true as const, data: [{ ...downloaded, available: true }] })),
    }
    const showing = showDownloadedProject(downloaded.path, backend)
    useAppStore.setState({ folder: '/tmp/new-choice', dirtyFilePaths: ['src/unsaved.ts'] })
    finish({ ok: true, data: downloaded })
    await showing
    expect(backend.addProject).toHaveBeenCalledWith(downloaded.path)
    expect(useAppStore.getState()).toMatchObject({
      folder: '/tmp/new-choice', status: 'watching', roomCode: code,
      directAddress: '192.168.1.10:49500', dirtyFilePaths: ['src/unsaved.ts'],
      lastDownloadPath: downloaded.path, activeView: 'projects',
    })
  })

  it('keeps the previous live session and saved copy when project registration fails', async () => {
    useAppStore.setState({ roomCode: code, lastDownloadPath: '/tmp/downloaded' })
    const backend = {
      addProject: vi.fn(async () => ({ ok: false as const, error: refused })),
      listProjects: vi.fn(),
    }
    await expect(showDownloadedProject('/tmp/downloaded', backend)).rejects.toBe(refused)
    expect(backend.listProjects).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject({
      folder: '/tmp/receiving', roomCode: code, status: 'watching', lastDownloadPath: '/tmp/downloaded',
    })
  })
})
