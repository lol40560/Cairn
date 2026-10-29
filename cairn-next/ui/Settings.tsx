import { useEffect, useState } from 'react';
import type { ExportPreview, Locale } from '../shared/release-api';
import { Confirm, Dialog, Empty, ErrorBox, PageTitle, Size, useAction, useApp } from './common';
import { sourceKey, useI18n } from './i18n';

export function Onboarding({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const { refresh } = useApp();
  const action = useAction();
  return (
    <Dialog title={t('onboarding')} onClose={onClose}>
      <div className="onboarding-mark" aria-hidden="true">
        ◒
      </div>
      <h2>{t('welcome')}</h2>
      <p>{t('onboarding1')}</p>
      <p>{t('onboarding2')}</p>
      <p>{t('onboarding3')}</p>
      <p className="muted">
        ⌘ / Ctrl P · {t('quickOpen')}
        <br />⌘ / Ctrl K · {t('commands')}
        <br />⌘ / Ctrl S · {t('saveNow')}
      </p>
      <ErrorBox error={action.error} />
      <div className="dialog-actions">
        <button
          className="primary"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await window.cairn.savePreferences({ onboardingDone: true });
              await refresh();
              onClose();
            })
          }
        >
          {t('start')}
        </button>
      </div>
    </Dialog>
  );
}

