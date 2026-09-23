/** 为每次 PR 导出生成独立分支，避免复用已存在的远端分支。 */
export function createPRBranchName(roomCode: string, timestamp = Date.now()): string {
  return `cairn-${roomCode}-${timestamp}`
}
