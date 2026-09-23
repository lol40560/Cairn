import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const rendererListeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const windowListeners = new Map<string, Array<() => void>>()
  const window = {
    isDestroyed: vi.fn(() => false),
    loadFile: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    once: vi.fn((event: string, listener: () => void) => {
      const listeners = windowListeners.get(event) ?? []
      listeners.push(listener)
      windowListeners.set(event, listeners)
      return window
    }),
    show: vi.fn(),
    webContents: {
      send: vi.fn(),
    },
  }
  const BrowserWindow = vi.fn(function BrowserWindow() {
    return window
  })
  Object.assign(BrowserWindow, {
    getAllWindows: vi.fn(() => []),
  })

  const makeWatcher = () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const watcher = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const eventListeners = listeners.get(event) ?? []
        eventListeners.push(listener)
        listeners.set(event, eventListeners)
        return watcher
      }),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      emit: (event: string, ...args: unknown[]): void => {
        for (const listener of listeners.get(event) ?? []) {
          listener(...args)
        }
      },
    }
    return watcher
  }

  const oplogs: Array<{ close: ReturnType<typeof vi.fn>; listRecent: ReturnType<typeof vi.fn> }> = []
  const watchers: ReturnType<typeof makeWatcher>[] = []
  const syncs: Array<ReturnType<typeof makeSync>> = []

  function makeSync() {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const sync = {
      announceLocalOp: vi.fn(),
      listPeers: vi.fn<() => unknown[]>(() => []),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const eventListeners = listeners.get(event) ?? []
        eventListeners.push(listener)
        listeners.set(event, eventListeners)
        return sync
      }),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      emit: (event: string, ...args: unknown[]): void => {
        for (const listener of listeners.get(event) ?? []) {
          listener(...args)
        }
      },
    }
    return sync
  }

  return {
    BrowserWindow,
    app: {
      getPath: vi.fn(() => '/tmp'),
      on: vi.fn(),
      quit: vi.fn(),
      setName: vi.fn(),
      whenReady: vi.fn(() => new Promise<void>(() => undefined)),
    },
    contextBridge: {
      exposeInMainWorld: vi.fn(),
    },
    createOplog: vi.fn(() => {
      const oplog = {
        close: vi.fn(),
        listRecent: vi.fn(() => []),
      }
      oplogs.push(oplog)
      return oplog
    }),
    dialog: {
      showOpenDialog: vi.fn(),
    },
    safeStorage: {
      decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
      encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
      isEncryptionAvailable: vi.fn(() => true),
    },
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }),
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        const listeners = rendererListeners.get(channel) ?? []
        listeners.push(listener)
        rendererListeners.set(channel, listeners)
      }),
      removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        const listeners = rendererListeners.get(channel) ?? []
        rendererListeners.set(
          channel,
          listeners.filter((registered) => registered !== listener),
        )
      }),
    },
    oplogs,
    createShadowGit: vi.fn(() => ({
      close: vi.fn(),
      commitOp: vi.fn(async () => undefined),
      init: vi.fn(async () => undefined),
    })),
    exportPR: vi.fn(),
    rendererListeners,
    syncs,
    watchers,
    window,
    windowListeners,
    makeWatcher,
    makeSync,
  }
})

vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => ({ close: vi.fn(), exec: vi.fn() })),
}))

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  contextBridge: mocks.contextBridge,
  dialog: mocks.dialog,
  ipcMain: mocks.ipcMain,
  ipcRenderer: mocks.ipcRenderer,
  safeStorage: mocks.safeStorage,
}))

vi.mock('./core/oplog', () => ({
  createOplog: mocks.createOplog,
}))

vi.mock('./core/watcher', () => ({
  ProjectWatcher: class {
    constructor() {
      const watcher = mocks.makeWatcher()
      mocks.watchers.push(watcher)
      return watcher
    }
  },
}))

vi.mock('./core/sync', () => ({
  Sync: class {
    constructor() {
      const sync = mocks.makeSync()
      mocks.syncs.push(sync)
      return sync
    }
  },
}))

