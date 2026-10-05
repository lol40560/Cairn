import { useCallback, useEffect, useRef, useState } from 'react'

import { Bookmark, ChevronLeft, FileDiff, Plus, RotateCcw, Trash2, X } from 'lucide-react'

import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { MonacoDiff } from '@/components/MonacoDiff'
import { Toast, type ToastMessage } from '@/components/Toast'
import { useTranslation, type TranslateFn } from '@/i18n'
import { detectLanguage } from '@/lib/detect-language'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { useAppStore } from '@/store/appStore'
import type { Checkpoint, CheckpointComparison, CheckpointComparisonFile, CheckpointFileContents, IpcResult } from '@/types/cairn'

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

interface CheckpointsViewProps { checkpoints?: Checkpoint[] }

/** 管理 project snapshots；所有變更仍透過主進程安全交易執行。 */
export function CheckpointsView({ checkpoints: checkpointsOverride }: CheckpointsViewProps) {
  const { t } = useTranslation()
  const dirtyFilePaths = useAppStore((state) => state.dirtyFilePaths)
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>(checkpointsOverride ?? [])
  const [loading, setLoading] = useState(checkpointsOverride === undefined)
  const [showCreate, setShowCreate] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<Checkpoint | undefined>()
  const [pendingDelete, setPendingDelete] = useState<Checkpoint | undefined>()
  const [comparison, setComparison] = useState<CheckpointComparison | undefined>()
  const [comparisonLoading, setComparisonLoading] = useState(false)
  const [selectedComparisonFile, setSelectedComparisonFile] = useState<CheckpointComparisonFile | undefined>()
  const [comparisonFileContents, setComparisonFileContents] = useState<CheckpointFileContents | undefined>()
  const [toast, setToast] = useState<ToastMessage | NormalizedError | null>(null)

  const loadCheckpoints = useCallback(async (): Promise<void> => {
    if (checkpointsOverride !== undefined) return
    setLoading(true)
    try { setCheckpoints(getIpcData(await window.cairn.listCheckpoints())) }
    catch (error) { setToast(normalizeError(error, t)) }
    finally { setLoading(false) }
  }, [checkpointsOverride, t])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCheckpoints(), 0)
    return () => window.clearTimeout(timer)
  }, [loadCheckpoints])

  const handleCreate = async (name?: string): Promise<void> => {
    try {
      getIpcData(await window.cairn.createCheckpoint(name))
      setShowCreate(false)
      await loadCheckpoints()
    } catch (error) { setToast(normalizeError(error, t)) }
  }

  const openComparison = async (checkpoint: Checkpoint, openRestorePreview = false): Promise<void> => {
    setComparisonLoading(true)
    try {
      setComparison(getIpcData(await window.cairn.compareCheckpoint(checkpoint.id)))
      if (openRestorePreview) setPendingRestore(checkpoint)
    }
    catch (error) { setToast(normalizeError(error, t)) }
    finally { setComparisonLoading(false) }
  }

  const openComparisonFile = async (file: CheckpointComparisonFile): Promise<void> => {
    if (!comparison) return
    try {
      setSelectedComparisonFile(file)
      setComparisonFileContents(getIpcData(await window.cairn.readCheckpointComparisonFile(comparison.checkpoint.id, file.path)))
    } catch (error) { setToast(normalizeError(error, t)) }
  }

  const handleRestore = async (): Promise<void> => {
    if (!pendingRestore || !comparison) return
    const checkpoint = pendingRestore
    if (dirtyFilePaths.length > 0) {
      setToast({ message: t('restoreBlockedDirty').replace('{files}', dirtyFilePaths.join(', ')), tone: 'error' })
      return
    }
    try {
      const result = getIpcData(await window.cairn.restoreCheckpoint(checkpoint.id, comparison.currentRevision, dirtyFilePaths))
      setPendingRestore(undefined)
      setComparison(undefined)
      setToast({ message: t('restoreSuccessProtected').replace('{n}', String(result.restored + result.removed)).replace('{name}', result.recoveryCheckpoint.name), tone: 'success' })
      await loadCheckpoints()
    } catch (error) { setToast(normalizeError(error, t)) }
  }

  const handleDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    try {
      getIpcData(await window.cairn.deleteCheckpoint(pendingDelete.id))
      setPendingDelete(undefined)
      if (comparison?.checkpoint.id === pendingDelete.id) setComparison(undefined)
      await loadCheckpoints()
    } catch (error) { setToast(normalizeError(error, t)) }
  }

  return (
    <section className="view active checkpoints-view">
      <div className="view-header">
        <h1 className="view-title">{t('checkpoints')}</h1>
        <span className="view-count">{checkpoints.length} {t('items')}</span>
        <span className="view-spacer" />
        <button className="btn btn-primary" type="button" onClick={() => setShowCreate(true)}><Plus aria-hidden="true" size={14} />{t('createCheckpoint')}</button>
      </div>
      {loading ? <div className="checkpoints-loading">{t('loading')}</div> : comparison ? (
        <CheckpointComparisonPanel
          comparison={comparison}
          loading={comparisonLoading}
          onBack={() => setComparison(undefined)}
          onFileClick={(file) => void openComparisonFile(file)}
          onRestore={() => setPendingRestore(comparison.checkpoint)}
        />
      ) : checkpoints.length === 0 ? (
        <EmptyState actions={[{ label: t('createCheckpoint'), onClick: () => setShowCreate(true), variant: 'primary' }]} description={t('noCheckpointsDesc')} icon={Bookmark} title={t('noCheckpoints')} />
      ) : (
        <div className="checkpoints-list">
          {checkpoints.map((checkpoint) => <CheckpointRow checkpoint={checkpoint} key={checkpoint.id} onCompare={() => void openComparison(checkpoint)} onDelete={() => setPendingDelete(checkpoint)} onRestore={() => void openComparison(checkpoint, true)} />)}
        </div>
      )}
      {showCreate ? <CreateCheckpointDialog onCancel={() => setShowCreate(false)} onConfirm={handleCreate} /> : null}
      <ConfirmDialog
        cancelLabel={t('cancel')} confirmLabel={t('restoreCheckpoint')} danger
        message={restorePreviewMessage(comparison, dirtyFilePaths, t)} open={pendingRestore !== undefined}
        title={dirtyFilePaths.length > 0 ? t('restoreBlockedTitle') : t('restoreCheckpointTitle')}
        onCancel={() => setPendingRestore(undefined)} onConfirm={() => void handleRestore()}
      />
      <ConfirmDialog cancelLabel={t('cancel')} confirmLabel={t('delete')} danger message={t('deleteCheckpointMessage').replace('{name}', pendingDelete?.name ?? '')} open={pendingDelete !== undefined} title={t('deleteCheckpointTitle')} onCancel={() => setPendingDelete(undefined)} onConfirm={() => void handleDelete()} />
      <CheckpointDiffDialog contents={comparisonFileContents} file={selectedComparisonFile} open={selectedComparisonFile !== undefined} onClose={() => { setSelectedComparisonFile(undefined); setComparisonFileContents(undefined) }} />
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </section>
  )
}

