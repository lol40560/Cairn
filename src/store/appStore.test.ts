import { afterEach, describe, expect, it, vi } from 'vitest'

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
    activeView: 'activity',
    locale: 'en',
    ops: [],
    peers: [],
    roomCode: '',
    isHost: false,
    pendingAutoDownload: false,
    status: 'idle',
    showDownloadPrompt: false,
    sidebarCollapsed: false,
    activityViewMode: 'grouped',
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

  it('更新房间码、队友列表和本机角色', () => {
    const peers = [{ host: '127.0.0.1', lastSeen: 1, peerId: 'peer', port: 1234 }]

    useAppStore.getState().setRoomCode('ABCDEF')
    useAppStore.getState().setPeers(peers)
    useAppStore.getState().setIsHost(true)

    expect(useAppStore.getState().roomCode).toBe('ABCDEF')
    expect(useAppStore.getState().peers).toEqual(peers)
    expect(useAppStore.getState().isHost).toBe(true)
  })

  it('切换工作区视图', () => {
    useAppStore.getState().setActiveView('room')
    expect(useAppStore.getState().activeView).toBe('room')

    useAppStore.getState().setActiveView('conflicts')
    expect(useAppStore.getState().activeView).toBe('conflicts')
  })

  it('折叠侧边栏时会保存偏好', () => {
    const storage = new Map<string, string>()
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    })

    try {
      useAppStore.getState().setSidebarCollapsed(true)

      expect(useAppStore.getState().sidebarCollapsed).toBe(true)
      expect(storage.get('cairn.sidebarCollapsed')).toBe('true')

      useAppStore.getState().setSidebarCollapsed(false)
      expect(storage.get('cairn.sidebarCollapsed')).toBe('false')
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })

  it('初始化时读取已保存的折叠偏好', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (key: string) => key === 'cairn.sidebarCollapsed' ? 'true' : null, setItem: () => undefined },
    })

    try {
      vi.resetModules()
      const { useAppStore: freshStore } = await import('./appStore')
      expect(freshStore.getState().sidebarCollapsed).toBe(true)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })

  it('切換 Activity 模式時會保存偏好', () => {
    const storage = new Map<string, string>()
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    })

    try {
      useAppStore.getState().setActivityViewMode('raw')

      expect(useAppStore.getState().activityViewMode).toBe('raw')
      expect(storage.get('cairn.activityViewMode')).toBe('raw')
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })

  it('加入团队后可等待 seeder 并控制下载确认弹窗', () => {
    useAppStore.getState().setPendingAutoDownload(true)
    expect(useAppStore.getState().pendingAutoDownload).toBe(true)

    useAppStore.getState().setShowDownloadPrompt(true)
    expect(useAppStore.getState().showDownloadPrompt).toBe(true)

    useAppStore.getState().resetDownload()
    expect(useAppStore.getState().pendingAutoDownload).toBe(false)
    expect(useAppStore.getState().showDownloadPrompt).toBe(false)
  })
})
