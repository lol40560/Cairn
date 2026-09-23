import { afterEach, describe, expect, it } from 'vitest'

import { useAppStore } from './appStore'

function createOp(index: number) {
  return {
    id: `op-${index}`,
    hash: index.toString(16).padStart(64, '0'),
    author: 'alice',
    parentHashes: [],
    timestamp: index,
    filePath: `src/${index}.ts`,
    diff: '+line',
  }
}

afterEach(() => {
  useAppStore.setState({
    folder: '',
    locale: 'en',
    ops: [],
    peers: [],
    roomCode: '',
    status: 'idle',
  })
})

describe('appStore', () => {
  it('将新 op 插入列表顶部', () => {
    const first = createOp(1)
    const second = createOp(2)

    useAppStore.getState().prependOp(first)
    useAppStore.getState().prependOp(second)

    expect(useAppStore.getState().ops).toEqual([second, first])
  })

  it('忽略重复 hash 的 op', () => {
    const op = createOp(1)

    useAppStore.getState().prependOp(op)
    useAppStore.getState().prependOp({ ...op, author: 'bob' })

    expect(useAppStore.getState().ops).toEqual([op])
  })

  it('插入超过 200 条时截断最旧记录', () => {
    for (let index = 0; index < 201; index += 1) {
      useAppStore.getState().prependOp(createOp(index))
    }

    const ops = useAppStore.getState().ops
    expect(ops).toHaveLength(200)
    expect(ops[0]?.id).toBe('op-200')
    expect(ops.at(-1)?.id).toBe('op-1')
  })

  it('replaceOps 直接替换列表', () => {
    useAppStore.getState().prependOp(createOp(1))
    const replacement = [createOp(2), createOp(3)]

    useAppStore.getState().replaceOps(replacement)

    expect(useAppStore.getState().ops).toEqual(replacement)
  })

  it('更新 folder、status 与 locale', () => {
    useAppStore.getState().setFolder('/tmp/project')
    useAppStore.getState().setStatus('watching')
    useAppStore.getState().setLocale('zh')

    expect(useAppStore.getState().folder).toBe('/tmp/project')
    expect(useAppStore.getState().status).toBe('watching')
    expect(useAppStore.getState().locale).toBe('zh')
  })

  it('更新房间码和队友列表', () => {
    const peers = [{ host: '127.0.0.1', lastSeen: 1, peerId: 'peer', port: 1234 }]

    useAppStore.getState().setRoomCode('ABCDEF')
    useAppStore.getState().setPeers(peers)

    expect(useAppStore.getState().roomCode).toBe('ABCDEF')
    expect(useAppStore.getState().peers).toEqual(peers)
  })
})
