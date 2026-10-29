import type { LineEnding, Projection, Role } from './types.js';

export const TEAM_PROTOCOL = 2;
export type FileKind = 'text' | 'binary' | 'directory';
export type ChangeSource = {
  kind: 'app' | 'unknown' | 'external' | 'declared-ai' | 'recovery' | 'system';
  tool?: string;
};
export interface Actor {
  id: string;
  name: string;
  role: Role;
  source: ChangeSource;
  clientId?: string;
}
export interface ProjectFile {
  id: string;
  path: string;
  kind: FileKind;
  generation: number;
  revision: number;
  hash: string;
  size: number;
  stateHash: string | null;
  lineEnding: LineEnding | null;
  deleted: boolean;
  reason?: string;
}
export interface FileChange {
  before: ProjectFile | null;
  after: ProjectFile;
  preserveDisk?: boolean;
}
export interface BlobObject {
  hash: string;
  data: string;
}
export interface ActivityEntry {
  id: string;
  opId: string;
  revision: number;
  time: number;
  actor: Actor;
  kind: string;
  paths: string[];
  files: FileChange[];
  added: number;
  removed: number;
  summary: string;
  sessionId: string;
}
export interface Claim {
  id: string;
  fileId: string;
  ownerId: string;
  ownerName: string;
  description: string;
  source: ChangeSource;
  baseRevision: number;
  baseHash: string;
  generation: number;
  strict: boolean;
  external: boolean;
  createdAt: number;
  expiresAt: number;
  status: 'active' | 'completed' | 'cancelled' | 'expired';
}
export interface ConflictEntry {
  id: string;
  fileId: string | null;
  path: string;
  reason: string;
  generation: number;
  revision: number;
  baseHash: string | null;
  localHash: string | null;
  remoteHash: string | null;
  localStateHash?: string | null;
  actorId: string;
  createdAt: number;
  status: 'open' | 'resolved';
  resolution?: string;
  current?: ProjectFile | null;
}
export interface Checkpoint {
  id: string;
  name: string;
  createdAt: number;
  revision: number;
  actorName: string;
  protected: boolean;
  files: ProjectFile[];
}
export interface TrashEntry {
  id: string;
  fileId: string;
  path: string;
  kind: FileKind;
  size: number;
  deletedAt: number;
  actorName: string;
  generation: number;
  file: ProjectFile;
}
export interface SharedMetadata {
  claims: Claim[];
  conflicts: ConflictEntry[];
  checkpoints: Checkpoint[];
  trash: TrashEntry[];
  ignorePatterns: string[];
  retentionDays: number;
  strictClaims: boolean;
}
export interface SnapshotManifest {
  id: string;
  projectId: string;
  name: string;
  revision: number;
  manifestHash: string;
  files: ProjectFile[];
  blobs: { hash: string; size: number }[];
  metadata: SharedMetadata;
  createdAt: number;
}
export interface ProjectEvent {
  opId: string;
  revision: number;
  time: number;
  actor: Actor;
  kind: string;
  changes: FileChange[];
  metadata: SharedMetadata;
  manifestHash: string;
  activity: ActivityEntry;
  result?: Record<string, unknown>;
}
export interface ImpactPreview {
  revision: number;
  paths: string[];
  files: FileChange[];
  creates: number;
  updates: number;
  deletes: number;
  bytes: number;
}
export type ProjectCommand =
  | {
      opId: string;
      kind: 'text';
      fileId: string;
      generation: number;
      update: string;
      source?: ChangeSource;
    }
  | {
      opId: string;
      kind: 'write';
      fileId: string;
      generation: number;
      baseRevision: number;
      baseHash: string;
      data: string;
      source?: ChangeSource;
    }
  | {
      opId: string;
      kind: 'create';
      path: string;
      nodeKind: FileKind;
      data?: string;
      source?: ChangeSource;
    }
  | {
      opId: string;
      kind: 'move';
      fileId: string;
      path: string;
      baseRevision: number;
      expectedRevision?: number;
      source?: ChangeSource;
    }
  | {
      opId: string;
      kind: 'delete';
      fileId: string;
      baseRevision: number;
      expectedRevision: number;
      source?: ChangeSource;
    }
  | {
      opId: string;
      kind: 'claim-create';
      fileId: string;
      description: string;
      strict: boolean;
      external: boolean;
      source?: ChangeSource;
      ttlMs?: number;
    }
  | { opId: string; kind: 'claim-renew' | 'claim-complete' | 'claim-cancel'; claimId: string }
  | { opId: string; kind: 'claim-expire' }
  | {
      opId: string;
      kind: 'conflict-create';
      fileId: string | null;
      path: string;
      reason: string;
      generation: number;
      revision: number;
      baseHash: string | null;
      localData: string | null;
      localState?: string;
      remoteHash: string | null;
      source?: ChangeSource;
    }
  | {
      opId: string;
      kind: 'conflict-resolve';
      conflictId: string;
      choice: 'local' | 'remote' | 'both' | 'merged';
      expectedRevision: number;
      data?: string;
    }
  | { opId: string; kind: 'checkpoint-create'; name: string }
  | { opId: string; kind: 'checkpoint-delete'; checkpointId: string; expectedRevision: number }
  | {
      opId: string;
      kind: 'checkpoint-restore';
      checkpointId: string;
      fileIds?: string[];
      expectedRevision: number;
    }
  | { opId: string; kind: 'trash-restore'; trashId: string; expectedRevision: number }
  | { opId: string; kind: 'trash-purge'; trashIds: string[]; expectedRevision: number }
  | {
      opId: string;
      kind: 'settings';
      ignorePatterns?: string[];
      retentionDays?: number;
      strictClaims?: boolean;
    }
  | { opId: string; kind: 'rescan' };
