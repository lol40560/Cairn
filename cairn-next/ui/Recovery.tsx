import { useEffect, useMemo, useState } from 'react';
import { diffLines } from 'diff';
import type {
  ActivityEntry,
  Checkpoint,
  ConflictEntry,
  ImpactPreview,
  ProjectFile,
  TrashEntry,
} from '../shared/project';
import {
  Confirm,
  DateText,
  Dialog,
  Empty,
  ErrorBox,
  BlobPane,
  FileComparison,
  Impact,
  NeedProject,
  PageTitle,
  Size,
  decodeBlob,
  encodeText,
  useAction,
  useApp,
  useQuery,
} from './common';
import { sourceKey, useI18n } from './i18n';

function operation(kind: string): string {
  return kind === 'text' || kind === 'write'
    ? 'updates'
    : kind === 'create'
      ? 'create'
      : kind === 'move'
        ? 'move'
        : kind === 'delete'
          ? 'delete'
          : kind.startsWith('checkpoint')
            ? 'checkpoints'
            : kind.startsWith('conflict')
              ? 'conflicts'
              : kind.startsWith('trash')
                ? 'deleted'
                : kind.startsWith('claim')
                  ? 'claims'
                  : kind === 'settings'
                    ? 'settings'
                    : 'activity';
}

