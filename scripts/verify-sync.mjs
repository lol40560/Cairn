import { build } from 'esbuild'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = resolve(dirname(scriptPath), '..')

if (process.env.CAIRN_VERIFY_COMPILED !== 'true') {
  const bundlePath = join(projectRoot, 'scripts', `.verify-sync-bundle-${process.pid}.mjs`)

  try {
    await build({
      absWorkingDir: projectRoot,
      bundle: true,
      define: { 'process.env.CAIRN_VERIFY_COMPILED': '"true"' },
      entryPoints: [scriptPath],
      format: 'esm',
      outfile: bundlePath,
      packages: 'external',
      platform: 'node',
      target: 'node24',
    })
    await import(pathToFileURL(bundlePath).href)
  } finally {
    await rm(bundlePath, { force: true })
  }
} else {
  const [{ createOplog }, { ProjectWatcher }, { Sync }] = await Promise.all([
    import('../electron/core/oplog/index.ts'),
    import('../electron/core/watcher/index.ts'),
    import('../electron/core/sync/index.ts'),
  ])

  const directoryA = '/tmp/cairn-verify-a'
  const directoryB = '/tmp/cairn-verify-b'
  const roomCode = 'VERIFY'
  const resources = []
  const errors = []

  const logPass = (message) => console.log(`✓ ${message}`)
  const logFail = (message) => console.error(`✗ ${message}`)
  const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

  const isPathInside = (root, candidate) => {
    const normalizedRoot = resolve(root)
    const normalizedCandidate = resolve(normalizedRoot, candidate)
    return normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  }

  const projectFilePath = (root, filePath) => {
    if (!isPathInside(root, filePath)) {
      throw new Error(`验证脚本拒绝越界路径：${filePath}`)
    }
    return resolve(root, filePath)
  }

  const waitFor = async (description, predicate, timeoutMilliseconds = 10_000) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMilliseconds) {
      if (await predicate()) {
        logPass(description)
        return
      }
      await delay(50)
    }
    throw new Error(`${description} 超时（${timeoutMilliseconds}ms）`)
  }

  const exists = async (filePath) => {
    try {
      await access(filePath)
      return true
    } catch {
      return false
    }
  }

  const readProjectFile = async (root, filePath) => {
    const absolutePath = projectFilePath(root, filePath)
    try {
      return await readFile(absolutePath, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return ''
      }
      throw error
    }
  }

  const writeProjectFile = async (root, filePath, content) => {
    const absolutePath = projectFilePath(root, filePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, 'utf8')
  }

  const listDirectory = async (root) => {
    if (!(await exists(root))) {
      return '(目录不存在)'
    }
    const entries = []
    const visit = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = join(directory, entry.name)
        const displayPath = relative(root, entryPath)
        if (entry.isDirectory()) {
          entries.push(`${displayPath}/`)
          await visit(entryPath)
        } else {
          const content = await readFile(entryPath, 'utf8').catch(() => '<无法读取>')
          entries.push(`${displayPath}: ${JSON.stringify(content.slice(0, 240))}`)
        }
      }
    }
    await visit(root)
    return entries.join('\n') || '(空目录)'
  }

  const createParticipant = async (root, label) => {
    const oplog = createOplog(root)
    const watcher = new ProjectWatcher(root, oplog, { author: `verify-${label}` })
    const sync = new Sync(
      { oplog, roomCode },
      {},
      {
        applyRemoteChange: (filePath, content) => watcher.applyRemoteChange(filePath, content),
        readFile: (filePath) => readProjectFile(root, filePath),
        writeFile: (filePath, content) => writeProjectFile(root, filePath, content),
      },
    )
    watcher.on('op', (op) => sync.announceLocalOp(op))
    watcher.on('error', (error) => errors.push(`${label} watcher: ${error.message}`))
    sync.on('error', (error) => errors.push(`${label} sync: ${error.message}`))
    const participant = { label, oplog, root, sync, watcher }
    resources.push(participant)
    return participant
  }

  const cleanup = async () => {
    await Promise.all(resources.map(async ({ sync, watcher, oplog }) => {
      await sync.stop()
      await watcher.stop()
      oplog.close()
    }))
    await Promise.all([rm(directoryA, { force: true, recursive: true }), rm(directoryB, { force: true, recursive: true })])
  }

  try {
    await Promise.all([rm(directoryA, { force: true, recursive: true }), rm(directoryB, { force: true, recursive: true })])
    await Promise.all([mkdir(directoryA, { recursive: true }), mkdir(directoryB, { recursive: true })])
    await Promise.all([
      writeProjectFile(directoryA, 'sample.ts', 'export const value = 1\n'),
      writeProjectFile(directoryB, 'sample.ts', 'export const value = 1\n'),
    ])
    logPass('已创建两个独立项目目录及相同的 sample.ts')

    const [participantA, participantB] = await Promise.all([
      createParticipant(directoryA, 'a'),
      createParticipant(directoryB, 'b'),
    ])
    const peerJoined = { a: false, b: false }
    const connected = { a: false, b: false }
    const remoteOpsA = []
    const remoteOpsB = []
    participantA.sync.on('peerJoined', (peer) => {
      peerJoined.a = true
      console.log(`  A 发现 ${peer.peerId} @ ${peer.host}:${peer.port}`)
    })
    participantB.sync.on('peerJoined', (peer) => {
      peerJoined.b = true
      console.log(`  B 发现 ${peer.peerId} @ ${peer.host}:${peer.port}`)
    })
    participantA.sync.on('connected', () => { connected.a = true })
    participantB.sync.on('connected', () => { connected.b = true })
    participantA.sync.on('remoteOp', (op) => remoteOpsA.push(op))
    participantB.sync.on('remoteOp', (op) => remoteOpsB.push(op))

    await Promise.all([participantA.watcher.start(), participantB.watcher.start()])
    logPass('两个真实 watcher 已完成初始扫描')
    await participantA.sync.start()
    await participantB.sync.start()
    logPass('两个真实 Sync 已通过 mDNS 发布并开始 TCP 监听')

    await waitFor('A 与 B 都收到 peerJoined', () => peerJoined.a && peerJoined.b)
    await waitFor('A 与 B 的真实 TCP 连接均已建立', () => connected.a && connected.b)

    await writeProjectFile(directoryA, 'sample.ts', 'export const value = 2\n')
    logPass('A 已把 sample.ts 修改为 value = 2')
    await waitFor('B 的 sample.ts 已同步为 value = 2', async () =>
      (await readProjectFile(directoryB, 'sample.ts')) === 'export const value = 2\n',
    )

    if (remoteOpsB.length !== 1 || remoteOpsB[0]?.source !== 'remote') {
      throw new Error(`B 未收到恰好一条 source=remote 的 remoteOp：${remoteOpsB.length}`)
    }
    if (!participantB.oplog.hasOp(remoteOpsB[0].hash)) {
      throw new Error(`B oplog 缺少远端 op：${remoteOpsB[0].hash}`)
    }
    logPass('B 收到一条 source=remote 的 op，且已写入其 oplog')

    const bStableCount = participantB.oplog.listAllHashes().length
    await delay(2_000)
    if (participantB.oplog.listAllHashes().length !== bStableCount) {
      throw new Error('B oplog 在远端应用后继续增长，检测到循环 op')
    }
    logPass('B 等待 2 秒后 oplog 未继续增长（无循环 op）')

    await writeProjectFile(directoryB, 'sample.ts', 'export const value = 3\n')
    logPass('B 已把 sample.ts 修改为 value = 3')
    await waitFor('A 的 sample.ts 已同步为 value = 3', async () =>
      (await readProjectFile(directoryA, 'sample.ts')) === 'export const value = 3\n',
    )

    if (remoteOpsA.length !== 1 || remoteOpsA[0]?.source !== 'remote') {
      throw new Error(`A 未收到恰好一条 source=remote 的 remoteOp：${remoteOpsA.length}`)
    }
    const aStableCount = participantA.oplog.listAllHashes().length
    await delay(2_000)
    if (participantA.oplog.listAllHashes().length !== aStableCount) {
      throw new Error('A oplog 在远端应用后继续增长，检测到循环 op')
    }
    logPass('A 等待 2 秒后 oplog 未继续增长（无循环 op）')

    await cleanup()
    console.log('PASS')
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    const isCiWithoutMdns = Boolean(process.env.CI) && /peerJoined.*超时/.test(message)
    if (isCiWithoutMdns) {
      console.log('SKIP: CI 环境未能通过 mDNS 发现本机 peer。')
      await cleanup()
      process.exitCode = 0
    } else {
      logFail(message)
      if (errors.length > 0) {
        console.error(`相关事件错误：\n${errors.join('\n')}`)
      }
      console.error(`目录 A 内容：\n${await listDirectory(directoryA)}`)
      console.error(`目录 B 内容：\n${await listDirectory(directoryB)}`)
      await cleanup()
      console.log('FAIL')
      process.exitCode = 1
    }
  }
}
