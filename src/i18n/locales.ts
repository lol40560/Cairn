export type Locale = 'zh' | 'en'

export const zh = {
  activity: '活动',
  activityTitle: '活动',
  roomTitle: '房间',
  conflicts: '冲突',
  conflictsTitle: '冲突',
  selectFolder: '选择文件夹',
  statusIdle: '未监控',
  statusWatching: '监控中',
  statusStopped: '已停止',
  emptyState: '暂无变更，选择一个文件夹开始监控。',
  justNow: '刚刚',
  minuteAgo: '{n} 分钟前',
  minutesAgo: '{n} 分钟前',
  hourAgo: '{n} 小时前',
  hoursAgo: '{n} 小时前',
  dayAgo: '{n} 天前',
  daysAgo: '{n} 天前',
  activityLast24h: '最近 24 小时',
  activityAll: '全部变更',
  activitySummary: '{changes} 项变更 · {files} 个文件',
  changeFolder: '更改文件夹',
  filter: '筛选',
  remote: '远端',
  remoteChangesEmpty: '此工作区没有远端变更。',
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
  createOrJoin: '创建或加入',
  shareRoomHint: '将此房间码分享给同一局域网内的队友。',
  connectedPeers: '已连接 · {n}',
  peerHost: '主机',
  peerLan: '局域网',
  peerAi: 'AI',
  noRoom: '未加入房间',
  createRoomSuccess: '房间已创建',
  conflictDetected: '检测到冲突',
  settings: '设置', settingsGithub: 'GitHub', githubToken: 'GitHub Token', githubOwner: 'Owner', githubRepo: 'Repository', save: '保存', clear: '清除', close: '关闭', configured: '已配置', notConfigured: '未配置', exportPR: '导出 PR', prTitle: 'PR 标题', prCreated: 'PR 已创建', conflictTitle: '冲突', conflictHint: '远端变更与本地冲突，请手动处理', ignore: '忽略', noConflicts: '无冲突', commitHistory: '提交历史',
  saving: '保存中...', savedToken: '已保存的 token（留空则不修改）',
  creating: '创建中...', create: '创建', cancel: '取消',
  settingsGeneral: '通用',
  rememberLastFolder: '记住上次文件夹',
  autoStartWatching: '启动时自动监控',
  rememberLastFolderHint: '关闭后，每次启动都需要重新选择文件夹',
  autoStartWatchingHint: '仅在“记住上次文件夹”开启且上次退出时正在监控时生效',
  watching: '监控中',
  watchingStatus: '正在监控',
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
  conflictsEmpty: '无冲突',
  conflictsEmptyDesc: '所有变更已与队友同步。',
  conflictsUnresolved: '{n} 个未解决',
  unresolvedConflicts: '{n} 个未解决',
  conflictsDismissAll: '全部忽略',
  conflictsIgnore: '忽略',
  conflictsFrom: '来自 {name}',
  workspaceNavigation: '工作区导航',
  exportPRTitle: '导出 PR',
  exportPRLabel: 'PR 标题',
  exportPRCreate: '创建',
  exportPRCreating: '创建中...',
  exportPRCancel: '取消',
  exportSnapshot: '导出 .zip',
  exportSnapshotSuccess: '已导出 {count} 个文件到：{path}',
  exportSnapshotCopied: '路径已复制到剪贴板',
  exportSnapshotTooLarge: '项目过大，超过 50 MB 上限',
  sharingSection: '项目分享',
  sharingActive: '正在分享 · {n} 位队友可下载',
  stopSharing: '停止分享',
  startSharing: '分享项目文件',
  download: '下载',
  downloadFrom: '来自 {peer} · {size}',
  saveTo: '保存到',
  waitingForHost: '等待队长分享',
  waitingForHostDesc: '请队长点击“分享项目文件”',
  downloadWaiting: '等待元数据...',
  downloadDownloading: '下载中...',
  downloadVerifying: '校验中...',
  downloadExtracting: '解压中...',
  downloadDone: '下载完成',
  downloadFailed: '下载失败',
  downloadSuccessMsg: '已下载 {n} 个文件到 {path}',
  downloadConflictsMsg: '{n} 个文件冲突，已保存为 .cairn-remote',
  cancelDownload: '取消',
  directConnection: '直接连接',
  directConnectionHint: '当自动发现失败时，把这个地址分享给队友。',
  roomCodeOrAddress: '房间码或 IP:端口',
  invalidRoomCodeOrAddress: '房间码或地址格式不正确',
  connectedTo: '已连接到 {address}',
} as const

