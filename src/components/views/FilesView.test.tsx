import { renderToStaticMarkup } from 'react-dom/server'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@monaco-editor/react', () => ({
  Editor: ({ value }: { value: string }) => <div data-testid="monaco-editor">{value}</div>,
}))

import { FileTree } from '@/components/FileTree'
import { buildFileTree } from '@/lib/file-tree'
import { FilesView } from './FilesView'
import { useAppStore } from '@/store/appStore'

const initialState = useAppStore.getState()

afterEach(() => useAppStore.setState(initialState, true))

describe('FilesView', () => {
  const files = [
    { mtime: 1, name: 'auth.ts', path: 'src/auth.ts', size: 42 },
    { mtime: 2, name: 'README.md', path: 'README.md', size: 12 },
  ]

  it('空文件列表显示空状态', () => {
    useAppStore.setState({ locale: 'en', projectFiles: [] })
    const html = renderToStaticMarkup(<FilesView files={[]} />)

    expect(html).toContain('No files to show.')
  })

  it('有文件时渲染文件树与选择提示', () => {
    useAppStore.setState({ fileFilter: '', locale: 'en', projectFiles: files })
    const html = renderToStaticMarkup(<FilesView files={files} />)

    expect(html).toContain('src')
    expect(html).toContain('auth.ts')
    expect(html).toContain('README.md')
    expect(html).toContain('Select a file to view')
  })

  it('搜索过滤会只保留匹配文件及其目录', () => {
    const html = renderToStaticMarkup(
      <FileTree files={files} filter="auth" selectedPath={undefined} onSelect={() => undefined} />,
    )

    expect(html).toContain('auth.ts')
    expect(html).not.toContain('README.md')
  })

  it('构造稳定的目录树', () => {
    const tree = buildFileTree(files)

    expect(tree).toEqual([
      expect.objectContaining({ name: 'src', type: 'directory' }),
      expect.objectContaining({ name: 'README.md', type: 'file' }),
    ])
    expect(tree[0]?.children).toEqual([expect.objectContaining({ path: 'src/auth.ts', type: 'file' })])
  })
})
