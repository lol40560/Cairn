import { useCallback, useEffect, useState } from 'react'

import { Editor } from '@monaco-editor/react'

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

/** 项目文本文件的安全只读浏览器，文件内容仅经 IPC 从主进程读取。 */
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
      void loadFiles()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [folder, loadFiles, setSelectedFilePath])

  const selectFile = async (path: string): Promise<void> => {
    setSelectedFilePath(path)
    try {
      setSelectedFile(getIpcData(await window.cairn.readProjectFile(path)))
    } catch (error) {
      console.error(`[cairn:files] 无法读取文件 ${path}`, error)
      setSelectedFile(undefined)
      setToast(
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'FILE_TOO_LARGE'
          ? { message: t('fileTooLarge'), tone: 'error' }
          : normalizeError(error, t),
      )
    }
  }

  return (
    <section className="view active files-view">
      <div className="view-header files-view-header">
        <h1 className="view-title">{t('files')}</h1>
        <span className="view-spacer" />
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
              onSelect={(path) => void selectFile(path)}
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
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 13,
                      minimap: { enabled: false },
                      readOnly: true,
                      scrollBeyondLastLine: false,
                      scrollbar: { horizontalScrollbarSize: 8, verticalScrollbarSize: 8 },
                    }}
                    path={`inmemory://cairn/files/${encodeURIComponent(selectedFile.path)}`}
                    theme="vs-dark"
                    value={selectedFile.content}
                  />
                </div>
              </>
            ) : (
              <div className="files-main-empty">{t('fileSelectHint')}</div>
            )}
          </div>
        </div>
      )}
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </section>
  )
}
