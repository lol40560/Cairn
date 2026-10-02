import { useMemo, useState } from 'react'

import { ChevronRight, File as FileIconDefault, FileCode2, FileImage, FileJson2, FileText, Folder, FolderOpen } from 'lucide-react'

import { useTranslation } from '@/i18n'
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
    return <FileJson2 aria-hidden="true" className="file-tree-icon file-tree-icon-code" />
  }
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'html', 'htm', 'css', 'scss'].includes(extension ?? '')) {
    return <FileCode2 aria-hidden="true" className="file-tree-icon file-tree-icon-code" />
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension ?? '')) {
    return <FileImage aria-hidden="true" className="file-tree-icon file-tree-icon-image" />
  }
  if (extension === 'md' || extension === 'pdf') {
    return <FileText aria-hidden="true" className="file-tree-icon file-tree-icon-text" />
  }
  return <FileIconDefault aria-hidden="true" className="file-tree-icon file-tree-icon-text" />
}

interface TreeRowsProps {
  collapsedPaths: Set<string>
  nodes: TreeNode[]
  onSelect(path: string): void
  onToggle(path: string): void
  selectedPath: string | undefined
}

function TreeRows({ collapsedPaths, nodes, onSelect, onToggle, selectedPath }: TreeRowsProps) {
  return nodes.map((node) => {
    const collapsed = collapsedPaths.has(node.path)
    const selected = node.type === 'file' && selectedPath === node.path
    if (node.type === 'directory') {
      return (
        <div key={node.path} className="file-tree-group">
          <button
            aria-expanded={!collapsed}
            className="file-tree-node file-tree-directory"
            type="button"
            onClick={() => onToggle(node.path)}
          >
            <ChevronRight aria-hidden="true" className={`file-tree-chevron ${collapsed ? '' : 'open'}`} size={14} />
            {collapsed ? <Folder aria-hidden="true" className="file-tree-icon file-tree-icon-folder" /> : <FolderOpen aria-hidden="true" className="file-tree-icon file-tree-icon-folder" />}
            <span className="file-tree-name">{node.name}</span>
          </button>
          {!collapsed && (
            <div className="file-tree-children">
              <TreeRows
                collapsedPaths={collapsedPaths}
                nodes={node.children}
                selectedPath={selectedPath}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            </div>
          )}
        </div>
      )
    }

    return (
      <button
        key={node.path}
        aria-current={selected ? 'page' : undefined}
        className={`file-tree-node ${selected ? 'selected' : ''}`}
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
  const { t } = useTranslation()
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
      {tree.length === 0 ? (
        <div className="file-tree-empty">
          {filter.trim() ? t('filesNoResults').replace('{query}', filter.trim()) : t('filesEmpty')}
        </div>
      ) : (
        <TreeRows
          collapsedPaths={collapsedPaths}
          nodes={tree}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onToggle={togglePath}
        />
      )}
    </nav>
  )
}
