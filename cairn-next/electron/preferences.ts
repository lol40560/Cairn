import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CairnError } from '../core/common.js';
import type { GitHubSettings, Preferences, RecentProject } from '../shared/release-api.js';
import type { TeamInvite } from '../shared/project.js';

export interface StoredSettings {
  version: 1;
  ownerId: string;
  preferences: Preferences;
  projects: RecentProject[];
  activeProject: string | null;
  selected: Record<string, string>;
  teams: Record<string, { enabled: boolean; port: number }>;
  github: Record<string, Omit<GitHubSettings, 'hasToken'>>;
}
export interface SecretCodec {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Uint8Array>;
  decrypt(value: Uint8Array): Promise<string>;
}
interface Secrets {
  invitations: Record<string, TeamInvite>;
  tokens: Record<string, string>;
}
/** Profile preferences never contain invitation grants or GitHub credentials. */
export class ProfileStore {
  readonly settings: StoredSettings;
  private secrets: Secrets = { invitations: {}, tokens: {} };
  private writes: Promise<void> = Promise.resolve();
  private loaded = false;
  private loading: Promise<void> | null = null;
  constructor(
    readonly directory: string,
    private readonly codec: SecretCodec,
  ) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let stored: Partial<StoredSettings> = {};
    const file = path.join(directory, 'profile.json');
    if (fs.existsSync(file)) {
      try {
        if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error();
        stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new CairnError(
          'PROFILE_INVALID',
          'The saved profile cannot be read. Keep it for recovery and use a separate profile.',
        );
      }
    }
    this.settings = {
      version: 1,
      ownerId: typeof stored.ownerId === 'string' ? stored.ownerId : randomUUID(),
      preferences: {
        locale: 'ko',
        displayName: 'Me',
        onboardingDone: false,
        source: { kind: 'unknown' },
        ...stored.preferences,
      },
      projects: Array.isArray(stored.projects) ? stored.projects : [],
      activeProject: stored.activeProject ?? null,
      selected: stored.selected ?? {},
      teams: stored.teams ?? {},
      github: stored.github ?? {},
    };
  }
  async loadSecrets(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    const loading = this.unlockSecrets();
    this.loading = loading;
    try {
      await loading;
    } finally {
      if (this.loading === loading) this.loading = null;
    }
  }
  private async unlockSecrets(): Promise<void> {
    const file = path.join(this.directory, 'secrets.encrypted');
    if (!fs.existsSync(file)) {
      this.loaded = true;
      return;
    }
    if (!(await this.codec.available()))
      throw new CairnError(
        'SECURE_STORAGE_UNAVAILABLE',
        'The OS credential store is unavailable. Enter the invitation or token again; project work remains on disk.',
      );
    try {
      const bytes = fs.readFileSync(file);
      if (bytes.length > 4 * 1024 * 1024) throw new Error();
      const value = JSON.parse(await this.codec.decrypt(bytes));
      if (!value || !value.invitations || !value.tokens) throw new Error();
      this.secrets = value;
      this.loaded = true;
    } catch {
      throw new CairnError(
        'SECURE_STORAGE_UNAVAILABLE',
        'Saved credentials could not be unlocked. The encrypted original has been preserved.',
      );
    }
  }
  save(): void {
    this.atomic('profile.json', Buffer.from(JSON.stringify(this.settings, null, 2)));
  }
  invitation(id: string): TeamInvite | undefined {
    return this.secrets.invitations[id];
  }
  token(id: string): string | undefined {
    return this.secrets.tokens[id];
  }
  async setInvitation(id: string, invite: TeamInvite): Promise<void> {
    await this.loadSecrets();
    this.secrets.invitations[id] = { ...invite };
    await this.saveSecrets();
  }
  async setToken(id: string, token: string | undefined): Promise<void> {
    await this.loadSecrets();
    if (token) this.secrets.tokens[id] = token;
    else delete this.secrets.tokens[id];
    await this.saveSecrets();
  }
  private saveSecrets(): Promise<void> {
    const plaintext = JSON.stringify(this.secrets);
    const write = async () => {
      if (!(await this.codec.available()))
        throw new CairnError(
          'SECURE_STORAGE_UNAVAILABLE',
          'Credentials were kept for this app session only because the OS secure store is unavailable.',
        );
      const encrypted = await this.codec.encrypt(plaintext);
      this.atomic('secrets.encrypted', encrypted);
    };
    const result = this.writes.then(write, write);
    this.writes = result.catch(() => {});
    return result;
  }
  async finish(): Promise<void> {
    await this.writes;
  }
  private atomic(name: string, bytes: Uint8Array): void {
    const destination = path.join(this.directory, name),
      temporary = path.join(this.directory, `${name}.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(temporary, destination);
  }
}