export const en: Record<keyof typeof zh, string> = {
  activity: 'Activity',
  activityTitle: 'Activity',
  roomTitle: 'Room',
  conflicts: 'Conflicts',
  conflictsTitle: 'Conflicts',
  selectFolder: 'Select Folder',
  statusIdle: 'Not Watching',
  statusWatching: 'Watching',
  statusStopped: 'Stopped',
  emptyState: 'No changes yet. Select a folder to start watching.',
  justNow: 'just now',
  minuteAgo: '1 minute ago',
  minutesAgo: '{n} minutes ago',
  hourAgo: '1 hour ago',
  hoursAgo: '{n} hours ago',
  dayAgo: '1 day ago',
  daysAgo: '{n} days ago',
  activityLast24h: 'LAST 24 HOURS',
  activityAll: 'ALL CHANGES',
  activitySummary: '{changes} changes · {files} files',
  changeFolder: 'Change folder',
  filter: 'Filter',
  remote: 'Remote',
  remoteChangesEmpty: 'No remote changes in this workspace.',
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
  createOrJoin: 'Create or join',
  shareRoomHint: 'Share this code with peers on your local network.',
  connectedPeers: 'Connected · {n}',
  peerHost: 'host',
  peerLan: 'LAN',
  peerAi: 'AI',
  noRoom: 'No room',
  createRoomSuccess: 'Room created',
  conflictDetected: 'Conflict detected',
  settings: 'Settings', settingsGithub: 'GitHub', githubToken: 'GitHub Token', githubOwner: 'Owner', githubRepo: 'Repository', save: 'Save', clear: 'Clear', close: 'Close', configured: 'Configured', notConfigured: 'Not configured', exportPR: 'Export PR', prTitle: 'PR title', prCreated: 'PR created', conflictTitle: 'Conflicts', conflictHint: 'Remote change conflicts with local changes. Please resolve manually.', ignore: 'Ignore', noConflicts: 'No conflicts', commitHistory: 'Commit history',
  saving: 'Saving...', savedToken: 'Saved token (leave blank to keep it)',
  creating: 'Creating...', create: 'Create', cancel: 'Cancel',
  settingsGeneral: 'General',
  rememberLastFolder: 'Remember last folder',
  autoStartWatching: 'Start watching automatically',
  rememberLastFolderHint: 'When disabled, select a folder again every time the app starts.',
  autoStartWatchingHint: 'Only applies when remembering the last folder is enabled and it was watched at exit.',
  watching: 'Watching',
  watchingStatus: 'Watching',
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
  conflictsEmpty: 'No conflicts',
  conflictsEmptyDesc: 'All changes synced cleanly with your peers.',
  conflictsUnresolved: '{n} unresolved',
  unresolvedConflicts: '{n} unresolved',
  conflictsDismissAll: 'Dismiss all',
  conflictsIgnore: 'Ignore',
  conflictsFrom: 'from {name}',
  workspaceNavigation: 'Workspace navigation',
  exportPRTitle: 'Export PR',
  exportPRLabel: 'PR title',
  exportPRCreate: 'Create',
  exportPRCreating: 'Creating...',
  exportPRCancel: 'Cancel',
  exportSnapshot: 'Export .zip',
  exportSnapshotSuccess: 'Exported {count} files to: {path}',
  exportSnapshotCopied: 'Path copied to clipboard',
  exportSnapshotTooLarge: 'Project exceeds 50 MB limit',
  sharingSection: 'Project sharing',
  sharingActive: 'Sharing · {n} peer(s) can download',
  stopSharing: 'Stop sharing',
  startSharing: 'Share project files',
  download: 'Download',
  downloadFrom: 'from {peer} · {size}',
  saveTo: 'Save to',
  waitingForHost: 'Waiting for host to share',
  waitingForHostDesc: 'Ask the host to click "Share project files"',
  downloadWaiting: 'Waiting for metadata...',
  downloadDownloading: 'Downloading...',
  downloadVerifying: 'Verifying...',
  downloadExtracting: 'Extracting...',
  downloadDone: 'Download complete',
  downloadFailed: 'Download failed',
  downloadSuccessMsg: 'Downloaded {n} files to {path}',
  downloadConflictsMsg: '{n} files conflicted and saved as .cairn-remote',
  cancelDownload: 'Cancel',
  directConnection: 'Direct connection',
  directConnectionHint: 'Share this address with peers when automatic discovery fails.',
  roomCodeOrAddress: 'Room code or IP:port',
  invalidRoomCodeOrAddress: 'Invalid room code or address',
  connectedTo: 'Connected to {address}',
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
