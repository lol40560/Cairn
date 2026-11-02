import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { MAX_UPDATE_BYTES, type ClientSnapshot } from '../shared/types';
import { errorText, translate, useI18n } from './i18n';
import type { Locale } from '../shared/release-api';

(globalThis as typeof globalThis & { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: (_module: string, label: string) =>
    label === 'json'
      ? new JsonWorker()
      : ['typescript', 'javascript'].includes(label)
        ? new TsWorker()
        : ['css', 'scss', 'less'].includes(label)
          ? new CssWorker()
          : ['html', 'handlebars', 'razor'].includes(label)
            ? new HtmlWorker()
            : new EditorWorker(),
};
const REMOTE = Symbol('main-process');
function bytes(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}
function base64(update: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < update.length; offset += 16_384)
    binary += String.fromCharCode(...update.subarray(offset, offset + 16_384));
  return btoa(binary);
}
function language(fileName: string): string {
  const extension = fileName.split('.').at(-1)?.toLowerCase();
  return (
    (
      {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        json: 'json',
        md: 'markdown',
        py: 'python',
        html: 'html',
        css: 'css',
        rs: 'rust',
        go: 'go',
        yaml: 'yaml',
        yml: 'yaml',
      } as Record<string, string>
    )[extension ?? ''] ?? 'plaintext'
  );
}
interface SaveError {
  message: string;
  recoverySaved: boolean;
}
function readableError(error: unknown, locale: Locale): SaveError {
  const raw = error instanceof Error ? error.message : String(error);
  return {
    message: errorText(error, locale),
    recoverySaved: /\[LOCAL_UPDATE_RECOVERED\]/.test(raw),
  };
}
const COLORS = ['#2767b5', '#a13f7b', '#497629', '#8b6515', '#6550a2'];

