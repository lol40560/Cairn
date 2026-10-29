import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CairnError, b64, publicError, unb64 } from '../core/common.js';
import { ProjectStore } from '../core/project/store.js';
import { RecoveryService } from '../core/project/recovery.js';
import { ProjectReplica } from '../core/project/replica.js';
import { TeamHost, parseTeamInvite } from '../core/project/transport.js';
import { TeamDiscovery } from '../core/project/discovery.js';
import {
  exportSnapshot,
  previewGitHub,
  publishGitHub,
  type GitHubPreview,
} from '../core/project/exports.js';
import type { ClientSnapshot } from '../shared/types.js';
import type {
  CommandInput,
  ProjectEvent,
  ProjectStatus,
  ReplicaStatus,
  StoreQuery,
  TeamInvite,
} from '../shared/project.js';
import type {
  ExportPreview,
  GitHubSettings,
  Preferences,
  RecentProject,
  ReleaseApi,
  ReleaseState,
} from '../shared/release-api.js';
import { ProfileStore } from './preferences.js';
import { Simulation } from './simulation.js';

interface Session {
  record: RecentProject;
  replica: ProjectReplica;
  authority?: ProjectStore;
  host?: TeamHost;
  selected: string | null;
}
export interface DesktopServices {
  version: string;
  runtime: ReleaseState['runtime'];
  chooseFolder(): Promise<string | null>;
  saveArchive(name: string): Promise<string | null>;
  copy(text: string): void;
  openPath(path: string): Promise<void>;
  legal(): Promise<{ licenses: string; privacy: string }>;
}
/** Main-process coordinator: each workcopy has one writer and every UI mutation uses the durable core. */
export class DesktopController extends EventEmitter {
  private session: Session | null = null;
  private simulation: Simulation | null = null;
  private readonly discovery = new TeamDiscovery();
  private discoveryStarted = false;
  private busy: string | null = null;
  private error: ReleaseState['error'] = null;
  private epoch = 0;
  private switching = false;
  private closed = false;
  private preview: GitHubPreview | null = null;
  private publication: NodeJS.Immediate | null = null;
  constructor(
    readonly profile: ProfileStore,
    private readonly services: DesktopServices,
  ) {
    super();
    this.discovery.on('update', () => this.publish());
  }
  state(): ReleaseState {
    const s = this.session,
      authority = s?.authority?.status(),
      replica = s?.replica.status();
    const files = replica?.files ?? [];
    const editor = this.editor(replica, authority);
    return {
      version: this.services.version,
      preferences: { ...this.profile.settings.preferences },
      projects: this.profile.settings.projects.map((p) => ({
        ...p,
        exists: fs.existsSync(p.path),
      })),
      current:
        this.simulation?.current ??
        (s
          ? {
              ...s.record,
              files,
              excluded: authority?.excluded ?? s.replica.store.status().excluded,
              watching: authority?.watching ?? replica!.watching,
            }
          : null),
      replica:
        this.simulation?.replica ??
        (replica
          ? {
              ...replica,
              root: s!.record.path,
              watching: authority?.watching ?? replica.watching,
              projections: authority
                ? [...replica.projections, ...authority.projections]
                : replica.projections,
            }
          : null),
      editor,
      team: this.simulation?.team ?? s?.host?.status() ?? replica?.team ?? null,
      discovered: this.discoveryStarted ? this.discovery.list() : [],
      gitHub: this.github(),
      busy: this.busy,
      error: this.error,
      simulation: !!this.simulation,
      runtime: this.services.runtime,
    };
  }
  private editor(replica?: ReplicaStatus, authority?: ProjectStatus): ClientSnapshot | null {
    if (this.simulation) return this.simulation.editor;
    const s = this.session;
    if (!s?.selected) return null;
    const status = replica ?? s.replica.status();
    const file = status.files.find((f) => f.id === s.selected && !f.deleted);
    if (file?.kind !== 'text') return null;
    try {
      const editor = s.replica.editorSnapshot(s.selected, status);
      const projection = (authority ?? s.authority?.status())?.projections.find(
        (p) => p.fileId === s.selected,
      );
      return {
        ...editor,
        directory: s.record.path,
        serverProjection: projection
          ? projection.state === 'held'
            ? 'pending'
            : projection.state
          : editor.serverProjection,
      };
    } catch {
      return null;
    }
  }
  private publish(): void {
    if (this.closed || this.publication) return;
    // Several durable core notifications may occur in one event-loop turn.
    // Publish one fresh view, without repeating full history/policy inspection.
    this.publication = setImmediate(() => {
      this.publication = null;
      if (!this.closed) this.emit('state', this.state());
    });
  }
  report(error: unknown): void {
    this.error = publicError(error);
    this.publish();
  }
  private real(): Session {
    if (this.simulation)
      throw new CairnError(
        'SIMULATION_ONLY',
        'Leave the simulation before using a real folder or connection.',
      );
    if (!this.session) throw new CairnError('NO_PROJECT', 'Open a project first.');
    return this.session;
  }
  private async action<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.switching) throw new CairnError('BUSY', 'A project change is already in progress.');
    this.switching = true;
    this.busy = label;
    this.error = null;
    this.publish();
    try {
      return await fn();
    } catch (error) {
      this.report(error);
      throw error;
    } finally {
      this.switching = false;
      this.busy = null;
      this.publish();
    }
  }
  private observe(s: Session): void {
    const changed = () => {
      if (this.session === s) {
        this.ensureSelection(s);
        this.publish();
      }
    };
    s.replica.on('state', changed);
    s.replica.on('awareness', (a: { fileId: string; generation: number; update: string }) => {
      if (
        this.session === s &&
        s.selected === a.fileId &&
        this.editor()?.generation === a.generation
      )
        this.emit('awareness', a.update);
    });
    s.authority?.on('status', changed);
    s.authority?.on('diagnostic', (e: unknown) => {
      if (this.session === s) this.report(e);
    });
    s.host?.on('status', () => {
      if (this.session === s) {
        if (s.host!.status().enabled && this.discoveryStarted)
          this.discovery.advertise(s.host!.status(), s.host!.fingerprint);
        changed();
      }
    });
  }
  private ensureSelection(s: Session): void {
    const files = s.replica.store.files();
    if (!files.some((f) => f.id === s.selected && !f.deleted))
      s.selected = files.find((f) => f.kind === 'text' && !f.deleted)?.id ?? null;
  }
  private register(record: RecentProject): void {
    const settings = this.profile.settings;
    settings.projects = settings.projects.filter((p) => p.id !== record.id);
    settings.projects.unshift(record);
    settings.activeProject = record.id;
    this.profile.save();
  }
  private async closeSession(clearActive = false): Promise<void> {
    const s = this.session;
    this.session = null;
    this.preview = null;
    this.discovery.stopAdvertising();
    if (s) {
      s.replica.close();
      await s.host?.stop();
      s.authority?.close();
    }
    if (clearActive) {
      this.profile.settings.activeProject = null;
      this.profile.save();
    }
    this.publish();
  }
  chooseFolder(): Promise<string | null> {
    if (this.simulation)
      throw new CairnError('SIMULATION_ONLY', 'Leave the simulation to open real folders.');
    return this.services.chooseFolder();
  }
  async openProject(input: { path: string }): Promise<ReleaseState> {
    return this.action('open', async () => {
      if (this.simulation) throw new CairnError('SIMULATION_ONLY', 'Leave the simulation first.');
      const root = path.resolve(input.path),
        existing = this.profile.settings.projects.find(
          (p) => p.path.toLowerCase() === root.toLowerCase(),
        );
      if (existing?.kind === 'joined') return this.openJoined(existing);
      await this.openLocal(root, existing);
      return this.state();
    });
  }
  private async openLocal(root: string, existing?: RecentProject): Promise<void> {
    if (existing && !fs.existsSync(path.join(root, '.cairn-next', 'project.sqlite')))
      throw new CairnError(
        'IDENTITY_MISMATCH',
        'Choose the original project folder, including its .cairn-next recovery data.',
      );
    const attempt = ++this.epoch;
    await this.closeSession();
    if (attempt !== this.epoch || this.closed)
      throw new CairnError('CANCELLED', 'Project opening was cancelled.');
    let store: ProjectStore | undefined,
      host: TeamHost | undefined,
      replica: ProjectReplica | undefined;
    try {
      store = new ProjectStore({
        root,
        mode: 'authority',
        ownerId: this.profile.settings.ownerId,
        projectId: existing?.projectId,
      });
      new RecoveryService(store);
      if (existing && store.projectId !== existing.projectId)
        throw new CairnError('IDENTITY_MISMATCH', 'The selected folder is a different project.');
      const savedTeam = this.profile.settings.teams[store.projectId];
      host = await TeamHost.start({
        store,
        name: store.status().name.trim().slice(0, 80) || 'Project',
        port: savedTeam?.port,
        lan: savedTeam?.enabled ?? false,
      });
      if (attempt !== this.epoch || this.closed)
        throw new CairnError('CANCELLED', 'Project opening was cancelled.');
      const invite = host.invite(
        'owner',
        `wss://127.0.0.1:${host.status().port}/team`,
        30 * 86400_000,
      );
      const cache = path.join(this.profile.directory, 'owner-workcopies', store.projectId);
      fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
      replica = new ProjectReplica({
        root: cache,
        invite,
        name: this.profile.settings.preferences.displayName,
        watch: false,
      });
      const record: RecentProject = {
        id: existing?.id ?? randomUUID(),
        projectId: store.projectId,
        name: store.status().name,
        path: store.root,
        kind: 'local',
        lastOpened: Date.now(),
        exists: true,
      };
      const s: Session = {
        record,
        replica,
        authority: store,
        host,
        selected: this.profile.settings.selected[record.id] ?? null,
      };
      this.session = s;
      this.observe(s);
      this.applySource();
      store.startWatching();
      this.register(record);
      this.publish();
      await replica.connect();
      if (attempt !== this.epoch || this.session !== s) return;
      this.ensureSelection(s);
      if (s.selected) replica.select(s.selected);
      if (host.status().enabled) {
        this.startDiscovery();
        this.discovery.advertise(host.status(), host.fingerprint);
      }
      this.publish();
    } catch (error) {
      if (!this.session || this.session.replica !== replica) {
        replica?.close();
        await host?.stop();
        store?.close();
      }
      throw error;
    }
  }
  async switchProject(id: string): Promise<ReleaseState> {
    return this.action('open', async () => {
      if (this.simulation) throw new CairnError('SIMULATION_ONLY', 'Leave the simulation first.');
      const record = this.profile.settings.projects.find((p) => p.id === id);
      if (!record) throw new CairnError('NOT_FOUND', 'Project is not in the recent list.');
      if (!fs.existsSync(record.path))
        throw new CairnError(
          'FOLDER_MISSING',
          'Locate the moved folder or remove this entry from the recent list.',
        );
      if (record.kind === 'joined') return this.openJoined(record);
      await this.openLocal(record.path, record);
      return this.state();
    });
  }
  private async openJoined(record: RecentProject): Promise<ReleaseState> {
    if (!fs.existsSync(path.join(record.path, '.cairn-next', 'project.sqlite')))
      throw new CairnError(
        'IDENTITY_MISMATCH',
        'Choose the original workcopy including its .cairn-next recovery data.',
      );
    const invite = this.profile.invitation(record.id);
    if (!invite)
      throw new CairnError(
        'INVITE_REQUIRED',
        'Enter a fresh invitation for this workcopy. Its files are preserved.',
      );
    return this.joinInternal(invite, record.path, record);
  }
  async locateProject(input: { id: string; path: string }): Promise<ReleaseState> {
    return this.action('locate', async () => {
      const record = this.profile.settings.projects.find((p) => p.id === input.id);
      if (!record) throw new CairnError('NOT_FOUND', 'Project not found.');
      const moved = { ...record, path: path.resolve(input.path) };
      if (record.kind === 'joined') return this.openJoined(moved);
      await this.openLocal(moved.path, moved);
      return this.state();
    });
  }
  async removeProject(id: string): Promise<ReleaseState> {
    if (this.session?.record.id === id) {
      ++this.epoch;
      await this.closeSession(true);
    }
    this.profile.settings.projects = this.profile.settings.projects.filter((p) => p.id !== id);
    this.profile.save();
    this.publish();
    return this.state();
  }
  async closeProject(): Promise<void> {
    ++this.epoch;
    await this.closeSession(true);
  }
  async selectFile(id: string): Promise<ClientSnapshot | null> {
    if (this.simulation) {
      this.simulation.selectFile(id);
      this.publish();
      return this.editor();
    }
    const s = this.real(),
      file = s.replica.status().files.find((f) => f.id === id);
    if (!file || file.deleted)
      throw new CairnError('NOT_FOUND', 'File is no longer in the project.');
    s.selected = id;
    if (file.kind === 'text') s.replica.select(id);
    this.profile.settings.selected[s.record.id] = id;
    this.profile.save();
    this.publish();
    return this.editor();
  }
  update(input: Parameters<ReleaseApi['update']>[0]): ClientSnapshot {
    if (this.simulation) {
      const value = this.simulation.update(input);
      this.publish();
      return value;
    }
    const s = this.real();
    if (input.clientId !== s.replica.clientId)
      throw new CairnError('STALE_SESSION', 'The input belongs to a previous project session.');
    const result = s.replica.applyLocalUpdate(input.fileId, input.generation, unb64(input.update));
    return { ...result, directory: s.record.path };
  }
  awareness(update: string): void {
    if (this.simulation) return;
    const s = this.real(),
      file = s.selected ? s.replica.store.file(s.selected) : undefined;
    if (file?.kind === 'text' && !file.deleted)
      s.replica.awareness({ fileId: file.id, generation: file.generation, update });
  }
  async command(
    input: CommandInput,
    scope?: { projectId: string; clientId: string },
  ): Promise<ProjectEvent> {
    const current = this.simulation?.replica ?? this.session?.replica.status();
    if (
      scope &&
      (!current || scope.projectId !== current.projectId || scope.clientId !== current.clientId)
    )
      throw new CairnError('STALE_SESSION', 'This action belongs to a previous project session.');
    if (this.switching) throw new CairnError('BUSY', 'Wait until the project change finishes.');
    if (this.simulation) {
      const e = this.simulation.command(input);
      this.publish();
      return e;
    }
    const s = this.real();
    if (input.kind === 'rescan' && s.authority) s.authority.scanExternal();
    return s.replica.command(input);
  }
  async query(input: StoreQuery): Promise<unknown> {
    return this.simulation ? this.simulation.query(input) : this.real().replica.query(input);
  }
  async readBlob(hash: string): Promise<{ data: string }> {
    return this.simulation
      ? this.simulation.readBlob(hash)
      : { data: b64(await this.real().replica.blob(hash)) };
  }
  setWatching(enabled: boolean): void {
    if (this.simulation) {
      this.simulation.setWatching(enabled);
      this.publish();
      return;
    }
    const s = this.real();
    if (s.authority) {
      if (enabled) s.authority.startWatching();
      else s.authority.stopWatching();
    } else s.replica.setWatching(enabled);
    this.publish();
  }
  retryProjection(): void {
    const s = this.real();
    s.authority?.retryProjection();
    s.replica.retryProjection();
    this.publish();
  }
  private startDiscovery(): void {
    if (!this.discoveryStarted) {
      this.discovery.start();
      this.discoveryStarted = true;
    }
  }
  async discoverTeams() {
    if (this.simulation) return [];
    this.startDiscovery();
    this.publish();
    return this.discovery.list();
  }
  async createTeam(): Promise<ReleaseState> {
    return this.action('team', async () => {
      const s = this.real();
      if (!s.host)
        throw new CairnError('OWNER_REQUIRED', 'Only the project creator can create a team.');
      await s.host.setLan(true);
      this.profile.settings.teams[s.record.projectId] = {
        enabled: true,
        port: s.host.status().port,
      };
      this.profile.save();
      await s.replica.connect();
      this.startDiscovery();
      this.discovery.advertise(s.host.status(), s.host.fingerprint);
      this.publish();
      return this.state();
    });
  }
  copyInvite(input: { role: 'editor' | 'viewer'; address?: string; memberId?: string }): {
    fingerprint: string;
    expiresAt: number;
  } {
    const s = this.real();
    if (!s.host?.status().enabled)
      throw new CairnError('NO_TEAM', 'Create a team before copying an invitation.');
    const choices = s.host
      .status()
      .addresses.filter(
        (a) => !['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(new URL(a).hostname),
      );
    const address = input.address ?? choices[0];
    if (!address || !choices.includes(address))
      throw new CairnError(
        'NO_LAN_ADDRESS',
        'Connect to the local network and choose its address.',
      );
    const invite = s.host.invite(input.role, address, 86400_000, input.memberId);
    this.services.copy(JSON.stringify(invite));
    return { fingerprint: invite.fingerprint, expiresAt: invite.expiresAt };
  }
  async joinTeam(input: Parameters<ReleaseApi['joinTeam']>[0]): Promise<ReleaseState> {
    return this.action('join', async () => {
      if (this.simulation) throw new CairnError('SIMULATION_ONLY', 'Leave the simulation first.');
      const invite = parseTeamInvite(input.invite);
      if (input.address)
        invite.address = parseTeamInvite(
          JSON.stringify({ ...invite, address: input.address }),
        ).address;
      if (input.name) {
        this.profile.settings.preferences.displayName = input.name;
        this.profile.save();
      }
      const existing = this.profile.settings.projects.find(
        (p) => p.path.toLowerCase() === path.resolve(input.directory).toLowerCase(),
      );
      if (existing && (existing.kind !== 'joined' || existing.projectId !== invite.projectId))
        throw new CairnError(
          'IDENTITY_MISMATCH',
          'This folder is registered for a different project.',
        );
      return this.joinInternal(invite, input.directory, existing);
    });
  }
  private async joinInternal(
    invite: TeamInvite,
    directory: string,
    existing?: RecentProject,
  ): Promise<ReleaseState> {
    const attempt = ++this.epoch;
    await this.closeSession();
    if (attempt !== this.epoch || this.closed)
      throw new CairnError('CANCELLED', 'Joining was cancelled.');
    const replica = new ProjectReplica({
      root: directory,
      invite,
      name: this.profile.settings.preferences.displayName,
      watch: true,
    });
    const record: RecentProject = {
      id: existing?.id ?? randomUUID(),
      projectId: invite.projectId,
      name: invite.projectName,
      path: replica.store.root,
      kind: 'joined',
      lastOpened: Date.now(),
      exists: true,
    };
    const s: Session = {
      record,
      replica,
      selected: this.profile.settings.selected[record.id] ?? null,
    };
    this.session = s;
    this.observe(s);
    this.applySource();
    this.register(record);
    this.publish();
    try {
      await this.profile.setInvitation(record.id, invite);
    } catch (error) {
      this.report(error);
    }
    if (attempt !== this.epoch || this.session !== s || this.closed) return this.state();
    await replica.connect();
    if (attempt !== this.epoch || this.session !== s) return this.state();
    this.ensureSelection(s);
    if (s.selected) replica.select(s.selected);
    this.publish();
    return this.state();
  }
  cancelJoin(): void {
    ++this.epoch;
    this.session?.replica.cancel();
    this.busy = null;
    this.publish();
  }
  async leaveTeam(): Promise<void> {
    const s = this.real();
    ++this.epoch;
    if (s.host) {
      this.discovery.stopAdvertising();
      await s.host.setLan(false);
      this.profile.settings.teams[s.record.projectId] = {
        enabled: false,
        port: s.host.status().port,
      };
      this.profile.save();
      await s.replica.connect();
    } else s.replica.disconnect();
    this.publish();
  }
  async reconnect(): Promise<void> {
    const s = this.real();
    await s.replica.connect();
    this.publish();
  }
  revokeMember(memberId: string): void {
    const s = this.real();
    if (!s.host) throw new CairnError('OWNER_REQUIRED', 'Only the team creator can remove access.');
    s.host.revoke(memberId);
    this.publish();
  }
  private applySource(): void {
    const s = this.session;
    if (!s) return;
    const prefs = this.profile.settings.preferences;
    s.replica.setSource(prefs.source);
    s.authority?.setExternalActor({
      id: s.authority.ownerId,
      name: prefs.displayName,
      role: 'owner',
      source: prefs.source,
    });
  }
  async savePreferences(input: Partial<Preferences>): Promise<ReleaseState> {
    const previousName = this.profile.settings.preferences.displayName;
    Object.assign(this.profile.settings.preferences, input);
    this.profile.save();
    this.applySource();
    if (input.displayName && input.displayName !== previousName && this.session)
      await this.session.replica.setName(input.displayName);
    this.publish();
    return this.state();
  }
  private github(): GitHubSettings {
    const id = this.session?.record.projectId ?? '',
      saved = this.profile.settings.github[id];
    return {
      owner: saved?.owner ?? '',
      repo: saved?.repo ?? '',
      baseBranch: saved?.baseBranch ?? 'main',
      hasToken: !!this.profile.token(id),
    };
  }
  async saveGitHub(input: Parameters<ReleaseApi['saveGitHub']>[0]): Promise<GitHubSettings> {
    const s = this.real();
    this.profile.settings.github[s.record.projectId] = {
      owner: input.owner,
      repo: input.repo,
      baseBranch: input.baseBranch,
    };
    this.profile.save();
    if (input.token !== undefined || input.clearToken)
      await this.profile.setToken(s.record.projectId, input.clearToken ? undefined : input.token);
    this.preview = null;
    this.publish();
    return this.github();
  }
  private exportable(): Session {
    const s = this.real(),
      r = s.replica.status();
    if (!r.initialized || r.pending || r.rejected)
      throw new CairnError(
        'EXPORT_PENDING',
        'Send or review pending changes before exporting this verified project snapshot.',
      );
    return s;
  }
  async previewGitHub(): Promise<ExportPreview> {
    const s = this.exportable(),
      config = this.github(),
      token = this.profile.token(s.record.projectId);
    if (!token)
      throw new CairnError('GITHUB_TOKEN_REQUIRED', 'Save GitHub settings and a token first.');
    const preview = await previewGitHub({
      snapshot: await s.replica.snapshot(),
      readBlob: (h) => s.replica.blob(h),
      ...config,
      token,
    });
    if (this.session !== s)
      throw new CairnError('STALE_SESSION', 'The project changed while previewing.');
    this.preview = preview;
    return structuredClone(preview);
  }
  async publishGitHub(
    input: Parameters<ReleaseApi['publishGitHub']>[0],
  ): Promise<{ url: string; branch: string }> {
    const s = this.exportable(),
      preview = this.preview;
    if (
      !preview ||
      preview.previewId !== input.previewId ||
      preview.projectId !== s.record.projectId
    )
      throw new CairnError('GITHUB_PREVIEW_INVALID', 'Review a fresh export preview.');
    const token = this.profile.token(s.record.projectId);
    if (!token) throw new CairnError('GITHUB_TOKEN_REQUIRED', 'Save a GitHub token first.');
    this.preview = null;
    return publishGitHub({
      preview,
      selectedPaths: input.selectedPaths,
      readBlob: (h) => s.replica.blob(h),
      token,
      title: input.title,
      body: input.body,
    });
  }
  async exportSnapshot(): Promise<{ path: string; files: number; bytes: number } | null> {
    const s = this.exportable(),
      snapshot = await s.replica.snapshot();
    const outputPath = await this.services.saveArchive(
      `${s.record.name}-${new Date().toISOString().slice(0, 10)}.zip`,
    );
    if (!outputPath) return null;
    if (this.session !== s)
      throw new CairnError('STALE_SESSION', 'The project changed before export.');
    return exportSnapshot({ snapshot, readBlob: (h) => s.replica.blob(h), outputPath });
  }
  async openFolder(input?: { relativePath?: string }): Promise<void> {
    const s = this.real();
    const target = input?.relativePath
      ? (s.authority ?? s.replica.store).policy.resolve(input.relativePath)
      : s.record.path;
    await this.services.openPath(target);
  }
  copyText(text: string): void {
    this.services.copy(text);
  }
  copyDiagnostics(): void {
    const s = this.state();
    this.services.copy(
      JSON.stringify(
        {
          version: s.version,
          runtime: s.runtime,
          time: new Date().toISOString(),
          connection: s.replica?.connection,
          revision: s.replica?.revision,
          pending: s.replica?.pending,
          rejected: s.replica?.rejected,
          projections: s.replica?.projections.map((p) => ({ state: p.state, fileId: p.fileId })),
          errorCode: s.error?.code,
          simulation: s.simulation,
        },
        null,
        2,
      ),
    );
  }
  legal(): Promise<{ licenses: string; privacy: string }> {
    return this.services.legal();
  }
  async startSimulation(): Promise<ReleaseState> {
    return this.action('simulation', async () => {
      ++this.epoch;
      await this.closeSession();
      this.simulation?.close();
      this.simulation = new Simulation({ name: this.profile.settings.preferences.displayName });
      this.simulation.on('state', () => this.publish());
      this.publish();
      return this.state();
    });
  }
  async stopSimulation(): Promise<ReleaseState> {
    this.simulation?.close();
    this.simulation = null;
    this.error = null;
    this.publish();
    return this.state();
  }
  async restore(): Promise<void> {
    try {
      await this.profile.loadSecrets();
    } catch (error) {
      this.report(error);
    }
    const id = this.profile.settings.activeProject;
    if (id)
      try {
        await this.switchProject(id);
      } catch (error) {
        this.report(error);
      }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.publication) clearImmediate(this.publication);
    this.publication = null;
    ++this.epoch;
    this.simulation?.close();
    this.simulation = null;
    await this.closeSession();
    this.discovery.close();
    await this.profile.finish();
    this.removeAllListeners();
  }
}
