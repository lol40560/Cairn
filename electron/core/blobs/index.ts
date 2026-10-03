import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ensureCairnDataDir } from '../data-dir'

const HASH_PATTERN = /^[a-f0-9]{64}$/

/** 管理以 SHA-256 內容雜湊定址的二進制檔案。 */
export class BlobStore {
  private readonly blobsRoot: string

  constructor(projectRoot: string) {
    this.blobsRoot = join(ensureCairnDataDir(projectRoot), 'blobs')
  }

  async put(content: Buffer): Promise<string> {
    const hash = createHash('sha256').update(content).digest('hex')
    const destination = this.blobPath(hash)

    if (await this.has(hash)) return hash

    await mkdir(join(this.blobsRoot, hash.slice(0, 2)), { recursive: true })
    const temporaryPath = `${destination}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, content, { flag: 'wx' })
      await rename(temporaryPath, destination)
    } catch (error) {
      // 多個事件同時存入相同內容時，另一個寫入者已完成即可安全復用。
      if (await this.has(hash)) return hash
      throw error
    } finally {
      await rm(temporaryPath, { force: true })
    }

    return hash
  }

  async get(hash: string): Promise<Buffer | undefined> {
    this.assertHash(hash)
    try {
      return await readFile(this.blobPath(hash))
    } catch (error) {
      if (this.isMissing(error)) return undefined
      throw error
    }
  }

  async has(hash: string): Promise<boolean> {
    this.assertHash(hash)
    try {
      await access(this.blobPath(hash))
      return true
    } catch (error) {
      if (this.isMissing(error)) return false
      throw error
    }
  }

  async listAll(): Promise<string[]> {
    try {
      const prefixes = await readdir(this.blobsRoot, { withFileTypes: true })
      const nested = await Promise.all(prefixes
        .filter((entry) => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name))
        .map(async (entry) => readdir(join(this.blobsRoot, entry.name), { withFileTypes: true })))
      return nested
        .flat()
        .filter((entry) => entry.isFile() && HASH_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    } catch (error) {
      if (this.isMissing(error)) return []
      throw error
    }
  }

  async delete(hash: string): Promise<void> {
    this.assertHash(hash)
    await rm(this.blobPath(hash), { force: true })
  }

  private blobPath(hash: string): string {
    this.assertHash(hash)
    return join(this.blobsRoot, hash.slice(0, 2), hash)
  }

  private assertHash(hash: string): void {
    if (!HASH_PATTERN.test(hash)) throw new Error(`blob hash 非法：${hash}`)
  }

  private isMissing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
  }
}
