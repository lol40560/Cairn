import { describe, expect, it, vi } from 'vitest'

import { exportPR, type ExportPRInput } from './pr'
import type { ShadowGit } from './shadow'

const options: ExportPRInput = {
  branch: 'main',
  owner: 'acme',
  prBranch: 'cairn-ROOM',
  repo: 'demo',
  title: '同步修改',
  token: 'secret',
}

function shadow(): ShadowGit {
  return {
    close: vi.fn(),
    commitOp: vi.fn(),
    getRemoteInfo: vi.fn(),
    init: vi.fn(),
    listCommits: vi.fn(async () => [{ message: 'one', sha: 'local', timestamp: 1 }]),
    listFiles: vi.fn(async () => [{ content: 'export const value = 2\n', path: 'sample.ts' }]),
    setRemoteInfo: vi.fn(),
    squashCommits: vi.fn(async () => 'squashed'),
  }
}

function octokit({ empty = false, missingBranch = false, prBranchExists = false, createPrFails = false } = {}) {
  const calls: string[] = []
  const getRef = vi.fn(async ({ ref }: { ref: string }) => {
    calls.push('getRef')
    if (ref === 'heads/main') {
      if (missingBranch) throw { status: 404 }
      return { data: { object: { sha: 'base-head' } } }
    }
    if (ref.startsWith('heads/cairn-')) {
      if (!prBranchExists) throw { status: 404 }
      return { data: { object: { sha: 'existing-pr-head' } } }
    }
    return { data: { object: { sha: 'base-head' } } }
  })
  const getCommit = vi.fn(async () => {
    calls.push('getCommit')
    return { data: { tree: { sha: 'base-tree' } } }
  })
  const createBlob = vi.fn(async () => {
    calls.push('createBlob')
    return { data: { sha: 'blob-sha' } }
  })
  const createTree = vi.fn(async () => {
    calls.push('createTree')
    return { data: { sha: 'tree-sha' } }
  })
  const createCommit = vi.fn(async () => {
    calls.push('createCommit')
    return { data: { sha: 'commit-sha' } }
  })
  const createRef = vi.fn(async () => {
    calls.push('createRef')
    return { data: {} }
  })
  const updateRef = vi.fn(async () => {
    calls.push('updateRef')
    return { data: {} }
  })
  const deleteRef = vi.fn(async () => {
    calls.push('deleteRef')
    return { data: {} }
  })
  const pullsCreate = vi.fn(async () => {
    calls.push('pulls.create')
    if (createPrFails) throw new Error('GitHub PR API failed')
    return { data: { html_url: 'https://github.com/acme/demo/pull/7', number: 7 } }
  })
  const reposGet = vi.fn(async () => ({ data: { size: empty ? 0 : 1 } }))
  return {
    calls,
    client: { git: { createBlob, createCommit, createRef, createTree, deleteRef, getCommit, getRef, updateRef }, pulls: { create: pullsCreate }, repos: { get: reposGet } },
    createBlob,
    createCommit,
    createRef,
    createTree,
    deleteRef,
  }
}

describe('exportPR', () => {
  it('以目标分支 HEAD 为 parent 并按 Git Data API 顺序创建 PR', async () => {
    const fake = octokit()
    const result = await exportPR(shadow(), options, { octokit: fake.client as never })

    expect(fake.calls).toEqual(['getRef', 'getCommit', 'getRef', 'createBlob', 'createTree', 'createCommit', 'createRef', 'pulls.create'])
    expect(fake.createBlob).toHaveBeenCalledWith(expect.objectContaining({ content: Buffer.from('export const value = 2\n').toString('base64'), encoding: 'base64' }))
    expect(fake.createTree).toHaveBeenCalledWith(expect.objectContaining({ base_tree: 'base-tree', tree: [{ mode: '100644', path: 'sample.ts', sha: 'blob-sha', type: 'blob' }] }))
    expect(fake.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: ['base-head'], tree: 'tree-sha' }))
    expect(result).toEqual({ prNumber: 7, prUrl: 'https://github.com/acme/demo/pull/7' })
  })

  it('空仓库创建无 parent 的首个 commit/ref', async () => {
    const fake = octokit({ empty: true, missingBranch: true })
    await exportPR(shadow(), options, { octokit: fake.client as never })

    expect(fake.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: [] }))
  })

  it('无 token 时抛出明确错误', async () => {
    await expect(exportPR(shadow(), { ...options, token: '' })).rejects.toThrow(
      'PR 导出所需的 owner、repo、token 和 title 不能为空',
    )
  })

  it('非空仓库缺少目标分支时抛出明确错误', async () => {
    const fake = octokit({ missingBranch: true })
    await expect(exportPR(shadow(), options, { octokit: fake.client as never })).rejects.toThrow('目标分支 main')
  })

  it('PR 分支已存在时不创建 ref，并提示重试', async () => {
    const fake = octokit({ prBranchExists: true })

    await expect(exportPR(shadow(), options, { octokit: fake.client as never })).rejects.toThrow(
      'PR 分支已存在，请重试',
    )
    expect(fake.createRef).not.toHaveBeenCalled()
  })

  it('创建 PR 失败时保留已经创建的分支', async () => {
    const fake = octokit({ createPrFails: true })

    await expect(exportPR(shadow(), options, { octokit: fake.client as never })).rejects.toThrow(
      'GitHub PR API failed',
    )
    expect(fake.createRef).toHaveBeenCalledOnce()
    expect(fake.deleteRef).not.toHaveBeenCalled()
  })

  it('省略 branch 时默认使用 main', async () => {
    const fake = octokit()

    await exportPR(shadow(), { ...options, branch: undefined }, { octokit: fake.client as never })

    expect(fake.client.git.getRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/main' }),
    )
    expect(fake.client.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'main' }),
    )
  })

  it('省略 prBranch 时默认使用带时间戳的手动分支', async () => {
    const fake = octokit()
    vi.spyOn(Date, 'now').mockReturnValue(1727104500000)

    await exportPR(shadow(), { ...options, prBranch: undefined }, { octokit: fake.client as never })

    expect(fake.createRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'refs/heads/cairn-manual-1727104500000' }),
    )
    vi.restoreAllMocks()
  })
})