vi.mock('./core/git', () => ({
  createShadowGit: mocks.createShadowGit,
  exportPR: mocks.exportPR,
}))

let currentMain: typeof import('./main') | undefined
const roots: string[] = []

async function createDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-ipc-'))
  roots.push(root)
  return root
}

async function loadMain(): Promise<typeof import('./main')> {
  vi.resetModules()
  currentMain = await import('./main')
  return currentMain
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.rendererListeners.clear()
  mocks.windowListeners.clear()
  mocks.watchers.splice(0)
  mocks.syncs.splice(0)
  mocks.oplogs.splice(0)
  mocks.window.isDestroyed.mockReturnValue(false)
  mocks.window.loadFile.mockClear()
  mocks.window.loadURL.mockClear()
  mocks.window.once.mockClear()
  mocks.window.show.mockClear()
  mocks.window.webContents.send.mockClear()
  mocks.contextBridge.exposeInMainWorld.mockClear()
  mocks.createOplog.mockClear()
  mocks.createShadowGit.mockClear()
  mocks.dialog.showOpenDialog.mockReset()
  mocks.ipcMain.handle.mockClear()
  mocks.ipcRenderer.invoke.mockClear()
  mocks.ipcRenderer.on.mockClear()
  mocks.ipcRenderer.removeListener.mockClear()
  mocks.exportPR.mockClear()
  mocks.safeStorage.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
  mocks.safeStorage.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf8'))
  mocks.safeStorage.isEncryptionAvailable.mockReturnValue(true)
  mocks.app.getPath.mockReturnValue(tmpdir())
})

