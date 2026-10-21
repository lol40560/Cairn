import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EditClaimsManager } from './index'

const roots: string[] = []

async function manager(): Promise<EditClaimsManager> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-edit-claims-'))
  roots.push(root)
  return new EditClaimsManager(root)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('EditClaimsManager', () => {
  it('creates, renews, and completes a 10-minute edit claim', async () => {
    const claims = await manager()
    const created = await claims.create({
      baseContent: 'const ready = false\n',
      owner: { id: 'agent-a', kind: 'agent', name: 'Agent A' },
      path: 'src/ready.ts',
      summary: 'Update readiness flow',
    })

    expect(created.status).toBe('active')
    expect(created.expiresAt - created.createdAt).toBe(10 * 60 * 1000)
    const renewed = await claims.heartbeat(created.id, 'agent-a')
    expect(renewed.expiresAt).toBeGreaterThanOrEqual(created.expiresAt)

    await claims.complete(created.id, 'agent-a')
    expect((await claims.list()).find((claim) => claim.id === created.id)?.status).toBe('completed')
  })

  it('records soft conflicts but only blocks writes in strict mode', async () => {
    const claims = await manager()
    await claims.create({
      baseContent: 'export {}\n',
      owner: { id: 'agent-a', kind: 'agent', name: 'Agent A' },
      path: 'src/index.ts',
      summary: 'Refactor exports',
    })

    await expect(claims.assertWritable('src/index.ts', 'agent-b', false)).resolves.toBeUndefined()
    await expect(claims.assertWritable('src/index.ts', 'agent-b', true)).rejects.toThrow('Agent A')
    expect((await claims.listMessages()).some((message) => message.type === 'conflict')).toBe(true)
  })

  it('accepts a remote claim without marking it as a local broadcast event', async () => {
    const claims = await manager()
    const changed = vi.fn()
    claims.on('changed', changed)
    await claims.receiveRemote({
      baseHash: 'abc',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      id: 'remote-claim',
      owner: { id: 'agent-b', kind: 'agent', name: 'Agent B' },
      path: 'src/sync.ts',
      status: 'active',
      summary: 'Protect transport edits',
      updatedAt: 1,
    }, 'peer-b')

    expect((await claims.list())[0]?.owner.name).toBe('Agent B')
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'remote-claim' }), false)
  })

  it('binds remote ownership to its authenticated peer and rejects a takeover', async () => {
    const claims = await manager()
    const remoteClaim = {
      baseHash: 'abc', createdAt: 1, expiresAt: Date.now() + 60_000, id: 'claim-a',
      owner: { id: 'spoofed-owner', kind: 'agent' as const, name: 'Agent A' }, path: 'src/sync.ts',
      status: 'active' as const, summary: 'Protect transport edits', updatedAt: 1,
    }
    await claims.receiveRemote(remoteClaim, 'peer-a')
    expect((await claims.list())[0]?.owner.id).toBe('peer-a')
    await expect(claims.receiveRemote({ ...remoteClaim, updatedAt: 9 }, 'peer-b')).rejects.toThrow('cannot replace')
  })
})
