import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'

import { ChevronRight, ChevronsUp, File as FileIconDefault, FileCode2, FileImage, FileJson2, FileText, Folder, FolderOpen } from 'lucide-react'

import { useTranslation } from '@/i18n'
import { buildFileTree, type TreeNode } from '@/lib/file-tree'
import type { ConflictRiskLevel } from '@/lib/conflictIntelligence'
import type { ProjectFileEntry } from '@/types/cairn'

interface FileTreeProps {
  files: ProjectFileEntry[]
  selectedPath: string | undefined
  recentActivity?: Record<string, string>
  conflictRisks?: Record<string, { level: Exclude<ConflictRiskLevel, 'none'>; label: string }>
  onSelect(path: string): void
  filter: string
  onContextMenu?(event: MouseEvent<HTMLButtonElement>, path: string): void
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
  onContextMenu?(event: MouseEvent<HTMLButtonElement>, path: string): void
  recentActivity?: Record<string, string>
  conflictRisks?: Record<string, { level: Exclude<ConflictRiskLevel, 'none'>; label: string }>
  onToggle(path: string): void
  selectedPath: string | undefined
}

function TreeRows({ collapsedPaths, nodes, onContextMenu, onSelect, onToggle, recentActivity, conflictRisks, selectedPath }: TreeRowsProps) {
  return nodes.map((node) => {
    const collapsed = collapsedPaths.has(node.path)
    const selected = node.type === 'file' && selectedPath === node.path
    if (node.type === 'directory') {
      return (
        <div key={node.path} className="file-tree-group">
          <button
            aria-expanded={!collapsed}
            className="file-tree-node file-tree-directory"
            data-path={node.path}
            data-tree-node="directory"
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
                onContextMenu={onContextMenu}
                recentActivity={recentActivity}
                conflictRisks={conflictRisks}
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
        data-path={node.path}
        data-tree-node="file"
        title={node.path}
        type="button"
        onClick={() => onSelect(node.path)}
        onContextMenu={(event) => {
          if (!onContextMenu) return
          event.preventDefault()
          onContextMenu(event, node.path)
        }}
      >
        <span aria-hidden="true" className="file-tree-indent" />
        <FileIcon name={node.name} />
        <span className="file-tree-name">{node.name}</span>
        {conflictRisks?.[node.path]
          ? <span aria-label={conflictRisks[node.path].label} className={`file-tree-presence ${conflictRisks[node.path].level}`} title={conflictRisks[node.path].label} />
          : recentActivity?.[node.path] ? <span aria-label={recentActivity[node.path]} className="file-tree-presence shared-recent" title={recentActivity[node.path]} /> : null}
      </button>
    )
  })
}

/** 只读项目文件树；筛选仅影响可见节点，不改变选择状态。 */
export function FileTree({ files, selectedPath, onContextMenu, onSelect, filter, recentActivity, conflictRisks }: FileTreeProps) {
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

  const collapseAll = (): void => {
    const paths = new Set<string>()
    const collectDirectories = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'directory') {
          paths.add(node.path)
          collectDirectories(node.children)
        }
      }
    }
    collectDirectories(tree)
    setCollapsedPaths(paths)
  }

  const moveFocus = (container: HTMLElement, direction: -1 | 1): void => {
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.file-tree-node'))
    const currentIndex = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next = rows[currentIndex + direction]
    next?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLButtonElement
    if (!target.classList.contains('file-tree-node')) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveFocus(event.currentTarget, 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.currentTarget, -1)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.file-tree-node'))
      ;(event.key === 'Home' ? rows[0] : rows.at(-1))?.focus()
      return
    }

    const path = target.dataset.path
    const isDirectory = target.dataset.treeNode === 'directory'
    if (!path || !isDirectory) return

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (collapsedPaths.has(path)) {
        togglePath(path)
      } else {
        const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.file-tree-node'))
        rows[rows.indexOf(target) + 1]?.focus()
      }
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (!collapsedPaths.has(path)) {
        togglePath(path)
      } else {
        const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined
        if (parentPath) {
          Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.file-tree-node'))
            .find((row) => row.dataset.path === parentPath)?.focus()
        }
      }
    }
  }

  return (
    <nav aria-label="Project files" className="file-tree" onKeyDown={handleKeyDown}>
      {tree.length > 0 ? (
        <div className="file-tree-toolbar">
          <button aria-label={t('collapseAllFolders')} className="file-tree-utility" title={t('collapseAllFolders')} type="button" onClick={collapseAll}>
            <ChevronsUp aria-hidden="true" size={14} />
          </button>
        </div>
      ) : null}
      {tree.length === 0 ? (
        <div className="file-tree-empty">
          {filter.trim() ? t('filesNoResults').replace('{query}', filter.trim()) : t('filesEmpty')}
        </div>
      ) : (
        <TreeRows
          collapsedPaths={collapsedPaths}
          nodes={tree}
          selectedPath={selectedPath}
          onContextMenu={onContextMenu}
          recentActivity={recentActivity}
          conflictRisks={conflictRisks}
          onSelect={onSelect}
          onToggle={togglePath}
        />
      )}
    </nav>
  )
}
