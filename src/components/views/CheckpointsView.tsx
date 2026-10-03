import { useCallback, useEffect, useRef, useState } from 'react'

import { Bookmark, Plus, RotateCcw, Trash2, X } from 'lucide-react'

import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { Toast, type ToastMessage } from '@/components/Toast'
import { useTranslation, type TranslateFn } from '@/i18n'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import type { Checkpoint, IpcResult } from '@/types/cairn'

function getIpcData<T>(result: IpcResult<T>): T {
  if (!result.ok) throw result.error
  return result.data
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatRelativeTime(timestamp: number, t: TranslateFn): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return t('justNow')
  if (minutes < 60) return minutes === 1 ? t('minuteAgo') : t('minutesAgo').replace('{n}', String(minutes))

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? t('hourAgo') : t('hoursAgo').replace('{n}', String(hours))

  const days = Math.floor(hours / 24)
  return days === 1 ? t('dayAgo') : t('daysAgo').replace('{n}', String(days))
}

interface CheckpointsViewProps {
  /** 静态渲染测试可提供检查点快照；运行时经 IPC 读取。 */
  checkpoints?: Checkpoint[]
}

/** 管理本项目可恢复快照；文件操作全部通过主进程 IPC 执行。 */
export function CheckpointsView({ checkpoints: checkpointsOverride }: CheckpointsViewProps) {
  const { t } = useTranslation()
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>(checkpointsOverride ?? [])
  const [loading, setLoading] = useState(checkpointsOverride === undefined)
  const [showCreate, setShowCreate] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<Checkpoint | undefined>()
  const [pendingDelete, setPendingDelete] = useState<Checkpoint | undefined>()
  const [toast, setToast] = useState<ToastMessage | NormalizedError | null>(null)

  const loadCheckpoints = useCallback(async (): Promise<void> => {
    if (checkpointsOverride !== undefined) return
    setLoading(true)
    try {
      setCheckpoints(getIpcData(await window.cairn.listCheckpoints()))
    } catch (error) {
      console.error('[cairn:checkpoints] 无法读取检查点', error)
      setToast(normalizeError(error, t))
    } finally {
      setLoading(false)
    }
  }, [checkpointsOverride, t])

  useEffect(() => {
    // 延后一帧读取，避免首次渲染期间同步更新本地状态。
    const timer = window.setTimeout(() => void loadCheckpoints(), 0)
    return () => window.clearTimeout(timer)
  }, [loadCheckpoints])

  const handleCreate = async (name: string): Promise<void> => {
    try {
      getIpcData(await window.cairn.createCheckpoint(name))
      setShowCreate(false)
      await loadCheckpoints()
    } catch (error) {
      console.error('[cairn:checkpoints] 无法创建检查点', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleRestore = async (): Promise<void> => {
    if (!pendingRestore) return
    const checkpoint = pendingRestore
    setPendingRestore(undefined)
    try {
      const result = getIpcData(await window.cairn.restoreCheckpoint(checkpoint.id))
      setToast({ message: t('restoreSuccess').replace('{n}', String(result.restored)), tone: 'success' })
    } catch (error) {
      console.error('[cairn:checkpoints] 无法恢复检查点', error)
      setToast(normalizeError(error, t))
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const checkpoint = pendingDelete
    setPendingDelete(undefined)
    try {
      getIpcData(await window.cairn.deleteCheckpoint(checkpoint.id))
      await loadCheckpoints()
    } catch (error) {
      console.error('[cairn:checkpoints] 无法删除检查点', error)
      setToast(normalizeError(error, t))
    }
  }

  return (
    <section className="view active">
      <div className="view-header">
        <h1 className="view-title">{t('checkpoints')}</h1>
        <span className="view-count">{checkpoints.length} {t('items')}</span>
        <span className="view-spacer" />
        <button className="btn btn-primary" type="button" onClick={() => setShowCreate(true)}>
          <Plus aria-hidden="true" size={14} />
          {t('createCheckpoint')}
        </button>
      </div>

      {loading ? (
        <div className="checkpoints-loading">{t('loading')}</div>
      ) : checkpoints.length === 0 ? (
        <EmptyState
          actions={[{ label: t('createCheckpoint'), onClick: () => setShowCreate(true), variant: 'primary' }]}
          description={t('noCheckpointsDesc')}
          icon={Bookmark}
          title={t('noCheckpoints')}
        />
      ) : (
        <div className="checkpoints-list">
          {checkpoints.map((checkpoint) => (
            <CheckpointRow
              checkpoint={checkpoint}
              key={checkpoint.id}
              onDelete={() => setPendingDelete(checkpoint)}
              onRestore={() => setPendingRestore(checkpoint)}
            />
          ))}
        </div>
      )}

      {showCreate ? <CreateCheckpointDialog onCancel={() => setShowCreate(false)} onConfirm={handleCreate} /> : null}
      <ConfirmDialog
        cancelLabel={t('cancel')}
        confirmLabel={t('restore')}
        danger
        message={t('restoreCheckpointMessage').replace('{name}', pendingRestore?.name ?? '')}
        open={pendingRestore !== undefined}
        title={t('restoreCheckpointTitle')}
        onCancel={() => setPendingRestore(undefined)}
        onConfirm={() => void handleRestore()}
      />
      <ConfirmDialog
        cancelLabel={t('cancel')}
        confirmLabel={t('delete')}
        danger
        message={t('deleteCheckpointMessage').replace('{name}', pendingDelete?.name ?? '')}
        open={pendingDelete !== undefined}
        title={t('deleteCheckpointTitle')}
        onCancel={() => setPendingDelete(undefined)}
        onConfirm={() => void handleDelete()}
      />
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </section>
  )
}

function CheckpointRow({ checkpoint, onRestore, onDelete }: {
  checkpoint: Checkpoint
  onRestore(): void
  onDelete(): void
}) {
  const { t } = useTranslation()

  return (
    <article className="checkpoint-row">
      <Bookmark aria-hidden="true" className="checkpoint-icon" size={16} />
      <div className="checkpoint-info">
        <p className="checkpoint-name">{checkpoint.name}</p>
        <p className="checkpoint-meta">
          {formatRelativeTime(checkpoint.createdAt, t)} · {checkpoint.fileCount} {t('filesCount')} · {formatBytes(checkpoint.sizeBytes)}
        </p>
      </div>
      <div className="checkpoint-actions">
        <button className="btn btn-ghost btn-sm" title={t('restore')} type="button" onClick={onRestore}>
          <RotateCcw aria-hidden="true" size={14} />
          {t('restore')}
        </button>
        <button aria-label={t('delete')} className="btn btn-ghost btn-sm" title={t('delete')} type="button" onClick={onDelete}>
          <Trash2 aria-hidden="true" size={14} />
        </button>
      </div>
    </article>
  )
}

function CreateCheckpointDialog({ onConfirm, onCancel }: {
  onConfirm(name: string): Promise<void>
  onCancel(): void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = async (): Promise<void> => {
    const normalizedName = name.trim()
    if (!normalizedName || creating) return
    setCreating(true)
    await onConfirm(normalizedName)
    setCreating(false)
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <section aria-modal="true" aria-labelledby="create-checkpoint-title" className="modal modal-compact" role="dialog">
        <header className="modal-header">
          <h2 id="create-checkpoint-title" className="modal-title">{t('createCheckpoint')}</h2>
          <button aria-label={t('close')} className="btn btn-ghost btn-sm" type="button" onClick={onCancel}>
            <X aria-hidden="true" size={14} />
          </button>
        </header>
        <div className="modal-body">
          <div className="field">
            <label className="field-label" htmlFor="checkpoint-name">{t('checkpointName')}</label>
            <input
              id="checkpoint-name"
              ref={inputRef}
              className="input"
              maxLength={100}
              placeholder={t('checkpointNamePlaceholder')}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSubmit()
                if (event.key === 'Escape') onCancel()
              }}
            />
          </div>
        </div>
        <footer className="modal-actions">
          <button className="btn btn-ghost" type="button" onClick={onCancel}>{t('cancel')}</button>
          <button className="btn btn-primary" disabled={!name.trim() || creating} type="button" onClick={() => void handleSubmit()}>
            {creating ? t('creating') : t('create')}
          </button>
        </footer>
      </section>
    </div>
  )
}
