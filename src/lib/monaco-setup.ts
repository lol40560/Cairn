import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

import { CAIRN_MONACO_THEME } from './monaco-theme'

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

monaco.editor.defineTheme(CAIRN_MONACO_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7F8792', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'D88792' },
    { token: 'string', foreground: 'A8C18F' },
    { token: 'number', foreground: 'D2A66D' },
    { token: 'type.identifier', foreground: '8FB4C8' },
  ],
  colors: {
    'editor.background': '#111216',
    'editor.foreground': '#D9DCE1',
    'editorLineNumber.foreground': '#666E79',
    'editorLineNumber.activeForeground': '#BFC4CC',
    'editor.lineHighlightBackground': '#191B20',
    'editor.selectionBackground': '#63363E99',
    'editor.inactiveSelectionBackground': '#3E2B3066',
    'editorCursor.foreground': '#D66A77',
    'editorWhitespace.foreground': '#2B2F36',
    'editorIndentGuide.background1': '#252930',
    'editorIndentGuide.activeBackground1': '#3A4049',
    'editorWidget.background': '#1F2228',
    'editorWidget.border': '#2B2F36',
    'editorHoverWidget.background': '#1F2228',
    'editorHoverWidget.border': '#2B2F36',
    'scrollbarSlider.background': '#59616C55',
    'scrollbarSlider.hoverBackground': '#70798577',
    'scrollbarSlider.activeBackground': '#8A949F88',
    'diffEditor.insertedTextBackground': '#35513D66',
    'diffEditor.removedTextBackground': '#632F3766',
    'diffEditor.insertedLineBackground': '#24342A66',
    'diffEditor.removedLineBackground': '#3B252966',
  },
})
