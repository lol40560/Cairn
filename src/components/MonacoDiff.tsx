import { DiffEditor } from '@monaco-editor/react'

interface MonacoDiffProps {
  original: string
  modified: string
  originalLabel?: string
  modifiedLabel?: string
  language?: string
  height?: string | number
  readOnly?: boolean
  modelId?: string
}

/** 统一封装只读 Monaco 差异查看器，供冲突与操作历史复用。 */
export function MonacoDiff({
  original,
  modified,
  originalLabel = 'Original',
  modifiedLabel = 'Modified',
  language = 'plaintext',
  height = '100%',
  modelId,
  readOnly = true,
}: MonacoDiffProps) {
  const modelPrefix = encodeURIComponent(modelId ?? `${originalLabel}:${modifiedLabel}`)
  return (
    <div className="monaco-diff-wrapper">
      <DiffEditor
        height={height}
        modified={modified}
        modifiedLanguage={language}
        modifiedModelPath={`inmemory://cairn/${modelPrefix}-modified`}
        options={{
          fixedOverflowWidgets: true,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12,
          lineNumbers: 'on',
          minimap: { enabled: false },
          overviewRulerBorder: false,
          readOnly,
          renderOverviewRuler: false,
          renderSideBySide: true,
          scrollBeyondLastLine: false,
          scrollbar: { horizontalScrollbarSize: 8, verticalScrollbarSize: 8 },
        }}
        original={original}
        originalLanguage={language}
        originalModelPath={`inmemory://cairn/${modelPrefix}-original`}
        theme="vs-dark"
      />
    </div>
  )
}
