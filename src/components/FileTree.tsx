import { useMemo, useState } from 'react'

import { ChevronDown, ChevronRight, FileCode2, FileJson2, FileText, Folder, FolderOpen } from 'lucide-react'

import { buildFileTree, type TreeNode } from '@/lib/file-tree'
import type { ProjectFileEntry } from '@/types/cairn'

interface FileTreeProps {
  files: ProjectFileEntry[]
  selectedPath: string | undefined
  onSelect(path: string): void
  filter: string
}

function FileIcon({ name }: { name: string }) {
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension === 'json' || extension === 'yml' || extension === 'yaml') {
    return <FileJson2 aria-hidden="true" className="file-tree-icon" />
  }
  if (['ts', 'tsx', 'js', 'jsx', 'css', 'html', 'py', 'go', 'rs', 'java', 'c', 'cpp'].includes(extension ?? '')) {
    return <FileCode2 aria-hidden="true" className="file-tree-icon" />
  }
  return <FileText aria-hidden="true" className="file-tree-icon" />
}

interface TreeRowsProps {
  collapsedPaths: Set<string>
  depth?: number
  nodes: TreeNode[]
  onSelect(path: string): void
  onToggle(path: string): void
  selectedPath: string | undefined
}

function TreeRows({ collapsedPaths, depth = 0, nodes, onSelect, onToggle, selectedPath }: TreeRowsProps) {
  return nodes.map((node) => {
    const collapsed = collapsedPaths.has(node.path)
    const selected = node.type === 'file' && selectedPath === node.path
    const indent = { paddingLeft: `${8 + depth * 16}px` }

    if (node.type === 'directory') {
      return (
        <div key={node.path}>
          <button
            aria-expanded={!collapsed}
            className="file-tree-node file-tree-directory"
            style={indent}
            type="button"
            onClick={() => onToggle(node.path)}
          >
            {collapsed ? <ChevronRight aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}
            {collapsed ? <Folder aria-hidden="true" className="file-tree-icon" /> : <FolderOpen aria-hidden="true" className="file-tree-icon" />}
            <span className="file-tree-name">{node.name}</span>
          </button>
          {!collapsed && (
            <TreeRows
              collapsedPaths={collapsedPaths}
              depth={depth + 1}
              nodes={node.children}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          )}
        </div>
      )
    }

    return (
      <button
        key={node.path}
        aria-current={selected ? 'page' : undefined}
        className={`file-tree-node ${selected ? 'selected' : ''}`}
        style={indent}
        title={node.path}
        type="button"
        onClick={() => onSelect(node.path)}
      >
        <span aria-hidden="true" className="file-tree-indent" />
        <FileIcon name={node.name} />
        <span className="file-tree-name">{node.name}</span>
      </button>
    )
  })
}

/** 只读项目文件树；筛选仅影响可见节点，不改变选择状态。 */
export function FileTree({ files, selectedPath, onSelect, filter }: FileTreeProps) {
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set())
  const tree = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    const visibleFiles = query ? files.filter((file) => file.path.toLocaleLowerCase().includes(query)) : files
    return buildFileTree(visibleFiles)
  }, [files, filter])

  const togglePath = (path: string): void => {
    setCollapsedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <nav aria-label="Project files" className="file-tree">
      <TreeRows
        collapsedPaths={collapsedPaths}
        nodes={tree}
        selectedPath={selectedPath}
        onSelect={onSelect}
        onToggle={togglePath}
      />
    </nav>
  )
}
