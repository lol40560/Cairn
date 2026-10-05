import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { Editor } from '@monaco-editor/react'
import { FileCode2, Search } from 'lucide-react'

import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'
import { EmptyState } from '@/components/EmptyState'
import { Spinner } from '@/components/Spinner'
import { FileTree } from '@/components/FileTree'
import { OpDiffDialog } from '@/components/OpDiffDialog'
import { Toast, type ToastMessage } from '@/components/Toast'
import { useTranslation } from '@/i18n'
import { detectLanguage } from '@/lib/detect-language'
import { getConflictRisk, remoteAuthorForRisk } from '@/lib/conflictIntelligence'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { useAppStore } from '@/store/appStore'
import type { IpcResult, Op, ProjectFileContent, ProjectFileEntry } from '@/types/cairn'

function getIpcData<T>(result: IpcResult<T>): T {
  if (!result.ok) throw result.error
  return result.data
}

function formatRecentTime(timestamp: number, t: ReturnType<typeof useTranslation>['t']): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000)
  if (minutes < 1) return t('justNow')
  return minutes === 1 ? t('minuteAgo') : t('minutesAgo').replace('{n}', String(minutes))
}

interface FilesViewProps {
  /** 静态渲染测试可传入文件快照；运行时读取 store。 */
  files?: ProjectFileEntry[]
  /** 静态渲染测试可传入当前选择；运行时读取 store。 */
  selectedPath?: string
}

/** 偵測副檔名與文字內容不一致的常見誤命名情況。 */
// eslint-disable-next-line react-refresh/only-export-components
export function detectMisleadingContent(filePath: string, content: string): 'rtf' | 'html' | undefined {
  const extension = filePath.split('.').pop()?.toLowerCase()
  if (extension !== 'md' && extension !== 'txt') return undefined

  if (content.startsWith('{\\rtf')) return 'rtf'
  if (/^<!DOCTYPE html/i.test(content.trim())) return 'html'

  return undefined
}