export function CheckpointsView() {
  const { t } = useI18n();
  const { state, command, memoryPending } = useApp();
  const query = useQuery<Checkpoint[]>({ kind: 'checkpoints' });
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Checkpoint | null>(null);
  const [deletion, setDeletion] = useState<{ checkpoint: Checkpoint; revision: number } | null>(
    null,
  );
  const action = useAction();
  const writable =
    state.replica?.role !== 'viewer' && state.replica?.connection === 'online' && !memoryPending;
  useEffect(() => {
    setSelected(null);
    setDeletion(null);
    setName('');
  }, [state.current?.projectId]);
  return (
    <NeedProject>
      <div className="page">
        <PageTitle title="checkpoints" />
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await command({ kind: 'checkpoint-create', name: name.trim() });
              setName('');
            });
          }}
        >
          <input
            aria-label={t('checkpointName')}
            placeholder={t('checkpointName')}
            value={name}
            maxLength={160}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <button className="primary" disabled={!writable || action.busy || !name.trim()}>
            {t('newCheckpoint')}
          </button>
        </form>
        <ErrorBox error={query.error || action.error} />
        {query.loading ? (
          <Empty text="loading" />
        ) : query.data?.length ? (
          query.data.map((c) => (
            <section className="card list-row" key={c.id}>
              <div className="grow">
                <h2>
                  {c.name} {c.protected ? <span className="badge">{t('protected')}</span> : null}
                </h2>
                <p className="muted">
                  {c.actorName} · <DateText time={c.createdAt} /> · {c.files.length} {t('files')}
                </p>
              </div>
              <button onClick={() => setSelected(c)}>{t('compareRestore')}</button>
              <button
                className="quiet danger-text"
                disabled={!writable}
                onClick={() =>
                  setDeletion({ checkpoint: c, revision: state.replica?.revision ?? 0 })
                }
              >
                {t('delete')}
              </button>
            </section>
          ))
        ) : (
          <Empty />
        )}
        {selected ? (
          <CheckpointDialog checkpoint={selected} onClose={() => setSelected(null)} />
        ) : null}
        {deletion ? (
          <Confirm
            title="deleteCheckpoint"
            description="deleteCheckpointExplain"
            onClose={() => setDeletion(null)}
            onConfirm={() =>
              command({
                kind: 'checkpoint-delete',
                checkpointId: deletion.checkpoint.id,
                expectedRevision: deletion.revision,
              })
            }
          >
            <strong>{deletion.checkpoint.name}</strong>
          </Confirm>
        ) : null}
      </div>
    </NeedProject>
  );
}
function CheckpointDialog({ checkpoint, onClose }: { checkpoint: Checkpoint; onClose(): void }) {
  const { t } = useI18n();
  const { state, command, memoryPending } = useApp();
  const query = useQuery<ImpactPreview>({
    kind: 'preview-checkpoint',
    checkpointId: checkpoint.id,
  });
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [comparison, setComparison] = useState<string | null>(null);
  const [restore, setRestore] = useState<{ preview: ImpactPreview; fileIds?: string[] } | null>(
    null,
  );
  const action = useAction();
  const union = useMemo(
    () =>
      [
        ...new Map(
          [...(state.current?.files ?? []), ...checkpoint.files]
            .filter((f) => !f.deleted)
            .map((f) => [f.id, f]),
        ).values(),
      ]
        .filter((f) => f.kind !== 'directory')
        .sort((a, b) => a.path.localeCompare(b.path)),
    [checkpoint, state.current?.files],
  );
  const writable =
    state.replica?.role !== 'viewer' && state.replica?.connection === 'online' && !memoryPending;
  const before = state.current?.files.find((f) => f.id === comparison && !f.deleted);
  const after = checkpoint.files.find((f) => f.id === comparison && !f.deleted);
  async function previewRestore(fileIds?: string[]) {
    await action.run(async () => {
      const preview = (await window.cairn.query({
        kind: 'preview-checkpoint',
        checkpointId: checkpoint.id,
        ...(fileIds ? { fileIds } : {}),
      })) as ImpactPreview;
      setRestore({ preview, fileIds });
    });
  }
  return (
    <Dialog title={`${t('checkpoints')} · ${checkpoint.name}`} onClose={onClose} wide>
      <p className="muted">{t('restoreExplain')}</p>
      <ErrorBox error={query.error || action.error} />
      {query.data ? <Impact preview={query.data} /> : <p>{t('loading')}</p>}
      <h3>{t('chooseFiles')}</h3>
      <div className="checkpoint-files">
        {union.map((f) => (
          <div className="list-row" key={f.id}>
            <label className="check grow">
              <input
                type="checkbox"
                checked={ids.has(f.id)}
                onChange={(e) =>
                  setIds((old) => {
                    const next = new Set(old);
                    e.target.checked ? next.add(f.id) : next.delete(f.id);
                    return next;
                  })
                }
              />
              <span className="path">{f.path}</span>
            </label>
            <button className="quiet" onClick={() => setComparison(f.id)}>
              {t('compare')}
            </button>
          </div>
        ))}
      </div>
      {comparison ? (
        <FileComparison
          before={before?.hash ?? null}
          after={after?.hash ?? null}
          kind={(after ?? before)?.kind}
        />
      ) : null}
      <div className="dialog-actions">
        <button onClick={onClose}>{t('close')}</button>
        <button
          disabled={!writable || !ids.size || action.busy}
          onClick={() => void previewRestore([...ids])}
        >
          {t('restoreSelected')} ({ids.size})
        </button>
        <button
          className="primary"
          disabled={!writable || action.busy}
          onClick={() => void previewRestore()}
        >
          {t('restoreProject')}
        </button>
      </div>
      {restore ? (
        <Confirm
          title="restore"
          description="restoreExplain"
          danger={false}
          onClose={() => setRestore(null)}
          onConfirm={async () => {
            await command({
              kind: 'checkpoint-restore',
              checkpointId: checkpoint.id,
              expectedRevision: restore.preview.revision,
              ...(restore.fileIds ? { fileIds: restore.fileIds } : {}),
            });
            onClose();
          }}
        >
          <Impact preview={restore.preview} />
        </Confirm>
      ) : null}
    </Dialog>
  );
}

