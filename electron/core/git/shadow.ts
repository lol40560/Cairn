import { existsSync } from 'node:fs'
import { access, chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path'

import * as git from 'isomorphic-git'

import type { Op } from '../oplog'
import { ensureCairnDataDir } from '../data-dir'

export interface CommitInfo {
  sha: string
  message: string
  timestamp: number
}

export interface RemoteInfo {
  url: string
  branch: string
}

export interface ShadowFile {
  content: Buffer
  /** Git 只需要保存一般檔與 executable 一般檔兩種語義。 */
  mode: '100644' | '100755'
  path: string
}

export interface ShadowGit {
  init(): Promise<void>
  commitOp(op: Op, projectRoot: string): Promise<string>
  listCommits(): Promise<CommitInfo[]>
  squashCommits(count: number): Promise<string>
  getRemoteInfo(): Promise<RemoteInfo | undefined>
  setRemoteInfo(info: RemoteInfo): Promise<void>
  listFiles(): Promise<ShadowFile[]>
  close(): void
}

async function safeProjectPath(projectRoot: string, filePath: string): Promise<string> {
  const normalized = filePath.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (
    normalized.length === 0
    || isAbsolute(normalized)
    || win32.isAbsolute(normalized)
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`影子 Git 文件路径越界：${filePath}`)
  }

  const root = await realpath(projectRoot)
  const target = resolve(root, ...segments)
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`影子 Git 文件路径越界：${filePath}`)
  }

  let currentPath = root
  for (const segment of segments) {
    currentPath = join(currentPath, segment)
    try {
      const resolvedPath = await realpath(currentPath)
      if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${sep}`)) {
        throw new Error(`影子 Git 文件路径通过符号链接越界：${filePath}`)
      }
    } catch (error) {
      if (isMissingPath(error)) {
        break
      }
      throw error
    }
  }
  return target
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

class IsomorphicShadowGit implements ShadowGit {
  private readonly configPath: string
  private readonly gitDir: string
  private readonly workDir: string
  private closed = false
  private initialized = false

  constructor(projectRoot: string) {
    const root = ensureCairnDataDir(projectRoot)
    this.gitDir = join(root, 'git')
    this.workDir = join(root, 'git-worktree')
    this.configPath = join(this.gitDir, 'config.json')
  }

  async init(): Promise<void> {
    this.assertOpen('init')
    if (this.initialized) {
      return
    }

    await mkdir(this.workDir, { recursive: true })
    if (!existsSync(this.gitDir)) {
      await git.init({ bare: true, defaultBranch: 'main', fs: await import('node:fs'), gitdir: this.gitDir })
    }
    this.initialized = true
  }

  async commitOp(op: Op, projectRoot: string): Promise<string> {
    await this.init()
    const sourcePath = await safeProjectPath(projectRoot, op.filePath)
    const targetPath = await safeProjectPath(this.workDir, op.filePath)
    const fs = await import('node:fs')
    if (!(await fileExists(sourcePath))) {
      if (!(await fileExists(targetPath))) {
        console.info(`[cairn:shadow] 文件已在 shadow 中删除，跳过：${op.filePath}`)
        return ''
      }

      // 删除 op 的源文件已由废纸篓接管；同步删除影子工作树中的版本。
      await rm(targetPath, { force: true })
      await git.remove({ dir: this.workDir, filepath: op.filePath, fs, gitdir: this.gitDir })
      return git.commit({
        author: { email: `${op.author}@cairn.local`, name: op.author },
        dir: this.workDir,
        fs,
        gitdir: this.gitDir,
        message: `[cairn] ${op.author}: deleted ${op.filePath} (${op.hash.slice(0, 8)})`,
      })
    }

    const [content, sourceStats] = await Promise.all([readFile(sourcePath), stat(sourcePath)])
    const mode = executableMode(sourceStats.mode)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, content)
    await applyExecutableMode(targetPath, mode)
    await git.add({ dir: this.workDir, filepath: op.filePath, fs, gitdir: this.gitDir })
    return git.commit({
      author: { email: `${op.author}@cairn.local`, name: op.author },
      dir: this.workDir,
      fs,
      gitdir: this.gitDir,
      message: `[cairn] ${op.author}: ${op.filePath} (${op.hash.slice(0, 8)})`,
    })
  }

  async listCommits(): Promise<CommitInfo[]> {
    await this.init()
    const fs = await import('node:fs')
    try {
      const commits = await git.log({ depth: 10_000, fs, gitdir: this.gitDir, ref: 'main' })
      return commits.map(({ commit, oid }) => ({
        message: commit.message.trimEnd(),
        sha: oid,
        timestamp: commit.author.timestamp * 1000,
      }))
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'NotFoundError'
      ) {
        return []
      }
      throw error
    }
  }

  async squashCommits(count: number): Promise<string> {
    await this.init()
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`squash count 必须是正整数，收到 ${count}`)
    }
    const commits = await this.listCommits()
    if (commits.length === 0) {
      throw new Error('影子仓库没有可 squash 的提交')
    }
    if (count > commits.length) {
      throw new Error(`squash count 超过提交数：${count} > ${commits.length}`)
    }

    const fs = await import('node:fs')
    const files = await this.listFiles()
    await rm(this.workDir, { force: true, recursive: true })
    await mkdir(this.workDir, { recursive: true })
    for (const file of files) {
      const targetPath = await safeProjectPath(this.workDir, file.path)
      await mkdir(dirname(targetPath), { recursive: true })
      await writeFile(targetPath, file.content)
      await applyExecutableMode(targetPath, file.mode)
      await git.add({ dir: this.workDir, filepath: file.path, fs, gitdir: this.gitDir })
    }

    const sha = await git.commit({
      author: { email: 'cairn@local', name: 'Cairn' },
      dir: this.workDir,
      fs,
      gitdir: this.gitDir,
      message: `[cairn] Squash ${count} commits`,
      parent: [],
    })
    await git.writeRef({ force: true, fs, gitdir: this.gitDir, ref: 'refs/heads/main', value: sha })
    return sha
  }

  async getRemoteInfo(): Promise<RemoteInfo | undefined> {
    await this.init()
    try {
      return JSON.parse(await readFile(this.configPath, 'utf8')) as RemoteInfo
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return undefined
      }
      throw error
    }
  }

  async setRemoteInfo(info: RemoteInfo): Promise<void> {
    await this.init()
    if (!info.url || !info.branch) {
      throw new Error('远端 URL 和 branch 均不能为空')
    }
    await writeFile(this.configPath, JSON.stringify(info), 'utf8')
  }

  async listFiles(): Promise<ShadowFile[]> {
    await this.init()
    const fs = await import('node:fs')
    const commits = await this.listCommits()
    if (commits.length === 0) {
      return []
    }
    const { commit } = await git.readCommit({ fs, gitdir: this.gitDir, oid: commits[0].sha })
    const files: ShadowFile[] = []
    const visit = async (oid: string, prefix = ''): Promise<void> => {
      const { tree } = await git.readTree({ fs, gitdir: this.gitDir, oid })
      for (const entry of tree) {
        const path = prefix ? `${prefix}/${entry.path}` : entry.path
        if (entry.type === 'tree') {
          await visit(entry.oid, path)
        } else if (entry.type === 'blob') {
          const { blob } = await git.readBlob({ fs, gitdir: this.gitDir, oid: entry.oid })
          files.push({ content: Buffer.from(blob), mode: entry.mode === '100755' ? '100755' : '100644', path })
        }
      }
    }
    await visit(commit.tree)
    return files.sort((left, right) => left.path.localeCompare(right.path))
  }

  close(): void {
    this.closed = true
  }

  private assertOpen(operation: string): void {
    if (this.closed) {
      throw new Error(`影子 Git 已关闭，无法执行 ${operation}`)
    }
  }
}

function executableMode(mode: number): '100644' | '100755' {
  return (mode & 0o111) === 0 ? '100644' : '100755'
}

async function applyExecutableMode(path: string, mode: ShadowFile['mode']): Promise<void> {
  if (process.platform !== 'win32') await chmod(path, mode === '100755' ? 0o755 : 0o644)
}

export function createShadowGit(projectRoot: string): ShadowGit {
  return new IsomorphicShadowGit(projectRoot)
}
