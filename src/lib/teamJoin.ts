import { useAppStore } from '@/store/appStore'
import type { AvailableProjectEntry, IpcResult, LocalEndpoint, PeerInfo, ProjectEntry, SerializedError } from '@/types/cairn'

export function teamInputError(code: string, message: string): SerializedError {
  return { category: 'config', code, message, raw: message }
}

/** Validate the optional endpoint before changing the current room. */
export function parseDirectEndpoint(value: string): LocalEndpoint | undefined {
  const address = value.trim()
  if (!address) return undefined
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(address)
  const port = match ? Number(match[2]) : 0
  if (!match || match[1]!.split('.').some((part) => Number(part) > 255) || port < 1 || port > 65_535) {
    throw teamInputError('errorInvalidAddress', 'Enter an IPv4 address and a port from 1 to 65535.')
  }
  return { host: match[1]!, port }
}

interface TeamJoinApi {
  joinRoom(code: string, endpoint?: LocalEndpoint): Promise<IpcResult<void>>
  listPeers(): Promise<IpcResult<PeerInfo[]>>
}

/** Commit connected-room UI state only after the backend accepts the join. */
export async function joinTeam(code: string, endpoint: LocalEndpoint | undefined, api: TeamJoinApi): Promise<void> {
  const state = useAppStore.getState()
  if (!state.folder || state.status !== 'watching') {
    throw teamInputError('errorProjectRequired', 'Choose and start monitoring a project first.')
  }
  state.resetTeamState()
  try {
    const result = await api.joinRoom(code, endpoint)
    if (!result.ok) throw result.error
  } catch (error) {
    useAppStore.getState().resetTeamState()
    throw error
  }
  useAppStore.setState({
    roomCode: code,
    directAddress: endpoint ? `${endpoint.host}:${endpoint.port}` : undefined,
    isHost: false,
  })
  // A failed refresh must not turn a successful join into a reported failure.
  try {
    const peers = await api.listPeers()
    if (peers.ok && useAppStore.getState().roomCode === code) useAppStore.getState().setPeers(peers.data)
  } catch (error) {
    console.error('[cairn] Unable to refresh teammates after joining', error)
  }
}

export function initializeDownloadTarget(): string {
  const state = useAppStore.getState()
  if (!state.downloadTargetDir && state.folder) state.setDownloadTargetDir(state.folder)
  return useAppStore.getState().downloadTargetDir
}

/** Register a saved copy for an explicit project choice without moving live sync. */
export async function showDownloadedProject(path: string, api: {
  addProject(path: string): Promise<IpcResult<ProjectEntry>>
  listProjects(): Promise<IpcResult<AvailableProjectEntry[]>>
}): Promise<void> {
  const added = await api.addProject(path)
  if (!added.ok) throw added.error
  const projects = await api.listProjects()
  if (!projects.ok) throw projects.error
  useAppStore.getState().setProjects(projects.data)
  useAppStore.getState().setActiveView('projects')
}
