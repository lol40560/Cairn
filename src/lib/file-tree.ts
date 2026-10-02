import type { ProjectFileEntry } from '@/types/cairn'

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children: TreeNode[]
  size?: number
}

/** 将扁平文件列表转换为按目录展示的稳定树结构。 */
export function buildFileTree(files: ProjectFileEntry[]): TreeNode[] {
  const root: TreeNode = { children: [], name: '', path: '', type: 'directory' }

  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean)
    let parent = root
    for (const [index, segment] of segments.entries()) {
      const isFile = index === segments.length - 1
      const path = segments.slice(0, index + 1).join('/')
      let node = parent.children.find((child) => child.name === segment && child.type === (isFile ? 'file' : 'directory'))
      if (!node) {
        node = { children: [], name: segment, path, type: isFile ? 'file' : 'directory', ...(isFile ? { size: file.size } : {}) }
        parent.children.push(node)
      }
      parent = node
    }
  }

  const sortNodes = (nodes: TreeNode[]): TreeNode[] => nodes
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    .map((node) => ({ ...node, children: sortNodes(node.children) }))

  return sortNodes(root.children)
}
