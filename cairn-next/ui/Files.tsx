import { useEffect, useMemo, useState } from 'react';
import type { Claim, ImpactPreview, ProjectFile } from '../shared/project';
import { CollaborativeEditor } from './Editor';
import {
  Confirm,
  Dialog,
  Empty,
  ErrorBox,
  Impact,
  Size,
  decodeBlob,
  encodeText,
  useAction,
  useApp,
} from './common';
import { fileReason, useI18n } from './i18n';
import { Icon } from './Icon';

interface TreeNode {
  path: string;
  name: string;
  file?: ProjectFile;
  children: TreeNode[];
}
function makeTree(files: ProjectFile[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    let parent = roots;
    let path = '';
    for (const part of file.path.split('/')) {
      path = path ? `${path}/${part}` : part;
      let node = byPath.get(path);
      if (!node) {
        node = { path, name: part, children: [] };
        byPath.set(path, node);
        parent.push(node);
      }
      if (path === file.path) node.file = file;
      parent = node.children;
    }
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort(
      (a, b) =>
        Number(b.children.length > 0 || b.file?.kind === 'directory') -
          Number(a.children.length > 0 || a.file?.kind === 'directory') ||
        a.name.localeCompare(b.name),
    );
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}
function Tree({
  nodes,
  depth = 0,
  expanded,
  toggle,
  selected,
  onSelect,
}: {
  nodes: TreeNode[];
  depth?: number;
  expanded: Set<string>;
  toggle(path: string): void;
  selected: string | null;
  onSelect(file: ProjectFile): void;
}) {
  const { t } = useI18n();
  return (
    <ul role={depth === 0 ? 'tree' : 'group'} className="file-tree">
      {nodes.map((node) => {
        const directory = node.file?.kind === 'directory' || node.children.length > 0;
        const open = expanded.has(node.path);
        return (
          <li key={node.path} role="none">
            <div
              className={`tree-row ${node.file?.id === selected ? 'selected' : ''}`}
              style={{ paddingLeft: 8 + depth * 15 }}
              role="treeitem"
              aria-expanded={directory ? open : undefined}
              aria-selected={node.file?.id === selected}
            >
              <button
                className="tree-name"
                title={node.path}
                onClick={() => {
                  if (directory) toggle(node.path);
                  if (node.file) onSelect(node.file);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' && directory && !open) {
                    e.preventDefault();
                    toggle(node.path);
                  }
                  if (e.key === 'ArrowLeft' && directory && open) {
                    e.preventDefault();
                    toggle(node.path);
                  }
                  if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
                    e.preventDefault();
                    const tree = e.currentTarget.closest('[role=tree]');
                    const buttons = [
                      ...(tree?.querySelectorAll<HTMLButtonElement>('.tree-name') ?? []),
                    ];
                    buttons[
                      buttons.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)
                    ]?.focus();
                  }
                }}
              >
                <span aria-hidden="true" className="tree-chevron">
                  {directory ? (open ? '▾' : '▸') : ''}
                </span>
                <Icon
                  name={directory ? (open ? 'folderOpen' : 'projects') : 'files'}
                  className="tree-file-icon"
                />
                <span>{node.name}</span>
              </button>
            </div>
            {directory && open ? (
              node.children.length ? (
                <Tree
                  nodes={node.children}
                  depth={depth + 1}
                  expanded={expanded}
                  toggle={toggle}
                  selected={selected}
                  onSelect={onSelect}
                />
              ) : (
                <small className="muted" style={{ paddingLeft: 24 + depth * 15 }}>
                  {t('emptyFolder')}
                </small>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function BinaryPreview({ file }: { file: ProjectFile }) {
  const { t, locale } = useI18n();
  const { state } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const image = /\.(png|jpe?g|gif|webp)$/i.test(file.path);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | undefined;
    setUrl(null);
    setError(null);
    setInvalid(false);
    if (!image || file.size > 4 * 1024 * 1024) return;
    void window.cairn
      .readBlob(file.hash)
      .then(({ data }) => {
        const b = decodeBlob(data);
        const ascii = (a: number, z: number) => String.fromCharCode(...b.subarray(a, z));
        const mime =
          b[0] === 137 && ascii(1, 4) === 'PNG'
            ? 'image/png'
            : b[0] === 255 && b[1] === 216 && b[2] === 255
              ? 'image/jpeg'
              : /^GIF8[79]a$/.test(ascii(0, 6))
                ? 'image/gif'
                : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
                  ? 'image/webp'
                  : null;
        if (!alive) return;
        if (!mime) {
          setInvalid(true);
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([b.slice().buffer], { type: mime }));
        setUrl(objectUrl);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.hash, image, file.size]);
  return (
    <div className="binary-preview">
      <h2>{file.path}</h2>
      <p className="badge">
        {t('binary')} · <Size bytes={file.size} />
      </p>
      <p className="muted">{t('binaryExplain')}</p>
      {file.reason ? <p className="muted">{fileReason(file.reason, locale)}</p> : null}
      <ErrorBox error={error} />
      {image ? (
        file.size > 4 * 1024 * 1024 ? (
          <p>{t('previewLimit')}</p>
        ) : invalid ? (
          <p>{t('unsafeImage')}</p>
        ) : url ? (
          <img
            src={url}
            alt={file.path}
            onError={() => {
              setInvalid(true);
              setUrl(null);
            }}
          />
        ) : (
          <p>{t('loading')}</p>
        )
      ) : null}
      <button
        disabled={state.simulation}
        onClick={() => void window.cairn.openFolder({ relativePath: file.path }).catch(setError)}
      >
        {t('reveal')}
      </button>
    </div>
  );
}

type FileForm = {
  kind: 'create-file' | 'create-directory' | 'rename' | 'move';
  file?: ProjectFile;
  revision: number;
};
function FileFormDialog({ form, onClose }: { form: FileForm; onClose(): void }) {
  const { t } = useI18n();
  const { command } = useApp();
  const [path, setPath] = useState(form.file?.path ?? '');
  const [content, setContent] = useState('');
  const { busy, error, run } = useAction();
  const title =
    form.kind === 'create-file'
      ? 'newFile'
      : form.kind === 'create-directory'
        ? 'newFolder'
        : form.kind;
  return (
    <Dialog title={t(title)} onClose={() => !busy && onClose()} busy={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (form.file)
              await command({
                kind: 'move',
                fileId: form.file.id,
                path: path.trim(),
                baseRevision: form.file.revision,
                expectedRevision: form.revision,
              });
            else
              await command({
                kind: 'create',
                path: path.trim(),
                nodeKind: form.kind === 'create-file' ? 'text' : 'directory',
                ...(form.kind === 'create-file' ? { data: encodeText(content) } : {}),
              });
            onClose();
          });
        }}
      >
        <label>
          {t('path')}
          <input
            required
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="src/example.ts"
            maxLength={1024}
          />
        </label>
        {form.kind === 'create-file' ? (
          <label>
            {t('content')}
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6} />
          </label>
        ) : null}
        <ErrorBox error={error} />
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={busy || !path.trim()}>
            {t(busy ? 'working' : form.file ? 'save' : 'create')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function ClaimForm({ file, onClose }: { file: ProjectFile; onClose(): void }) {
  const { t } = useI18n();
  const { command } = useApp();
  const [description, setDescription] = useState('');
  const [external, setExternal] = useState(true);
  const [strict, setStrict] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <Dialog title={t('startClaim')} onClose={() => !busy && onClose()} busy={busy}>
      <p className="path">{file.path}</p>
      <p className="muted">{t('claimExplain')}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await command({ kind: 'claim-create', fileId: file.id, description, external, strict });
            onClose();
          });
        }}
      >
        <label>
          {t('description')}
          <input
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={external}
            onChange={(e) => setExternal(e.target.checked)}
          />
          {t('externalClaim')}
        </label>
        <label className="check">
          <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
          {t('strictClaim')}
        </label>
        <ErrorBox error={error} />
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={busy}>
            {t('startClaim')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function FilesView() {
  const {
    state,
    selectedId,
    select,
    clearSelection,
    memoryPending,
    onMemoryPending,
    busy: appBusy,
    command,
    notify,
  } = useApp();
  const { t, locale } = useI18n();
  const files = state.current?.files.filter((f) => !f.deleted) ?? [];
  const selected = files.find((f) => f.id === selectedId);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(new Set<string>());
  const [tabs, setTabs] = useState<string[]>([]);
  const [form, setForm] = useState<FileForm | null>(null);
  const [claimFile, setClaimFile] = useState<ProjectFile | null>(null);
  const [deletion, setDeletion] = useState<{ file: ProjectFile; preview: ImpactPreview } | null>(
    null,
  );
  const { busy, error, run } = useAction();
  const writable = state.replica?.role !== 'viewer' && state.replica?.connection === 'online';
  const tree = useMemo(() => makeTree(files), [state.current?.files]);
  useEffect(() => {
    setTabs([]);
    setExpanded(new Set());
    setSearch('');
    setForm(null);
    setDeletion(null);
  }, [state.current?.projectId]);
  useEffect(() => {
    if (selectedId && selected?.kind !== 'directory')
      setTabs((previous) => (previous.includes(selectedId) ? previous : [...previous, selectedId]));
  }, [selectedId, selected?.kind]);
  const choose = (file: ProjectFile) => void run(() => select(file.id));
  const closeTab = (id: string) => {
    if (id === selectedId && memoryPending) {
      notify(t('memoryGuard'));
      return;
    }
    setTabs((old) => old.filter((v) => v !== id));
    if (id === selectedId) {
      const next = tabs.find((v) => v !== id && files.some((f) => f.id === v));
      if (next) void run(() => select(next));
      else clearSelection();
    }
  };
  const claims =
    state.replica?.metadata.claims.filter(
      (c) => c.fileId === selectedId && c.status === 'active',
    ) ?? [];
  if (!state.current) return <Empty text="selectProject" />;
  return (
    <div className="files-layout">
      <aside className="file-sidebar">
        <div className="sidebar-section-title">
          <strong>{t('files')}</strong>
          <div className="actions file-create-actions">
            <button
              className="file-create-action"
              title={t('newFile')}
              aria-label={t('newFile')}
              disabled={!writable || !!memoryPending}
              onClick={() =>
                setForm({ kind: 'create-file', revision: state.replica?.revision ?? 0 })
              }
            >
              <Icon name="files" />
              <span>{t('newFile')}</span>
            </button>
            <button
              className="file-create-action"
              title={t('newFolder')}
              aria-label={t('newFolder')}
              disabled={!writable || !!memoryPending}
              onClick={() =>
                setForm({ kind: 'create-directory', revision: state.replica?.revision ?? 0 })
              }
            >
              <Icon name="projects" />
              <span>{t('newFolder')}</span>
            </button>
          </div>
        </div>
        <input
          aria-label={t('searchFiles')}
          placeholder={t('searchFiles')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="tree-search"
        />
        {search ? (
          <ul className="search-results">
            {files
              .filter((f) => f.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
              .map((f) => (
                <li key={f.id}>
                  <button
                    title={f.path}
                    className={f.id === selectedId ? 'selected' : ''}
                    onClick={() => choose(f)}
                  >
                    {f.path}
                  </button>
                </li>
              ))}
          </ul>
        ) : (
          <Tree
            nodes={tree}
            expanded={expanded}
            toggle={(path) =>
              setExpanded((prev) => {
                const next = new Set(prev);
                next.has(path) ? next.delete(path) : next.add(path);
                return next;
              })
            }
            selected={selectedId}
            onSelect={choose}
          />
        )}
        {files.length === 0 ? <Empty /> : null}
        {state.current.excluded.length ? (
          <details className="excluded">
            <summary>
              {t('excluded')} ({state.current.excluded.length})
            </summary>
            <p>{t('excludedExplain')}</p>
            {state.current.excluded.map((f) => (
              <p key={f.path}>
                <strong>{f.path}</strong>
                <br />
                {fileReason(f.reason, locale)}
              </p>
            ))}
          </details>
        ) : null}
      </aside>
      <section className="file-workspace">
        <div className="tabs" role="tablist">
          {tabs.map((id) => {
            const f = files.find((x) => x.id === id);
            return f ? (
              <div className={`tab ${id === selectedId ? 'active' : ''}`} key={id}>
                <button
                  role="tab"
                  aria-selected={id === selectedId}
                  onClick={() => choose(f)}
                  title={f.path}
                >
                  {f.path.split('/').at(-1)}
                </button>
                <button
                  className="tab-close"
                  aria-label={`${t('close')} ${f.path}`}
                  onClick={() => closeTab(id)}
                >
                  ×
                </button>
              </div>
            ) : null;
          })}
        </div>
        <ErrorBox error={error} />
        {selected ? (
          <>
            <header className="file-toolbar">
              <span className="file-path" title={selected.path}>
                {selected.path}
              </span>
              <div className="actions">
                <button
                  className="quiet"
                  onClick={() =>
                    void run(() => window.cairn.copyText(selected.path)).then(() =>
                      notify(t('copied')),
                    )
                  }
                >
                  {t('copyPath')}
                </button>
                <button
                  className="quiet"
                  disabled={state.simulation}
                  onClick={() =>
                    void run(() => window.cairn.openFolder({ relativePath: selected.path }))
                  }
                >
                  {t('reveal')}
                </button>
                <button
                  className="quiet"
                  disabled={!writable || !!memoryPending || busy}
                  onClick={() =>
                    setForm({
                      kind: 'rename',
                      file: selected,
                      revision: state.replica?.revision ?? 0,
                    })
                  }
                >
                  {t('rename')}
                </button>
                <button
                  className="quiet"
                  disabled={!writable || !!memoryPending || busy}
                  onClick={() =>
                    setForm({
                      kind: 'move',
                      file: selected,
                      revision: state.replica?.revision ?? 0,
                    })
                  }
                >
                  {t('move')}
                </button>
                <button
                  className="quiet danger-text"
                  disabled={!writable || !!memoryPending || busy}
                  onClick={() =>
                    void run(async () => {
                      const preview = (await window.cairn.query({
                        kind: 'preview-delete',
                        fileId: selected.id,
                      })) as ImpactPreview;
                      setDeletion({ file: selected, preview });
                    })
                  }
                >
                  {t('delete')}
                </button>
              </div>
            </header>
            {selected.kind === 'text' && state.editor?.fileId === selected.id ? (
              <CollaborativeEditor
                key={`${state.current.projectId}/${selected.id}/${state.editor.generation}`}
                snapshot={state.editor}
                switching={appBusy}
                onMemoryPending={onMemoryPending}
              />
            ) : selected.kind === 'binary' ? (
              <BinaryPreview file={selected} />
            ) : selected.kind === 'directory' ? (
              <Empty text="selectFile" />
            ) : (
              <Empty text="loading" />
            )}
            {selected.kind !== 'directory' ? (
              <details className="claims">
                <summary>
                  {t('claims')} ({claims.length})
                </summary>
                <p className="muted">{t('claimExplain')}</p>
                <div className="actions">
                  <button
                    disabled={!writable || !!memoryPending}
                    onClick={() => setClaimFile(selected)}
                  >
                    {t('startClaim')}
                  </button>
                </div>
                {claims.map((c) => (
                  <ClaimRow key={c.id} claim={c} />
                ))}
              </details>
            ) : null}
            <footer className="editor-status">
              <span>
                {state.simulation
                  ? t('temporary')
                  : memoryPending
                    ? t('memoryPending')
                    : t('localSaved')}
              </span>
              <span>
                {selected.lineEnding?.toUpperCase() ?? '—'} · <Size bytes={selected.size} />
              </span>
              <button
                className="quiet"
                disabled={selected.kind !== 'text'}
                onClick={() => window.dispatchEvent(new Event('cairn-save'))}
              >
                {t('saveNow')} · ⌘ / Ctrl S
              </button>
            </footer>
          </>
        ) : (
          <Empty text="selectFile" />
        )}
      </section>
      {form ? <FileFormDialog form={form} onClose={() => setForm(null)} /> : null}
      {claimFile ? <ClaimForm file={claimFile} onClose={() => setClaimFile(null)} /> : null}
      {deletion ? (
        <Confirm
          title="delete"
          description="deleteExplain"
          onClose={() => setDeletion(null)}
          onConfirm={() =>
            command({
              kind: 'delete',
              fileId: deletion.file.id,
              baseRevision: deletion.file.revision,
              expectedRevision: deletion.preview.revision,
            })
          }
        >
          <Impact preview={deletion.preview} />
        </Confirm>
      ) : null}
    </div>
  );
}
function ClaimRow({ claim }: { claim: Claim }) {
  const { t } = useI18n();
  const { state, command } = useApp();
  const { busy, error, run } = useAction();
  const own = claim.ownerId === state.replica?.actorId;
  const owner = state.replica?.role === 'owner';
  return (
    <div className="claim-row">
      <strong>{claim.ownerName}</strong>
      <span>{claim.description}</span>
      <span>{t(claim.external ? 'externalClaim' : 'app')}</span>
      <div className="actions">
        {own ? (
          <>
            <button
              disabled={busy}
              onClick={() => void run(() => command({ kind: 'claim-renew', claimId: claim.id }))}
            >
              {t('renew')}
            </button>
            <button
              disabled={busy}
              onClick={() => void run(() => command({ kind: 'claim-complete', claimId: claim.id }))}
            >
              {t('completeClaim')}
            </button>
          </>
        ) : null}
        {own || owner ? (
          <button
            disabled={busy}
            onClick={() => void run(() => command({ kind: 'claim-cancel', claimId: claim.id }))}
          >
            {t('cancelClaim')}
          </button>
        ) : null}
      </div>
      <ErrorBox error={error} />
    </div>
  );
}