export type CommandInput = ProjectCommand extends infer C
  ? C extends { opId: string }
    ? Omit<C, 'opId'>
    : never
  : never;
export type CommandKind = ProjectCommand['kind'];
export interface ProjectionRecord {
  fileId: string;
  state: Projection | 'held';
  error?: string;
  hash?: string;
  path: string;
}
export interface ProjectStatus {
  projectId: string;
  name: string;
  root: string;
  revision: number;
  manifestHash: string;
  files: ProjectFile[];
  projections: ProjectionRecord[];
  metadata: SharedMetadata;
  watching: boolean;
  excluded: { path: string; reason: string }[];
  storageBytes: number;
}
export interface TeamInvite {
  version: 2;
  teamId: string;
  projectId: string;
  projectName: string;
  address: string;
  certificate: string;
  fingerprint: string;
  token: string;
  memberId: string;
  role: Role;
  expiresAt: number;
}
export interface TeamPeer {
  clientId: string;
  memberId: string;
  name: string;
  role: Role;
  appliedRevision: number;
  projection: 'applied' | 'pending' | 'blocked';
  activeFileId?: string;
}
export interface TeamStatus {
  teamId: string;
  projectId: string;
  name: string;
  enabled: boolean;
  port: number;
  addresses: string[];
  peers: TeamPeer[];
  members?: {
    memberId: string;
    name: string;
    role: Role;
    expiresAt: number;
    revoked: boolean;
    connected: boolean;
  }[];
  revision: number;
  manifestHash: string;
  confirmedRevision: number | null;
}
export interface TransferState {
  stage:
    | 'idle'
    | 'authenticating'
    | 'manifest'
    | 'downloading'
    | 'catching-up'
    | 'verifying'
    | 'ready'
    | 'cancelled'
    | 'error';
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  error?: { code: string; message: string };
}
export interface ReplicaStatus {
  projectId: string;
  clientId: string;
  actorId: string;
  name: string;
  role: Role;
  root: string;
  connection: 'offline' | 'connecting' | 'online' | 'error';
  initialized: boolean;
  pending: number;
  rejected: number;
  revision: number;
  manifestHash: string;
  confirmedRevision: number | null;
  team: TeamStatus | null;
  transfer: TransferState;
  files: ProjectFile[];
  projections: ProjectionRecord[];
  metadata: SharedMetadata;
  error?: { code: string; message: string };
  watching: boolean;
}
export interface DiscoveredTeam {
  teamId: string;
  projectId: string;
  name: string;
  addresses: string[];
  port: number;
  fingerprint: string;
  seenAt: number;
}
export type StoreQuery =
  | {
      kind: 'activity';
      search?: string;
      fileId?: string;
      actorId?: string;
      source?: string;
      limit?: number;
    }
  | { kind: 'conflicts' }
  | { kind: 'checkpoints' }
  | { kind: 'trash' }
  | { kind: 'claims' }
  | { kind: 'preview-delete'; fileId: string }
  | { kind: 'preview-checkpoint'; checkpointId: string; fileIds?: string[] }
  | { kind: 'metadata' };
