export function shouldCloseDialogFromBackdrop(target: EventTarget | null, currentTarget: EventTarget | null): boolean {
  return target === currentTarget
}

export function shouldCloseDialogFromKey(key: string): boolean {
  return key === 'Escape'
}

export async function submitExportPR<T>(
  title: string,
  onSubmit: (title: string) => Promise<T>,
): Promise<T> {
  return onSubmit(title)
}

/** 设置开关改动后立即持久化，不影响 GitHub 配置的保存流程。 */
export async function updateGeneralSettings(
  partial: Partial<{ autoStartWatching: boolean; rememberLastFolder: boolean }>,
  update: (partial: Partial<{ autoStartWatching: boolean; rememberLastFolder: boolean }>) => Promise<
    import('@/types/cairn').IpcResult<void>
  > =
    window.cairn.updateSettings,
): Promise<import('@/types/cairn').IpcResult<void>> {
  return update(partial)
}
