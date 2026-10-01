import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ProjectsManager } from './index'

const roots: string[] = []

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cairn-projects-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ProjectsManager', () => {
  it('空存储返回空项目列表', async () => {
    const root = await createRoot()
    const manager = new ProjectsManager(join(root, 'projects.json'))

    await expect(manager.list()).resolves.toEqual([])
  })

  it('添加路径后可在列表中找到项目', async () => {
    const root = await createRoot()
    const project = join(root, 'alpha')
    await mkdir(project)
    const manager = new ProjectsManager(join(root, 'projects.json'))

    const added = await manager.add(project)

    await expect(manager.list()).resolves.toEqual([added])
  })

  it('重复添加相同路径只保留一项并刷新时间', async () => {
    const root = await createRoot()
    const project = join(root, 'alpha')
    await mkdir(project)
    const manager = new ProjectsManager(join(root, 'projects.json'))
    const first = await manager.add(project)
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await manager.add(project)

    expect(second.id).toBe(first.id)
    expect(second.lastOpenedAt).toBeGreaterThanOrEqual(first.lastOpenedAt)
    await expect(manager.list()).resolves.toHaveLength(1)
  })

  it('按最近打开时间排序，收藏项目置顶', async () => {
    const root = await createRoot()
    const alpha = join(root, 'alpha')
    const beta = join(root, 'beta')
    await Promise.all([mkdir(alpha), mkdir(beta)])
    const manager = new ProjectsManager(join(root, 'projects.json'))
    const first = await manager.add(alpha)
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await manager.add(beta)

    await expect(manager.list()).resolves.toEqual([second, first])
  })

  it('移除项目后不再出现在列表中', async () => {
    const root = await createRoot()
    const manager = new ProjectsManager(join(root, 'projects.json'))
    const entry = await manager.add(join(root, 'alpha'))

    await manager.remove(entry.id)

    await expect(manager.list()).resolves.toEqual([])
  })

  it('设置活动项目后可读取同一条目', async () => {
    const root = await createRoot()
    const manager = new ProjectsManager(join(root, 'projects.json'))
    const entry = await manager.add(join(root, 'alpha'))

    await manager.setActive(entry.id)

    await expect(manager.getActive()).resolves.toEqual(entry)
  })

  it('检查存在和缺失项目的可用性', async () => {
    const root = await createRoot()
    const existingPath = join(root, 'existing')
    await mkdir(existingPath)
    const manager = new ProjectsManager(join(root, 'projects.json'))
    const existing = await manager.add(existingPath)
    const missing = await manager.add(join(root, 'missing'))

    await expect(manager.checkAvailability(existing.id)).resolves.toBe(true)
    await expect(manager.checkAvailability(missing.id)).resolves.toBe(false)
  })

  it('从旧 last-session 迁移第一个活动项目', async () => {
    const root = await createRoot()
    const storagePath = join(root, 'projects.json')
    const projectPath = join(root, 'legacy-project')
    const lastSessionPath = join(root, 'last-session.json')
    await writeFile(lastSessionPath, JSON.stringify({ folder: projectPath, watching: true, updatedAt: 1 }), 'utf8')
    const manager = new ProjectsManager(storagePath)

    await manager.migrateFromLastSession(lastSessionPath)

    await expect(manager.list()).resolves.toMatchObject([{ name: 'legacy-project', path: projectPath }])
    await expect(manager.getActive()).resolves.toMatchObject({ path: projectPath })
  })

  it('损坏存储回退为空列表而不崩溃', async () => {
    const root = await createRoot()
    const storagePath = join(root, 'projects.json')
    await writeFile(storagePath, '{broken', 'utf8')
    const manager = new ProjectsManager(storagePath)

    await expect(manager.list()).resolves.toEqual([])
  })
})
