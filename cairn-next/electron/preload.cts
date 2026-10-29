import { contextBridge, ipcRenderer } from 'electron';
import type { ReleaseApi, ReleaseState } from '../shared/release-api.js';
const invoke = <T,>(name: string, input?: unknown): Promise<T> =>
  ipcRenderer.invoke(`cairn:${name}`, input) as Promise<T>;
const api: ReleaseApi = {
  state: () => invoke('state'),
  chooseFolder: () => invoke('choose-folder'),
  openProject: (v) => invoke('open-project', v),
  switchProject: (v) => invoke('switch-project', v),
  locateProject: (v) => invoke('locate-project', v),
  removeProject: (v) => invoke('remove-project', v),
  closeProject: () => invoke('close-project'),
  selectFile: (v) => invoke('select-file', v),
  update: (v) => invoke('update', v),
  awareness: (v) => invoke('awareness', v),
  command: (command, scope) => invoke('command', { command, scope }),
  query: (v) => invoke('query', v),
  readBlob: (v) => invoke('read-blob', v),
  setWatching: (v) => invoke('set-watching', v),
  retryProjection: () => invoke('retry-projection'),
  createTeam: () => invoke('create-team'),
  copyInvite: (v) => invoke('copy-invite', v),
  joinTeam: (v) => invoke('join-team', v),
  cancelJoin: () => invoke('cancel-join'),
  leaveTeam: () => invoke('leave-team'),
  reconnect: () => invoke('reconnect'),
  discoverTeams: () => invoke('discover-teams'),
  revokeMember: (v) => invoke('revoke-member', v),
  savePreferences: (v) => invoke('save-preferences', v),
  saveGitHub: (v) => invoke('save-github', v),
  previewGitHub: () => invoke('preview-github'),
  publishGitHub: (v) => invoke('publish-github', v),
  exportSnapshot: () => invoke('export-snapshot'),
  openFolder: (v) => invoke('open-folder', v),
  copyText: (v) => invoke('copy-text', v),
  copyDiagnostics: () => invoke('copy-diagnostics'),
  legal: () => invoke('legal'),
  startSimulation: () => invoke('start-simulation'),
  stopSimulation: () => invoke('stop-simulation'),
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ReleaseState) => listener(state);
    ipcRenderer.on('cairn:state', handler);
    return () => ipcRenderer.removeListener('cairn:state', handler);
  },
  onAwareness: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, update: string) => listener(update);
    ipcRenderer.on('cairn:awareness', handler);
    return () => ipcRenderer.removeListener('cairn:awareness', handler);
  },
};
contextBridge.exposeInMainWorld('cairn', api);
