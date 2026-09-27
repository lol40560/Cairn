import { renderToStaticMarkup } from 'react-dom/server'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConflictsView } from './ConflictsView'
import { ActivityView } from './ActivityView'
import { RoomView } from './RoomView'
import { TrashView } from './TrashView'
import { useAppStore, type AppState } from '@/store/appStore'

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
})
