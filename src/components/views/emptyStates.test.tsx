import { renderToStaticMarkup } from 'react-dom/server'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConflictsView } from './ConflictsView'
import { ActivityView } from './ActivityView'
import { createRoomAndStartSharing, RoomView } from './RoomView'
import { TrashView } from './TrashView'
import { useAppStore, type AppState } from '@/store/appStore'
import { DownloadPromptDialog } from '@/components/DownloadPromptDialog'
import { Onboarding } from '@/components/Onboarding'

const initialState = useAppStore.getState()

function resetState(partial: Partial<AppState> = {}): void {
  useAppStore.setState({
    ...initialState,
    conflicts: [],
    folder: '',
    isHost: false,
    locale: 'en',
    ops: [],
    peers: [],
    roomCode: '',
    trash: [],
    ...partial,
  })
}

const roomHandlers = {
  onCreateRoom: async () => undefined,
  onExportPR: () => undefined,
  onExportSnapshot: async () => undefined,
  onJoinRoom: async () => undefined,
  onLeaveRoom: async () => undefined,
}

beforeEach(() => resetState())
afterEach(() => useAppStore.setState(initialState, true))

describe('引导式空状态', () => {
  it('Activity 未选项目时显示打开项目引导', () => {
    const html = renderToStaticMarkup(<ActivityView ops={[]} onChangeFolder={async () => undefined} />)

    expect(html).toContain('No project open')
    expect(html).toContain('Choose a folder to start tracking, or join a team.')
  })

  it('Activity 已选项目但没有改动时显示等待提示', () => {
    const html = renderToStaticMarkup(<ActivityView folder="/tmp/project" ops={[]} onChangeFolder={async () => undefined} />)

    expect(html).toContain('Nothing new yet')
    expect(html).toContain('Changes will appear here as you and your teammates edit files.')
  })

  it('Same-file edits 空状态显示同步说明', () => {
    const html = renderToStaticMarkup(<ConflictsView />)

    expect(html).toContain("Everything&#x27;s in sync")
    expect(html).toContain("Nothing gets lost.")
  })

  it('Deleted files 空状态说明可恢复期限', () => {
    const html = renderToStaticMarkup(<TrashView />)

    expect(html).toContain('No deleted files')
    expect(html).toContain('Anything you delete stays here for 30 days')
  })

  it('Team 没有队友时显示邀请提示', () => {
    resetState({ roomCode: 'ABC123' })
    const html = renderToStaticMarkup(<RoomView hasOps={false} peers={[]} roomCode="ABC123" {...roomHandlers} />)

    expect(html).toContain('Just you so far')
    expect(html).toContain('Share your invite code to add teammates.')
  })

  it('加入团队发现分享者后显示下载确认内容', () => {
    const html = renderToStaticMarkup(
      <DownloadPromptDialog
        defaultTargetDir="/Users/test/Cairn/project"
        open
        seeder={{ peerId: 'alice-macbook', projectName: 'project', size: 5_242_880, snapshotId: 'snapshot' }}
        onChangeTarget={() => undefined}
        onConfirm={() => undefined}
        onSkip={() => undefined}
      />,
    )

    expect(html).toContain('Download project')
    expect(html).toContain('project')
    expect(html).toContain('5.0 MB')
    expect(html).toContain('Download now')
  })

  it('首次引导默认显示欢迎页和两条开始路径', () => {
    const html = renderToStaticMarkup(<Onboarding onComplete={() => undefined} />)

    expect(html).toContain('Welcome to Cairn')
    expect(html).toContain('Start a project')
    expect(html).toContain('Join a team')
    expect(html).toContain('Skip')
  })

  it('创建团队成功后会自动开始分享', async () => {
    const createRoom = vi.fn(async () => {
      useAppStore.getState().setRoomCode('ABC123')
      useAppStore.getState().setIsHost(true)
    })
    const startSharing = vi.fn(async () => ({
      data: { peerId: 'host', projectName: 'project', size: 1, snapshotId: 'snapshot-1' },
      ok: true as const,
    }))

    await createRoomAndStartSharing(createRoom, startSharing)

    expect(createRoom).toHaveBeenCalledOnce()
    expect(startSharing).toHaveBeenCalledOnce()
    expect(useAppStore.getState().isSharing).toBe(true)
    expect(useAppStore.getState().mySnapshotId).toBe('snapshot-1')
  })

  it('分享失败不会撤销已创建的团队，停止分享后状态会重置', async () => {
    const createRoom = vi.fn(async () => {
      useAppStore.getState().setRoomCode('ABC123')
      useAppStore.getState().setIsHost(true)
    })
    const startSharing = vi.fn(async () => ({
      error: { category: 'unknown' as const, message: 'failed', raw: 'failed' },
      ok: false as const,
    }))

    await createRoomAndStartSharing(createRoom, startSharing)

    expect(startSharing).toHaveBeenCalledOnce()
    expect(useAppStore.getState().roomCode).toBe('ABC123')
    expect(useAppStore.getState().isHost).toBe(true)
    expect(useAppStore.getState().isSharing).toBe(false)

    useAppStore.getState().setIsSharing(true)
    useAppStore.getState().setIsSharing(false)
    expect(useAppStore.getState().isSharing).toBe(false)
  })
})
