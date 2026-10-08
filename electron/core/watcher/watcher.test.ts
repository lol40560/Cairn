import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createOplog } from '../oplog'
import type { Oplog, Op } from '../oplog'
import { BlobStore } from '../blobs'
import { snapshotExists, writeSnapshot } from './snapshot'
import { ProjectWatcher } from './watcher'
import { TrashManager } from '../trash'

const roots: string[] = []
const resources: Array<{ oplog: Oplog; watcher: ProjectWatcher }> = []

async function createFixture(options: { debounceMs?: number; trash?: TrashManager } = {}): Promise<{
  projectRoot: string
  oplog: Oplog
  watcher: ProjectWatcher
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'cairn-watcher-'))
  const oplog = createOplog(projectRoot)
  const watcher = new ProjectWatcher(projectRoot, oplog, {
    author: 'watcher-test',
    debounceMs: options.debounceMs ?? 50,
  }, options.trash)

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
    // chokidar 的 ready 代表初始扫描完成；macOS FSEvents 仍可能在极短时间内完成底层订阅。
    // 让测试等待一个极小观察窗口，确保断言的是 add 事件而不是平台订阅时序。
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    const opPromise = waitForOp(watcher)
    await writeFile(join(projectRoot, 'new.ts'), 'export const value = 1\n', 'utf8')
    const op = await opPromise

    expect(op.filePath).toBe('new.ts')
    expect(op.author).toBe('watcher-test')
    expect(op.diff).toContain('+export const value = 1')
    expect(op.parentHashes).toEqual([])
    expect(op.kind).toBe('created')
    expect(op.baseHash).toBe(createHash('sha256').update('').digest('hex'))
  })

  it('regression: wire frame 超限的 Unicode 文字改以完整 UTF-8 blob 产生 op', async () => {
    const { projectRoot, oplog, watcher } = await createFixture({ debounceMs: 10 })
    await watcher.start()

    const opPromise = waitForOp(watcher, 30_000)
    const text = '🧭'.repeat(2_700_000)
    const filePath = join(projectRoot, 'oversized.ts')
    const middle = text.length / 2
    await writeFile(filePath, text.slice(0, middle), 'utf8')
    // 模擬慢速非原子寫入：第一段已觸發 add/change，但完整內容仍在寫入。
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
    await writeFile(filePath, text.slice(middle), { encoding: 'utf8', flag: 'a' })
    const op = await opPromise

    expect(op).toMatchObject({
      contentEncoding: 'full-text-blob',
      diff: '',
      filePath: 'oversized.ts',
      size: Buffer.byteLength(text, 'utf8'),
    })
    expect(op.blobHash).toMatch(/^[a-f0-9]{64}$/)
    expect(await new BlobStore(projectRoot).get(op.blobHash!)).toEqual(Buffer.from(text, 'utf8'))
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    expect(oplog.listRecent(200)).toHaveLength(1)
  }, 45_000)

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

    const firstOp = waitForOp(watcher, 10_000)
    await writeFile(path, 'one\n', 'utf8')
    await firstOp

    const secondOp = waitForOp(watcher, 10_000)
    await writeFile(path, 'two\n', 'utf8')
    await secondOp
  }, 15_000)

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
    expect(op.baseHash).toBe(createHash('sha256').update('keep\nreplace\n').digest('hex'))
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

  it('遵守 .gitignore，且 .cairnignore 的否定规则可重新纳入文件', async () => {
    const { projectRoot, watcher } = await createFixture()
    await writeFile(join(projectRoot, '.gitignore'), '*.log\n', 'utf8')
    await watcher.start()

    await writeFile(join(projectRoot, 'ignored.log'), 'first\n', 'utf8')
    await expectNoOp(watcher)

    const configOp = waitForOp(watcher)
    await writeFile(join(projectRoot, '.cairnignore'), '!ignored.log\n', 'utf8')
    await expect(configOp).resolves.toMatchObject({ filePath: '.cairnignore' })

    const opPromise = waitForOp(watcher)
    await writeFile(join(projectRoot, 'ignored.log'), 'second\n', 'utf8')

    await expect(opPromise).resolves.toMatchObject({ filePath: 'ignored.log', kind: 'created' })
  })

  it('忽略敏感文件，但允许共享 .env.example 模板', async () => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()

    await writeFile(join(projectRoot, '.env'), 'API_TOKEN=secret\n', 'utf8')
    await expectNoOp(watcher)

    const template = waitForOp(watcher)
    await writeFile(join(projectRoot, '.env.example'), 'API_TOKEN=replace-me\n', 'utf8')
    await expect(template).resolves.toMatchObject({ filePath: '.env.example', kind: 'created' })
  })

  it('不读取指向项目外的符号链接', async () => {
    const { projectRoot, watcher } = await createFixture()
    const outside = await mkdtemp(join(tmpdir(), 'cairn-watcher-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'secret.ts'), 'export const secret = true\n', 'utf8')
    await watcher.start()

    await symlink(join(outside, 'secret.ts'), join(projectRoot, 'external-link.ts'))

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
    expect(op.kind).toBe('deleted')
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

  it('废纸篓写入失败时恢复文件且不生成删除 op', async () => {
    const failingTrash = {
      moveToTrash: vi.fn(async () => {
        throw new Error('磁盘写入失败')
      }),
    } as unknown as TrashManager
    const { projectRoot, watcher } = await createFixture({ trash: failingTrash })
    const path = join(projectRoot, 'recover.ts')
    await writeFile(path, 'keep this\n', 'utf8')
    await watcher.start()

    const failure = new Promise<Error>((resolve) => watcher.once('error', resolve))
    await rm(path)
    await expect(failure).resolves.toMatchObject({ message: expect.stringContaining('写入变更失败') })
    await expect(readFile(path, 'utf8')).resolves.toBe('keep this\n')
    await expectNoOp(watcher)
    expect(failingTrash.moveToTrash).toHaveBeenCalledOnce()
  })

  it('远端空文件建立空基线，后续修改仍为 modified', async () => {
    const { projectRoot, watcher } = await createFixture()
    const path = join(projectRoot, 'empty.ts')
    await writeFile(path, '', 'utf8')
    await watcher.start()

    await watcher.applyRemoteChange('empty.ts', '', false)
    await writeFile(path, '', 'utf8')
    await expectNoOp(watcher)

    const changed = waitForOp(watcher)
    await writeFile(path, 'export {}\n', 'utf8')
    await expect(changed).resolves.toMatchObject({ kind: 'modified' })
  })

  it('新建、修改、删除会产生三条无 parent 的 op', async () => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()
    const path = join(projectRoot, 'lifecycle.ts')

    const created = waitForOp(watcher, 10_000)
    await writeFile(path, 'first\n', 'utf8')
    const first = await created

    const changed = waitForOp(watcher, 10_000)
    await writeFile(path, 'second\n', 'utf8')
    const second = await changed

    const deleted = waitForOp(watcher, 10_000)
    await rm(path)
    const third = await deleted

    expect([first, second, third]).toHaveLength(3)
    expect([first, second, third].every((op) => op.parentHashes.length === 0)).toBe(true)
    expect([first.kind, second.kind, third.kind]).toEqual([
      'created',
      'modified',
      'deleted',
    ])
  }, 15_000)

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

  it.each(['document.pdf', 'archive.zip'])('不在白名单的 binary 扩展名 %s 不产生 op', async (fileName) => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()
    await writeFile(join(projectRoot, fileName), Buffer.from([0, 1, 2, 3]))
    await expectNoOp(watcher)
  })

  it('创建 PNG 会产生带 blobHash 的 op', async () => {
    const { projectRoot, watcher } = await createFixture()
    // 目录创建与文件创建会被底层 watcher 合并；预建目录让本测试只断言 PNG 文件事件。
    await mkdir(join(projectRoot, 'assets'), { recursive: true })
    await watcher.start()

    const opPromise = waitForOp(watcher)
    await writeFile(join(projectRoot, 'assets', 'logo.png'), Buffer.from([137, 80, 78, 71]))

    await expect(opPromise).resolves.toMatchObject({
      filePath: 'assets/logo.png',
      kind: 'created',
      diff: '',
      blobHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      size: 4,
    })
  })

  it('创建 OTF 会产生 blob op，但 PDF 仍被跳过', async () => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()

    const fontOp = waitForOp(watcher)
    await writeFile(join(projectRoot, 'font.otf'), Buffer.from([0, 1, 2]))
    await expect(fontOp).resolves.toMatchObject({ filePath: 'font.otf', blobHash: expect.any(String) })

    await writeFile(join(projectRoot, 'document.pdf'), Buffer.from([0, 1, 2]))
    await expectNoOp(watcher)
  })

  it('超过 5 MB 的 PNG 不产生 op', async () => {
    const { projectRoot, watcher } = await createFixture()
    await watcher.start()

    await writeFile(join(projectRoot, 'large.png'), Buffer.alloc(5 * 1024 * 1024 + 1, 1))
    await expectNoOp(watcher)
  })

  it('内容未变的 PNG 不重复产生 op', async () => {
    const { projectRoot, watcher } = await createFixture()
    const path = join(projectRoot, 'same.png')
    const content = Buffer.from([1, 2, 3])
    await writeFile(path, content)
    await watcher.start()

    await writeFile(path, content)
    await expectNoOp(watcher)
  })

  it('删除 PNG 会产生保留旧 blobHash 的 deleted op', async () => {
    const { projectRoot, watcher } = await createFixture()
    const path = join(projectRoot, 'deleted.png')
    await writeFile(path, Buffer.from([1, 2, 3]))
    await watcher.start()

    const opPromise = waitForOp(watcher)
    await rm(path)

    await expect(opPromise).resolves.toMatchObject({
      filePath: 'deleted.png',
      kind: 'deleted',
      blobHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
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