interface EditorProps {
  snapshot: ClientSnapshot;
  switching: boolean;
  onMemoryPending(count: number): void;
}
interface Runtime {
  doc: Y.Doc;
  editor: monaco.editor.IStandaloneCodeEditor;
  awareness: Awareness;
  initialized: boolean;
  lineEnding: ClientSnapshot['lineEnding'];
  paused: boolean;
  drain(): void;
}
export function CollaborativeEditor({ snapshot, switching, onMemoryPending }: EditorProps) {
  const { locale, t } = useI18n();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const latest = useRef(snapshot);
  const pendingCallback = useRef(onMemoryPending);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  latest.current = snapshot;
  pendingCallback.current = onMemoryPending;

  useEffect(() => {
    if (!container.current) return;
    const initial = latest.current;
    const doc = new Y.Doc();
    if (initial.state) Y.applyUpdate(doc, bytes(initial.state), REMOTE);
    const text = doc.getText('content');
    const awareness = new Awareness(doc);
    const color = COLORS[doc.clientID % COLORS.length]!;
    awareness.setLocalStateField('user', { name: initial.name, color });
    monaco.editor.defineTheme('cairn', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#253247',
        'editorLineNumber.foreground': '#64748b',
        'editorLineNumber.activeForeground': '#405b7c',
        'editor.selectionBackground': '#dceaff',
        'editor.lineHighlightBackground': '#f5f8fc',
        'editorCursor.foreground': '#0067d8',
      },
    });
    const model = monaco.editor.createModel(
      text.toString(),
      language(initial.fileName),
      monaco.Uri.parse(
        `inmemory://cairn/${initial.projectId}/${initial.fileId}/${initial.generation}/${initial.fileName}`,
      ),
    );
    // Metadata survives an empty document, so clearing a CRLF file never changes
    // its policy. Set the initial model format before y-monaco observes edits.
    model.setEOL(
      initial.lineEnding === 'crlf'
        ? monaco.editor.EndOfLineSequence.CRLF
        : monaco.editor.EndOfLineSequence.LF,
    );
    const editor = monaco.editor.create(container.current, {
      model,
      theme: 'cairn',
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 14,
      lineHeight: 23,
      padding: { top: 18, bottom: 18 },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      wordWrap: 'on',
      readOnly: switching || !initial.initialized || initial.role === 'viewer',
      ariaLabel: initial.fileName + ' ' + translate(localeRef.current, 'editorLabel'),
      stickyScroll: { enabled: false },
    });
    const binding = new MonacoBinding(text, model, new Set([editor]), awareness);
    const undo = new Y.UndoManager(text, {
      trackedOrigins: new Set([binding]),
      captureTimeout: 500,
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () => undo.undo());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, () =>
      undo.redo(),
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => undo.redo());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => drain());
    const queue: Uint8Array[] = [];
    let flushing = false;
    let disposed = false;
    async function drain(): Promise<void> {
      if (flushing || disposed) return;
      flushing = true;
      let capturedCount = 0;
      setSaveError(null);
      try {
        while (queue.length && !disposed) {
          capturedCount = queue.length;
          // A rejected paste and a later local undo must be validated together.
          // Keep later edits queued until this exact captured prefix is durable.
          const update = Y.mergeUpdates(queue.slice(0, capturedCount));
          if (update.byteLength > MAX_UPDATE_BYTES) {
            throw new Error('[LOCAL_UPDATE_TOO_LARGE] Update exceeds the recoverable size limit.');
          }
          await window.cairn.update({
            update: base64(update),
            clientId: initial.clientId,
            fileId: initial.fileId,
            generation: initial.generation,
          });
          queue.splice(0, capturedCount);
          pendingCallback.current(queue.length);
        }
      } catch (error) {
        if (!disposed) setSaveError(readableError(error, localeRef.current));
      } finally {
        flushing = false;
        // An undo may arrive while the previous IPC call is still rejecting.
        if (!disposed && queue.length > capturedCount) void drain();
      }
    }
    const localUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === REMOTE) return;
      queue.push(update);
      pendingCallback.current(queue.length);
      void drain();
    };
    doc.on('update', localUpdate);
    const awarenessStyle = document.createElement('style');
    document.head.append(awarenessStyle);
    const refreshCursorStyles = (): void => {
      awarenessStyle.textContent = [...awareness.getStates()]
        .filter(([id]) => id !== doc.clientID)
        .map(([id, value]) => {
          const remoteColor = COLORS[id % COLORS.length]!;
          const name =
            typeof value.user?.name === 'string'
              ? value.user.name.slice(0, 80)
              : translate(localeRef.current, 'teammate');
          return `.yRemoteSelection-${id}{background:${remoteColor}33}.yRemoteSelectionHead-${id}{position:absolute;border-left:2px solid ${remoteColor};height:100%;box-sizing:border-box}.yRemoteSelectionHead-${id}::after{content:${JSON.stringify(name)};position:absolute;top:-1.3em;left:-2px;background:${remoteColor};color:#ffffff;font:12px/1.35 sans-serif;padding:1px 4px;white-space:nowrap;z-index:10}`;
        })
        .join('\n');
    };
    const changedAwareness = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ): void => {
      refreshCursorStyles();
      if (origin !== REMOTE) {
        const affected = [...added, ...updated, ...removed].filter((id) => id === doc.clientID);
        if (affected.length)
          void window.cairn
            .awareness(base64(encodeAwarenessUpdate(awareness, affected)))
            .catch(() => undefined);
      }
    };
    awareness.on('update', changedAwareness);
    const stopAwareness = window.cairn.onAwareness((update) => {
      if (disposed) return;
      try {
        applyAwarenessUpdate(awareness, bytes(update), REMOTE);
      } catch {
        /* malformed awareness never changes document state */
      }
    });
    const blur = editor.onDidBlurEditorWidget(() =>
      awareness.setLocalStateField('selection', null),
    );
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (queue.length) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    const saveNow = () => {
      void drain();
    };
    window.addEventListener('cairn-save', saveNow);
    const pauseEditing = (event: Event) => {
      const paused = (event as CustomEvent<boolean>).detail;
      if (runtime.current) runtime.current.paused = paused;
      editor.updateOptions({
        readOnly: paused || !latest.current.initialized || latest.current.role === 'viewer',
      });
    };
    window.addEventListener('cairn-pause-editing', pauseEditing);
    runtime.current = {
      doc,
      editor,
      awareness,
      initialized: initial.initialized,
      lineEnding: initial.lineEnding,
      paused: false,
      drain: () => {
        void drain();
      },
    };
    void window.cairn
      .awareness(base64(encodeAwarenessUpdate(awareness, [doc.clientID])))
      .catch(() => undefined);
    return () => {
      disposed = true;
      awareness.setLocalState(null);
      awareness.off('update', changedAwareness);
      stopAwareness();
      blur.dispose();
      awarenessStyle.remove();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('cairn-save', saveNow);
      window.removeEventListener('cairn-pause-editing', pauseEditing);
      doc.off('update', localUpdate);
      undo.destroy();
      binding.destroy();
      editor.dispose();
      model.dispose();
      awareness.destroy();
      doc.destroy();
      runtime.current = null;
    };
  }, []);

  useEffect(() => {
    const current = runtime.current;
    if (!current) return;
    if (!current.initialized && snapshot.initialized) {
      const model = current.editor.getModel();
      // The first authenticated snapshot can arrive after the read-only blank
      // editor mounted. Set EOL while both sides are still empty, before applying
      // any remote Yjs content; converting a nonempty bound model changes offsets.
      if (!model || model.getValueLength() !== 0 || current.doc.getText('content').length !== 0) {
        setSaveError({
          message: translate(localeRef.current, 'editorEol'),
          recoverySaved: false,
        });
        current.editor.updateOptions({ readOnly: true });
        return;
      }
      model.setEOL(
        snapshot.lineEnding === 'crlf'
          ? monaco.editor.EndOfLineSequence.CRLF
          : monaco.editor.EndOfLineSequence.LF,
      );
      current.lineEnding = snapshot.lineEnding;
      current.initialized = true;
    } else if (current.initialized && current.lineEnding !== snapshot.lineEnding) {
      setSaveError({
        message: translate(localeRef.current, 'editorEol'),
        recoverySaved: false,
      });
      current.editor.updateOptions({ readOnly: true });
      return;
    }
    if (snapshot.state) Y.applyUpdate(current.doc, bytes(snapshot.state), REMOTE);
    current.editor.updateOptions({
      readOnly: switching || current.paused || !snapshot.initialized || snapshot.role === 'viewer',
    });
    current.awareness.setLocalStateField('user', {
      name: snapshot.name,
      color: COLORS[current.doc.clientID % COLORS.length],
    });
    if (snapshot.connection === 'online')
      void window.cairn
        .awareness(base64(encodeAwarenessUpdate(current.awareness, [current.doc.clientID])))
        .catch(() => undefined);
    else
      removeAwarenessStates(
        current.awareness,
        [...current.awareness.getStates().keys()].filter((id) => id !== current.doc.clientID),
        REMOTE,
      );
  }, [
    snapshot.state,
    snapshot.initialized,
    snapshot.lineEnding,
    snapshot.role,
    snapshot.name,
    snapshot.connection,
    switching,
  ]);

  return (
    <div className="editor-container">
      {saveError ? (
        <div className="error-banner" role="alert">
          <div>
            <strong>{saveError.recoverySaved ? t('recoveredInput') : t('memoryPending')}</strong>
            <p>{saveError.message}</p>
            {saveError.recoverySaved ? <p>{t('recoveredHelp')}</p> : null}
          </div>
          <button onClick={() => runtime.current?.drain()}>{t('retry')}</button>
        </div>
      ) : null}
      <div className="monaco-host" ref={container} />
    </div>
  );
}
