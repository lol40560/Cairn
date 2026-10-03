import ignore, { type Ignore } from 'ignore'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 所有專案都應略過的常見內部目錄與建置產物。 */
export const DEFAULT_IGNORE_PATTERNS = [
  '.git',
  '.cairn',
  '.vibeswarm',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'target',
  'coverage',
  '.DS_Store',
]

const SENSITIVE_IGNORE_PATTERNS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa',
  'id_ed25519',
  '.npmrc',
  '.netrc',
  'credentials.json',
]

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').replace(/^\.\//, '')
}

function countRules(content: string): number {
  return content
    .split(/\r?\n/)
    .filter((line) => {
      const rule = line.trim()
      return rule.length > 0 && !rule.startsWith('#')
    })
    .length
}

/**
 * 依序疊加 Cairn 預設、.gitignore 與 .cairnignore。
 * ignore 套件遵循 Git 的規則語意，後加入的否定規則可覆蓋先前規則。
 */
export class IgnoreMatcher {
  private matcher: Ignore
  private readonly projectRoot: string
  private readonly sensitiveMatcher: Ignore

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
    this.matcher = ignore()
    this.sensitiveMatcher = ignore().add(SENSITIVE_IGNORE_PATTERNS)
    this.reload()
  }

  reload(): void {
    this.matcher = ignore().add(DEFAULT_IGNORE_PATTERNS)

    let rulesCount = DEFAULT_IGNORE_PATTERNS.length
    rulesCount += this.addFile(join(this.projectRoot, '.gitignore'))
    rulesCount += this.addFile(join(this.projectRoot, '.cairnignore'))

    console.info(`[cairn:ignore] 已載入 ${rulesCount} 條規則（來自 .gitignore 和 .cairnignore）`)
  }

  isIgnored(relativePath: string): boolean {
    const normalizedPath = normalizeRelativePath(relativePath)
    if (normalizedPath.length === 0) return false

    // 範本檔可安全共享，其他敏感檔案一律不允許被規則重新納入。
    if (!normalizedPath.endsWith('.env.example') && this.sensitiveMatcher.ignores(normalizedPath)) {
      return true
    }

    return this.matcher.ignores(normalizedPath)
  }

  private addFile(filePath: string): number {
    if (!existsSync(filePath)) return 0

    try {
      const content = readFileSync(filePath, 'utf8')
      this.matcher.add(content)
      return countRules(content)
    } catch (error) {
      console.warn(`[cairn:ignore] 讀取 ${filePath} 失敗：${String(error)}`)
      return 0
    }
  }
}

/** 供其他核心模組使用的敏感檔案快速判斷，.env.example 是明確例外。 */
export function isSensitiveFile(relativePath: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath)
  return !normalizedPath.endsWith('.env.example')
    && ignore().add(SENSITIVE_IGNORE_PATTERNS).ignores(normalizedPath)
}
