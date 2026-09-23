import { describe, expect, it, vi } from 'vitest'

import { shouldCloseDialogFromKey, submitExportPR } from '../lib/settingsDialog'

describe('ExportPRDialog', () => {
  it('提交标题会调用 onSubmit', async () => {
    const submit = vi.fn(async () => ({ data: undefined, ok: true }) as const)
    await submitExportPR('My PR', submit)
    expect(submit).toHaveBeenCalledWith('My PR')
  })

  it('提交失败会将错误交给调用方处理', async () => {
    await expect(
      submitExportPR('My PR', async () => ({
        error: { category: 'unknown', message: 'failed', raw: 'failed' },
        ok: false,
      }) as const),
    ).resolves.toMatchObject({ ok: false })
  })

  it('Esc 满足关闭条件', () => {
    expect(shouldCloseDialogFromKey('Escape')).toBe(true)
  })
})
