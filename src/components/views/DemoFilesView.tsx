import { useCallback, useEffect, useMemo, useState } from 'react'

import { Editor } from '@monaco-editor/react'
import { Search } from 'lucide-react'

import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FileTree } from '@/components/FileTree'
import { OpDiffDialog } from '@/components/OpDiffDialog'
import { detectLanguage } from '@/lib/detect-language'
import { getConflictRisk, remoteAuthorForRisk } from '@/lib/conflictIntelligence'
import { getDemoNow } from '@/lib/hackathonMode'
import type { DemoWorkspace } from '@/lib/demoWorkspace'
import { useTranslation } from '@/i18n'
import type { ConflictRecord, Op, ProjectFileEntry } from '@/types/cairn'

interface DemoFilesViewProps {
  workspace: DemoWorkspace
  ops: Op[]
  conflicts: ConflictRecord[]
  onDirtyChange(dirty: boolean): void
}

/** 模擬模式專用的 Files 入口；只操作 DemoWorkspace，絕不經過 IPC。 */
export function DemoFilesView({ workspace, ops, conflicts, onDirtyChange }: DemoFilesViewProps) {
  const { t } = useTranslation()
  const [selectedPath, setSelectedPath] = useState('src/auth.ts')
  const [draft, setDraft] = useState(() => workspace.readFile('src/auth.ts')?.content ?? '')
  const [saved, setSaved] = useState(draft)
  const [filter, setFilter] = useState('')
  const [dirty, setDirty] = useState(false)
  const [pendingPath, setPendingPath] = useState<string | undefined>()
  const [reviewOp, setReviewOp] = useState<Op | undefined>()
  const [justSaved, setJustSaved] = useState(false)
  const files = useMemo<ProjectFileEntry[]>(() => workspace.listFiles().map((file) => ({ path: file.path, name: file.path.split('/').at(-1) ?? file.path, size: new TextEncoder().encode(file.content).length, mtime: 1_700_000_000_000 })), [workspace])

  const load = (path: string): void => {
    const file = workspace.readFile(path)
    if (!file) return
    setSelectedPath(path)
    setDraft(file.content)
    setSaved(file.content)
    setDirty(false)
    onDirtyChange(false)
  }
  const select = (path: string): void => {
    if (path === selectedPath) return
    if (dirty) { setPendingPath(path); return }
    load(path)
  }
  const save = useCallback((): void => {
    if (!dirty) return
    workspace.saveFile(selectedPath, draft)
    setSaved(draft)
    setDirty(false)
    onDirtyChange(false)
    setJustSaved(true)
    window.setTimeout(() => setJustSaved(false), 1_600)
  }, [dirty, draft, onDirtyChange, selectedPath, workspace])
  useEffect(() => {
    const onSave = (event: KeyboardEvent): void => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save() } }
    window.addEventListener('keydown', onSave)
    return () => { window.removeEventListener('keydown', onSave); onDirtyChange(false) }
  }, [onDirtyChange, save])

  const demoNow = getDemoNow()
  const risk = getConflictRisk({ filePath: selectedPath, ops, conflicts, dirty, now: demoNow })
  const riskLabel = risk.level === 'confirmed-conflict' ? t('conflictDetected') : risk.level === 'potential-overlap' ? t('potentialOverlap') : undefined
  const treeRisks = useMemo(() => Object.fromEntries(files.flatMap((file) => {
    const item = getConflictRisk({ filePath: file.path, ops, conflicts, dirty: dirty && file.path === selectedPath, now: demoNow })
    if (item.level === 'none') return []
    const author = remoteAuthorForRisk(ops, file.path) ?? item.contributors[0] ?? t('peers')
    return [[file.path, { level: item.level, label: item.level === 'confirmed-conflict' ? t('conflictDetected') : t('recentRemoteChange').replace('{author}', author).replace('{time}', t('justNow')) }]]
  })), [conflicts, demoNow, dirty, files, ops, selectedPath, t])
  const selectedRemoteOp = ops.find((op) => op.filePath === selectedPath && op.source === 'remote')

  return <section className="view active files-view demo-files-view">
    <div className="view-header files-view-header">
      <div><h1 className="view-title">{t('files')}</h1><p className="files-breadcrumb">demo-app / {selectedPath}</p></div>
      <span className="view-spacer" />
      <div className="files-search"><Search size={14} /><input aria-label={t('filesSearchPlaceholder')} placeholder={t('filesSearchPlaceholder')} value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
      <span className={`files-status ${dirty ? 'dirty' : ''}`}>{dirty ? t('filesUnsaved') : justSaved ? t('filesSaved') : t('filesSaved')}</span>
      <button className="btn btn-primary btn-sm" disabled={!dirty} type="button" onClick={save}>{t('filesSave')}</button>
    </div>
    <div className="files-layout">
      <aside className="files-sidebar"><FileTree conflictRisks={treeRisks} files={files} filter={filter} selectedPath={selectedPath} onSelect={select} /></aside>
      <div className="files-main">
        {riskLabel ? <div className="files-content-warning"><strong>{riskLabel}</strong>{selectedRemoteOp ? <button className="btn btn-ghost btn-sm" type="button" onClick={() => setReviewOp(selectedRemoteOp)}>{t('reviewChanges')}</button> : null}</div> : null}
        <Editor height="100%" language={detectLanguage(selectedPath)} options={{ automaticLayout: true, fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false }} theme="vs-dark" value={draft} onChange={(value) => { const next = value ?? ''; setDraft(next); const nextDirty = next !== saved; setDirty(nextDirty); onDirtyChange(nextDirty) }} />
      </div>
    </div>
    <ConfirmDialog cancelLabel={t('cancel')} confirmLabel={t('filesDiscard')} danger message={t('filesDiscardConfirmMessage')} open={pendingPath !== undefined} title={t('filesDiscardConfirmTitle')} onCancel={() => setPendingPath(undefined)} onConfirm={() => { const target = pendingPath; setPendingPath(undefined); if (target) load(target) }} />
    <OpDiffDialog open={reviewOp !== undefined} op={reviewOp} onClose={() => setReviewOp(undefined)} />
  </section>
}