export function SettingsView() {
  const { t } = useI18n();
  const { state, refresh, command, notify, replace, memoryPending } = useApp();
  const [name, setName] = useState(state.preferences.displayName);
  const [locale, setLocale] = useState<Locale>(state.preferences.locale);
  const [source, setSource] = useState(state.preferences.source.kind);
  const [tool, setTool] = useState(state.preferences.source.tool ?? '');
  const [ignore, setIgnore] = useState(state.replica?.metadata.ignorePatterns.join('\n') ?? '');
  const [retention, setRetention] = useState(state.replica?.metadata.retentionDays ?? 30);
  const [strict, setStrict] = useState(state.replica?.metadata.strictClaims ?? false);
  const [owner, setOwner] = useState(state.gitHub.owner);
  const [repo, setRepo] = useState(state.gitHub.repo);
  const [branch, setBranch] = useState(state.gitHub.baseBranch);
  const [token, setToken] = useState('');
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [legal, setLegal] = useState<{ title: string; content: string } | null>(null);
  const [guide, setGuide] = useState(false);
  const [clear, setClear] = useState(false);
  const action = useAction();
  const ownerRole = state.replica?.role === 'owner' && state.replica.connection === 'online';
  useEffect(() => {
    setIgnore(state.replica?.metadata.ignorePatterns.join('\n') ?? '');
    setRetention(state.replica?.metadata.retentionDays ?? 30);
    setStrict(state.replica?.metadata.strictClaims ?? false);
    setPreview(null);
  }, [state.current?.projectId]);
  async function saveGitHub() {
    await window.cairn.saveGitHub({
      owner: owner.trim(),
      repo: repo.trim(),
      baseBranch: branch.trim(),
      ...(token ? { token } : {}),
    });
    setToken('');
    await refresh();
    notify(t('saved'));
  }
  return (
    <div className="page settings-page">
      <PageTitle title="settings" />
      <ErrorBox error={action.error} />
      <div className="two-column">
        <section className="card">
          <h2>{t('profile')}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                await window.cairn.savePreferences({
                  displayName: name.trim(),
                  locale,
                  source: {
                    kind: source,
                    ...(source === 'declared-ai' && tool.trim() ? { tool: tool.trim() } : {}),
                  },
                });
                await refresh();
                notify(t('saved'));
              });
            }}
          >
            <label>
              {t('displayName')}
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
              />
            </label>
            <label>
              {t('locale')}
              <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                <option value="ko">한국어</option>
                <option value="en">English</option>
                <option value="zh-TW">繁體中文</option>
              </select>
            </label>
            <label>
              {t('source')}
              <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
                {['app', 'unknown', 'declared-ai'].map((s) => (
                  <option value={s} key={s}>
                    {t(sourceKey(s))}
                  </option>
                ))}
              </select>
            </label>
            {source === 'declared-ai' ? (
              <label>
                {t('description')} · {t('optional')}
                <input value={tool} onChange={(e) => setTool(e.target.value)} maxLength={80} />
              </label>
            ) : null}
            <p className="muted">{t('sourceExplain')}</p>
            <button className="primary" disabled={action.busy || !name.trim()}>
              {t('save')}
            </button>
          </form>
        </section>
        <section className="card">
          <h2>{t('current')}</h2>
          {state.current ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(async () => {
                  await command({
                    kind: 'settings',
                    ignorePatterns: ignore
                      .split(/\r?\n/)
                      .map((v) => v.trim())
                      .filter(Boolean),
                    retentionDays: retention,
                    strictClaims: strict,
                  });
                  notify(t('saved'));
                });
              }}
            >
              <p className="path">{state.current.name}</p>
              {!ownerRole ? (
                <p className="muted">
                  {t(
                    state.replica?.connection !== 'online'
                      ? 'settingsConnectFirst'
                      : 'settingsOwnerOnly',
                  )}
                </p>
              ) : null}
              <label>
                {t('ignore')}
                <textarea
                  rows={5}
                  value={ignore}
                  onChange={(e) => setIgnore(e.target.value)}
                  disabled={!ownerRole}
                />
                <small>{t('ignoreExplain')}</small>
              </label>
              <label>
                {t('retention')}
                <input
                  type="number"
                  min={1}
                  max={3650}
                  required
                  value={retention}
                  onChange={(e) => setRetention(Number(e.target.value))}
                  disabled={!ownerRole}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={strict}
                  onChange={(e) => setStrict(e.target.checked)}
                  disabled={!ownerRole}
                />
                {t('strictClaims')}
              </label>
              <button className="primary" disabled={!ownerRole || action.busy || !!memoryPending}>
                {t('save')}
              </button>
            </form>
          ) : (
            <Empty text="selectProject" />
          )}
        </section>
      </div>
      <section className="card">
        <h2>{t('github')}</h2>
        <p className="muted">{t('githubHelp')}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(saveGitHub);
          }}
        >
          <div className="three-column">
            <label>
              {t('repoOwner')}
              <input
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                required
                autoComplete="off"
              />
            </label>
            <label>
              {t('repo')}
              <input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                required
                autoComplete="off"
              />
            </label>
            <label>
              {t('baseBranch')}
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                required
                autoComplete="off"
              />
            </label>
          </div>
          <label>
            {t('token')}
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
            />
            <small>{t(state.gitHub.hasToken ? 'tokenSaved' : 'tokenEmpty')}</small>
          </label>
          <div className="actions">
            <button className="primary" disabled={action.busy || state.simulation}>
              {t('save')}
            </button>
            <button
              type="button"
              disabled={action.busy || !state.gitHub.hasToken || state.simulation}
              onClick={() => setClear(true)}
            >
              {t('clearToken')}
            </button>
            <button
              type="button"
              disabled={action.busy || !state.current || state.simulation || !!memoryPending}
              onClick={() =>
                void action.run(async () => {
                  setPreview(await window.cairn.previewGitHub());
                })
              }
            >
              {t('previewExport')}
            </button>
          </div>
        </form>
      </section>
      <div className="two-column">
        <section className="card">
          <h2>{t('snapshot')}</h2>
          <p className="muted">{t('snapshotHelp')}</p>
          <button
            disabled={!state.current || action.busy || !!memoryPending || state.simulation}
            onClick={() =>
              void action.run(async () => {
                const result = await window.cairn.exportSnapshot();
                if (result)
                  notify(`${t('exportDone')} · ${result.files} ${t('files')} · ${result.path}`);
              })
            }
          >
            {t('snapshot')}
          </button>
        </section>
        <section className="card coming-soon">
          <span className="badge">{t('pcServer')}</span>
          <p className="muted">{t('pcServerHelp')}</p>
        </section>
      </div>
      <section className="card">
        <div className="actions wrap">
          <button onClick={() => setGuide(true)}>{t('onboarding')}</button>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const text = await window.cairn.legal();
                setLegal({ title: t('legal'), content: text.licenses });
              })
            }
          >
            {t('legal')}
          </button>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const text = await window.cairn.legal();
                setLegal({ title: t('privacy'), content: t('privacyNotice') });
              })
            }
          >
            {t('privacy')}
          </button>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await window.cairn.copyDiagnostics();
                notify(t('copied'));
              })
            }
          >
            {t('diagnostics')}
          </button>
          <button
            disabled={action.busy || !!memoryPending}
            onClick={() =>
              void action.run(() =>
                replace(() =>
                  state.simulation ? window.cairn.stopSimulation() : window.cairn.startSimulation(),
                ),
              )
            }
          >
            {t(state.simulation ? 'stopSimulation' : 'startSimulation')}
          </button>
        </div>
        <p className="muted">Cairn Next {state.version}</p>
      </section>
      {preview ? <ExportDialog preview={preview} onClose={() => setPreview(null)} /> : null}
      {legal ? (
        <Dialog title={legal.title} onClose={() => setLegal(null)} wide>
          <pre className="legal-text">{legal.content}</pre>
        </Dialog>
      ) : null}
      {guide ? <Onboarding onClose={() => setGuide(false)} /> : null}
      {clear ? (
        <Confirm
          title="clearToken"
          description="clearToken"
          onClose={() => setClear(false)}
          onConfirm={async () => {
            await window.cairn.saveGitHub({
              owner: state.gitHub.owner,
              repo: state.gitHub.repo,
              baseBranch: state.gitHub.baseBranch,
              clearToken: true,
            });
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}
function ExportDialog({ preview, onClose }: { preview: ExportPreview; onClose(): void }) {
  const { t } = useI18n();
  const { state, notify } = useApp();
  const [selected, setSelected] = useState(
    () => new Set(preview.files.filter((f) => f.selected).map((f) => f.path)),
  );
  const [active, setActive] = useState(preview.files[0]?.path ?? '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ url: string; branch: string } | null>(null);
  const file = preview.files.find((f) => f.path === active);
  const action = useAction();
  return (
    <Dialog title={t('previewExport')} onClose={onClose} wide>
      <p>
        <strong>
          {preview.owner}/{preview.repo}
        </strong>{' '}
        → {preview.baseBranch}
      </p>
      <p className="muted">{t('publishExplain')}</p>
      <div className="export-files">
        {preview.files.map((f) => (
          <div className="list-row" key={f.path}>
            <label className="check grow">
              <input
                type="checkbox"
                disabled={!!result}
                checked={selected.has(f.path)}
                onChange={(e) =>
                  setSelected((old) => {
                    const next = new Set(old);
                    e.target.checked ? next.add(f.path) : next.delete(f.path);
                    return next;
                  })
                }
              />
              <span className="path">{f.path}</span>
            </label>
            <span className="badge">
              {t(f.action === 'add' ? 'additions' : f.action === 'delete' ? 'removals' : 'updates')}
            </span>
            <Size bytes={f.size} />
            <button className="quiet" onClick={() => setActive(f.path)}>
              {t('diff')}
            </button>
          </div>
        ))}
      </div>
      {file ? (
        <pre className="diff-text">
          {file.diff ?? t(file.kind === 'binary' ? 'binary' : 'none')}
        </pre>
      ) : (
        <Empty />
      )}
      {preview.excluded.length ? (
        <details>
          <summary>
            {t('excluded')} ({preview.excluded.length})
          </summary>
          <ul>
            {preview.excluded.map((f) => (
              <li key={f.path}>{f.path}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {result ? (
        <div className="success-box">
          <h3>{t('published')}</h3>
          <p>{result.branch}</p>
          <input readOnly value={result.url} aria-label={t('published')} />
          <button
            onClick={() =>
              void action.run(async () => {
                await window.cairn.copyText(result.url);
                notify(t('copied'));
              })
            }
          >
            {t('copy')}
          </button>
        </div>
      ) : (
        <>
          <label>
            {t('title')}
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </label>
          <label>
            {t('body')}
            <textarea
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={10000}
            />
          </label>
          <div className="dialog-actions">
            <button onClick={onClose}>{t('cancel')}</button>
            <button
              className="primary"
              disabled={!selected.size || !title.trim() || state.simulation}
              onClick={() => setConfirm(true)}
            >
              {t('publish')} ({selected.size})
            </button>
          </div>
        </>
      )}
      <ErrorBox error={action.error} />
      {confirm ? (
        <Confirm
          title="publish"
          description="publishExplain"
          danger={false}
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            const result = await window.cairn.publishGitHub({
              previewId: preview.previewId,
              selectedPaths: [...selected],
              title: title.trim(),
              body,
            });
            setResult(result);
          }}
        >
          <p>
            {preview.owner}/{preview.repo} → {preview.baseBranch}
          </p>
          <ul className="path-list">
            {[...selected].map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </Confirm>
      ) : null}
    </Dialog>
  );
}
