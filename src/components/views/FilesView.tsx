import { useCallback, useEffect, useRef, useState } from 'react'

import { Editor } from '@monaco-editor/react'

import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FileTree } from '@/components/FileTree'
import { Toast, type ToastMessage } from '@/components/Toast'
import { useTranslation } from '@/i18n'
import { detectLanguage } from '@/lib/detect-language'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { useAppStore } from '@/store/appStore'
import type { IpcResult, ProjectFileContent, ProjectFileEntry } from '@/types/cairn'

function getIpcData<T>(result: IpcResult<T>): T {
  if (!result.ok) throw result.error
  return result.data
}

interface FilesViewProps {
  /** 静态渲染测试可传入文件快照；运行时读取 store。 */
  files?: ProjectFileEntry[]
}

/** 项目文本文件浏览与编辑器；所有读取和保存均经受限 IPC。 */
export function FilesView({ files: filesOverride }: FilesViewProps) {
  const { t } = useTranslation()
  const folder = useAppStore((state) => state.folder)
  const fileFilter = useAppStore((state) => state.fileFilter)
  const storedProjectFiles = useAppStore((state) => state.projectFiles)
  const projectFiles = filesOverride ?? storedProjectFiles
  const selectedFilePath = useAppStore((state) => state.selectedFilePath)
  const setFileFilter = useAppStore((state) => state.setFileFilter)
  const setProjectFiles = useAppStore((state) => state.setProjectFiles)
  const setSelectedFilePath = useAppStore((state) => state.setSelectedFilePath)
  const [selectedFile, setSelectedFile] = useState<ProjectFileContent | undefined>()
  const [toast, setToast] = useState<ToastMessage | NormalizedError | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [lastSaveError, setLastSaveError] = useState<string | undefined>()
  const [pendingSwitchPath, setPendingSwitchPath] = useState<string | undefined>()
  const loadRequestId = useRef(0)
  const saveHandlerRef = useRef<() => Promise<void>>(async () => undefined)

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

  const handleSave = useCallback(async (): Promise<void> => {
    if (!selectedFilePath || !isDirty || saving) return

    setSaving(true)
    setLastSaveError(undefined)
    try {
      getIpcData(await window.cairn.saveProjectFile(selectedFilePath, editorContent))
      setSavedContent(editorContent)
      setSelectedFile((file) => file ? { ...file, content: editorContent } : file)
      setIsDirty(false)
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

  return (
    <section className="view active files-view">
      <div className="view-header files-view-header">
        <h1 className="view-title">{t('files')}</h1>
        <span className="view-spacer" />
        <div className="files-status" aria-live="polite">
          {saving ? <span className="files-status-saving">{t('filesSaving')}</span> : null}
          {!saving && isDirty ? (
            <span className="files-status-dirty">{t('filesUnsaved')} · {t('filesSaveShortcut')}</span>
          ) : null}
          {!saving && !isDirty && lastSaveError ? <span className="files-status-error">{lastSaveError}</span> : null}
        </div>
        <button className="btn btn-ghost btn-sm" disabled={!isDirty || saving} type="button" onClick={() => void handleSave()}>
          {t('filesSave')}
        </button>
        <label className="files-search">
          <span className="sr-only">{t('filesSearchPlaceholder')}</span>
          <input
            placeholder={t('filesSearchPlaceholder')}
            type="search"
            value={fileFilter}
            onChange={(event) => setFileFilter(event.target.value)}
          />
        </label>
      </div>
      {projectFiles.length === 0 ? (
        <div className="empty files-empty">
          <p className="empty-title">{t('filesEmpty')}</p>
        </div>
      ) : (
        <div className="files-layout">
          <aside className="files-sidebar">
            <FileTree
              files={projectFiles}
              filter={fileFilter}
              selectedPath={selectedFilePath}
              onSelect={selectFile}
            />
          </aside>
          <div className="files-main">
            {selectedFile ? (
              <>
                <div className="files-main-title" title={selectedFile.path}>{selectedFile.path}</div>
                <div className="files-editor">
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
              </>
            ) : (
              <div className="files-main-empty">{t('fileSelectHint')}</div>
            )}
          </div>
        </div>
      )}
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
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </section>
  )
}
