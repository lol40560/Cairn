/** 平台快捷键文案与输入上下文判断，避免各页面重复实现。 */
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
}

export function shortcutLabel(key: string): string {
  return `${isMacPlatform() ? '⌘' : 'Ctrl+'}${key}`
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor'))
}
