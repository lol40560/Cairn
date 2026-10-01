import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

export interface ProjectEntry {
  id: string
  name: string
  path: string
  lastOpenedAt: number
  isFavorite: boolean
}

interface ProjectsData {
  projects: ProjectEntry[]
  lastActiveId?: string
}

interface LegacyLastSession {
  folder?: unknown
}

const emptyProjectsData = (): ProjectsData => ({ projects: [] })

/** 管理本机使用过的项目；该索引不会参与项目同步。 */
export class ProjectsManager {
  constructor(private readonly storagePath: string) {}

  /** 收藏项目优先，其余按最近打开时间排序。 */
  async list(): Promise<ProjectEntry[]> {
    const data = await this.read()
    return [...data.projects].sort((left, right) => {
      if (left.isFavorite !== right.isFavorite) return left.isFavorite ? -1 : 1
      if (left.lastOpenedAt !== right.lastOpenedAt) return right.lastOpenedAt - left.lastOpenedAt
      return left.name.localeCompare(right.name)
    })
  }

  /** 添加项目；已有路径仅刷新最近打开时间。 */
  async add(projectPath: string): Promise<ProjectEntry> {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      throw new Error('项目路径不能为空')
    }

    const normalizedPath = resolve(projectPath)
    const data = await this.read()
    const existing = data.projects.find((entry) => entry.path === normalizedPath)
    if (existing) {
      existing.lastOpenedAt = Date.now()
      await this.write(data)
      return existing
    }

    const entry: ProjectEntry = {
      id: randomUUID(),
      name: basename(normalizedPath) || normalizedPath,
      path: normalizedPath,
      lastOpenedAt: Date.now(),
      isFavorite: false,
    }
    data.projects.push(entry)
    await this.write(data)
    return entry
  }

  async remove(id: string): Promise<void> {
    const data = await this.read()
    data.projects = data.projects.filter((entry) => entry.id !== id)
    if (data.lastActiveId === id) {
      data.lastActiveId = undefined
    }
    await this.write(data)
  }

  async setActive(id: string): Promise<void> {
    const data = await this.read()
    if (!data.projects.some((entry) => entry.id === id)) {
      throw new Error('项目不存在')
    }
    data.lastActiveId = id
    await this.write(data)
  }

  async getActive(): Promise<ProjectEntry | undefined> {
    const data = await this.read()
    return data.projects.find((entry) => entry.id === data.lastActiveId)
  }

  async touch(id: string): Promise<void> {
    const data = await this.read()
    const entry = data.projects.find((item) => item.id === id)
    if (!entry) {
      throw new Error('项目不存在')
    }
    entry.lastOpenedAt = Date.now()
    await this.write(data)
  }

  async checkAvailability(id: string): Promise<boolean> {
    const data = await this.read()
    const entry = data.projects.find((item) => item.id === id)
    if (!entry) return false

    try {
      return (await stat(entry.path)).isDirectory()
    } catch {
      return false
    }
  }

  async exists(projectPath: string): Promise<ProjectEntry | undefined> {
    const normalizedPath = resolve(projectPath)
    const data = await this.read()
    return data.projects.find((entry) => entry.path === normalizedPath)
  }

  /** projects.json 首次缺失时，将旧的单项目 session 迁入项目列表。 */
  async migrateFromLastSession(lastSessionStoragePath: string): Promise<void> {
    if (existsSync(this.storagePath)) return

    try {
      const session = JSON.parse(await readFile(lastSessionStoragePath, 'utf8')) as LegacyLastSession
      if (typeof session.folder !== 'string' || !session.folder) return

      const entry = await this.add(session.folder)
      await this.setActive(entry.id)
    } catch {
      // 旧 session 缺失或损坏时保留首次使用的空列表状态。
    }
  }

  private async read(): Promise<ProjectsData> {
    try {
      const raw = JSON.parse(await readFile(this.storagePath, 'utf8')) as Partial<ProjectsData>
      if (!Array.isArray(raw.projects)) return emptyProjectsData()

      const projects = raw.projects.filter(isProjectEntry)
      return {
        projects,
        lastActiveId: typeof raw.lastActiveId === 'string' ? raw.lastActiveId : undefined,
      }
    } catch {
      // 损坏的索引不应妨碍用户继续打开项目。
      return emptyProjectsData()
    }
  }

  private async write(data: ProjectsData): Promise<void> {
    await mkdir(dirname(this.storagePath), { recursive: true })
    const temporaryPath = `${this.storagePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf8')
    await rename(temporaryPath, this.storagePath)
  }
}

function isProjectEntry(value: unknown): value is ProjectEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<ProjectEntry>
  return typeof entry.id === 'string'
    && typeof entry.name === 'string'
    && typeof entry.path === 'string'
    && typeof entry.lastOpenedAt === 'number'
    && typeof entry.isFavorite === 'boolean'
}