export function DeletedView() {
  const { t } = useI18n();
  const { state, command, memoryPending } = useApp();
  const query = useQuery<TrashEntry[]>({ kind: 'trash' });
  const [confirm, setConfirm] = useState<{
    kind: 'purge' | 'restore';
    items: TrashEntry[];
    revision: number;
  } | null>(null);
  const writable =
    state.replica?.role !== 'viewer' && state.replica?.connection === 'online' && !memoryPending;
  useEffect(() => setConfirm(null), [state.current?.projectId]);
  return (
    <NeedProject>
      <div className="page">
        <PageTitle title="deleted">
          <button
            className="danger"
            disabled={!writable || !query.data?.length}
            onClick={() =>
              setConfirm({
                kind: 'purge',
                items: query.data ?? [],
                revision: state.replica?.revision ?? 0,
              })
            }
          >
            {t('emptyTrash')}
          </button>
        </PageTitle>
        <p className="muted">
          {t('retention')}: {state.replica?.metadata.retentionDays ?? '—'}. {t('retentionExplain')}
        </p>
        <ErrorBox error={query.error} />
        {query.loading ? (
          <Empty text="loading" />
        ) : query.data?.length ? (
          query.data.map((item) => (
            <section className="card list-row" key={item.id}>
              <div className="grow">
                <h2 className="path">{item.path}</h2>
                <p className="muted">
                  {item.actorName} · <DateText time={item.deletedAt} /> · <Size bytes={item.size} />
                </p>
              </div>
              <button
                disabled={!writable}
                onClick={() =>
                  setConfirm({
                    kind: 'restore',
                    items: [item],
                    revision: state.replica?.revision ?? 0,
                  })
                }
              >
                {t('restore')}
              </button>
              <button
                className="quiet danger-text"
                disabled={!writable}
                onClick={() =>
                  setConfirm({
                    kind: 'purge',
                    items: [item],
                    revision: state.replica?.revision ?? 0,
                  })
                }
              >
                {t('purge')}
              </button>
            </section>
          ))
        ) : (
          <Empty />
        )}
        {confirm ? (
          <Confirm
            title={confirm.kind === 'purge' ? 'purge' : 'restore'}
            description={confirm.kind === 'purge' ? 'purgeExplain' : 'restoreDeletedExplain'}
            danger={confirm.kind === 'purge'}
            onClose={() => setConfirm(null)}
            onConfirm={() =>
              confirm.kind === 'purge'
                ? command({
                    kind: 'trash-purge',
                    trashIds: confirm.items.map((i) => i.id),
                    expectedRevision: confirm.revision,
                  })
                : command({
                    kind: 'trash-restore',
                    trashId: confirm.items[0]!.id,
                    expectedRevision: confirm.revision,
                  })
            }
          >
            <ul className="path-list">
              {confirm.items.map((i) => (
                <li key={i.id}>{i.path}</li>
              ))}
            </ul>
          </Confirm>
        ) : null}
      </div>
    </NeedProject>
  );
}
function DiffText({
  before,
  after,
  kind,
}: {
  before: string | null;
  after: string | null;
  kind: string;
}) {
  const { t } = useI18n();
  const { state } = useApp();
  const [parts, setParts] = useState<
    { value: string; added?: boolean; removed?: boolean }[] | null
  >(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    setParts(null);
    setError(null);
    if (kind !== 'text') return;
    void Promise.all([
      before ? window.cairn.readBlob(before) : Promise.resolve({ data: '' }),
      after ? window.cairn.readBlob(after) : Promise.resolve({ data: '' }),
    ])
      .then(([a, b]) => {
        if (!alive) return;
        const left = decodeBlob(a.data),
          right = decodeBlob(b.data);
        if (left.length + right.length > 512 * 1024) {
          setParts([{ value: t('previewLimit') }]);
          return;
        }
        const d = diffLines(
          new TextDecoder('utf-8', { fatal: true }).decode(left),
          new TextDecoder('utf-8', { fatal: true }).decode(right),
          { timeout: 100 },
        );
        setParts(d ?? [{ value: t('previewLimit') }]);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [before, after, kind, state.current?.projectId]);
  return (
    <>
      <ErrorBox error={error} />
      <pre className="diff-text">
        {kind !== 'text'
          ? t('binary')
          : parts
            ? parts.map((p, i) => (
                <span
                  className={p.added ? 'diff-add' : p.removed ? 'diff-remove' : 'diff-same'}
                  key={i}
                >
                  {p.value.split(/(?<=\n)/).map((line, j) => (
                    <span key={j}>
                      {p.added ? '+ ' : p.removed ? '− ' : '  '}
                      {line}
                    </span>
                  ))}
                </span>
              ))
            : t('loading')}
      </pre>
    </>
  );
}
export function ActivityView() {
  const { state, notify } = useApp();
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [fileId, setFileId] = useState('');
  const [actorId, setActorId] = useState('');
  const [source, setSource] = useState('');
  const [mode, setMode] = useState<'file' | 'session'>('file');
  const [entry, setEntry] = useState<ActivityEntry | null>(null);
  const query = useQuery<ActivityEntry[]>({
    kind: 'activity',
    ...(search ? { search } : {}),
    ...(fileId ? { fileId } : {}),
    ...(actorId ? { actorId } : {}),
    ...(source ? { source } : {}),
    limit: 500,
  });
  const [authors, setAuthors] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    setAuthors([]);
    setSearch('');
    setFileId('');
    setActorId('');
    setEntry(null);
  }, [state.current?.projectId]);
  useEffect(() => {
    if (query.data)
      setAuthors((old) => [
        ...new Map(
          [...old, ...query.data!.map((e) => ({ id: e.actor.id, name: e.actor.name }))].map((a) => [
            a.id,
            a,
          ]),
        ).values(),
      ]);
  }, [query.data]);
  const groups = useMemo(() => {
    const map = new Map<string, ActivityEntry[]>();
    for (const item of query.data ?? []) {
      const key = mode === 'session' ? item.sessionId : (item.paths[0] ?? t('activity'));
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()];
  }, [query.data, mode]);
  const summary = (entries: ActivityEntry[]) =>
    entries
      .map((e) =>
        [
          `${new Date(e.time).toLocaleString()} · ${e.actor.name} · ${t(operation(e.kind))} · ${t(sourceKey(e.actor.source.kind))}`,
          e.paths.join(', '),
          `+${e.added} −${e.removed}`,
        ].join(String.fromCharCode(10)),
      )
      .join(String.fromCharCode(10, 10));
  const action = useAction();
  return (
    <NeedProject>
      <div className="page">
        <PageTitle title="activity">
          <button onClick={query.reload}>{t('refresh')}</button>
        </PageTitle>
        <div className="filters">
          <input
            aria-label={t('searchActivity')}
            placeholder={t('searchActivity')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label={t('files')}
            value={fileId}
            onChange={(e) => setFileId(e.target.value)}
          >
            <option value="">
              {t('files')} · {t('all')}
            </option>
            {state.current?.files
              .filter((f) => f.kind !== 'directory')
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))}
          </select>
          <select
            aria-label={t('actor')}
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
          >
            <option value="">
              {t('actor')} · {t('all')}
            </option>
            {authors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            aria-label={t('source')}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">
              {t('source')} · {t('all')}
            </option>
            {['app', 'unknown', 'external', 'declared-ai', 'recovery', 'system'].map((k) => (
              <option key={k} value={k}>
                {t(sourceKey(k))}
              </option>
            ))}
          </select>
          <div className="segmented">
            <button aria-pressed={mode === 'file'} onClick={() => setMode('file')}>
              {t('byFile')}
            </button>
            <button aria-pressed={mode === 'session'} onClick={() => setMode('session')}>
              {t('bySession')}
            </button>
          </div>
        </div>
        <p className="muted">{t(mode === 'session' ? 'sessionExplain' : 'sourceExplain')}</p>
        <ErrorBox error={query.error || action.error} />
        {query.loading ? (
          <Empty text="loading" />
        ) : groups.length ? (
          groups.map(([key, entries]) => (
            <section className="card" key={key}>
              <div className="section-line">
                <h2>
                  {mode === 'session' ? (
                    <>
                      {entries[0]?.actor.name} · <DateText time={entries[0]!.time} />
                    </>
                  ) : (
                    key
                  )}
                </h2>
                <button
                  className="quiet"
                  onClick={() =>
                    void action.run(async () => {
                      await window.cairn.copyText(summary(entries));
                      notify(t('copied'));
                    })
                  }
                >
                  {t('copySummary')}
                </button>
              </div>
              {entries.map((e) => (
                <button className="activity-row" key={e.id} onClick={() => setEntry(e)}>
                  <span className="activity-symbol" aria-hidden="true">
                    ↳
                  </span>
                  <span className="grow">
                    <strong>
                      {t(operation(e.kind))} · {e.paths.join(', ')}
                    </strong>
                    <small>
                      {e.actor.name} · {t(sourceKey(e.actor.source.kind))} ·{' '}
                      <DateText time={e.time} />
                    </small>
                  </span>
                  <span className="line-count">
                    <i>+{e.added}</i>
                    <b>−{e.removed}</b>
                  </span>
                  <span>{t('compare')} →</span>
                </button>
              ))}
            </section>
          ))
        ) : (
          <Empty text="noResults" />
        )}
        {entry ? <ActivityDialog entry={entry} onClose={() => setEntry(null)} /> : null}
      </div>
    </NeedProject>
  );
}
function ActivityDialog({ entry, onClose }: { entry: ActivityEntry; onClose(): void }) {
  const { t } = useI18n();
  const [file, setFile] = useState(0);
  const [mode, setMode] = useState<'diff' | 'both'>('diff');
  const change = entry.files[file];
  return (
    <Dialog title={t('activity')} onClose={onClose} wide>
      <p>
        {entry.actor.name} · {t(sourceKey(entry.actor.source.kind))} ·{' '}
        <DateText time={entry.time} />
      </p>
      <div className="filters">
        <select
          aria-label={t('files')}
          value={file}
          onChange={(e) => setFile(Number(e.target.value))}
        >
          {entry.files.map((f, i) => (
            <option value={i} key={f.after.id}>
              {f.after.path}
            </option>
          ))}
        </select>
        <div className="segmented">
          <button aria-pressed={mode === 'diff'} onClick={() => setMode('diff')}>
            {t('diff')}
          </button>
          <button aria-pressed={mode === 'both'} onClick={() => setMode('both')}>
            {t('before')} / {t('after')}
          </button>
        </div>
        <span className="line-count">
          <i>+{entry.added}</i>
          <b>−{entry.removed}</b>
        </span>
      </div>
      {change ? (
        mode === 'diff' ? (
          <DiffText
            before={change.before?.hash ?? null}
            after={change.after.deleted ? null : change.after.hash}
            kind={change.after.kind}
          />
        ) : (
          <FileComparison
            before={change.before?.hash ?? null}
            after={change.after.deleted ? null : change.after.hash}
            kind={change.after.kind}
          />
        )
      ) : (
        <Empty />
      )}
    </Dialog>
  );
}

