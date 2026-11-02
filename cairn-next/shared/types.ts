export const PROTOCOL_VERSION = 1;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_UPDATE_BYTES = 4 * 1024 * 1024;
export type Role = 'owner' | 'editor' | 'viewer';
export type LineEnding = 'lf' | 'crlf';
export type Projection = 'pending' | 'applied' | 'blocked' | 'error';
export interface Invite {
  version: 1;
  serverId: string;
  projectId: string;
  fileId: string;
  generation: number;
  fileName: string;
  address: string;
  certificate: string;
  fingerprint: string;
  token: string;
  memberId: string;
  role: Role;
  expiresAt: number;
}
export interface Peer {
  clientId: string;
  name: string;
  role: Role;
  appliedRevision: number;
  projection: Projection;
}
export interface ServerStatus {
  serverId: string;
  projectId: string;
  fileId: string;
  generation: number;
  fileName: string;
  lineEnding: LineEnding;
  name: string;
  port: number;
  addresses: string[];
  revision: number;
  hash: string;
  projection: Projection;
  projectionError?: string;
  peers: Peer[];
  confirmedRevision: number | null;
  lastSavedAt: number;
}
export interface ClientSnapshot {
  connection: 'offline' | 'connecting' | 'online' | 'error';
  error?: { code: string; message: string };
  initialized: boolean;
  clientId: string;
  name: string;
  role: Role;
  projectId: string;
  fileId: string;
  generation: number;
  fileName: string;
  lineEnding: LineEnding;
  text: string;
  state: string;
  pending: number;
  rejected: number;
  localSaved: boolean;
  serverRevision: number;
  serverHash: string;
  serverProjection: Projection;
  localProjection: Projection;
  peers: Peer[];
  confirmedRevision: number | null;
  directory: string;
}
export interface HostOptions {
  root: string;
  fileName?: string;
  name?: string;
  port?: number;
  host?: string;
}
export interface ClientOptions {
  directory: string;
  invite: Invite;
  name: string;
}
export type ClientMessage =
  | {
      type: 'hello';
      version: number;
      serverId: string;
      projectId: string;
      fileId: string;
      generation: number;
      token: string;
      clientId: string;
      name: string;
    }
  | { type: 'update'; opId: string; fileId: string; generation: number; update: string }
  | { type: 'applied'; revision: number; hash: string; projection: Projection }
  | { type: 'awareness'; update: string }
  | { type: 'retry-projection' };
export type ServerMessage =
  | { type: 'welcome'; state: string; role: Role; status: ServerStatus }
  | { type: 'update'; update: string; revision: number; hash: string; opId: string }
  | { type: 'ack'; opId: string; revision: number; hash: string }
  | { type: 'error'; code: string; message: string; opId?: string }
  | { type: 'status'; status: ServerStatus }
  | { type: 'awareness'; update: string };
export interface DesktopState {
  host: ServerStatus | null;
  client: ClientSnapshot | null;
  runtime: { electron: string; node: string; platform: string };
}
export interface DesktopApi {
  state(): Promise<DesktopState>;
  chooseFolder(): Promise<string | null>;
  startHost(input: {
    root: string;
    fileName: string;
    name: string;
    port: number;
    displayName: string;
  }): Promise<DesktopState>;
  stopHost(): Promise<DesktopState>;
  restartHost(): Promise<DesktopState>;
  makeInvite(input: { role: 'editor' | 'viewer'; address: string }): Promise<string>;
  join(input: { invite: string; directory: string; name: string }): Promise<DesktopState>;
  cancelJoin(): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  update(input: {
    update: string;
    fileId: string;
    generation: number;
    clientId: string;
  }): Promise<ClientSnapshot>;
  awareness(update: string): Promise<void>;
  retryProjection(): Promise<void>;
  openFolder(): Promise<void>;
  copyDiagnostics(): Promise<void>;
  onState(listener: (state: DesktopState) => void): () => void;
  onAwareness(listener: (update: string) => void): () => void;
}