function CheckpointRow({ checkpoint, onRestore, onCompare, onDelete }: { checkpoint: Checkpoint; onRestore(): void; onCompare(): void; onDelete(): void }) {
  const { t } = useTranslation()
  return <article className="checkpoint-row">
    <Bookmark aria-hidden="true" className="checkpoint-icon" size={16} />
    <div className="checkpoint-info"><p className="checkpoint-name">{checkpoint.name}</p><p className="checkpoint-meta">{formatRelativeTime(checkpoint.createdAt, t)} · {checkpoint.fileCount} {t('filesCount')} · {formatBytes(checkpoint.sizeBytes)} · {checkpoint.source === 'manual' ? t('checkpointManual') : t('checkpointAutoRecovery')}</p></div>
    <div className="checkpoint-actions">
      <button className="btn btn-ghost btn-sm" type="button" onClick={onCompare}><FileDiff aria-hidden="true" size={14} />{t('compareWithCurrent')}</button>
      <button className="btn btn-ghost btn-sm" type="button" onClick={onRestore}><RotateCcw aria-hidden="true" size={14} />{t('restore')}</button>
      <button aria-label={t('delete')} className="btn btn-ghost btn-sm" title={t('delete')} type="button" onClick={onDelete}><Trash2 aria-hidden="true" size={14} /></button>
    </div>
  </article>
}

