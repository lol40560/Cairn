import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
      start: vi.fn(() => watcherStart()),
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
  const watcherStart = vi.fn(async () => undefined)

  function makeSync() {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const sync = {
      announceLocalOp: vi.fn(),
      broadcast: vi.fn(),
      connectToAddress: vi.fn(async () => undefined),
      getPeerId: vi.fn(() => 'local-peer'),
      getLocalPort: vi.fn(() => 49500),
      listPeers: vi.fn<() => unknown[]>(() => []),
      listSeeders: vi.fn<() => unknown[]>(() => []),
      registerDownloader: vi.fn(),
      registerSeeder: vi.fn(),
      send: vi.fn(),
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
      showSaveDialog: vi.fn(),
    },
    clipboard: {
      writeText: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => ''),
      showItemInFolder: vi.fn(),
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
    watcherStart,
  }
})

vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => ({ close: vi.fn(), exec: vi.fn() })),
}))

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  clipboard: mocks.clipboard,
  contextBridge: mocks.contextBridge,
  dialog: mocks.dialog,
  ipcMain: mocks.ipcMain,
  ipcRenderer: mocks.ipcRenderer,
  safeStorage: mocks.safeStorage,
  shell: mocks.shell,
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
  SnapshotDownloader: class {
    cancel(): void {}
    async startDownload(): Promise<never> {
      throw new Error('测试未配置下载器')
    }
  },
  SnapshotSeeder: class {
    stop(): void {}
    async start(): Promise<never> {
      throw new Error('测试未配置 seeder')
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
  mocks.watcherStart.mockReset()
  mocks.watcherStart.mockResolvedValue(undefined)
  mocks.shell.openPath.mockClear()
  mocks.shell.openPath.mockResolvedValue('')
  mocks.shell.showItemInFolder.mockClear()
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
      trashRetentionDays: 30,
    })

    await writeFile(join(root, 'last-session.json'), '{invalid json', 'utf8')
    await writeFile(join(root, 'settings.json'), '{invalid json', 'utf8')

    expect(await main.readLastSession()).toEqual({ folder: '', updatedAt: 0, watching: false })
    expect(await main.getSettings()).toEqual({ autoStartWatching: true, rememberLastFolder: true, trashRetentionDays: 30 })
  })

  it('首次引导状态缺失时未完成，完成后可读回并可重新开启', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    mocks.app.getPath.mockReturnValue(root)

    await expect(main.readOnboarding()).resolves.toEqual({ completed: false })
    await main.completeOnboarding()
    await expect(main.readOnboarding()).resolves.toMatchObject({ completed: true, completedAt: expect.any(Number) })
    await main.resetOnboarding()
    await expect(main.readOnboarding()).resolves.toEqual({ completed: false })
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

  it('文件浏览只列出项目内文本文件，并跳过内部、敏感与二进制文件', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, '.cairn'), { recursive: true })
    await writeFile(join(root, 'src', 'visible.ts'), 'export const visible = true\n', 'utf8')
    await writeFile(join(root, '.env'), 'TOKEN=secret\n', 'utf8')
    await writeFile(join(root, 'image.png'), Buffer.from([0, 1, 2]))
    await writeFile(join(root, '.cairn', 'internal.md'), 'internal\n', 'utf8')
    await main.startWatching(root)

    await expect(main.listProjectFiles()).resolves.toEqual({
      files: [expect.objectContaining({ name: 'visible.ts', path: 'src/visible.ts' })],
      truncated: false,
    })
  })

  it('文件浏览在超过上限时截断，并拒绝越界、符号链接和过大的读取请求', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    const outside = await createDirectory()
    await main.startWatching(root)
    for (let index = 0; index <= 5_000; index += 1) {
      await writeFile(join(root, `file-${index}.txt`), 'text\n', 'utf8')
    }
    await writeFile(join(root, 'large.txt'), 'a'.repeat(1_024 * 1_024 + 1), 'utf8')
    await writeFile(join(outside, 'outside.txt'), 'private\n', 'utf8')
    await symlink(join(outside, 'outside.txt'), join(root, 'linked.txt'))

    const listed = await main.listProjectFiles()
    expect(listed.files).toHaveLength(5_000)
    expect(listed.truncated).toBe(true)
    await expect(main.readProjectFile('../../outside.txt')).rejects.toThrow(/项目内/)
    await expect(main.readProjectFile('linked.txt')).rejects.toThrow(/符号链接/)
    await expect(main.readProjectFile('large.txt')).rejects.toThrow('File too large to display')
  })

  it('readProjectFile 返回只读预览所需的内容与元数据', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    await writeFile(join(root, 'README.md'), '# Cairn\n', 'utf8')
    await main.startWatching(root)

    await expect(main.readProjectFile('README.md')).resolves.toMatchObject({
      content: '# Cairn\n',
      path: 'README.md',
      size: 8,
    })
  })

  it('saveProjectFile 只保存项目内、大小受限的普通文本文件', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    await writeFile(join(root, 'README.md'), '# Before\n', 'utf8')
    await writeFile(join(root, '.env'), 'TOKEN=secret\n', 'utf8')
    await main.startWatching(root)

    await expect(main.saveProjectFile('README.md', '# After\n')).resolves.toMatchObject({
      saved: true,
      mtime: expect.any(Number),
    })
    await expect(readFile(join(root, 'README.md'), 'utf8')).resolves.toBe('# After\n')
    await expect(main.saveProjectFile('../outside.md', 'nope')).rejects.toThrow(/项目内/)
    await expect(main.saveProjectFile('.env', 'TOKEN=changed')).rejects.toThrow(/不能在 Cairn 中保存/)
    await expect(main.saveProjectFile('README.md', 'a'.repeat(1_024 * 1_024 + 1))).rejects.toThrow(
      'File too large to save',
    )
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

  it('开始监控成功后会登记并设为当前项目', async () => {
    const main = await loadMain()
    const projectRoot = await createDirectory()
    const configRoot = await createDirectory()
    mocks.app.getPath.mockReturnValue(configRoot)

    await main.startWatching(projectRoot)

    await expect(main.listProjects()).resolves.toMatchObject([
      { name: projectRoot.split('/').at(-1), path: projectRoot, available: true },
    ])
    await expect(main.getActiveProject()).resolves.toMatchObject({ path: projectRoot })
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
      'cairn:addProject',
      'cairn:cancelDownload',
      'cairn:checkFolder',
      'cairn:checkProjectAvailability',
      'cairn:clearGithubConfig',
      'cairn:clearLastSession',
      'cairn:completeOnboarding',
      'cairn:connectToAddress',
      'cairn:copyToClipboard',
      'cairn:createRoom',
      'cairn:deleteConflict',
      'cairn:downloadProject',
      'cairn:emptyTrash',
      'cairn:exportPR',
      'cairn:exportSnapshot',
      'cairn:getActiveProject',
      'cairn:getConflict',
      'cairn:getDefaultDownloadDir',
      'cairn:getDiscoveryStatus',
      'cairn:getGithubConfig',
      'cairn:getLastSession',
      'cairn:getLocalEndpoint',
      'cairn:getOnboardingState',
      'cairn:getProjectIdentity',
      'cairn:getSettings',
      'cairn:getTrashRetentionDays',
      'cairn:joinRoom',
      'cairn:leaveRoom',
      'cairn:listConflicts',
      'cairn:listPeers',
      'cairn:listProjectFiles',
      'cairn:listProjects',
      'cairn:listRecentOps',
      'cairn:listSeeders',
      'cairn:listTrash',
      'cairn:openExternal',
      'cairn:openInFileManager',
      'cairn:purgeFromTrash',
      'cairn:readProjectFile',
      'cairn:removeProject',
      'cairn:resetGithubConfig',
      'cairn:resetOnboarding',
      'cairn:resolveConflict',
      'cairn:restoreFromTrash',
      'cairn:saveGithubConfig',
      'cairn:saveProjectFile',
      'cairn:selectDownloadFolder',
      'cairn:selectFolder',
      'cairn:setActiveProject',
      'cairn:setTrashRetentionDays',
      'cairn:startSharing',
      'cairn:startWatching',
      'cairn:stopSharing',
      'cairn:stopWatching',
      'cairn:updateSettings',
    ])
  })

  it('取消下载在没有活动 downloader 时静默返回', async () => {
    const main = await loadMain()
    main.registerIpcHandlers()
    const handler = mocks.handlers.get('cairn:cancelDownload')

    await expect(handler?.({})).resolves.toEqual({ data: undefined, ok: true })
  })

  it('About 外部链接仅允许 HTTPS 地址', async () => {
    const main = await loadMain()

    await main.openExternal('https://github.com/lol40560/Cairn')
    await expect(main.openExternal('file:///tmp/private')).rejects.toThrow('仅支持打开 HTTPS 链接')

    expect(mocks.shell.openExternal).toHaveBeenCalledWith('https://github.com/lol40560/Cairn')
  })

  it('没有活动 sync 时直连端点为空，连接请求会转发给 sync', async () => {
    const main = await loadMain()
    expect(main.getLocalEndpoint()).toBeUndefined()

    const projectRoot = await createDirectory()
    await main.startWatching(projectRoot)
    const roomCode = await main.createRoom()
    main.registerIpcHandlers()
    const handler = mocks.handlers.get('cairn:connectToAddress')

    await expect(handler?.({}, { host: '192.168.1.10', port: 49500, roomCode })).resolves.toEqual({ data: undefined, ok: true })
    expect(mocks.syncs[0]?.connectToAddress).toHaveBeenCalledWith('192.168.1.10', 49500, roomCode)
    expect(main.getLocalEndpoint()).toMatchObject({ port: 49500 })
  })

  it('openInFileManager 会打开目录、定位文件并拒绝不存在的路径', async () => {
    const main = await loadMain()
    const directory = await createDirectory()
    const file = join(directory, 'sample.ts')
    await writeFile(file, 'export {}\n', 'utf8')

    await expect(main.openInFileManager(directory)).resolves.toBeUndefined()
    expect(mocks.shell.openPath).toHaveBeenCalledWith(directory)

    await expect(main.openInFileManager(file)).resolves.toBeUndefined()
    expect(mocks.shell.showItemInFolder).toHaveBeenCalledWith(file)
    await expect(main.openInFileManager(join(directory, 'missing'))).rejects.toThrow('路径不存在')
  })

  it('选择下载目录不污染上次项目会话', async () => {
    const main = await loadMain()
    const dataRoot = await createDirectory()
    const selectedRoot = await createDirectory()
    mocks.app.getPath.mockReturnValue(dataRoot)
    await main.writeLastSession({ folder: '/existing-project', watching: true, updatedAt: 1 })
    main.registerIpcHandlers()
    const handler = mocks.handlers.get('cairn:selectDownloadFolder')

    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(handler?.({})).resolves.toEqual({ data: '', ok: true })
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [selectedRoot] })
    await expect(handler?.({})).resolves.toEqual({ data: selectedRoot, ok: true })
    expect(await main.readLastSession()).toEqual({ folder: '/existing-project', watching: true, updatedAt: 1 })
    expect(mocks.dialog.showOpenDialog).toHaveBeenLastCalledWith({
      properties: ['openDirectory', 'createDirectory'],
    })
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

  it('并发启动同一目录时只保留一个 watcher', async () => {
    const main = await loadMain()
    const root = await createDirectory()

    await Promise.all([main.startWatching(root), main.startWatching(root)])

    expect(mocks.watchers).toHaveLength(1)
    expect(mocks.watchers[0]?.start).toHaveBeenCalledOnce()
    expect(mocks.watchers[0]?.stop).not.toHaveBeenCalled()
  })

  it('启动中调用 stopWatching 会在启动完成后释放 watcher', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    let resolveStart: (() => void) | undefined
    mocks.watcherStart.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      resolveStart = () => resolve(undefined)
    }))

    const starting = main.startWatching(root)
    await vi.waitFor(() => expect(mocks.watchers).toHaveLength(1))
    const stopping = main.stopWatching()
    resolveStart?.()
    await Promise.all([starting, stopping])

    expect(mocks.watchers[0]?.stop).toHaveBeenCalledOnce()
    await expect(main.listRecentOps(1)).resolves.toEqual([])
  })

  it('启动失败后会清理锁，后续请求仍可启动', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    mocks.watcherStart.mockRejectedValueOnce(new Error('启动失败'))

    await expect(main.startWatching(root)).rejects.toThrow('启动失败')
    await expect(main.startWatching(root)).resolves.toBeUndefined()

    expect(mocks.watchers).toHaveLength(2)
    expect(mocks.watchers[1]?.start).toHaveBeenCalledOnce()
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

  it('countFiles 在到达上限时提前返回，并忽略内部目录', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    await mkdir(join(root, '.cairn'), { recursive: true })
    await Promise.all([
      writeFile(join(root, 'first.ts'), 'export {}\n', 'utf8'),
      writeFile(join(root, 'second.ts'), 'export {}\n', 'utf8'),
      writeFile(join(root, 'third.ts'), 'export {}\n', 'utf8'),
      writeFile(join(root, '.cairn', 'internal.db'), 'internal', 'utf8'),
    ])

    await expect(main.countFiles(root, 2)).resolves.toBe(2)
    await expect(main.countFiles(root, 10)).resolves.toBe(3)
  })

  it('startWatching 拒绝超过文件上限的目录', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    await Promise.all([
      writeFile(join(root, 'first.txt'), 'x', 'utf8'),
      writeFile(join(root, 'second.txt'), 'x', 'utf8'),
      writeFile(join(root, 'third.txt'), 'x', 'utf8'),
    ])

    await expect(main.startWatching(root, 3)).rejects.toThrow(/超过 3 个文件/)
    expect(mocks.watchers).toHaveLength(0)
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

  it('废纸篓 IPC 可列出、恢复、永久删除和清空条目', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    const source = join(root, 'deleted.ts')
    await writeFile(source, 'recover me', 'utf8')
    await main.startWatching(root)
    const projectTrash = new (await import('./core/trash')).TrashManager(root)
    const trashId = await projectTrash.moveToTrash('deleted.ts', source, 'tester', 'a'.repeat(64))

    main.registerIpcHandlers()
    const list = mocks.handlers.get('cairn:listTrash')
    const restore = mocks.handlers.get('cairn:restoreFromTrash')
    const purge = mocks.handlers.get('cairn:purgeFromTrash')
    const empty = mocks.handlers.get('cairn:emptyTrash')
    await expect(list?.({})).resolves.toMatchObject({ ok: true, data: [expect.objectContaining({ trashId })] })
    await expect(restore?.({}, trashId)).resolves.toEqual({ data: undefined, ok: true })
    await expect(projectTrash.list()).resolves.toEqual([])

    const purgeId = await projectTrash.moveToTrash('deleted.ts', source, 'tester', 'b'.repeat(64))
    await expect(purge?.({}, purgeId)).resolves.toEqual({ data: undefined, ok: true })
    const emptySource = join(root, 'another.ts')
    await writeFile(emptySource, 'empty me', 'utf8')
    await projectTrash.moveToTrash('another.ts', emptySource, 'tester', 'c'.repeat(64))
    await expect(empty?.({})).resolves.toEqual({ data: undefined, ok: true })
    await expect(projectTrash.list()).resolves.toEqual([])
  })

  it('未打开项目时废纸篓 IPC 返回空值或静默成功', async () => {
    const main = await loadMain()
    main.registerIpcHandlers()

    const list = mocks.handlers.get('cairn:listTrash')
    const restore = mocks.handlers.get('cairn:restoreFromTrash')
    const purge = mocks.handlers.get('cairn:purgeFromTrash')
    const empty = mocks.handlers.get('cairn:emptyTrash')

    await expect(list?.({})).resolves.toEqual({ ok: true, data: [] })
    await expect(restore?.({}, 'missing-entry')).resolves.toEqual({ ok: true, data: undefined })
    await expect(purge?.({}, 'missing-entry')).resolves.toEqual({ ok: true, data: undefined })
    await expect(empty?.({})).resolves.toEqual({ ok: true, data: undefined })
  })

  it('废纸篓保留天数可读写，并拒绝范围外数值', async () => {
    const main = await loadMain()
    await main.setTrashRetentionDays(7)
    await expect(main.getTrashRetentionDays()).resolves.toBe(7)
    await expect(main.setTrashRetentionDays(0)).rejects.toThrow(/1\.\.365/)
    await expect(main.setTrashRetentionDays(366)).rejects.toThrow(/1\.\.365/)
  })

  it('冲突 IPC 可列出、读取、解决和删除记录', async () => {
    const main = await loadMain()
    const root = await createDirectory()
    await main.startWatching(root)
    const { ConflictsManager } = await import('./core/conflicts')
    const manager = new ConflictsManager(root)
    const opHash = 'd'.repeat(64)
    await manager.save({
      author: 'alice', filePath: 'src/file.ts', localContent: 'local',
      opHash, remoteContent: 'remote', timestamp: Date.now(),
    })
    main.registerIpcHandlers()
    const list = mocks.handlers.get('cairn:listConflicts')
    const get = mocks.handlers.get('cairn:getConflict')
    const resolve = mocks.handlers.get('cairn:resolveConflict')
    const remove = mocks.handlers.get('cairn:deleteConflict')

    await expect(list?.({})).resolves.toMatchObject({ ok: true, data: [expect.objectContaining({ opHash })] })
    await expect(get?.({}, opHash)).resolves.toMatchObject({ ok: true, data: { opHash } })
    await expect(resolve?.({}, opHash, 'local')).resolves.toEqual({ ok: true, data: undefined })
    await expect(remove?.({}, opHash)).resolves.toEqual({ ok: true, data: undefined })
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

  it('preload 只暴露契约白名单 API', async () => {
    vi.resetModules()
    await import('./preload')

    const exposed = mocks.contextBridge.exposeInMainWorld.mock.calls[0]
    expect(exposed?.[0]).toBe('cairn')
    expect(Object.keys(exposed?.[1] as object).sort()).toEqual([
      'addProject',
      'cancelDownload',
      'checkFolder',
      'checkProjectAvailability',
      'clearGithubConfig',
      'clearLastSession',
      'completeOnboarding',
      'connectToAddress',
      'copyToClipboard',
      'createRoom',
      'deleteConflict',
      'downloadProject',
      'emptyTrash',
      'exportPR',
      'exportSnapshot',
      'getActiveProject',
      'getConflict',
      'getDefaultDownloadDir',
      'getDiscoveryStatus',
      'getGithubConfig',
      'getLastSession',
      'getLocalEndpoint',
      'getOnboardingState',
      'getProjectIdentity',
      'getSettings',
      'getTrashRetentionDays',
      'joinRoom',
      'leaveRoom',
      'listConflicts',
      'listPeers',
      'listProjectFiles',
      'listProjects',
      'listRecentOps',
      'listSeeders',
      'listTrash',
      'onConflict',
      'onDownloadProgress',
      'onIdentityMismatch',
      'onOp',
      'onPeers',
      'openExternal',
      'openInFileManager',
      'purgeFromTrash',
      'readProjectFile',
      'removeProject',
      'resetGithubConfig',
      'resetOnboarding',
      'resolveConflict',
      'restoreFromTrash',
      'saveGithubConfig',
      'saveProjectFile',
      'selectDownloadFolder',
      'selectFolder',
      'setActiveProject',
      'setTrashRetentionDays',
      'startSharing',
      'startWatching',
      'stopSharing',
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
    const conflict = {
      author: 'bob', filePath: op.filePath, localContent: 'local content',
      opHash: op.hash, remoteContent: 'remote content', timestamp: 4,
    }
    sync?.emit('conflictRecord', conflict)

    expect(sync?.announceLocalOp).toHaveBeenCalledWith({ ...op, source: 'local' })
    expect(mocks.window.webContents.send).toHaveBeenCalledWith('cairn:op', op)
    expect(mocks.window.webContents.send).toHaveBeenCalledWith('cairn:conflict', conflict)
  })
})
