import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

type MonacoEnvironment = {
  getWorker(_: unknown, label: string): Worker
}

// Electron 不应依赖 CDN；所有 Monaco worker 都由 Vite 作为本地资源打包。
(self as unknown as { MonacoEnvironment: MonacoEnvironment }).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

loader.config({ monaco })