export function ConflictsView() {
  const { t } = useI18n();
  const { state } = useApp();
  const query = useQuery<ConflictEntry[]>({ kind: 'conflicts' });
  const [selected, setSelected] = useState<{
    conflict: ConflictEntry;
    file?: ProjectFile;
    expected: number;
  } | null>(null);
  useEffect(() => setSelected(null), [state.current?.projectId]);
  return (
    <NeedProject>
      <div className="page">
        <PageTitle title="conflicts">
          <button onClick={query.reload}>{t('refresh')}</button>
        </PageTitle>
        <p className="muted">{t('conflictNotice')}</p>
        <ErrorBox error={query.error} />
        {query.loading ? (
          <Empty text="loading" />
        ) : query.data?.filter((c) => c.status === 'open').length ? (
          query.data
            .filter((c) => c.status === 'open')
            .map((c) => (
              <section className="card list-row" key={c.id}>
                <div className="grow">
                  <h2 className="path">{c.path}</h2>
                  <p className="muted">
                    <DateText time={c.createdAt} />
                  </p>
                  <details>
                    <summary>{t('reason')}</summary>
                    <p>{t('conflictNotice')}</p>
                    <code>{c.reason.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}</code>
                  </details>
                </div>
                <button
                  onClick={() => {
                    const file =
                      c.current === undefined
                        ? state.current?.files.find((f) => f.id === c.fileId)
                        : (c.current ?? undefined);
                    setSelected({ conflict: c, file, expected: file?.revision ?? 0 });
                  }}
                >
                  {t('compare')}
                </button>
              </section>
            ))
        ) : (
          <Empty />
        )}
        {selected ? <ConflictDialog {...selected} onClose={() => setSelected(null)} /> : null}
      </div>
    </NeedProject>
  );
}
function ConflictDialog({
  conflict,
  file,
  expected,
  onClose,
}: {
  conflict: ConflictEntry;
  file?: ProjectFile;
  expected: number;
  onClose(): void;
}) {
  const { t } = useI18n();
  const { command, state, memoryPending } = useApp();
  const [choice, setChoice] = useState<'local' | 'remote' | 'both' | 'merged'>('both');
  const [merged, setMerged] = useState('');
  const [confirm, setConfirm] = useState(false);
  const kind = file?.kind ?? 'binary';
  useEffect(() => {
    let alive = true;
    if (kind === 'text' && conflict.localHash)
      void window.cairn
        .readBlob(conflict.localHash)
        .then((v) => {
          if (alive) {
            const bytes = decodeBlob(v.data);
            if (bytes.length <= 1024 * 1024)
              setMerged(
                (previous) => previous || new TextDecoder('utf-8', { fatal: true }).decode(bytes),
              );
          }
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [conflict.id]);
  return (
    <Dialog title={t('resolve')} onClose={onClose} wide>
      <h3 className="path">{conflict.path}</h3>
      <p className="muted">{t('resolveExplain')}</p>
      <FileComparison
        before={conflict.localHash}
        after={file && !file.deleted ? file.hash : null}
        base={conflict.baseHash}
        kind={kind}
      />
      <p className="muted">{t('currentVersionHelp')}</p>
      {conflict.remoteHash !== (file && !file.deleted ? file.hash : null) ? (
        <BlobPane title={t('historicalRemote')} hash={conflict.remoteHash} kind={kind} />
      ) : null}
      <div className="choice-row">
        {(['local', 'remote', 'both', ...(kind === 'text' ? ['merged'] : [])] as const).map((c) => (
          <label className="check" key={c}>
            <input
              type="radio"
              name="resolution"
              checked={choice === c}
              onChange={() => setChoice(c as typeof choice)}
            />
            {t(
              c === 'local'
                ? 'keepMine'
                : c === 'remote'
                  ? 'keepTheirs'
                  : c === 'both'
                    ? 'keepBoth'
                    : 'manual',
            )}
          </label>
        ))}
      </div>
      {choice === 'merged' ? (
        <label>
          {t('mergedText')}
          <textarea
            rows={12}
            value={merged}
            onChange={(e) => setMerged(e.target.value)}
            spellCheck={false}
          />
        </label>
      ) : null}
      {memoryPending ? <p className="warning">{t('memoryGuard')}</p> : null}
      <div className="dialog-actions">
        <button onClick={onClose}>{t('close')}</button>
        <button
          className="primary"
          disabled={
            !!memoryPending ||
            state.replica?.role === 'viewer' ||
            state.replica?.connection !== 'online'
          }
          onClick={() => setConfirm(true)}
        >
          {t('resolve')}
        </button>
      </div>
      {confirm ? (
        <Confirm
          title="resolve"
          description="resolveExplain"
          danger={false}
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await command({
              kind: 'conflict-resolve',
              conflictId: conflict.id,
              choice,
              expectedRevision: expected,
              ...(choice === 'merged' ? { data: encodeText(merged) } : {}),
            });
            onClose();
          }}
        >
          <p>
            {conflict.path} ·{' '}
            {t(
              choice === 'local'
                ? 'keepMine'
                : choice === 'remote'
                  ? 'keepTheirs'
                  : choice === 'both'
                    ? 'keepBoth'
                    : 'manual',
            )}
          </p>
        </Confirm>
      ) : null}
    </Dialog>
  );
}
