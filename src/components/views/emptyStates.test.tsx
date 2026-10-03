import { renderToStaticMarkup } from 'react-dom/server'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="monaco-diff">{original}|{modified}</div>
  ),
  Editor: ({ value }: { value: string }) => <div data-testid="monaco-editor">{value}</div>,
}))

import { ConflictsView } from './ConflictsView'
import { ActivityView } from './ActivityView'
import { createRoomAndStartSharing, RoomView } from './RoomView'
import { TrashView } from './TrashView'
import { useAppStore, type AppState } from '@/store/appStore'
import { DownloadPromptDialog } from '@/components/DownloadPromptDialog'
import { ConflictDialog } from '@/components/ConflictDialog'
import { Sidebar } from '@/components/Sidebar'
import { OpDiffDialog } from '@/components/OpDiffDialog'
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
  const conflicts = [
    {
      author: 'alice', filePath: 'src/auth.ts', localContent: 'local\n',
      opHash: 'a'.repeat(64), remoteContent: 'remote\n', timestamp: Date.now(),
    },
    {
      author: 'bob', filePath: 'src/api.ts', localContent: 'left\n',
      opHash: 'b'.repeat(64), remoteContent: 'right\n', timestamp: Date.now(),
    },
  ]

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

  it('Activity 依檔案彙整變更', () => {
    const ops = [
      { author: 'alice', diff: '@@ -1 +1 @@\n-old\n+new', filePath: 'src/auth.ts', hash: 'a'.repeat(64), id: 'one', parentHashes: [], timestamp: 200 },
      { author: 'bob', diff: '@@ -1 +1 @@\n-old\n+new', filePath: 'src/auth.ts', hash: 'b'.repeat(64), id: 'two', parentHashes: [], timestamp: 100 },
    ]
    const html = renderToStaticMarkup(<ActivityView folder="/tmp/project" ops={ops} onChangeFolder={async () => undefined} />)

    expect(html).toContain('src/auth.ts')
    expect(html).toContain('2 changes')
    expect(html).toContain('2 authors')
  })

  it('Same-file edits 空状态显示同步说明', () => {
    const html = renderToStaticMarkup(<ConflictsView />)

    expect(html).toContain("Everything&#x27;s in sync")
    expect(html).toContain("Nothing gets lost.")
  })

  it('Same-file edits 有冲突时显示双方内容和解决操作', () => {
    const html = renderToStaticMarkup(<ConflictsView conflicts={conflicts} />)

    expect(html).toContain('src/auth.ts')
    expect(html).toContain('Keep mine')
    expect(html).toContain('Keep theirs')
  })

  it('Changes 有冲突时显示处理横幅', () => {
    const html = renderToStaticMarkup(<ActivityView conflicts={conflicts} ops={[]} onChangeFolder={async () => undefined} />)

    expect(html).toContain('2 changes need your attention')
    expect(html).toContain('Review')
  })

  it('ConflictDialog 显示两个冲突以及双方对比内容', () => {
    const html = renderToStaticMarkup(
      <ConflictDialog open conflicts={conflicts} onClose={() => undefined} onResolve={async () => undefined} />,
    )

    expect(html).toContain('src/auth.ts')
    expect(html).toContain('src/api.ts')
    expect(html).toContain('Keep mine')
    expect(html).toContain('Keep theirs')
    expect(html).toContain('remote')
    expect(html).toContain('local')
  })

  it('OpDiffDialog 仅在打开时显示操作的原始 diff', () => {
    const op = {
      author: 'alice', diff: '@@ -1 +1 @@\n-old\n+new\n', filePath: 'src/auth.ts',
      hash: 'a'.repeat(64), id: 'op-1', parentHashes: [], timestamp: Date.now(),
    }
    expect(renderToStaticMarkup(<OpDiffDialog open={false} op={op} onClose={() => undefined} />)).toBe('')
    const html = renderToStaticMarkup(<OpDiffDialog open op={op} onClose={() => undefined} />)
    expect(html).toContain('src/auth.ts')
    expect(html).toContain('+new')
  })

  it('Sidebar 显示项目、协作和复原分组', () => {
    const html = renderToStaticMarkup(<Sidebar onOpenSettings={() => undefined} />)

    expect(html).toContain('Project')
    expect(html).toContain('Collaboration')
    expect(html).toContain('Recovery')
    expect(html).toContain('Settings')
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
