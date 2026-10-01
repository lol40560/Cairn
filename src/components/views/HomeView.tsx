import { useCallback, useEffect, useState } from 'react'

import { FolderPlus, Plus } from 'lucide-react'

import { Toast, type ToastMessage } from '@/components/Toast'
import { useTranslation, type TranslateFn } from '@/i18n'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { useAppStore } from '@/store/appStore'
import type { AvailableProjectEntry, IpcResult } from '@/types/cairn'

function getIpcData<T>(result: IpcResult<T>): T {
  if (!result.ok) throw result.error
  return result.data
}

function formatProjectRelativeTime(timestamp: number, t: TranslateFn): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return t('justNow')
  if (minutes < 60) return minutes === 1 ? t('minuteAgo') : t('minutesAgo').replace('{n}', String(minutes))

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? t('hourAgo') : t('hoursAgo').replace('{n}', String(hours))

  const days = Math.floor(hours / 24)
  if (days < 30) return days === 1 ? t('dayAgo') : t('daysAgo').replace('{n}', String(days))

  const months = Math.floor(days / 30)
  return months === 1 ? t('monthAgo') : t('monthsAgo').replace('{n}', String(months))
}

/** 本机项目索引的入口视图；文件内容始终经由主进程 IPC 访问。 */
interface HomeViewProps {
  /** 静态渲染测试可提供项目快照；运行时始终读取 store。 */
  projects?: AvailableProjectEntry[]
}

export function HomeView({ projects: projectsOverride }: HomeViewProps) {
  const { t } = useTranslation()
  const folder = useAppStore((state) => state.folder)
  const storedProjects = useAppStore((state) => state.projects)
  const projects = projectsOverride ?? storedProjects
  const replaceOps = useAppStore((state) => state.replaceOps)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const setFolder = useAppStore((state) => state.setFolder)
  const setProjects = useAppStore((state) => state.setProjects)
  const setStatus = useAppStore((state) => state.setStatus)
  const [toast, setToast] = useState<ToastMessage | NormalizedError | null>(null)

  const refreshProjects = useCallback(async (): Promise<void> => {
    try {
      setProjects(getIpcData(await window.cairn.listProjects()))
    } catch (error) {
      console.error('[cairn:home] 无法读取项目列表', error)
      setToast(normalizeError(error, t))
    }
  }, [setProjects, t])

  useEffect(() => {
    // 延后一帧读取，避免首次渲染期间同步更新外部 store。
    const timer = window.setTimeout(() => void refreshProjects(), 0)
    return () => window.clearTimeout(timer)
  }, [refreshProjects])

  const activateProject = async (projectPath: string): Promise<void> => {
    getIpcData(await window.cairn.startWatching(projectPath))
    setFolder(projectPath)
    setStatus('watching')
    replaceOps(getIpcData(await window.cairn.listRecentOps(200)))
    setActiveView('activity')
    await refreshProjects()
  }

  const openProject = async (project: AvailableProjectEntry): Promise<void> => {
    try {
      await activateProject(project.path)
    } catch (error) {
      console.error('[cairn:home] 无法打开项目', error)
      setToast(normalizeError(error, t))
    }
  }

  const addProject = async (): Promise<void> => {
    try {
      const selectedFolder = getIpcData(await window.cairn.selectFolder())
      if (!selectedFolder) return
      getIpcData(await window.cairn.addProject(selectedFolder))
      await refreshProjects()
      await activateProject(selectedFolder)
    } catch (error) {
      console.error('[cairn:home] 无法添加项目', error)
      setToast(normalizeError(error, t))
    }
  }

  const removeProject = async (id: string): Promise<void> => {
    try {
      getIpcData(await window.cairn.removeProject(id))
      await refreshProjects()
    } catch (error) {
      console.error('[cairn:home] 无法移除项目', error)
      setToast(normalizeError(error, t))
    }
  }

  const relocateProject = async (project: AvailableProjectEntry): Promise<void> => {
    try {
      const selectedFolder = getIpcData(await window.cairn.selectFolder())
      if (!selectedFolder) return
      // 先写入新位置，再移除失效记录，避免选择后出现空项目列表。
      getIpcData(await window.cairn.addProject(selectedFolder))
      getIpcData(await window.cairn.removeProject(project.id))
      await refreshProjects()
      await activateProject(selectedFolder)
    } catch (error) {
      console.error('[cairn:home] 无法重新定位项目', error)
      setToast(normalizeError(error, t))
    }
  }

  return (
    <section className="view active">
      <div className="view-header">
        <h1 className="view-title">{t('home')}</h1>
      </div>

      {projects.length === 0 ? (
        <div className="empty home-empty">
          <p className="empty-title">{t('noProjects')}</p>
          <p className="empty-desc">{t('noProjectsDesc')}</p>
          <button className="btn btn-primary" type="button" onClick={() => void addProject()}>
            <FolderPlus size={15} strokeWidth={1.8} />
            {t('addProject')}
          </button>
        </div>
      ) : (
        <>
          <p className="home-section-label">{t('recentProjects')}</p>
          <div className="home-grid">
            {projects.map((project) => project.available ? (
              <article
                key={project.id}
                aria-label={project.name}
                className={`project-card ${folder === project.path ? 'active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => void openProject(project)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    void openProject(project)
                  }
                }}
              >
                {project.isFavorite && <span aria-label="Favorite" className="project-card-favorite">★</span>}
                <div>
                  <p className="project-card-name">{project.name}</p>
                  <p className="project-card-path" title={project.path}>{project.path}</p>
                </div>
                <p className="project-card-meta">{formatProjectRelativeTime(project.lastOpenedAt, t)}</p>
              </article>
            ) : (
              <article key={project.id} className="project-card missing">
                <div>
                  <p className="project-card-name">{project.name}</p>
                  <p className="project-card-path" title={project.path}>{project.path}</p>
                </div>
                <p className="project-card-meta">{t('folderNotFound')}</p>
                <div className="project-card-actions">
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => void removeProject(project.id)}>
                    {t('remove')}
                  </button>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => void relocateProject(project)}>
                    {t('relocate')}
                  </button>
                </div>
              </article>
            ))}
            <button aria-label={t('addProject')} className="project-card add" type="button" onClick={() => void addProject()}>
              <Plus size={20} strokeWidth={1.8} />
              <span>{t('addProject')}</span>
            </button>
          </div>
        </>
      )}
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </section>
  )
}
