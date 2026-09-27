import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createOplog } from '../oplog'
import type { Oplog, Op } from '../oplog'
import { snapshotExists, writeSnapshot } from './snapshot'
import { ProjectWatcher } from './watcher'

const roots: string[] = []
const resources: Array<{ oplog: Oplog; watcher: ProjectWatcher }> = []

async function createFixture(options: { debounceMs?: number } = {}): Promise<{
  projectRoot: string
  oplog: Oplog
  watcher: ProjectWatcher
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'cairn-watcher-'))
  const oplog = createOplog(projectRoot)
  const watcher = new ProjectWatcher(projectRoot, oplog, {
    author: 'watcher-test',
    debounceMs: options.debounceMs ?? 50,
  })

  roots.push(projectRoot)
  resources.push({ oplog, watcher })

  return { projectRoot, oplog, watcher }
}

function waitForOp(watcher: ProjectWatcher, timeoutMs = 5_000): Promise<Op> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      watcher.off('op', onOp)
      reject(new Error(`等待 op 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    const onOp = (op: Op): void => {
      clearTimeout(timeout)
      watcher.off('op', onOp)
      resolve(op)
    }

    watcher.on('op', onOp)
  })
}

async function expectNoOp(
  watcher: ProjectWatcher,
  timeoutMs = 350,
): Promise<void> {
  await expect(waitForOp(watcher, timeoutMs)).rejects.toThrow(/等待 op 超时/)
}

afterEach(async () => {
  const currentResources = resources.splice(0)
  await Promise.all(currentResources.map(({ watcher }) => watcher.stop()))
  for (const { oplog } of currentResources) {
    oplog.close()
  }
  await Promise.all(
    roots.splice(0).map((projectRoot) =>
      rm(projectRoot, { recursive: true, force: true }),
    ),
  )
})

describe('ProjectWatcher', () => {
  it('启动时已有文件只建立基线且 start 在 ready 后返回', async () => {
    const { projectRoot, oplog, watcher } = await createFixture()
    const path = join(projectRoot, 'existing.ts')
    await writeFile(path, 'const ready = true\n', 'utf8')

    await watcher.start()

    expect(oplog.listRecent(200)).toEqual([])
    expect(
      snapshotExists(
        projectRoot,
        writeSnapshot(projectRoot, 'existing.ts', 'const ready = true\n'),
        'existing.ts',
      ),
    ).toBe(true)
  })

  it('新建文件产生从空内容到当前内容的一条 op', async () => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()

    const opPromise = waitForOp(watcher)
    await writeFile(join(projectRoot, 'new.ts'), 'export const value = 1\n', 'utf8')
    const op = await opPromise

    expect(op.filePath).toBe('new.ts')
    expect(op.author).toBe('watcher-test')
    expect(op.diff).toContain('+export const value = 1')
    expect(op.parentHashes).toEqual([])
  })

  it('applyRemoteChange 更新基线但不产生 op，后续本地修改仍会产生 op', async () => {
    const { projectRoot, watcher } = await createFixture()
    const path = join(projectRoot, 'remote.ts')
    await writeFile(path, 'before\n', 'utf8')
    await watcher.start()

    await watcher.applyRemoteChange('remote.ts', 'remote\n')
    await writeFile(path, 'remote\n', 'utf8')
    await expectNoOp(watcher)

    const opPromise = waitForOp(watcher)
    await writeFile(path, 'local\n', 'utf8')
    const op = await opPromise

    expect(op.source).toBe('local')
    expect(op.diff).toContain('-remote')
    expect(op.diff).toContain('+local')
  })

  it('在 debounce 窗口结束后再写入会产生第二条 op', async () => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()
    const path = join(projectRoot, 'debounce.ts')

    const firstOp = waitForOp(watcher)
    await writeFile(path, 'one\n', 'utf8')
    await firstOp

    const secondOp = waitForOp(watcher)
    await writeFile(path, 'two\n', 'utf8')
    await secondOp
  })

  it('同一 debounce 窗口内的连续写入合并为一条 op', async () => {
    const { projectRoot, oplog, watcher } = await createFixture()
    const path = join(projectRoot, 'merged.ts')
    await writeFile(path, 'before\n', 'utf8')
    await watcher.start()

    const opPromise = waitForOp(watcher)
    await writeFile(path, 'middle\n', 'utf8')
    await writeFile(path, 'after\n', 'utf8')
    await opPromise
    await watcher.stop()

    expect(oplog.listRecent(200)).toHaveLength(1)
  })

  it('diff 只包含实际变更的行', async () => {
    const { projectRoot, watcher } = await createFixture()
    const path = join(projectRoot, 'diff.ts')
    await writeFile(path, 'keep\nreplace\n', 'utf8')
    await watcher.start()

    const opPromise = waitForOp(watcher)
    await writeFile(path, 'keep\nchanged\n', 'utf8')
    const op = await opPromise

    expect(op.diff).toContain('-replace')
    expect(op.diff).toContain('+changed')
    expect(op.diff).not.toContain('-keep')
    expect(op.diff).not.toContain('+keep')
  })

  it('忽略目录中的文件不会产生 op', async () => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()

    for (const directory of ['.git', '.vibeswarm', '.cairn', 'node_modules', 'dist', 'build']) {
      const path = join(projectRoot, directory, 'ignored.ts')
      await mkdir(join(projectRoot, directory), { recursive: true })
      await writeFile(path, 'ignored\n', 'utf8')
    }

    await expectNoOp(watcher)
  })

  it('stop 后不再接收文件变更事件', async () => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()
    await watcher.stop()

    await writeFile(join(projectRoot, 'after-stop.ts'), 'no op\n', 'utf8')

    await expectNoOp(watcher)
  })

  it('删除文件产生从内容到空内容的 op', async () => {
    const { projectRoot, watcher } = await createFixture()
    const path = join(projectRoot, 'deleted.ts')
    await writeFile(path, 'remove me\n', 'utf8')
    await watcher.start()

    const opPromise = waitForOp(watcher)
    await rm(path)
    const op = await opPromise

    expect(op.diff).toContain('-remove me')
    expect(op.diff).not.toContain('+remove me')
  })

  it('删除文件会将原始内容保存到 .cairn/trash，且内部目录不会产生 op', async () => {
    const { projectRoot, oplog, watcher } = await createFixture()
    const path = join(projectRoot, 'deleted.ts')
    await writeFile(path, 'keep me\n', 'utf8')
    await watcher.start()

    const opPromise = waitForOp(watcher)
    await rm(path)
    await opPromise

    const entries = await import('../trash').then(({ TrashManager }) => new TrashManager(projectRoot).list())
    expect(entries).toHaveLength(1)
    await expect(readFile(join(projectRoot, '.cairn', 'trash', entries[0]!.trashId, 'content'), 'utf8')).resolves.toBe('keep me\n')
    await expectNoOp(watcher)
    expect(oplog.listRecent(200)).toHaveLength(1)
  })

  it('新建、修改、删除会产生三条无 parent 的 op', async () => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()
    const path = join(projectRoot, 'lifecycle.ts')

    const created = waitForOp(watcher)
    await writeFile(path, 'first\n', 'utf8')
    const first = await created

    const changed = waitForOp(watcher)
    await writeFile(path, 'second\n', 'utf8')
    const second = await changed

    const deleted = waitForOp(watcher)
    await rm(path)
    const third = await deleted

    expect([first, second, third]).toHaveLength(3)
    expect([first, second, third].every((op) => op.parentHashes.length === 0)).toBe(true)
  })

  it('快照以内容 SHA-256 为键去重', async () => {
    const { projectRoot } = await createFixture()

    const firstHash = writeSnapshot(projectRoot, 'src/file.ts', 'same content')
    const secondHash = writeSnapshot(projectRoot, 'src/file.ts', 'same content')

    expect(secondHash).toBe(firstHash)
    expect(snapshotExists(projectRoot, firstHash, 'src/file.ts')).toBe(true)
  })

  it('快照拒绝越界相对路径', async () => {
    const { projectRoot } = await createFixture()

    expect(() => writeSnapshot(projectRoot, '../escape.ts', 'content')).toThrow(
      /路径越界/,
    )
  })

  it('start 与 stop 都是幂等的', async () => {
    const { watcher } = await createFixture()

    await expect(watcher.stop()).resolves.toBeUndefined()
    await expect(watcher.start()).resolves.toBeUndefined()
    await expect(watcher.start()).resolves.toBeUndefined()
    await expect(watcher.stop()).resolves.toBeUndefined()
    await expect(watcher.stop()).resolves.toBeUndefined()
  })

  it.each(['image.png', 'document.pdf'])('binary 扩展名 %s 不产生 op', async (fileName) => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()
    await writeFile(join(projectRoot, fileName), Buffer.from([0, 1, 2, 3]))
    await expectNoOp(watcher)
  })

  it('无扩展名且含 NUL 的文件不产生 op', async () => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()
    await writeFile(join(projectRoot, 'binary'), Buffer.from([65, 0, 66]))
    await expectNoOp(watcher)
  })

  it('无扩展名的纯文本文件正常产生 op', async () => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()
    const opPromise = waitForOp(watcher)
    await writeFile(join(projectRoot, 'README'), 'plain text\n', 'utf8')
    await expect(opPromise).resolves.toMatchObject({ filePath: 'README' })
  })
})
