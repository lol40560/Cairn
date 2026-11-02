import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReleaseState, RecentProject } from '../shared/release-api';
import type { CommandInput } from '../shared/project';
import { I18n, translate, useI18n } from './i18n';
import {
  AppContext,
  Confirm,
  DateText,
  Dialog,
  Empty,
  ErrorBox,
  PageTitle,
  type Page,
  useAction,
  useApp,
} from './common';
import { FilesView } from './Files';
import { ActivityView, CheckpointsView, ConflictsView, DeletedView } from './Recovery';
import { TeamView } from './Team';
import { Onboarding, SettingsView } from './Settings';
import { Icon } from './Icon';
import './styles.css';
const pages: Page[] = [
  'home',
  'projects',
  'files',
  'activity',
  'team',
  'conflicts',
  'checkpoints',
  'deleted',
  'settings',
];
const navigationGroups: { label: string; pages: Page[] }[] = [
  { label: 'navWork', pages: ['home', 'projects', 'files'] },
  { label: 'navCollaborate', pages: ['team', 'conflicts'] },
  { label: 'navHistory', pages: ['activity', 'checkpoints', 'deleted'] },
];
function selectionSession(state: ReleaseState | null): string | null {
  return state?.current ? `${state.current.id}/${state.replica?.clientId ?? ''}` : null;
}
function restoredSelection(state: ReleaseState): string | null {
  const id = state.editor?.fileId;
  return id && state.current?.files.some((file) => file.id === id && !file.deleted) ? id : null;
}
function App() {
  const [state, setState] = useState<ReleaseState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [page, setPage] = useState<Page>('home');
  const [busy, setBusy] = useState(false);
  const [memoryPending, setMemoryPending] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [palette, setPalette] = useState<'files' | 'commands' | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const currentRef = useRef(state);
  currentRef.current = state;
  const pendingRef = useRef(0);
  const operationEpoch = useRef(0);
  const selectionEpoch = useRef(0);
  const eventEpoch = useRef(0);
  const busyRef = useRef(false);
  const shownOnboarding = useRef(false);
  const heldSnapshot = useRef(false);
  const selectionSessionRef = useRef<string | null | undefined>(undefined);
  const restoreSelectionPending = useRef(false);
  const notify = useCallback((message: string) => setNotice(message), []);
  const accept = useCallback((next: ReleaseState) => {
    setState((previous) => {
      if (pendingRef.current && previous?.current) {
        if (
          next.current?.projectId !== previous.current.projectId ||
          next.replica?.clientId !== previous.replica?.clientId
        ) {
          heldSnapshot.current = true;
          return previous;
        }
        if (
          previous.editor &&
          (!next.editor ||
            next.editor.fileId !== previous.editor.fileId ||
            next.editor.generation !== previous.editor.generation)
        ) {
          heldSnapshot.current = true;
          const retainedFile = previous.current.files.find(
            (file) => file.id === previous.editor!.fileId,
          );
          return {
            ...next,
            editor: previous.editor,
            current: {
              ...next.current!,
              files: [
                ...next.current!.files.map((file) =>
                  file.id === previous.editor!.fileId
                    ? (previous.current!.files.find((old) => old.id === file.id) ?? file)
                    : file,
                ),
                ...(retainedFile && !next.current!.files.some((file) => file.id === retainedFile.id)
                  ? [retainedFile]
                  : []),
              ],
            },
          };
        }
      }
      return next;
    });
  }, []);
  const refresh = useCallback(async () => {
    const epoch = operationEpoch.current,
      events = eventEpoch.current;
    const next = await window.cairn.state();
    if (epoch === operationEpoch.current && events === eventEpoch.current) accept(next);
  }, [accept]);
  useEffect(() => {
    if (!window.cairn) {
      setError({ code: 'DESKTOP_REQUIRED' });
      return;
    }
    let alive = true;
    const unsubscribe = window.cairn.onState((next) => {
      if (!alive) return;
      eventEpoch.current++;
      accept(next);
    });
    void refresh().catch(setError);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [accept, refresh]);
  useEffect(() => {
    if (state) {
      document.documentElement.lang = state.preferences.locale;
      if (!state.preferences.onboardingDone && !shownOnboarding.current) {
        shownOnboarding.current = true;
        setOnboarding(true);
      }
    }
  }, [state?.preferences.locale, state?.preferences.onboardingDone]);
  useEffect(() => {
    if (!state || pendingRef.current) return;
    const session = selectionSession(state);
    const restored = restoredSelection(state);
    if (selectionSessionRef.current !== session) {
      selectionSessionRef.current = session;
      restoreSelectionPending.current = !!session && !restored;
      setSelectedId(restored);
      return;
    }
    // A joining/restoring session may receive its editor after the first state.
    // Once hydrated or explicitly selected/closed, ordinary updates never reopen it.
    if (restoreSelectionPending.current && restored) {
      restoreSelectionPending.current = false;
      setSelectedId(restored);
    } else if (
      selectedId &&
      !state.current?.files.some((file) => file.id === selectedId && !file.deleted)
    ) {
      // Follow the controller's safe fallback only when the selected file disappeared.
      setSelectedId(restored);
    }
  }, [state?.current, state?.replica?.clientId, state?.editor?.fileId, memoryPending, selectedId]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  const guard = useCallback(() => {
    if (pendingRef.current)
      throw Object.assign(new Error('Input is waiting to be saved'), { code: 'MEMORY_PENDING' });
  }, []);
  const replace = useCallback(
    async (action: () => Promise<ReleaseState>) => {
      guard();
      if (busyRef.current) throw Object.assign(new Error('Busy'), { code: 'BUSY' });
      const epoch = ++operationEpoch.current;
      selectionEpoch.current++;
      busyRef.current = true;
      window.dispatchEvent(new CustomEvent('cairn-pause-editing', { detail: true }));
      setBusy(true);
      setError(null);
      const previousSession = selectionSession(currentRef.current);
      try {
        const next = await action();
        if (epoch !== operationEpoch.current) return;
        accept(next);
        if (previousSession !== selectionSession(next)) setSelectedId(restoredSelection(next));
      } finally {
        if (epoch === operationEpoch.current) {
          busyRef.current = false;
          window.dispatchEvent(new CustomEvent('cairn-pause-editing', { detail: false }));
          setBusy(false);
        }
      }
    },
    [guard, accept],
  );
  const command = useCallback(
    async (input: CommandInput) => {
      guard();
      const epoch = operationEpoch.current;
      const projectId = state?.current?.projectId,
        clientId = state?.replica?.clientId;
      if (!projectId || !clientId)
        throw Object.assign(new Error('No project'), { code: 'PROJECT_REQUIRED' });
      const event = await window.cairn.command(input, { projectId, clientId });
      if (epoch === operationEpoch.current) await refresh();
      return event;
    },
    [guard, refresh, state?.current?.projectId, state?.replica?.clientId],
  );
  const select = useCallback(
    async (id: string) => {
      if (selectedId === id) return;
      guard();
      if (busyRef.current) throw Object.assign(new Error('Busy'), { code: 'BUSY' });
      const epoch = ++selectionEpoch.current;
      const project = currentRef.current?.current?.projectId;
      const clientId = currentRef.current?.replica?.clientId;
      busyRef.current = true;
      setBusy(true);
      window.dispatchEvent(new CustomEvent('cairn-pause-editing', { detail: true }));
      try {
        const editor = await window.cairn.selectFile(id);
        if (
          epoch !== selectionEpoch.current ||
          project !== currentRef.current?.current?.projectId ||
          clientId !== currentRef.current?.replica?.clientId
        )
          return;
        restoreSelectionPending.current = false;
        setSelectedId(id);
        setState((previous) => (previous ? { ...previous, editor } : previous));
        setPage('files');
      } finally {
        if (epoch === selectionEpoch.current) {
          busyRef.current = false;
          setBusy(false);
          window.dispatchEvent(new CustomEvent('cairn-pause-editing', { detail: false }));
        }
      }
    },
    [guard, selectedId],
  );
  const onMemoryPending = useCallback(
    (count: number) => {
      pendingRef.current = count;
      setMemoryPending(count);
      if (!count && heldSnapshot.current) {
        heldSnapshot.current = false;
        void refresh().catch(setError);
      }
    },
    [refresh],
  );
  const clearSelection = useCallback(() => {
    guard();
    selectionEpoch.current++;
    restoreSelectionPending.current = false;
    setSelectedId(null);
  }, [guard]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const letter = event.key.toLowerCase();
      if (letter === 'p' || letter === 'k') {
        event.preventDefault();
        event.stopPropagation();
        setPalette(letter === 'p' ? 'files' : 'commands');
      } else if (letter === 's') {
        event.preventDefault();
        window.dispatchEvent(new Event('cairn-save'));
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  if (!state)
    return (
      <I18n value="en">
        <div className="loading-screen">
          <div className="brand">
            Cairn <span>Next</span>
          </div>
          <ErrorBox error={error} />
          {!error ? <Empty text="loading" /> : null}
        </div>
      </I18n>
    );
  return (
    <I18n value={state.preferences.locale}>
      <AppContext.Provider
        value={{
          state,
          memoryPending,
          busy,
          selectedId,
          onMemoryPending,
          go: setPage,
          notify,
          refresh,
          command,
          replace,
          select,
          clearSelection,
        }}
      >
        <Shell page={page} setPage={setPage} palette={() => setPalette('commands')}>
          <ErrorBox error={error || state.error} />
          <div
            className={`editor-route ${page === 'files' ? 'visible' : ''}`}
            aria-hidden={page !== 'files'}
          >
            <FilesView key={state.current?.id + String(state.replica?.clientId)} />
          </div>
          {page === 'home' ? (
            <HomeView key={state.current?.id + String(state.replica?.clientId)} />
          ) : page === 'projects' ? (
            <ProjectsView />
          ) : page === 'activity' ? (
            <ActivityView key={state.current?.id + String(state.replica?.clientId)} />
          ) : page === 'team' ? (
            <TeamView />
          ) : page === 'conflicts' ? (
            <ConflictsView key={state.current?.id + String(state.replica?.clientId)} />
          ) : page === 'checkpoints' ? (
            <CheckpointsView key={state.current?.id + String(state.replica?.clientId)} />
          ) : page === 'deleted' ? (
            <DeletedView key={state.current?.id + String(state.replica?.clientId)} />
          ) : page === 'settings' ? (
            <SettingsView key={state.current?.id + String(state.replica?.clientId)} />
          ) : null}
        </Shell>
        {notice ? (
          <div className="toast" role="status">
            <span>{notice}</span>
            <button
              onClick={() => setNotice('')}
              aria-label={translate(state.preferences.locale, 'close')}
            >
              <Icon name="close" />
            </button>
          </div>
        ) : null}
        {palette ? <Palette mode={palette} onClose={() => setPalette(null)} /> : null}
        {onboarding ? <Onboarding onClose={() => setOnboarding(false)} /> : null}
      </AppContext.Provider>
    </I18n>
  );
}
function Shell({
  page,
  setPage,
  palette,
  children,
}: {
  page: Page;
  setPage(page: Page): void;
  palette(): void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { state, busy, memoryPending, refresh, notify, replace } = useApp();
  const action = useAction();
  const conflicts =
    state.replica?.metadata.conflicts.filter((c) => c.status === 'open').length ?? 0;
  return (
    <div className="app-shell">
      <aside className="navigation">
        <div className="brand">
          <span className="cairn-mark" aria-hidden="true">
            <i />
            <i />
          </span>
          Cairn <span>Next</span>
        </div>
        <button
          className="project-switch"
          onClick={() => setPage('projects')}
          title={state.current?.path}
        >
          <span className="eyebrow">{t(state.current ? 'current' : 'projects')}</span>
          <strong>{state.current?.name ?? t('chooseProject')}</strong>
          <span aria-hidden="true">
            <Icon name="chevronDown" />
          </span>
        </button>
        <nav aria-label="Cairn">
          {navigationGroups.map((group) => (
            <div
              className="nav-group"
              key={group.label}
              role="group"
              aria-labelledby={`nav-${group.label}`}
            >
              <p className="nav-group-label" id={`nav-${group.label}`}>
                {t(group.label)}
              </p>
              {group.pages.map((p) => (
                <button
                  key={p}
                  className={page === p ? 'active' : ''}
                  aria-current={page === p ? 'page' : undefined}
                  onClick={() => setPage(p)}
                >
                  <Icon name={p} className="nav-icon" />
                  {t(p)}
                  {p === 'conflicts' && conflicts ? <b className="nav-count">{conflicts}</b> : null}
                </button>
              ))}
            </div>
          ))}
          <div className="nav-utility">
            <button
              className={page === 'settings' ? 'active' : ''}
              aria-current={page === 'settings' ? 'page' : undefined}
              onClick={() => setPage('settings')}
            >
              <Icon name="settings" className="nav-icon" />
              {t('settings')}
            </button>
          </div>
        </nav>
        <div className="navigation-bottom">
          <button className="palette-trigger" onClick={palette}>
            <span className="palette-label">
              <Icon name="search" />
              {t('commands')}
            </span>
            <kbd>⌘ / Ctrl K</kbd>
          </button>
          <span className="profile">
            <span className="avatar">{state.preferences.displayName.slice(0, 1)}</span>
            <strong>{state.preferences.displayName}</strong>
          </span>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div>
            <span className="breadcrumb">{state.current?.name ?? 'Cairn Next'}</span>
            <span className="separator">/</span>
            <strong>{t(page)}</strong>
          </div>
          <div className="actions">
            <span className="status-pill">
              <span
                className={`status-dot ${state.replica?.connection === 'online' ? 'green' : ''}`}
              />
              {state.simulation
                ? t('simulation')
                : state.replica
                  ? t(
                      state.replica.connection === 'error'
                        ? 'errorState'
                        : state.replica.connection,
                    )
                  : t('local')}
            </span>
            {busy ? <span role="status">{t('working')}</span> : null}
          </div>
        </header>
        {state.simulation ? (
          <div className="simulation-banner" role="status">
            <span>
              {t('simulationBanner')} · {t('temporary')}
            </span>
            <button
              disabled={busy || action.busy || !!memoryPending}
              onClick={() => void action.run(() => replace(() => window.cairn.stopSimulation()))}
            >
              {t('stopSimulation')}
            </button>
          </div>
        ) : null}
        {memoryPending ? (
          <div className="memory-banner" role="status">
            {t('memoryGuard')}
          </div>
        ) : null}
        <main>{children}</main>
        <footer className="app-footer">
          <span>
            {state.simulation
              ? t('simulation')
              : state.current
                ? t(state.current.watching ? 'watching' : 'off')
                : 'Cairn Next'}
          </span>
          <div className="actions">
            <button
              className="quiet"
              disabled={!state.current || action.busy || state.simulation}
              onClick={() =>
                void action.run(async () => {
                  await window.cairn.retryProjection();
                  await refresh();
                })
              }
            >
              {t('retryFolder')}
            </button>
            <button
              className="quiet"
              onClick={() =>
                void action.run(async () => {
                  await window.cairn.copyDiagnostics();
                  notify(t('copied'));
                })
              }
            >
              {t('diagnostics')}
            </button>
          </div>
        </footer>
        <ErrorBox error={action.error} />
      </div>
    </div>
  );
}
function HomeView() {
  const { t } = useI18n();
  const { state, go, replace, memoryPending, refresh } = useApp();
  const action = useAction();
  const replica = state.replica;
  const fileCount =
    state.current?.files.filter((f) => !f.deleted && f.kind !== 'directory').length ?? 0;
  const conflicts = replica?.metadata.conflicts.filter((c) => c.status === 'open').length ?? 0;
  const projections = replica?.projections ?? [];
  const disk = projections.some(
    (p) => p.state === 'error' || p.state === 'blocked' || p.state === 'held',
  )
    ? 'diskBlocked'
    : projections.some((p) => p.state === 'pending')
      ? 'diskPending'
      : 'diskApplied';
  const openFolderButton = (
    <button
      className={state.current ? '' : 'primary'}
      disabled={action.busy || !!memoryPending || state.simulation}
      onClick={() =>
        void action.run(async () => {
          const path = await window.cairn.chooseFolder();
          if (path) {
            await replace(() => window.cairn.openProject({ path }));
            go('files');
          }
        })
      }
    >
      <Icon name="folderOpen" />
      {t('openProject')}
    </button>
  );
  return (
    <div className="page home-page">
      {state.current ? (
        <div className="home-hero workspace-hero">
          <div className="workspace-heading">
            <span className="eyebrow">{t('current')}</span>
            <h1>{state.current.name}</h1>
            <p>{t('continueHelp')}</p>
          </div>
          <div className="actions wrap">
            <button className="primary" onClick={() => go('files')}>
              <Icon name="files" />
              {t(replica?.role === 'viewer' ? 'browseFiles' : 'resumeEditing')}
              <Icon name="arrowRight" />
            </button>
            {openFolderButton}
          </div>
        </div>
      ) : (
        <div className="home-hero">
          <span className="eyebrow">Cairn Next</span>
          <h1>{t('welcome')}</h1>
          <p>{t('intro')}</p>
          <div className="start-options">
            <section className="start-option">
              <span className="start-option-icon">
                <Icon name="folderOpen" />
              </span>
              <h2>{t('startWithFolder')}</h2>
              <p>{t('startWithFolderHelp')}</p>
              {openFolderButton}
            </section>
            <section className="start-option">
              <span className="start-option-icon">
                <Icon name="team" />
              </span>
              <h2>{t('startWithTeam')}</h2>
              <p>{t('startWithTeamHelp')}</p>
              <button onClick={() => go('team')}>
                <Icon name="team" />
                {t('joinTeam')}
              </button>
            </section>
          </div>
          <div className="practice-entry">
            <button
              className="quiet"
              disabled={action.busy || !!memoryPending}
              onClick={() =>
                void action.run(async () => {
                  await replace(() => window.cairn.startSimulation());
                  go('files');
                })
              }
            >
              <Icon name="play" />
              {t('startSimulation')}
            </button>
            <small className="muted">{t('temporary')}</small>
          </div>
        </div>
      )}
      <ErrorBox error={action.error} />
      {state.current ? (
        <>
          <section className="card workspace-card">
            <div className="section-line">
              <div className="save-heading">
                <h2>{t(state.simulation ? 'simulation' : 'saveStatus')}</h2>
                <p className="path muted">{state.current.path}</p>
              </div>
              <button
                disabled={state.simulation}
                title={state.simulation ? t('temporary') : undefined}
                onClick={() => void action.run(() => window.cairn.openFolder())}
              >
                <Icon name="folderOpen" />
                {t('reveal')}
              </button>
            </div>
            {state.simulation ? (
              <p>{t('simulationBanner')}</p>
            ) : (
              <div className="save-stages">
                <div>
                  <span className="stage-dot" />
                  <span className="save-stage-label">{t('saveDevice')}</span>
                  <strong>
                    {t(
                      memoryPending
                        ? 'memoryPending'
                        : replica?.initialized
                          ? 'localSaved'
                          : 'verifying',
                    )}
                  </strong>
                </div>
                <div>
                  <span className="stage-dot" />
                  <span className="save-stage-label">{t('saveTeam')}</span>
                  <strong>
                    {t(
                      !replica?.initialized
                        ? 'verifying'
                        : replica.pending
                          ? 'queued'
                          : replica.connection === 'online'
                            ? 'delivered'
                            : 'offline',
                    )}
                  </strong>
                  {replica?.pending ? <small>{replica.pending}</small> : null}
                </div>
                <div>
                  <span className="stage-dot" />
                  <span className="save-stage-label">{t('saveFolder')}</span>
                  <strong>{t(disk)}</strong>
                </div>
                <div>
                  <span className="stage-dot" />
                  <span className="save-stage-label">{t('saveConfirmation')}</span>
                  <strong>
                    {t(
                      replica?.confirmedRevision !== null &&
                        replica?.confirmedRevision === replica?.revision
                        ? 'peersConfirmed'
                        : 'peersWaiting',
                    )}
                  </strong>
                </div>
              </div>
            )}
            <div className="actions wrap">
              <button onClick={() => go('activity')}>
                <Icon name="activity" />
                {t('activity')}
              </button>
              <button onClick={() => go('checkpoints')}>
                <Icon name="checkpoints" />
                {t('newCheckpoint')}
              </button>
              <label className="check">
                <input
                  type="checkbox"
                  checked={state.current.watching}
                  disabled={action.busy || state.replica?.role === 'viewer'}
                  onChange={(e) =>
                    void action.run(async () => {
                      await window.cairn.setWatching(e.target.checked);
                      await refresh();
                    })
                  }
                />
                {t('watching')}
              </label>
            </div>
          </section>
          {conflicts ? (
            <section className="card attention-card">
              <Icon name="conflicts" />
              <div className="grow">
                <h2>
                  {t('reviewChanges')} <span className="badge">{conflicts}</span>
                </h2>
                <p>{t('conflictNotice')}</p>
              </div>
              <button onClick={() => go('conflicts')}>
                {t('reviewConflicts')}
                <Icon name="arrowRight" />
              </button>
            </section>
          ) : null}
          <div className="summary-grid">
            <button className="summary-card" onClick={() => go('files')}>
              <span className="summary-label">
                <Icon name="files" />
                {t('files')}
              </span>
              <strong>{fileCount}</strong>
              <small>{t('browseFiles')}</small>
            </button>
            <button className="summary-card" onClick={() => go('checkpoints')}>
              <span className="summary-label">
                <Icon name="checkpoints" />
                {t('checkpoints')}
              </span>
              <strong>{replica?.metadata.checkpoints.length ?? 0}</strong>
              <small>{t('checkpointHelp')}</small>
            </button>
            <button className="summary-card" onClick={() => go('team')}>
              <span className="summary-label">
                <Icon name="team" />
                {t('peers')}
              </span>
              <strong>{state.team?.peers.length ?? replica?.team?.peers.length ?? 0}</strong>
              <small>{t('manageTeam')}</small>
            </button>
          </div>
        </>
      ) : null}
      <div className="section-line">
        <h2>{t('recent')}</h2>
        <button className="quiet" onClick={() => go('projects')}>
          {t('projects')} <Icon name="arrowRight" />
        </button>
      </div>
      {state.projects.length ? (
        state.projects.slice(0, 4).map((p) => (
          <button
            className="recent-row"
            key={p.id}
            disabled={action.busy || !!memoryPending}
            onClick={() =>
              void action.run(async () => {
                if (!p.exists) {
                  go('projects');
                  return;
                }
                await replace(() => window.cairn.switchProject(p.id));
                go('files');
              })
            }
          >
            <span className="project-glyph" aria-hidden="true">
              <Icon name="projects" />
            </span>
            <span className="grow">
              <strong>{p.name}</strong>
              <small className="path">{p.path}</small>
            </span>
            <span className="muted">
              {t(p.exists ? (p.kind === 'local' ? 'local' : 'joined') : 'missing')}
            </span>
            <Icon name="arrowRight" />
          </button>
        ))
      ) : (
        <Empty text="noProjects" />
      )}
    </div>
  );
}
function ProjectsView() {
  const { t } = useI18n();
  const { state, replace, refresh, go, memoryPending, notify } = useApp();
  const action = useAction();
  const [remove, setRemove] = useState<RecentProject | null>(null);
  return (
    <div className="page">
      <PageTitle title="projects">
        <button
          className="primary"
          disabled={action.busy || !!memoryPending}
          onClick={() =>
            void action.run(async () => {
              const path = await window.cairn.chooseFolder();
              if (path) {
                await replace(() => window.cairn.openProject({ path }));
                go('files');
              }
            })
          }
        >
          <Icon name="folderOpen" />
          {t('openProject')}
        </button>
      </PageTitle>
      <ErrorBox error={action.error} />
      <p className="muted">{t('projectsHelp')}</p>
      {state.projects.length ? (
        state.projects.map((p) => (
          <section
            className={`card project-card ${state.current?.id === p.id ? 'current-project' : ''}`}
            key={p.id}
          >
            <span className="project-glyph" aria-hidden="true">
              <Icon name="projects" />
            </span>
            <div className="grow">
              <h2>
                {p.name}{' '}
                {state.current?.id === p.id ? <span className="badge">{t('current')}</span> : null}
              </h2>
              <p className="path muted">{p.path}</p>
              <small>
                {t(p.kind === 'local' ? 'local' : 'joined')} · <DateText time={p.lastOpened} />
                {!p.exists ? (
                  <>
                    {' '}
                    · <span className="warning">{t('missing')}</span>
                  </>
                ) : null}
              </small>
            </div>
            <div className="actions wrap">
              <button
                disabled={action.busy || !!memoryPending}
                className="primary"
                onClick={() =>
                  void action.run(async () => {
                    if (p.exists) await replace(() => window.cairn.switchProject(p.id));
                    else {
                      const path = await window.cairn.chooseFolder();
                      if (!path) return;
                      await replace(() => window.cairn.locateProject({ id: p.id, path }));
                    }
                    go('files');
                  })
                }
              >
                {t(p.exists ? 'open' : 'locate')}
              </button>
              <button
                onClick={() =>
                  void action.run(async () => {
                    await window.cairn.copyText(p.path);
                    notify(t('copied'));
                  })
                }
              >
                <Icon name="copy" />
                {t('copyPath')}
              </button>
              <button
                className="quiet"
                disabled={action.busy || !!memoryPending}
                onClick={() => setRemove(p)}
              >
                {t('remove')}
              </button>
            </div>
          </section>
        ))
      ) : (
        <Empty text="noProjects" />
      )}
      {remove ? (
        <Confirm
          title="removeConfirm"
          description="removeExplain"
          onClose={() => setRemove(null)}
          onConfirm={async () => {
            await window.cairn.removeProject(remove.id);
            await refresh();
          }}
        >
          <strong>{remove.name}</strong>
          <p className="path">{remove.path}</p>
        </Confirm>
      ) : null}
    </div>
  );
}
function Palette({ mode, onClose }: { mode: 'files' | 'commands'; onClose(): void }) {
  const { t } = useI18n();
  const { state, select, go } = useApp();
  const [search, setSearch] = useState('');
  const action = useAction();
  const items =
    mode === 'files'
      ? (state.current?.files
          .filter(
            (f) =>
              !f.deleted &&
              f.kind !== 'directory' &&
              f.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
          )
          .map((f) => ({ key: f.id, label: f.path, run: () => select(f.id) })) ?? [])
      : [
          ...pages.map((p) => ({ key: p, label: t(p), run: async () => go(p) })),
          {
            key: 'save',
            label: t('saveNow'),
            run: async () => {
              window.dispatchEvent(new Event('cairn-save'));
            },
          },
        ].filter((x) => x.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return (
    <Dialog title={t(mode === 'files' ? 'quickOpen' : 'commands')} onClose={onClose}>
      <input
        autoFocus
        className="palette-input"
        aria-label={t('search')}
        placeholder={t('search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            document.querySelector<HTMLButtonElement>('.palette-results button')?.focus();
          }
          if (e.key === 'Enter' && items[0]) {
            e.preventDefault();
            void action.run(async () => {
              await items[0]!.run();
              onClose();
            });
          }
        }}
      />
      <ErrorBox error={action.error} />
      <div className="palette-results">
        {items.slice(0, 100).map((item) => (
          <button
            key={item.key}
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await item.run();
                onClose();
              })
            }
          >
            {item.label}
          </button>
        ))}
        {!items.length ? <Empty text="noResults" /> : null}
      </div>
    </Dialog>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
