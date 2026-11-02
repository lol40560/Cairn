import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import Bonjour from 'bonjour-service';
import type { DiscoveredTeam, TeamStatus } from '../../shared/project.js';
import { CairnError } from '../common.js';

const SERVICE_TYPE = 'cairn-team';
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const fingerprintPattern = /^[a-f0-9]{64}$/;

/** Discovery advertises public hints only. Invitations and TLS pins remain authoritative. */
export class TeamDiscovery extends EventEmitter {
  private bonjour?: Bonjour;
  private browser?: Bonjour.Browser;
  private service?: Bonjour.Service;
  private teams = new Map<string, DiscoveredTeam>();
  private closed = false;
  private started = false;
  private refresh?: NodeJS.Timeout;
  private advertisement = '';
  constructor() {
    super();
    this.on('error', () => {});
  }
  private runtime(): Bonjour | undefined {
    if (this.closed) return;
    if (!this.bonjour) {
      try {
        this.bonjour = new Bonjour(undefined, () => this.unavailable());
      } catch {
        this.unavailable();
      }
    }
    return this.bonjour;
  }
  private unavailable(): void {
    if (!this.closed)
      this.emit('error', {
        code: 'DISCOVERY_UNAVAILABLE',
        message: 'Nearby team discovery is unavailable. You can still connect with an invitation.',
      });
  }
  start(): void {
    if (this.started || this.closed) return;
    const runtime = this.runtime();
    if (!runtime) return;
    try {
      this.browser = runtime.find({ type: SERVICE_TYPE, protocol: 'tcp' });
      this.browser.on('up', (service) => this.accept(service));
      this.browser.on('txt-update', (service) => this.accept(service));
      this.browser.on('srv-update', (service) => this.accept(service));
      this.browser.on('down', (service) => {
        const teamId = String(service.txt?.teamId ?? '');
        if (this.teams.delete(teamId)) this.emit('update', this.list());
      });
      this.started = true;
      this.refresh = setInterval(() => {
        if (this.closed) return;
        try {
          this.browser?.update();
          this.browser?.expire();
          for (const service of this.browser?.services ?? []) this.accept(service, false);
        } catch {
          this.unavailable();
        }
      }, 15000);
      this.refresh.unref();
    } catch {
      this.unavailable();
    }
  }
  private accept(service: Bonjour.Service, notify = true): void {
    if (this.closed) return;
    const txt = service.txt as Record<string, unknown> | undefined;
    if (!txt || String(txt.version) !== '2') return;
    const teamId = String(txt.teamId ?? ''),
      projectId = String(txt.projectId ?? ''),
      fingerprint = String(txt.fingerprint ?? '').toLowerCase(),
      name = String(txt.name ?? '');
    if (
      !identifier.test(teamId) ||
      !identifier.test(projectId) ||
      !fingerprintPattern.test(fingerprint) ||
      !name.trim() ||
      name.length > 80 ||
      /[\x00-\x1f\x7f]/.test(name) ||
      !Number.isInteger(service.port) ||
      service.port < 1 ||
      service.port > 65535
    )
      return;
    const addresses = [
      ...new Set(
        (service.addresses ?? [])
          .filter((ip) => isIP(ip) !== 0 && !['0.0.0.0', '::'].includes(ip))
          .map((ip) => `wss://${isIP(ip) === 6 ? `[${ip}]` : ip}:${service.port}/team`),
      ),
    ];
    if (!addresses.length) return;
    const value: DiscoveredTeam = {
      teamId,
      projectId,
      name,
      addresses,
      port: service.port,
      fingerprint,
      seenAt: Date.now(),
    };
    const previous = this.teams.get(teamId);
    this.teams.set(teamId, value);
    if (
      notify &&
      (!previous ||
        previous.name !== name ||
        previous.fingerprint !== fingerprint ||
        previous.addresses.join(',') !== addresses.join(','))
    )
      this.emit('update', this.list());
  }
  list(): DiscoveredTeam[] {
    return [...this.teams.values()]
      .map((team) => ({ ...team, addresses: [...team.addresses] }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId));
  }
  advertise(status: TeamStatus, fingerprint: string): void {
    if (this.closed) return;
    if (!status.enabled) {
      this.stopAdvertising();
      return;
    }
    if (
      !identifier.test(status.teamId) ||
      !identifier.test(status.projectId) ||
      !fingerprintPattern.test(fingerprint) ||
      !Number.isInteger(status.port) ||
      status.port < 1 ||
      status.port > 65535 ||
      !status.name.trim() ||
      status.name.length > 80 ||
      /[\x00-\x1f\x7f]/.test(status.name)
    )
      throw new CairnError('INVALID_DISCOVERY', 'The public team announcement is invalid.');
    // Explicit allowlist: never serialize status.peers, an invitation, a token, or project files.
    const txt = {
      version: '2',
      teamId: status.teamId,
      projectId: status.projectId,
      name: status.name,
      fingerprint,
    };
    const signature = JSON.stringify({ port: status.port, txt });
    if (signature === this.advertisement) return;
    this.stopAdvertising();
    const runtime = this.runtime();
    if (!runtime) return;
    try {
      this.service = runtime.publish({
        name: `Cairn-${status.teamId}`,
        type: SERVICE_TYPE,
        protocol: 'tcp',
        port: status.port,
        txt,
        disableIPv6: true,
      });
      this.service.on('error', () => this.unavailable());
      this.advertisement = signature;
    } catch {
      this.unavailable();
    }
  }
  stopAdvertising(): void {
    if (this.service) {
      try {
        this.service.stop();
      } catch {
        this.unavailable();
      }
      this.service = undefined;
    }
    this.advertisement = '';
  }
  close(): void {
    if (this.closed) return;
    this.stopAdvertising();
    this.closed = true;
    if (this.refresh) clearInterval(this.refresh);
    this.refresh = undefined;
    try {
      this.browser?.stop();
    } catch {}
    try {
      this.bonjour?.destroy();
    } catch {}
    this.browser = undefined;
    this.bonjour = undefined;
    this.started = false;
    this.teams.clear();
  }
}
