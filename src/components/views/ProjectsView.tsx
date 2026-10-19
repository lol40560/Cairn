import { useCallback, useEffect, useState, type MouseEvent } from 'react'

import { FolderOpen, MoreHorizontal, Plus } from 'lucide-react'

import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'
import { EmptyState } from '@/components/EmptyState'
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

interface ProjectsViewProps {
  activeProjectPath: string
  projects: AvailableProjectEntry[]
  onOpenProject(project: AvailableProjectEntry): Promise<void>
}

/** Launch destination and single owner of project-library actions. */
export function ProjectsView({ activeProjectPath, projects, onOpenProject }: ProjectsViewProps) {
  const { t } = useTranslation()
  const setProjects = useAppStore((state) => state.setProjects)
  const [pendingRemove, setPendingRemove] = useState<AvailableProjectEntry>()
  const [projectMenu, setProjectMenu] = useState<{ items: ContextMenuItem[]; x: number; y: number }>()
  const [toast, setToast] = useState<ToastMessage | NormalizedError | null>(null)

  const refreshProjects = useCallback(async (): Promise<AvailableProjectEntry[]> => {
    const refreshed = getIpcData(await window.cairn.listProjects())
    setProjects(refreshed)
    return refreshed
  }, [setProjects])

  useEffect(() => {
    let disposed = false
    void refreshProjects().catch((error) => {
      if (!disposed) setToast(normalizeError(error, t))
    })
    return () => { disposed = true }
  }, [refreshProjects, t])

  const addProject = async (): Promise<void> => {
    try {
      const selectedFolder = getIpcData(await window.cairn.selectFolder())
      if (!selectedFolder) return
      getIpcData(await window.cairn.addProject(selectedFolder))
      const refreshed = await refreshProjects()
      const project = refreshed.find((entry) => entry.path === selectedFolder)
      if (project) await onOpenProject(project)
    } catch (error) {
      setToast(normalizeError(error, t))
    }
  }

  const removeProject = async (id: string): Promise<void> => {
    try {
      getIpcData(await window.cairn.removeProject(id))
      await refreshProjects()
    } catch (error) {
      setToast(normalizeError(error, t))
    }
  }

  const relocateProject = async (project: AvailableProjectEntry): Promise<void> => {
    try {
      const selectedFolder = getIpcData(await window.cairn.selectFolder())
      if (!selectedFolder) return
      getIpcData(await window.cairn.addProject(selectedFolder))
      getIpcData(await window.cairn.removeProject(project.id))
      await refreshProjects()
    } catch (error) {
      setToast(normalizeError(error, t))
    }
  }

  const showProjectMenu = (event: MouseEvent<HTMLElement>, project: AvailableProjectEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    setProjectMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: t('openProject'), onSelect: () => void onOpenProject(project) },
        { label: t('copyPath'), onSelect: () => void window.cairn.copyToClipboard(project.path) },
        { label: t('revealInFinder'), onSelect: () => void window.cairn.openInFileManager(project.path) },
        { danger: true, label: t('remove'), onSelect: () => setPendingRemove(project), separatorBefore: true },
      ],
    })
  }

  return (
    <section className="view active projects-view">
      <header className="view-header projects-view-header">
        <div><h1 className="view-title">{t('projectsTitle')}</h1><p className="view-description">{t('projectsDescription')}</p></div>
        <button className="btn btn-primary" type="button" onClick={() => void addProject()}><Plus aria-hidden="true" size={18}/>{t('addProject')}</button>
      </header>

      {projects.length === 0 ? (
        <EmptyState actions={[{ label: t('addProject'), onClick: () => void addProject(), variant: 'primary' }]} description={t('noProjectsDesc')} icon={FolderOpen} title={t('noProjects')} />
      ) : (
        <div className="home-grid projects-grid">
          {projects.map((project) => project.available ? (
            <article className={`project-card ${activeProjectPath === project.path ? 'active' : ''}`} key={project.id} onContextMenu={(event) => showProjectMenu(event, project)}>
              <button aria-label={`${t('openProject')}: ${project.name}`} className="project-card-primary" type="button" onClick={() => void onOpenProject(project)}>
                <span className="project-card-name">{project.name}</span>
                <span className="project-card-path" title={project.path}>{project.path}</span>
              </button>
              <button aria-label={`${t('projectActions')}: ${project.name}`} className="project-card-remove" title={t('projectActions')} type="button" onClick={(event) => showProjectMenu(event, project)}><MoreHorizontal aria-hidden="true" size={16}/></button>
              {project.isFavorite ? <span aria-label="Favorite" className="project-card-favorite">★</span> : null}
              <div className="project-card-meta">
                {activeProjectPath === project.path ? <span className="project-card-state">● {t('statusWatching')}</span> : null}
                <span>{formatProjectRelativeTime(project.lastOpenedAt, t)}</span>
              </div>
            </article>
          ) : (
            <article className="project-card missing" key={project.id}>
              <div><p className="project-card-name">{project.name}</p><p className="project-card-path" title={project.path}>{project.path}</p></div>
              <p className="project-card-meta">{t('folderNotFound')}</p>
              <div className="project-card-actions"><button className="btn btn-ghost btn-sm" type="button" onClick={() => void removeProject(project.id)}>{t('remove')}</button><button className="btn btn-ghost btn-sm" type="button" onClick={() => void relocateProject(project)}>{t('relocate')}</button></div>
            </article>
          ))}
        </div>
      )}

      <ConfirmDialog cancelLabel={t('cancel')} confirmLabel={t('remove')} danger message={t('removeProjectMessage').replace('{name}', pendingRemove?.name ?? '')} open={pendingRemove !== undefined} title={t('removeProjectTitle')} onCancel={() => setPendingRemove(undefined)} onConfirm={() => { const project = pendingRemove; setPendingRemove(undefined); if (project) void removeProject(project.id) }} />
      {projectMenu ? <ContextMenu items={projectMenu.items} position={projectMenu} onClose={() => setProjectMenu(undefined)} /> : null}
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </section>
  )
}
