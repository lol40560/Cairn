import { Octokit } from '@octokit/rest'

import type { ShadowGit } from './shadow'

export interface ExportPRInput {
  owner: string
  repo: string
  token: string
  title: string
  branch?: string
  prBranch?: string
  body?: string
}

export interface PRExportResult {
  prUrl: string
  prNumber: number
}

export interface PRExportDependencies {
  octokit?: Octokit
}

interface ResolvedPRExportOptions extends ExportPRInput {
  branch: string
  prBranch: string
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404
}

export async function exportPR(
  shadowGit: ShadowGit,
  input: ExportPRInput,
  dependencies: PRExportDependencies = {},
): Promise<PRExportResult> {
  if (!input.owner || !input.repo || !input.token || !input.title) {
    throw new Error('PR 导出所需的 owner、repo、token 和 title 不能为空')
  }

  const options: ResolvedPRExportOptions = {
    ...input,
    branch: input.branch ?? 'main',
    prBranch: input.prBranch ?? `cairn-manual-${Date.now()}`,
  }

  const commits = await shadowGit.listCommits()
  if (commits.length === 0) {
    throw new Error('影子仓库没有可导出的提交')
  }
  await shadowGit.squashCommits(commits.length)
  const octokit = dependencies.octokit ?? new Octokit({ auth: options.token })
  let baseSha: string | undefined
  let baseTree: string | undefined
  try {
    const response = await octokit.git.getRef({ owner: options.owner, ref: `heads/${options.branch}`, repo: options.repo })
    baseSha = response.data.object.sha
    const baseCommit = await octokit.git.getCommit({ owner: options.owner, repo: options.repo, commit_sha: baseSha })
    baseTree = baseCommit.data.tree.sha
  } catch (error) {
    if (isNotFound(error)) {
      const repository = await octokit.repos.get({ owner: options.owner, repo: options.repo })
      if (repository.data.size === 0) {
        baseSha = undefined
        baseTree = undefined
      } else {
        throw new Error(`无法读取目标分支 ${options.branch}：该分支不存在`, { cause: error })
      }
    } else {
      throw new Error(
        `无法读取目标分支 ${options.branch}：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  // 导出前确认分支不存在，避免 createRef 遇到不明确的 422/not-fast-forward 错误。
  try {
    await octokit.git.getRef({
      owner: options.owner,
      ref: `heads/${options.prBranch}`,
      repo: options.repo,
    })
    throw new Error(`PR 分支已存在，请重试：${options.prBranch}`)
  } catch (error) {
    if (!isNotFound(error)) {
      throw error
    }
  }

  const files = await shadowGit.listFiles()
  const tree = []
  for (const file of files) {
    const blob = await octokit.git.createBlob({ owner: options.owner, repo: options.repo, content: Buffer.from(file.content).toString('base64'), encoding: 'base64' })
    tree.push({ path: file.path, mode: '100644' as const, type: 'blob' as const, sha: blob.data.sha })
  }
  const createdTree = await octokit.git.createTree({ owner: options.owner, repo: options.repo, base_tree: baseTree, tree })
  const commit = await octokit.git.createCommit({ owner: options.owner, repo: options.repo, message: options.title, tree: createdTree.data.sha, parents: baseSha ? [baseSha] : [] })
  await octokit.git.createRef({
    owner: options.owner,
    repo: options.repo,
    ref: `refs/heads/${options.prBranch}`,
    sha: commit.data.sha,
  })
  console.log(`Cairn PR branch created: https://github.com/${options.owner}/${options.repo}/tree/${options.prBranch}`)

  // PR 创建失败时保留分支与 commit，避免误删已成功创建的 PR 引用。
  const pr = await octokit.pulls.create({
    owner: options.owner,
    repo: options.repo,
    title: options.title,
    body: options.body,
    head: options.prBranch,
    base: options.branch,
  })
  console.log(`Cairn PR created: ${pr.data.html_url}`)
  return { prNumber: pr.data.number, prUrl: pr.data.html_url }
}
