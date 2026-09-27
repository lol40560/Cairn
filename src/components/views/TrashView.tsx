import { useCallback, useEffect, useState } from 'react'

import { useTranslation } from '@/i18n'
import type { TranslateFn } from '@/i18n'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { useAppStore } from '@/store/appStore'
import type { TrashEntry } from '@/types/cairn'

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

/** 展示可恢复的项目内删除记录。 */
export function TrashView() {
  const { t } = useTranslation()
  const trash = useAppStore((state) => state.trash)
  const setTrash = useAppStore((state) => state.setTrash)
  const [retentionDays, setRetentionDays] = useState(30)
  const [confirmingEmpty, setConfirmingEmpty] = useState(false)
  const [error, setError] = useState<NormalizedError | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const [trashResult, retentionResult] = await Promise.all([
      window.cairn.listTrash(),
      window.cairn.getTrashRetentionDays(),
    ])
    if (!trashResult.ok) throw trashResult.error
    setTrash(trashResult.data)
    if (retentionResult.ok) setRetentionDays(retentionResult.data)
  }, [setTrash])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((cause) => {
        console.error('[cairn] 无法读取废纸篓', cause)
        setError(normalizeError(cause, t))
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load, t])

  const run = async (action: (entry?: TrashEntry) => Promise<unknown>, entry?: TrashEntry): Promise<void> => {
    setError(null)
    try {
      await action(entry)
      await load()
    } catch (cause) {
      console.error('[cairn] 废纸篓操作失败', cause)
      setError(normalizeError(cause, t))
    }
  }

  const restore = async (entry?: TrashEntry): Promise<void> => {
    if (!entry) return
    const result = await window.cairn.restoreFromTrash(entry.trashId)
    if (!result.ok) throw result.error
  }
  const purge = async (entry?: TrashEntry): Promise<void> => {
    if (!entry) return
    const result = await window.cairn.purgeFromTrash(entry.trashId)
    if (!result.ok) throw result.error
  }
  const empty = async (): Promise<void> => {
    const result = await window.cairn.emptyTrash()
    if (!result.ok) throw result.error
    setConfirmingEmpty(false)
  }

  return (
    <section className="view active">
      <div className="view-header">
        <h1 className="view-title">{t('trash')}</h1>
        <span className="view-count">{t('trashItems').replace('{n}', String(trash.length))}</span>
        <span className="view-spacer" />
        {trash.length > 0 && !confirmingEmpty && (
          <button className="btn btn-ghost" type="button" onClick={() => setConfirmingEmpty(true)}>
            {t('trashEmptyAction')}
          </button>
        )}
      </div>

      {confirmingEmpty && (
        <div className="trash-confirm">
          <span>{t('trashEmptyConfirm').replace('{n}', String(trash.length))}</span>
          <button className="btn btn-ghost" type="button" onClick={() => void run(empty)}>{t('trashEmptyAction')}</button>
          <button className="btn btn-ghost" type="button" onClick={() => setConfirmingEmpty(false)}>{t('cancel')}</button>
        </div>
      )}
      {error && <p className="modal-error">{error.message}</p>}

      {trash.length === 0 ? (
        <div className="empty">
          <div className="empty-title">{t('trashEmpty')}</div>
          <div className="empty-desc">{t('trashEmptyDesc').replace('{days}', String(retentionDays))}</div>
        </div>
      ) : (
        <div className="trash-list">
          {trash.map((entry) => (
            <div className="trash-row" key={entry.trashId}>
              <div className="trash-info">
                <div className="trash-file">{entry.originalPath}</div>
                <div className="trash-meta">{entry.author} · {formatRelativeTime(entry.deletedAt, t)} · {formatBytes(entry.sizeBytes)}</div>
              </div>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => void run(restore, entry)}>{t('trashRestore')}</button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => void run(purge, entry)}>{t('trashDelete')}</button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