function CheckpointComparisonPanel({ comparison, loading, onBack, onFileClick, onRestore }: { comparison: CheckpointComparison; loading: boolean; onBack(): void; onFileClick(file: CheckpointComparisonFile): void; onRestore(): void }) {
  const { t } = useTranslation()
  const changed = comparison.files.filter((file) => file.status !== 'unchanged')
  return <div className="checkpoint-comparison">
    <div className="checkpoint-comparison-header"><button className="btn btn-ghost btn-sm" type="button" onClick={onBack}><ChevronLeft aria-hidden="true" size={14} />{t('back')}</button><div><h2>{t('checkpointVsCurrent')}</h2><p>{comparison.checkpoint.name}</p></div><span className="view-spacer" /><button className="btn btn-danger btn-sm" disabled={loading} type="button" onClick={onRestore}>{t('restoreCheckpoint')}</button></div>
    <div className="checkpoint-comparison-summary"><span>{changed.length} {t('filesChanged')}</span><span>{comparison.summary.modified} {t('filesModified')}</span><span>{comparison.summary.added} {t('filesAdded')}</span><span>{comparison.summary.deleted} {t('filesDeleted')}</span></div>
    <div className="checkpoint-comparison-files">{changed.length === 0 ? <p className="checkpoints-loading">{t('noCheckpointChanges')}</p> : changed.map((file) => <button className="checkpoint-comparison-file" key={file.path} type="button" onClick={() => onFileClick(file)}><span className={`checkpoint-file-status ${file.status}`}>{statusLetter(file.status)}</span><code>{file.path}</code>{file.binary ? <span>{t('binaryFileChanged')}</span> : null}</button>)}</div>
  </div>
}

function CheckpointDiffDialog({ open, file, contents, onClose }: { open: boolean; file?: CheckpointComparisonFile; contents?: CheckpointFileContents; onClose(): void }) {
  const { t } = useTranslation()
  if (!open || !file) return null
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}><section aria-modal="true" className="op-diff-dialog" role="dialog"><header className="op-diff-header"><div><h2 className="op-diff-title">{file.path}</h2><p className="op-diff-meta">{file.binary ? t('binaryFileChanged') : t('checkpointVsCurrent')}</p></div><button aria-label={t('close')} className="btn btn-ghost btn-sm" type="button" onClick={onClose}><X size={14} /></button></header><div className="op-diff-body">{file.binary || contents?.binary ? <EmptyState description={t('binaryFileDiffDesc')} title={t('binaryFileChanged')} /> : contents ? <MonacoDiff height="100%" language={detectLanguage(file.path)} modified={contents.currentContent ?? ''} modifiedLabel={t('current')} original={contents.checkpointContent ?? ''} originalLabel={t('checkpoint')} /> : <div className="checkpoints-loading">{t('loading')}</div>}</div></section></div>
}

function CreateCheckpointDialog({ onConfirm, onCancel }: { onConfirm(name?: string): Promise<void>; onCancel(): void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  const submit = async (): Promise<void> => { if (creating) return; setCreating(true); await onConfirm(name.trim() || undefined); setCreating(false) }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onCancel() }}><section aria-modal="true" aria-labelledby="create-checkpoint-title" className="modal modal-compact" role="dialog"><header className="modal-header"><h2 id="create-checkpoint-title" className="modal-title">{t('createCheckpoint')}</h2><button aria-label={t('close')} className="btn btn-ghost btn-sm" type="button" onClick={onCancel}><X aria-hidden="true" size={14} /></button></header><div className="modal-body"><div className="field"><label className="field-label" htmlFor="checkpoint-name">{t('checkpointNameOptional')}</label><input id="checkpoint-name" ref={inputRef} className="input" maxLength={100} placeholder={t('checkpointNamePlaceholder')} type="text" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit(); if (event.key === 'Escape') onCancel() }} /></div></div><footer className="modal-actions"><button className="btn btn-ghost" type="button" onClick={onCancel}>{t('cancel')}</button><button aria-busy={creating} className="btn btn-primary" disabled={creating} type="button" onClick={() => void submit()}>{creating ? t('creating') : t('create')}</button></footer></section></div>
}

function restorePreviewMessage(comparison: CheckpointComparison | undefined, dirtyPaths: string[], t: TranslateFn): string {
  if (dirtyPaths.length > 0) return t('restoreBlockedDirty').replace('{files}', dirtyPaths.join(', '))
  if (!comparison) return t('restorePreviewUnavailable')
  const { added, deleted, modified } = comparison.summary
  return t('restoreCheckpointPreview').replace('{modified}', String(modified)).replace('{deleted}', String(deleted)).replace('{added}', String(added))
}

function statusLetter(status: CheckpointComparisonFile['status']): string { return status === 'added' ? 'A' : status === 'deleted' ? 'D' : 'M' }
