export type Locale = 'zh' | 'en'

export const zh = {
  selectFolder: '选择文件夹',
  statusIdle: '未监控',
  statusWatching: '监控中',
  statusStopped: '已停止',
  emptyState: '暂无变更，选择一个文件夹开始监控。',
  justNow: '刚刚',
  minutesAgo: '{n} 分钟前',
  hoursAgo: '{n} 小时前',
  daysAgo: '{n} 天前',
  activityLast24h: '最近 24 小时',
  activityAll: '全部变更',
  activitySummary: '{changes} 项变更 · {files} 个文件',
  headerTime: '时间',
  headerAuthor: '作者',
  headerFile: '文件',
  headerChanges: '+/-',
  switchLanguage: 'EN',
  // v2-B 房间相关，先占位，v2-B 使用。
  createRoom: '创建房间',
  joinRoom: '加入房间',
  leaveRoom: '离开房间',
  roomCode: '房间码',
  peers: '队友',
  copy: '复制',
  copied: '已复制',
  room: '房间',
  noRoom: '未加入房间',
  createRoomSuccess: '房间已创建',
  conflictDetected: '检测到冲突',
  settings: '设置', githubToken: 'GitHub Token', githubOwner: 'Owner', githubRepo: 'Repository', save: '保存', clear: '清除', configured: '已配置', notConfigured: '未配置', exportPR: '导出 PR', prTitle: 'PR 标题', prCreated: 'PR 已创建', conflictTitle: '冲突', conflictHint: '远端变更与本地冲突，请手动处理', ignore: '忽略', noConflicts: '无冲突', commitHistory: '提交历史',
  saving: '保存中...', savedToken: '已保存的 token（留空则不修改）',
  creating: '创建中...', create: '创建', cancel: '取消',
  settingsGeneral: '通用',
  rememberLastFolder: '记住上次文件夹',
  autoStartWatching: '启动时自动监控',
  rememberLastFolderHint: '关闭后，每次启动都需要重新选择文件夹',
  autoStartWatchingHint: '仅在“记住上次文件夹”开启且上次退出时正在监控时生效',
  lastFolderUnavailable: '上次的文件夹已不可用，请重新选择',
  errorConfig: '配置不完整，请打开设置检查',
  errorNetwork: '网络连接失败，请检查 WiFi 或防火墙',
  errorPermission: '权限不足，请检查文件夹权限',
  errorGithub: 'GitHub 操作失败',
  errorConflict: '检测到冲突',
  errorNotFound: '找不到资源',
  errorUnknown: '发生未知错误',
  hintRegenerateToken: '打开 GitHub 设置重新生成 token',
  hintCheckRepo: '检查 owner 和 repo 拼写',
  hintReselectFolder: '重新选择文件夹',
  hintCheckFirewall: '检查系统防火墙是否允许 Cairn 通信',
  hintCheckGithubSettings: '打开设置检查 GitHub 配置',
  errorCopyRaw: '复制详细信息',
  errorOpenSettings: '打开设置',
  errorRetry: '重试',
} as const

export const en: Record<keyof typeof zh, string> = {
  selectFolder: 'Select Folder',
  statusIdle: 'Not Watching',
  statusWatching: 'Watching',
  statusStopped: 'Stopped',
  emptyState: 'No changes yet. Select a folder to start watching.',
  justNow: 'just now',
  minutesAgo: '{n} min ago',
  hoursAgo: '{n} hours ago',
  daysAgo: '{n} days ago',
  activityLast24h: 'LAST 24 HOURS',
  activityAll: 'ALL CHANGES',
  activitySummary: '{changes} changes · {files} files',
  headerTime: 'Time',
  headerAuthor: 'Author',
  headerFile: 'File',
  headerChanges: '+/-',
  switchLanguage: '中',
  createRoom: 'Create Room',
  joinRoom: 'Join Room',
  leaveRoom: 'Leave Room',
  roomCode: 'Room Code',
  peers: 'Peers',
  copy: 'Copy',
  copied: 'Copied',
  room: 'Room',
  noRoom: 'No room',
  createRoomSuccess: 'Room created',
  conflictDetected: 'Conflict detected',
  settings: 'Settings', githubToken: 'GitHub Token', githubOwner: 'Owner', githubRepo: 'Repository', save: 'Save', clear: 'Clear', configured: 'Configured', notConfigured: 'Not configured', exportPR: 'Export PR', prTitle: 'PR title', prCreated: 'PR created', conflictTitle: 'Conflicts', conflictHint: 'Remote change conflicts with local changes. Please resolve manually.', ignore: 'Ignore', noConflicts: 'No conflicts', commitHistory: 'Commit history',
  saving: 'Saving...', savedToken: 'Saved token (leave blank to keep it)',
  creating: 'Creating...', create: 'Create', cancel: 'Cancel',
  settingsGeneral: 'General',
  rememberLastFolder: 'Remember last folder',
  autoStartWatching: 'Start watching automatically',
  rememberLastFolderHint: 'When disabled, select a folder again every time the app starts.',
  autoStartWatchingHint: 'Only applies when remembering the last folder is enabled and it was watched at exit.',
  lastFolderUnavailable: 'The last folder is unavailable. Please select it again.',
  errorConfig: 'Configuration is incomplete. Open Settings to check it.',
  errorNetwork: 'Network connection failed. Check Wi-Fi or firewall.',
  errorPermission: 'Permission denied. Check folder permissions.',
  errorGithub: 'GitHub operation failed',
  errorConflict: 'A conflict was detected',
  errorNotFound: 'Resource not found',
  errorUnknown: 'An unknown error occurred',
  hintRegenerateToken: 'Open GitHub settings and generate a new token',
  hintCheckRepo: 'Check the owner and repository spelling',
  hintReselectFolder: 'Select the folder again',
  hintCheckFirewall: 'Check whether the system firewall allows Cairn communication',
  hintCheckGithubSettings: 'Open Settings and check GitHub configuration',
  errorCopyRaw: 'Copy details',
  errorOpenSettings: 'Open Settings',
  errorRetry: 'Retry',
}

export type TranslationKey = keyof typeof zh

export const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  zh,
  en,
}

const localeStorageKey = 'vibeswarm.locale'

function getStorage(): Storage | undefined {
  try {
    // Electron renderer 中优先使用页面所属的 window 存储空间。
    if (typeof window !== 'undefined') {
      return window.localStorage
    }

    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** 读取用户显式选择的语言，存储不可用时静默回退。 */
export function detectLocale(): Locale {
  try {
    const storedLocale = getStorage()?.getItem(localeStorageKey)
    if (storedLocale === 'zh' || storedLocale === 'en') {
      return storedLocale
    }
  } catch {
    // 私密模式等场景可能禁止访问 localStorage。
  }

  return globalThis.navigator?.language.startsWith('zh') ? 'zh' : 'en'
}

/** 保存用户选择；存储失败不能影响界面切换。 */
export function persistLocale(locale: Locale): void {
  try {
    getStorage()?.setItem(localeStorageKey, locale)
  } catch {
    // 存储不可用时只保留当前会话中的状态。
  }
}

export function t(key: TranslationKey, locale: Locale = detectLocale()): string {
  const dictionary = dictionaries[locale]
  return dictionary[key] ?? key
}