/** 项目文本文件浏览与编辑器；所有读取和保存均经受限 IPC。 */
export function FilesView({ files: filesOverride, selectedPath: selectedPathOverride }: FilesViewProps) {
  const { t } = useTranslation()
  const folder = useAppStore((state) => state.folder)
  const fileFilter = useAppStore((state) => state.fileFilter)
  const storedProjectFiles = useAppStore((state) => state.projectFiles)
  const ops = useAppStore((state) => state.ops)
  const conflicts = useAppStore((state) => state.conflicts)
  const projectFiles = filesOverride ?? storedProjectFiles
  const storedSelectedFilePath = useAppStore((state) => state.selectedFilePath)
  const selectedFilePath = selectedPathOverride ?? storedSelectedFilePath
  const setFileFilter = useAppStore((state) => state.setFileFilter)
  const fileTreeWidth = useAppStore((state) => state.fileTreeWidth)
  const setFileTreeWidth = useAppStore((state) => state.setFileTreeWidth)
  const setProjectFiles = useAppStore((state) => state.setProjectFiles)
  const setSelectedFilePath = useAppStore((state) => state.setSelectedFilePath)
  const setFileDirty = useAppStore((state) => state.setFileDirty)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const [selectedFile, setSelectedFile] = useState<ProjectFileContent | undefined>()
  const [toast, setToast] = useState<ToastMessage | NormalizedError | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [lastSaveError, setLastSaveError] = useState<string | undefined>()
  const [justSaved, setJustSaved] = useState(false)
  const [pendingSwitchPath, setPendingSwitchPath] = useState<string | undefined>()
  const [contextMenu, setContextMenu] = useState<{ items: ContextMenuItem[]; x: number; y: number } | undefined>()
  const [presenceClock, setPresenceClock] = useState(() => Date.now())
  const [reviewOp, setReviewOp] = useState<Op | undefined>()
  const loadRequestId = useRef(0)
  const initialFolder = useRef(folder)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const saveHandlerRef = useRef<() => Promise<void>>(async () => undefined)
  const contentMismatch = selectedFile ? detectMisleadingContent(selectedFile.path, selectedFile.content) : undefined
  const risksByPath = useMemo(() => Object.fromEntries(projectFiles.flatMap((file) => {
    const risk = getConflictRisk({ filePath: file.path, ops, conflicts, dirty: file.path === selectedFilePath && isDirty, now: presenceClock })
    if (risk.level === 'none') return []
    const author = remoteAuthorForRisk(ops, file.path, presenceClock) ?? risk.contributors[0]
    const label = risk.level === 'confirmed-conflict'
      ? t('conflictDetected')
      : risk.level === 'potential-overlap'
        ? t('potentialOverlap')
        : t('recentRemoteChange').replace('{author}', author ?? t('peers')).replace('{time}', formatRecentTime(risk.latestActivityAt, t))
    return [[file.path, { level: risk.level, label }]]
  })), [conflicts, isDirty, ops, presenceClock, projectFiles, selectedFilePath, t])
  const selectedRisk = selectedFilePath
    ? getConflictRisk({ filePath: selectedFilePath, ops, conflicts, dirty: isDirty, now: presenceClock })
    : undefined
  const reviewRemoteOp = selectedFilePath
    ? ops.filter((op) => op.filePath === selectedFilePath && op.source === 'remote').sort((a, b) => b.timestamp - a.timestamp)[0]
    : undefined

  useEffect(() => {
    const timer = window.setInterval(() => setPresenceClock(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const loadFiles = useCallback(async (): Promise<void> => {
    try {
      const result = getIpcData(await window.cairn.listProjectFiles())
      setProjectFiles(result.files)
      if (result.truncated) {
        setToast({ message: t('filesTooMany').replace('{n}', '5000') })
      }
    } catch (error) {
      console.error('[cairn:files] 无法读取项目文件', error)
      setProjectFiles([])
      setToast(normalizeError(error, t))
    }
  }, [setProjectFiles, t])

  useEffect(() => {
    if (initialFolder.current === folder) {
      void loadFiles()
      return
    }
    initialFolder.current = folder
    const timer = window.setTimeout(() => {
      setSelectedFilePath(undefined)
      setSelectedFile(undefined)
      setEditorContent('')
      setSavedContent('')
      setIsDirty(false)
      setLastSaveError(undefined)
      void loadFiles()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [folder, loadFiles, setSelectedFilePath])

  // 將 Monaco 的未保存狀態交給全域 recovery guard，避免 checkpoint 覆寫記憶體中的編輯。
  useEffect(() => {
    if (!selectedFilePath) return
    setFileDirty(selectedFilePath, isDirty)
    return () => setFileDirty(selectedFilePath, false)
  }, [isDirty, selectedFilePath, setFileDirty])

  const loadFile = useCallback(async (path: string): Promise<void> => {
    const requestId = loadRequestId.current + 1
    loadRequestId.current = requestId
    setSelectedFilePath(path)
    setLastSaveError(undefined)
    try {
      const file = getIpcData(await window.cairn.readProjectFile(path))
      if (requestId !== loadRequestId.current) return
      setSelectedFile(file)
      setEditorContent(file.content)
      setSavedContent(file.content)
      setIsDirty(false)
    } catch (error) {
      if (requestId !== loadRequestId.current) return
      console.error(`[cairn:files] 无法读取文件 ${path}`, error)
      setSelectedFile(undefined)
      setToast(
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'FILE_TOO_LARGE'
          ? { message: t('fileTooLarge'), tone: 'error' }
          : normalizeError(error, t),
      )
    }
  }, [setSelectedFilePath, t])

  const selectFile = (path: string): void => {
    if (path === selectedFilePath) return
    if (isDirty) {
      setPendingSwitchPath(path)
      return
    }
    void loadFile(path)
  }

  useEffect(() => {
    if (!selectedFilePath || selectedFile?.path === selectedFilePath) return
    const timer = window.setTimeout(() => void loadFile(selectedFilePath), 0)
    return () => window.clearTimeout(timer)
  }, [loadFile, selectedFile?.path, selectedFilePath])

  useEffect(() => {
    const openRequestedFile = (event: Event): void => {
      const path = (event as CustomEvent<string>).detail
      if (typeof path === 'string') selectFile(path)
    }
    const saveRequestedFile = (): void => void saveHandlerRef.current()
    window.addEventListener('cairn:open-file', openRequestedFile)
    window.addEventListener('cairn:save-current-file', saveRequestedFile)
    return () => {
      window.removeEventListener('cairn:open-file', openRequestedFile)
      window.removeEventListener('cairn:save-current-file', saveRequestedFile)
    }
  })

  const handleSave = useCallback(async (): Promise<void> => {
    if (!selectedFilePath || !isDirty || saving) return

    setSaving(true)
    setLastSaveError(undefined)
    try {
      getIpcData(await window.cairn.saveProjectFile(selectedFilePath, editorContent))
      setSavedContent(editorContent)
      setSelectedFile((file) => file ? { ...file, content: editorContent } : file)
      setIsDirty(false)
      setJustSaved(true)
    } catch (error) {
      console.error(`[cairn:files] 无法保存文件 ${selectedFilePath}`, error)
      const normalized = normalizeError(error, t)
      setLastSaveError(normalized.message)
      setToast(normalized)
    } finally {
      setSaving(false)
    }
  }, [editorContent, isDirty, saving, selectedFilePath, t])

  useEffect(() => {
    if (!justSaved) return undefined
    const timer = window.setTimeout(() => setJustSaved(false), 1_800)
    return () => window.clearTimeout(timer)
  }, [justSaved])

  useEffect(() => {
    saveHandlerRef.current = handleSave
  }, [handleSave])

  const handleEditorMount = useCallback((editor: { addCommand: (keybinding: number, handler: () => void) => void }, monaco: {
    KeyCode: { KeyS: number }
    KeyMod: { CtrlCmd: number }
  }): void => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveHandlerRef.current()
    })
  }, [])

  useEffect(() => {
    const unsubscribe = window.cairn.onOp((op) => {
      if (op.source !== 'remote' || op.filePath !== selectedFilePath) return
      if (isDirty) {
        setToast({ message: t('remoteChangeAvailable') })
        return
      }
      void loadFile(op.filePath)
    })
    return unsubscribe
  }, [isDirty, loadFile, selectedFilePath, t])

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = fileTreeWidth
    const resize = (moveEvent: PointerEvent): void => setFileTreeWidth(startWidth + moveEvent.clientX - startX)
    const finish = (): void => {
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', finish)
    }
    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', finish)
  }

  return (
    <section className="view active files-view">
      <header className="files-header">
        <h1 className="files-header-title">{t('files')}</h1>
        {selectedFilePath ? (
          <nav aria-label={selectedFilePath} className="files-breadcrumb">
            {selectedFilePath.split('/').map((part, index, parts) => (
              <span key={`${part}-${index}`}>
                {part}
                {index < parts.length - 1 ? <span aria-hidden="true" className="files-breadcrumb-sep">/</span> : null}
              </span>
            ))}
          </nav>
        ) : null}
        <div className="files-header-actions">
          <label className="files-search">
            <Search aria-hidden="true" size={13} />
            <span className="sr-only">{t('filesSearchPlaceholder')}</span>
            <input
              ref={searchInputRef}
              placeholder={t('filesSearchPlaceholder')}
              type="search"
              value={fileFilter}
              onChange={(event) => setFileFilter(event.target.value)}
            />
          </label>
          <div className="files-status" aria-live="polite">
            {saving ? <span className="files-status-saving"><Spinner size={12} />{t('filesSaving')}</span> : null}
            {!saving && isDirty ? <span className="files-status-dirty">{t('filesEditing')}</span> : null}
            {!saving && !isDirty && lastSaveError ? <span className="files-status-error">{lastSaveError}</span> : null}
            {!saving && !isDirty && !lastSaveError && selectedFilePath ? <span className={`files-status-saved${justSaved ? ' is-fresh' : ''}`}>{justSaved ? `✓ ${t('filesSaved')}` : t('filesSaved')}</span> : null}
          </div>
          {selectedFilePath ? (
            <button
              className={`btn btn-sm ${isDirty ? 'btn-primary' : ''}`}
              disabled={!isDirty || saving}
              aria-busy={saving}
              type="button"
              onClick={() => void handleSave()}
            >
              {saving ? t('filesSaving') : t('filesSave')}
              {!saving ? <span className="files-shortcut">⌘S</span> : null}
            </button>
          ) : null}
        </div>
      </header>
      <div className="files-layout">
        <aside className="files-sidebar" style={{ width: fileTreeWidth }}>
          <FileTree
            files={projectFiles}
            filter={fileFilter}
            selectedPath={selectedFilePath}
            conflictRisks={risksByPath}
            onContextMenu={(event, path) => setContextMenu({
              x: event.clientX,
              y: event.clientY,
              items: [
                { label: t('openFile'), onSelect: () => selectFile(path) },
                { label: t('copyPath'), onSelect: () => void window.cairn.copyToClipboard(path) },
                { label: t('revealInFinder'), onSelect: () => void window.cairn.openInFileManager(`${folder}/${path}`) },
              ],
            })}
            onSelect={selectFile}
          />
        </aside>
        <div
          aria-label={t('files')}
          aria-orientation="vertical"
          aria-valuemax={440}
          aria-valuemin={190}
          aria-valuenow={fileTreeWidth}
          className="files-resize-handle"
          role="separator"
          tabIndex={0}
          onPointerDown={beginResize}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setFileTreeWidth(fileTreeWidth - 12)
            if (event.key === 'ArrowRight') setFileTreeWidth(fileTreeWidth + 12)
          }}
        />
        <div className="files-main">
          {selectedFilePath && selectedRisk && selectedRisk.level !== 'none' ? (
            <div className={`file-collaboration-status ${selectedRisk.level}`} role="status">
              <span>{selectedRisk.level === 'confirmed-conflict'
                ? t('fileHasUnresolvedConflict')
                : selectedRisk.level === 'potential-overlap'
                  ? (isDirty ? t('dirtyRemoteOverlap') : t('potentialOverlap'))
                  : t('recentRemoteChange').replace('{author}', remoteAuthorForRisk(ops, selectedFilePath, presenceClock) ?? t('peers')).replace('{time}', formatRecentTime(selectedRisk.latestActivityAt, t))}</span>
              {selectedRisk.level === 'confirmed-conflict' ? <button className="btn btn-ghost btn-sm" type="button" onClick={() => setActiveView('conflicts')}>{t('reviewConflict')}</button> : null}
              {selectedRisk.level === 'potential-overlap' && reviewRemoteOp ? <button className="btn btn-ghost btn-sm" type="button" onClick={() => setReviewOp(reviewRemoteOp)}>{t('reviewChanges')}</button> : null}
            </div>
          ) : null}
          {selectedFile ? (
            <div className="files-editor">
              {contentMismatch ? (
                <div className="files-content-warning" role="status">
                  {contentMismatch === 'rtf' ? t('fileLooksLikeRtf') : t('fileLooksLikeHtml')}
                </div>
              ) : null}
              <div className="files-editor-monaco">
                <Editor
                  height="100%"
                  language={detectLanguage(selectedFile.path)}
                  options={{
                    automaticLayout: true,
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 13,
                    minimap: { enabled: false },
                    readOnly: false,
                    renderLineHighlight: 'all',
                    scrollBeyondLastLine: false,
                    scrollbar: { horizontalScrollbarSize: 8, verticalScrollbarSize: 8 },
                  }}
                  onChange={(value) => {
                    const content = value ?? ''
                    setEditorContent(content)
                    setIsDirty(content !== savedContent)
                  }}
                  onMount={handleEditorMount}
                  path={`inmemory://cairn/files/${encodeURIComponent(selectedFile.path)}`}
                  theme="vs-dark"
                  value={editorContent}
                />
              </div>
            </div>
          ) : (
            <EmptyState
              description={t('fileSelectHintDesc')}
              icon={FileCode2}
              title={t('fileSelectHint')}
            />
          )}
        </div>
      </div>
      <ConfirmDialog
        cancelLabel={t('filesCancel')}
        confirmLabel={t('filesDiscard')}
        danger
        message={t('filesDiscardConfirmMessage')}
        open={pendingSwitchPath !== undefined}
        title={t('filesDiscardConfirmTitle')}
        onCancel={() => setPendingSwitchPath(undefined)}
        onConfirm={() => {
          const path = pendingSwitchPath
          setPendingSwitchPath(undefined)
          if (path) void loadFile(path)
        }}
      />
      <OpDiffDialog open={Boolean(reviewOp)} op={reviewOp} onClose={() => setReviewOp(undefined)} />
      {contextMenu ? <ContextMenu items={contextMenu.items} position={contextMenu} onClose={() => setContextMenu(undefined)} /> : null}
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </section>
  )
}
