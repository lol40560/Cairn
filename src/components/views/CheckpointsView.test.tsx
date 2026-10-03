import { renderToStaticMarkup } from 'react-dom/server'

import { describe, expect, it } from 'vitest'

import { CheckpointsView } from './CheckpointsView'

describe('CheckpointsView', () => {
  it('没有检查点时显示创建入口', () => {
    const html = renderToStaticMarkup(<CheckpointsView checkpoints={[]} />)

    expect(html).toContain('No checkpoints yet')
    expect(html).toContain('Create checkpoint')
  })

  it('显示检查点列表及恢复和删除操作', () => {
    const html = renderToStaticMarkup(<CheckpointsView checkpoints={[{
      createdAt: Date.now(),
      fileCount: 12,
      id: 'checkpoint-1',
      name: 'DEMO SAFE',
      sizeBytes: 1_048_576,
    }]} />)

    expect(html).toContain('DEMO SAFE')
    expect(html).toContain('12 files')
    expect(html).toContain('1.0 MB')
    expect(html).toContain('Restore')
    expect(html).toContain('aria-label="Delete"')
  })
})
