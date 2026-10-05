import { useMemo, useState } from 'react'

import { Bookmark, ChevronLeft, FileDiff, RotateCcw } from 'lucide-react'

import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { MonacoDiff } from '@/components/MonacoDiff'
import { detectLanguage } from '@/lib/detect-language'
import type { DemoCheckpoint, DemoComparisonFile, DemoWorkspace } from '@/lib/demoWorkspace'
import { useTranslation } from '@/i18n'

interface DemoCheckpointsViewProps { workspace: DemoWorkspace; onWorkspaceChanged(): void }

/** 模擬 checkpoint 視圖重用真實的比較資訊架構，但不會呼叫任何 checkpoint IPC。 */
export function DemoCheckpointsView({ workspace, onWorkspaceChanged }: DemoCheckpointsViewProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<DemoCheckpoint | undefined>()
  const [pendingRestore, setPendingRestore] = useState<DemoCheckpoint | undefined>()
  const [selectedFile, setSelectedFile] = useState<DemoComparisonFile | undefined>()
  const checkpoints = workspace.listCheckpoints()
  const changes = useMemo(() => selected ? workspace.compareCheckpoint(selected.id) : [], [selected, workspace])
  const contents = selected && selectedFile ? workspace.readComparisonFile(selected.id, selectedFile.path) : undefined
  const restore = (): void => { if (!pendingRestore) return; workspace.restoreCheckpoint(pendingRestore.id); setPendingRestore(undefined); setSelected(undefined); setSelectedFile(undefined); onWorkspaceChanged() }

  return <section className="view active checkpoints-view demo-checkpoints-view">
    <div className="view-header"><h1 className="view-title">{t('checkpoints')}</h1><span className="view-count">{checkpoints.length} {t('items')}</span></div>
    {!selected ? checkpoints.length === 0 ? <EmptyState icon={Bookmark} title={t('noCheckpoints')} description={t('noCheckpointsDesc')} /> : <div className="checkpoints-list">{checkpoints.map((checkpoint) => <article className="checkpoint-row" key={checkpoint.id}><Bookmark className="checkpoint-icon" size={16} /><div className="checkpoint-info"><p className="checkpoint-name">{checkpoint.label}</p><p className="checkpoint-meta">{checkpoint.source === 'scenario' ? t('checkpointManual') : t('checkpointAutoRecovery')} · {checkpoint.revision}</p></div><div className="checkpoint-actions"><button className="btn btn-ghost btn-sm" type="button" onClick={() => setSelected(checkpoint)}><FileDiff size={14} />{t('compareWithCurrent')}</button><button className="btn btn-ghost btn-sm" type="button" onClick={() => setPendingRestore(checkpoint)}><RotateCcw size={14} />{t('restore')}</button></div></article>)}</div> : <div className="checkpoint-comparison"><div className="checkpoint-comparison-header"><button className="btn btn-ghost btn-sm" type="button" onClick={() => { setSelected(undefined); setSelectedFile(undefined) }}><ChevronLeft size={14} />{t('back')}</button><div><h2>{t('checkpointVsCurrent')}</h2><p>{selected.label}</p></div><span className="view-spacer" /><button className="btn btn-danger btn-sm" type="button" onClick={() => setPendingRestore(selected)}>{t('restoreCheckpoint')}</button></div><div className="checkpoint-comparison-summary"><span>{changes.length} {t('filesChanged')}</span><span>{changes.filter((item) => item.status === 'modified').length} {t('filesModified')}</span><span>{changes.filter((item) => item.status === 'added').length} {t('filesAdded')}</span><span>{changes.filter((item) => item.status === 'deleted').length} {t('filesDeleted')}</span></div><div className="checkpoint-comparison-files">{changes.map((file) => <button className="checkpoint-comparison-file" key={file.path} type="button" onClick={() => setSelectedFile(file)}><span className={`checkpoint-file-status ${file.status}`}>{file.status[0]?.toUpperCase()}</span><code>{file.path}</code></button>)}</div></div>}
    <ConfirmDialog cancelLabel={t('cancel')} confirmLabel={t('restoreCheckpoint')} danger message={t('restoreCheckpointPreview').replace('{modified}', String(changes.filter((item) => item.status === 'modified').length)).replace('{deleted}', String(changes.filter((item) => item.status === 'deleted').length)).replace('{added}', String(changes.filter((item) => item.status === 'added').length))} open={pendingRestore !== undefined} title={t('restoreCheckpointTitle')} onCancel={() => setPendingRestore(undefined)} onConfirm={restore} />
    {selectedFile && contents ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedFile(undefined) }}><section aria-modal="true" className="op-diff-dialog" role="dialog"><header className="op-diff-header"><h2 className="op-diff-title">{selectedFile.path}</h2><button className="btn btn-ghost btn-sm" type="button" onClick={() => setSelectedFile(undefined)}>{t('close')}</button></header><div className="op-diff-body"><MonacoDiff height="100%" language={detectLanguage(selectedFile.path)} modified={contents.current?.content ?? ''} modifiedLabel={t('current')} original={contents.checkpoint?.content ?? ''} originalLabel={t('checkpoint')} /></div></section></div> : null}
  </section>
}
