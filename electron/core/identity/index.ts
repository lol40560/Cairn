import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MANIFESTS = ['package.json', 'pubspec.yaml', 'Cargo.toml', 'pyproject.toml', 'go.mod']

export interface ProjectIdentity {
  projectName: string
  fingerprint: string
  baseCommit?: string
}

/** 以版本基準、常見專案設定與目錄名稱計算穩定的工作區識別碼。 */
export async function computeProjectIdentity(projectRoot: string): Promise<ProjectIdentity> {
  const projectName = basename(projectRoot)
  const parts = [projectName]
  let baseCommit: string | undefined

  try {
    await access(join(projectRoot, '.git', 'HEAD'))
    const result = await execFileAsync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { timeout: 2_000 })
    baseCommit = result.stdout.trim() || undefined
    if (baseCommit) parts.push(`git:${baseCommit}`)
  } catch {
    // 非 Git 專案或 Git 無法讀取時，仍以 manifest 與目錄名稱建立識別碼。
  }

  for (const manifest of MANIFESTS) {
    try {
      const content = await readFile(join(projectRoot, manifest), 'utf8')
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
      parts.push(`${manifest}:${hash}`)
    } catch {
      // 專案不一定包含每一種語言或工具鏈的 manifest。
    }
  }

  const fingerprint = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)
  return { baseCommit, fingerprint, projectName }
}
