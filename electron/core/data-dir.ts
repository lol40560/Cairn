import * as fs from 'node:fs'
import * as path from 'node:path'

const LEGACY_DATA_DIRECTORY = '.vibeswarm'
const DATA_DIRECTORY = '.cairn'

type DataDirectoryFs = Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'renameSync'>

/** 确保项目使用 Cairn 数据目录，并尽力迁移旧版目录。 */
export function ensureCairnDataDir(
  projectRoot: string,
  fileSystem: DataDirectoryFs = fs,
): string {
  const cairnDir = path.join(projectRoot, DATA_DIRECTORY)
  const legacyDir = path.join(projectRoot, LEGACY_DATA_DIRECTORY)

  if (fileSystem.existsSync(cairnDir)) {
    return cairnDir
  }

  if (fileSystem.existsSync(legacyDir)) {
    try {
      fileSystem.renameSync(legacyDir, cairnDir)
      console.info('[cairn] 已迁移 .vibeswarm → .cairn')
      return cairnDir
    } catch (error) {
      console.error('[cairn] 数据目录迁移失败，将使用新的 .cairn 目录', error)
      fileSystem.mkdirSync(cairnDir, { recursive: true })
      return cairnDir
    }
  }

  fileSystem.mkdirSync(cairnDir, { recursive: true })
  return cairnDir
}