afterEach(async () => {
  await currentMain?.stopWatching()
  currentMain = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('IPC bridge', () => {
  it('lastSession 与 settings 可读写往返，损坏文件回退默认值', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    mocks.app.getPath.mockReturnValue(root)
    const session = { folder: '/project', updatedAt: 123, watching: true }

    await main.writeLastSession(session)
    await main.updateSettings({ autoStartWatching: false })

    expect(await main.readLastSession()).toEqual(session)
    expect(await main.getSettings()).toEqual({
      autoStartWatching: false,
      rememberLastFolder: true,
    })

    await writeFile(join(root, 'last-session.json'), '{invalid json', 'utf8')
    await writeFile(join(root, 'settings.json'), '{invalid json', 'utf8')

    expect(await main.readLastSession()).toEqual({ folder: '', updatedAt: 0, watching: false })
    expect(await main.getSettings()).toEqual({ autoStartWatching: true, rememberLastFolder: true })
  })

  it('checkFolder 只接受存在的绝对目录', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    const file = join(root, 'file.ts')
    await writeFile(file, 'export {}\n', 'utf8')

    await expect(main.checkFolder(root)).resolves.toBe(true)
    await expect(main.checkFolder(join(root, 'missing'))).resolves.toBe(false)
    await expect(main.checkFolder(file)).resolves.toBe(false)
  })

  it('选择、开始与停止监控会更新 lastSession', async () => {
    const main = await loadMain()
    const projectRoot = await createDirectory()
    const configRoot = await createDirectory()
    mocks.app.getPath.mockReturnValue(configRoot)
    mocks.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [projectRoot] })

    await expect(main.selectFolder()).resolves.toBe(projectRoot)
    expect(await main.readLastSession()).toMatchObject({ folder: projectRoot })

    await main.startWatching(projectRoot)
    expect(await main.readLastSession()).toMatchObject({ folder: projectRoot, watching: true })

    await main.stopWatching()
    expect(await main.readLastSession()).toMatchObject({ folder: projectRoot, watching: false })
  })

  it('拒绝含中文或格式错误的 GitHub token 与非法仓库标识', async () => {
    const main = await loadMain()

    expect(() => main.validateGithubToken('ghp_已保存')).toThrow('token 格式不正确')
    expect(() => main.validateGithubToken('not-a-token')).toThrow('token 格式不正确')
    expect(() => main.validateGithubRepository('用户', 'repo')).toThrow('Owner 和 Repository 格式不正确')
  })

  it('saveGithubConfig 拒绝含中文或格式错误的 token 和非法 owner', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    mocks.app.getPath.mockReturnValue(root)
    const validToken = `ghp_${'a'.repeat(36)}`

    await expect(
      main.saveGithubConfig({ token: 'ghp_已保存', owner: 'cairn', repo: 'app' }),
    ).rejects.toThrow('token 格式不正确，请重新从 GitHub 复制')
    await expect(
      main.saveGithubConfig({ token: 'not-a-token', owner: 'cairn', repo: 'app' }),
    ).rejects.toThrow('token 格式不正确，请重新从 GitHub 复制')
    await expect(
      main.saveGithubConfig({ token: validToken, owner: '用户', repo: 'app' }),
    ).rejects.toThrow('Owner 和 Repository 格式不正确')
  })

  it('exportPR 在 token 非法时不调用 GitHub 客户端', async () => {
    const main = await loadMain()
    const projectRoot = await createDirectory()
    const configRoot = await createDirectory()
    mocks.app.getPath.mockReturnValue(configRoot)
    await main.startWatching(projectRoot)
    await writeFile(
      join(configRoot, 'github-config.json'),
      JSON.stringify({ owner: 'cairn', repo: 'app' }),
    )
    await writeFile(join(configRoot, 'github-token.bin'), 'ghp_已保存')

    await expect(
      main.exportProjectPR({ branch: 'main', prBranch: 'cairn/test', title: 'Test PR' }),
    ).rejects.toThrow('token 格式不正确，请重新从 GitHub 复制')
    expect(mocks.exportPR).not.toHaveBeenCalled()
  })

  it('resetGithubConfig 清除安全 token 与仓库配置', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    mocks.app.getPath.mockReturnValue(root)

    await main.saveGithubConfig({
      token: `ghp_${'a'.repeat(36)}`,
      owner: 'cairn',
      repo: 'app',
    })
    expect(await main.getGithubConfig()).toEqual({
      hasToken: true,
      owner: 'cairn',
      repo: 'app',
    })

    await main.resetGithubConfig()

    expect(await main.getGithubConfig()).toEqual({ hasToken: false, owner: '', repo: '' })
  })

  it('选择目录取消时返回空字符串且不改变已有项目', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    await main.startWatching(root)
    mocks.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

    await expect(main.selectFolder()).resolves.toBe('')
    expect(mocks.watchers[0]?.stop).not.toHaveBeenCalled()
  })

  it('选择目录只返回路径，不会自动开始监控', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    mocks.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [root] })

    main.registerIpcHandlers()

    await expect(main.selectFolder()).resolves.toBe(root)
    expect(mocks.watchers).toHaveLength(0)
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'cairn:checkFolder',
      'cairn:clearGithubConfig',
      'cairn:clearLastSession',
      'cairn:createRoom',
      'cairn:exportPR',
      'cairn:getGithubConfig',
      'cairn:getLastSession',
      'cairn:getSettings',
      'cairn:joinRoom',
      'cairn:leaveRoom',
      'cairn:listPeers',
      'cairn:listRecentOps',
      'cairn:resetGithubConfig',
      'cairn:saveGithubConfig',
      'cairn:selectFolder',
      'cairn:startWatching',
      'cairn:stopWatching',
      'cairn:updateSettings',
    ])
  })

  it('切换目录时先停止旧 watcher 并关闭旧 oplog', async () => {
    const main = await loadMain()
    const firstRoot = await createDirectory()
    const secondRoot = await createDirectory()
    await main.startWatching(firstRoot)
    const firstWatcher = mocks.watchers[0]
    const firstOplog = mocks.oplogs[0]

    await main.startWatching(secondRoot)

    expect(firstWatcher?.stop).toHaveBeenCalledOnce()
    expect(firstOplog?.close).toHaveBeenCalledOnce()
    expect(mocks.watchers).toHaveLength(2)
  })

  it('拒绝相对项目路径', async () => {
    const main = await loadMain()

    await expect(main.startWatching('relative/path')).rejects.toThrow(/绝对路径/)
  })

  it('拒绝不存在的项目路径', async () => {
    const main = await loadMain()
    const root = await createDirectory()

    await expect(main.startWatching(join(root, 'missing'))).rejects.toThrow(/不存在/)
  })

  it('拒绝文件路径', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    const file = join(root, 'file.ts')
    await writeFile(file, 'export {}\n', 'utf8')

    await expect(main.startWatching(file)).rejects.toThrow(/必须是目录/)
  })

  it('listRecentOps 转发合法 limit 并拒绝越界值', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    await main.startWatching(root)
    const oplog = mocks.oplogs[0]

    await main.listRecentOps(3)

    expect(oplog?.listRecent).toHaveBeenCalledWith(3)
    await expect(main.listRecentOps(0)).rejects.toThrow(/1\.\.200/)
    await expect(main.listRecentOps(201)).rejects.toThrow(/1\.\.200/)
  })

  it('stopWatching 释放活动 watcher 和 oplog', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    await main.startWatching(root)
    const watcher = mocks.watchers[0]
    const oplog = mocks.oplogs[0]

    await main.stopWatching()

    expect(watcher?.stop).toHaveBeenCalledOnce()
    expect(oplog?.close).toHaveBeenCalledOnce()
    await expect(main.listRecentOps(1)).resolves.toEqual([])
  })

  it('watcher op 事件通过指定频道发送到窗口', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    main.createWindow()
    await main.startWatching(root)
    const op = {
      id: 'op-1',
      hash: 'a'.repeat(64),
      author: 'alice',
      parentHashes: [],
      timestamp: 1,
      filePath: 'src/a.ts',
      diff: '+a',
    }

    mocks.watchers[0]?.emit('op', op)

    expect(mocks.window.webContents.send).toHaveBeenCalledWith('cairn:op', op)
  })

  it('窗口销毁后不再发送 op', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    main.createWindow()
    await main.startWatching(root)
    for (const listener of mocks.windowListeners.get('closed') ?? []) {
      listener()
    }

    mocks.watchers[0]?.emit('op', {
      id: 'op-2',
      hash: 'b'.repeat(64),
      author: 'alice',
      parentHashes: [],
      timestamp: 2,
      filePath: 'src/b.ts',
      diff: '+b',
    })

    expect(mocks.window.webContents.send).not.toHaveBeenCalled()
  })

  it('preload 只暴露契约中的十一个 API', async () => {
    vi.resetModules()
    await import('./preload')

    const exposed = mocks.contextBridge.exposeInMainWorld.mock.calls[0]
    expect(exposed?.[0]).toBe('cairn')
    expect(Object.keys(exposed?.[1] as object).sort()).toEqual([
      'checkFolder',
      'clearGithubConfig',
      'clearLastSession',
      'createRoom',
      'exportPR',
      'getGithubConfig',
      'getLastSession',
      'getSettings',
      'joinRoom',
      'leaveRoom',
      'listPeers',
      'listRecentOps',
      'onConflict',
      'onOp',
      'onPeers',
      'resetGithubConfig',
      'saveGithubConfig',
      'selectFolder',
      'startWatching',
      'stopWatching',
      'updateSettings',
    ])
    expect(Object.values(exposed?.[1] as object)).not.toContain(mocks.ipcRenderer)
  })

  it('preload onOp 返回取消订阅函数', async () => {
    vi.resetModules()
    await import('./preload')
    const api = mocks.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as {
      onOp(callback: (op: { id: string }) => void): () => void
    }
    const callback = vi.fn()
    const unsubscribe = api.onOp(callback)
    for (const listener of mocks.rendererListeners.get('cairn:op') ?? []) {
      listener({}, { id: 'op-1' })
    }
    unsubscribe()
    for (const listener of mocks.rendererListeners.get('cairn:op') ?? []) {
      listener({}, { id: 'op-2' })
    }

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({ id: 'op-1' })
  })

  it('preload 将 IPC result 原样返回给渲染进程', async () => {
    vi.resetModules()
    await import('./preload')
    const api = mocks.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as {
      selectFolder(): Promise<{ data: string; ok: true }>
    }
    mocks.ipcRenderer.invoke.mockResolvedValueOnce({ data: '/project', ok: true })

    await expect(api.selectFolder()).resolves.toEqual({ data: '/project', ok: true })
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('cairn:selectFolder')
  })

  it('preload onConflict 返回取消订阅函数', async () => {
    vi.resetModules()
    await import('./preload')
    const api = mocks.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as {
      onConflict(callback: (payload: { source: string }) => void): () => void
    }
    const callback = vi.fn()
    const unsubscribe = api.onConflict(callback)
    for (const listener of mocks.rendererListeners.get('cairn:conflict') ?? []) {
      listener({}, { source: 'remote' })
    }
    unsubscribe()
    for (const listener of mocks.rendererListeners.get('cairn:conflict') ?? []) {
      listener({}, { source: 'remote' })
    }

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({ source: 'remote' })
  })

  it('创建房间会生成合规房间码并在切换时停止旧 sync', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    await main.startWatching(root)

    const firstRoom = await main.createRoom()
    const firstSync = mocks.syncs[0]
    const secondRoom = await main.createRoom()

    expect(firstRoom).toMatch(/^[2-9A-HJ-NP-Z]{6}$/)
    expect(secondRoom).toMatch(/^[2-9A-HJ-NP-Z]{6}$/)
    expect(firstSync?.stop).toHaveBeenCalledOnce()
    expect(mocks.syncs).toHaveLength(2)
  })

  it('joinRoom 校验房间码并可列出及离开 peer', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    await main.startWatching(root)

    await expect(main.joinRoom('O0I1ZZ')).rejects.toThrow(/房间码/)
    await main.joinRoom('ABCDEF')
    const sync = mocks.syncs[0]
    sync?.listPeers.mockReturnValue([
      { host: '127.0.0.1', lastSeen: 1, peerId: 'peer', port: 1234 },
    ])

    expect(main.listPeers()).toEqual([
      { host: '127.0.0.1', lastSeen: 1, peerId: 'peer', port: 1234 },
    ])
    await main.leaveRoom()
    expect(sync?.stop).toHaveBeenCalledOnce()
    expect(main.listPeers()).toEqual([])
  })

  it('peer 变化会通过指定频道发送', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    main.createWindow()
    await main.startWatching(root)
    await main.createRoom()
    const sync = mocks.syncs[0]

    sync?.emit('peerJoined', { host: '127.0.0.1', lastSeen: 1, peerId: 'peer', port: 1234 })

    expect(mocks.window.webContents.send).toHaveBeenCalledWith('cairn:peers', [])
  })

  it('本地 op 通知活动 Sync，远端 op 与冲突转发到窗口', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    main.createWindow()
    await main.startWatching(root)
    await main.createRoom()
    const sync = mocks.syncs[0]
    const op = {
      id: 'remote-op',
      hash: 'c'.repeat(64),
      author: 'bob',
      parentHashes: [],
      timestamp: 3,
      filePath: 'src/remote.ts',
      diff: '+remote',
      source: 'remote' as const,
    }

    mocks.watchers[0]?.emit('op', { ...op, source: 'local' })
    sync?.emit('remoteOp', op)
    sync?.emit('conflict', op, 'local content')

    expect(sync?.announceLocalOp).toHaveBeenCalledWith({ ...op, source: 'local' })
    expect(mocks.window.webContents.send).toHaveBeenCalledWith('cairn:op', op)
    expect(mocks.window.webContents.send).toHaveBeenCalledWith('cairn:conflict', {
      localContent: 'local content',
      op,
      source: 'remote',
    })
  })
})
