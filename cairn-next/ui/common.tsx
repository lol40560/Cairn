import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ReleaseState } from '../shared/release-api';
import type { CommandInput, ImpactPreview, ProjectEvent, StoreQuery } from '../shared/project';
import { errorCode, errorText, useI18n } from './i18n';

export type Page =
  | 'home'
  | 'projects'
  | 'files'
  | 'activity'
  | 'team'
  | 'conflicts'
  | 'checkpoints'
  | 'deleted'
  | 'settings';
export interface AppContextValue {
  state: ReleaseState;
  memoryPending: number;
  busy: boolean;
  selectedId: string | null;
  onMemoryPending(count: number): void;
  go(page: Page): void;
  notify(message: string): void;
  refresh(): Promise<void>;
  command(input: CommandInput): Promise<ProjectEvent>;
  replace(action: () => Promise<ReleaseState>): Promise<void>;
  select(id: string): Promise<void>;
  clearSelection(): void;
}
export const AppContext = createContext<AppContextValue>(null!);
export const useApp = () => useContext(AppContext);
export function Size({ bytes }: { bytes: number }) {
  return (
    <>
      {bytes < 1024
        ? `${bytes} B`
        : bytes < 1024 * 1024
          ? `${(bytes / 1024).toFixed(1)} KiB`
          : `${(bytes / 1024 / 1024).toFixed(1)} MiB`}
    </>
  );
}
export function DateText({ time }: { time: number }) {
  const { locale } = useI18n();
  return (
    <time dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleString(locale)}</time>
  );
}
export function ErrorBox({ error }: { error: unknown }) {
  const { locale, t } = useI18n();
  if (!error) return null;
  return (
    <div className="error-banner" role="alert">
      <div>
        {errorText(error, locale)}
        <details>
          <summary>{t('details')}</summary>
          <code>{errorCode(error)}</code>
        </details>
      </div>
    </div>
  );
}
export function Empty({ text = 'empty' }: { text?: string }) {
  const { t } = useI18n();
  return (
    <div className="empty">
      <span className="empty-glyph" aria-hidden="true">
        ◌
      </span>
      <p>{t(text)}</p>
    </div>
  );
}
export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <header className="page-title">
      <h1>{t(title)}</h1>
      <div className="actions">{children}</div>
    </header>
  );
}
export function NeedProject({ children }: { children: ReactNode }) {
  const { state } = useApp();
  return state.current ? children : <Empty text="selectProject" />;
}

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  wide?: boolean;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const timer = window.setTimeout(() => {
      const field = el?.querySelector<HTMLElement>(
        'input:not([type=checkbox]):not([type=radio]):not(:disabled),textarea:not(:disabled),select:not(:disabled)',
      );
      (field ?? el?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
    }, 0);
    const key = (e: KeyboardEvent) => {
      if ([...document.querySelectorAll('[role=dialog]')].at(-1) !== el) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
      if (e.key === 'Tab' && el) {
        const nodes = [
          ...el.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
          ),
        ].filter((n) => n.offsetParent !== null);
        if (!nodes.length) {
          e.preventDefault();
          return;
        }
        const first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', key, true);
      prior?.isConnected && prior.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        ref={ref}
        className={`dialog ${wide ? 'wide-dialog' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="quiet icon" aria-label={t('close')} onClick={onClose} disabled={busy}>
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export function Confirm({
  title,
  description,
  onClose,
  onConfirm,
  children,
  danger = true,
}: {
  title: string;
  description: string;
  onClose(): void;
  onConfirm(): Promise<unknown>;
  children?: ReactNode;
  danger?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog title={t(title)} onClose={() => !busy && onClose()} busy={busy}>
      <p className="muted">{t(description)}</p>
      {children}
      <ErrorBox error={error} />
      <div className="dialog-actions">
        <button disabled={busy} onClick={onClose}>
          {t('cancel')}
        </button>
        <button
          className={danger ? 'danger' : 'primary'}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void onConfirm()
              .then(onClose)
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          {t(busy ? 'working' : 'confirm')}
        </button>
      </div>
    </Dialog>
  );
}
export function Impact({ preview }: { preview: ImpactPreview }) {
  const { t } = useI18n();
  return (
    <div className="impact">
      <div className="stat-inline">
        <span>
          {t('additions')} <b>{preview.creates}</b>
        </span>
        <span>
          {t('updates')} <b>{preview.updates}</b>
        </span>
        <span>
          {t('removals')} <b>{preview.deletes}</b>
        </span>
      </div>
      <ul className="path-list">
        {preview.paths.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}
export function useQuery<T>(query: StoreQuery): {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload(): void;
} {
  const { state } = useApp();
  const project = state.current?.projectId;
  const rev = state.replica?.revision;
  const serialized = JSON.stringify(query);
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ data: T | null; error: unknown; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    let alive = true;
    setResult({ data: null, error: null, loading: true });
    if (!project) {
      setResult({ data: null, error: null, loading: false });
      return;
    }
    void window.cairn.query(JSON.parse(serialized)).then(
      (data) => {
        if (alive) setResult({ data: data as T, error: null, loading: false });
      },
      (error) => {
        if (alive) setResult({ data: null, error, loading: false });
      },
    );
    return () => {
      alive = false;
    };
  }, [project, rev, serialized, tick]);
  return { ...result, reload: () => setTick((v) => v + 1) };
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}
export function decodeBlob(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}
export function encodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384)
    binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}
export function BlobPane({
  hash,
  title,
  kind = 'text',
}: {
  hash: string | null;
  title: string;
  kind?: string;
}) {
  const { state } = useApp();
  const { t, locale } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [byteLength, setByteLength] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setText(null);
    setByteLength(null);
    setError(null);
    if (!hash) return;
    void window.cairn
      .readBlob(hash)
      .then((v) => {
        if (!alive) return;
        if (v.data.length > Math.ceil((16 * 1024 * 1024) / 3) * 4)
          throw Object.assign(new Error('Preview exceeds the supported blob limit.'), {
            code: 'SIZE_LIMIT',
          });
        const bytes = decodeBlob(v.data);
        setByteLength(bytes.byteLength);
        if (kind === 'text')
          setText(
            bytes.length > 1024 * 1024
              ? t('previewLimit')
              : new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          );
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [hash, kind, state.current?.projectId, attempt, locale]);
  return (
    <section className="blob-pane">
      <h3>{title}</h3>
      <ErrorBox error={error} />
      {error ? (
        <button className="quiet" onClick={() => setAttempt((value) => value + 1)}>
          {t('retry')}
        </button>
      ) : null}
      <pre>
        {!hash ? (
          '∅'
        ) : kind !== 'text' ? (
          <>
            {t('binary')}
            {'\n\n'}
            {t('size')}:{' '}
            {byteLength === null
              ? error
                ? '—'
                : t('loading')
              : `${byteLength.toLocaleString(locale)} B`}
            {'\n\n'}SHA-256{'\n'}
            <code>{hash}</code>
          </>
        ) : (
          (text ?? (error ? '—' : t('loading')))
        )}
      </pre>
    </section>
  );
}
export function FileComparison({
  before,
  after,
  kind = 'text',
  base,
}: {
  before: string | null;
  after: string | null;
  kind?: string;
  base?: string | null;
}) {
  const { t } = useI18n();
  return (
    <div className={`comparison ${base !== undefined ? 'three' : ''}`}>
      {base !== undefined ? <BlobPane hash={base} title={t('base')} kind={kind} /> : null}
      <BlobPane hash={before} title={t(base !== undefined ? 'mine' : 'before')} kind={kind} />
      <BlobPane hash={after} title={t(base !== undefined ? 'theirs' : 'after')} kind={kind} />
    </div>
  );
}
