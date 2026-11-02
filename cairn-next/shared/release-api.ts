import type { ClientSnapshot, Role } from './types.js';
import type {
  Actor,
  ChangeSource,
  CommandInput,
  DiscoveredTeam,
  ImpactPreview,
  ProjectEvent,
  ProjectFile,
  ReplicaStatus,
  SharedMetadata,
  SnapshotManifest,
  StoreQuery,
  TeamStatus,
} from './project.js';
export type Locale = 'ko' | 'en' | 'zh-TW';
export interface RecentProject {
  id: string;
  projectId: string;
  name: string;
  path: string;
  kind: 'local' | 'joined';
  lastOpened: number;
  exists: boolean;
}
export interface Preferences {
  locale: Locale;
  displayName: string;
  onboardingDone: boolean;
  source: ChangeSource;
}
export interface CurrentProject {
  id: string;
  projectId: string;
  name: string;
  path: string;
  kind: 'local' | 'joined';
  files: ProjectFile[];
  excluded: { path: string; reason: string }[];
  watching: boolean;
}
export interface GitHubSettings {
  owner: string;
  repo: string;
  baseBranch: string;
  hasToken: boolean;
}
export interface ExportFile {
  path: string;
  action: 'add' | 'modify' | 'delete';
  kind: 'text' | 'binary';
  hash: string | null;
  size: number;
  beforeSha: string | null;
  diff: string | null;
  selected: boolean;
}
export interface ExportPreview {
  previewId: string;
  digest: string;
  owner: string;
  repo: string;
  baseBranch: string;
  baseHead: string;
  baseTree: string;
  projectId: string;
  revision: number;
  files: ExportFile[];
  excluded: { path: string; reason: string }[];
}
export interface ReleaseState {
  version: string;
  preferences: Preferences;
  projects: RecentProject[];
  current: CurrentProject | null;
  replica: ReplicaStatus | null;
  editor: ClientSnapshot | null;
  team: TeamStatus | null;
  discovered: DiscoveredTeam[];
  gitHub: GitHubSettings;
  busy: string | null;
  error: { code: string; message: string } | null;
  simulation: boolean;
  runtime: { electron: string; node: string; platform: string };
}
export interface ReleaseApi {
  state(): Promise<ReleaseState>;
  onState(listener: (state: ReleaseState) => void): () => void;
  chooseFolder(): Promise<string | null>;
  openProject(input: { path: string }): Promise<ReleaseState>;
  switchProject(id: string): Promise<ReleaseState>;
  locateProject(input: { id: string; path: string }): Promise<ReleaseState>;
  removeProject(id: string): Promise<ReleaseState>;
  closeProject(): Promise<void>;
  selectFile(id: string): Promise<ClientSnapshot | null>;
  update(input: {
    update: string;
    fileId: string;
    generation: number;
    clientId: string;
  }): Promise<ClientSnapshot>;
  awareness(update: string): Promise<void>;
  onAwareness(listener: (update: string) => void): () => void;
  command(
    input: CommandInput,
    scope: { projectId: string; clientId: string },
  ): Promise<ProjectEvent>;
  query(query: StoreQuery): Promise<unknown>;
  readBlob(hash: string): Promise<{ data: string }>;
  setWatching(enabled: boolean): Promise<void>;
  retryProjection(): Promise<void>;
  createTeam(): Promise<ReleaseState>;
  copyInvite(input: {
    role: 'editor' | 'viewer';
    address?: string;
    memberId?: string;
  }): Promise<{ fingerprint: string; expiresAt: number }>;
  joinTeam(input: {
    invite: string;
    directory: string;
    name?: string;
    address?: string;
  }): Promise<ReleaseState>;
  cancelJoin(): Promise<void>;
  leaveTeam(): Promise<void>;
  reconnect(): Promise<void>;
  discoverTeams(): Promise<DiscoveredTeam[]>;
  revokeMember(memberId: string): Promise<void>;
  savePreferences(input: Partial<Preferences>): Promise<ReleaseState>;
  saveGitHub(input: {
    owner: string;
    repo: string;
    baseBranch: string;
    token?: string;
    clearToken?: boolean;
  }): Promise<GitHubSettings>;
  previewGitHub(): Promise<ExportPreview>;
  publishGitHub(input: {
    previewId: string;
    selectedPaths: string[];
    title: string;
    body: string;
  }): Promise<{ url: string; branch: string }>;
  exportSnapshot(): Promise<{ path: string; files: number; bytes: number } | null>;
  openFolder(input?: { relativePath?: string }): Promise<void>;
  copyText(text: string): Promise<void>;
  copyDiagnostics(): Promise<void>;
  legal(): Promise<{ licenses: string; privacy: string }>;
  startSimulation(): Promise<ReleaseState>;
  stopSimulation(): Promise<ReleaseState>;
}
