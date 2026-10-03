import { EventEmitter } from 'node:events'

export type PeerStatus = 'connected' | 'reconnecting' | 'offline'

export interface PeerState {
  peerId: string
  status: PeerStatus
  host?: string
  port?: number
  attempt: number
  nextRetryAt?: number
}

export interface ReconnectOptions {
  connect(peerId: string, host: string, port: number): Promise<void>
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

/** 以有限次指數退避維護已知端點的 TCP 重連。 */
export class ReconnectManager extends EventEmitter {
  private readonly peers = new Map<string, PeerState>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly options: ReconnectOptions) {
    super()
  }

  markConnected(peerId: string, host?: string, port?: number): void {
    const previous = this.peers.get(peerId)
    this.clearTimer(peerId)
    const state: PeerState = {
      attempt: 0,
      host: host ?? previous?.host,
      peerId,
      port: port ?? previous?.port,
      status: 'connected',
    }
    this.peers.set(peerId, state)
    this.emitStatus(state)
  }

  markDisconnected(peerId: string, host?: string, port?: number): void {
    const previous = this.peers.get(peerId)
    if (previous?.status === 'reconnecting') return

    const endpoint = {
      host: host ?? previous?.host,
      port: port ?? previous?.port,
    }
    if (!this.hasEndpoint(endpoint.host, endpoint.port)) {
      this.setOffline(peerId, endpoint.host, endpoint.port, previous?.attempt ?? 0)
      return
    }
    this.schedule(peerId, endpoint.host, endpoint.port!, (previous?.attempt ?? 0) + 1)
  }

  retryNow(peerId: string): void {
    const state = this.peers.get(peerId)
    if (!state || !this.hasEndpoint(state.host, state.port)) return
    this.clearTimer(peerId)
    this.schedule(peerId, state.host, state.port!, 1, 0)
  }

  list(): PeerState[] {
    return [...this.peers.values()].sort((left, right) => left.peerId.localeCompare(right.peerId))
  }

  get(peerId: string): PeerState | undefined {
    const state = this.peers.get(peerId)
    return state ? { ...state } : undefined
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.peers.clear()
  }

  private schedule(peerId: string, host: string, port: number, attempt: number, delay = this.delayFor(attempt)): void {
    if (attempt > this.options.maxAttempts) {
      this.setOffline(peerId, host, port, attempt - 1)
      return
    }

    const nextRetryAt = Date.now() + delay
    const state: PeerState = { attempt, host, nextRetryAt, peerId, port, status: 'reconnecting' }
    this.peers.set(peerId, state)
    this.emitStatus(state)
    this.clearTimer(peerId)
    const timer = setTimeout(() => {
      this.timers.delete(peerId)
      void this.tryConnect(peerId, host, port, attempt)
    }, delay)
    this.timers.set(peerId, timer)
  }

  private async tryConnect(peerId: string, host: string, port: number, attempt: number): Promise<void> {
    try {
      await this.options.connect(peerId, host, port)
      this.markConnected(peerId, host, port)
    } catch {
      this.schedule(peerId, host, port, attempt + 1)
    }
  }

  private setOffline(peerId: string, host: string | undefined, port: number | undefined, attempt: number): void {
    this.clearTimer(peerId)
    const state: PeerState = { attempt, host, peerId, port, status: 'offline' }
    this.peers.set(peerId, state)
    this.emitStatus(state)
  }

  private delayFor(attempt: number): number {
    const initialDelays = [
      this.options.baseDelayMs,
      this.options.baseDelayMs * 2,
      this.options.baseDelayMs * 4,
      this.options.baseDelayMs * 8,
      Math.min(this.options.baseDelayMs * 15, this.options.maxDelayMs),
    ]
    return initialDelays[attempt - 1] ?? this.options.maxDelayMs
  }

  private clearTimer(peerId: string): void {
    const timer = this.timers.get(peerId)
    if (timer) clearTimeout(timer)
    this.timers.delete(peerId)
  }

  private hasEndpoint(host: string | undefined, port: number | undefined): host is string {
    return typeof host === 'string' && host.length > 0 && typeof port === 'number' && Number.isInteger(port) && port > 0
  }

  private emitStatus(state: PeerState): void {
    this.emit('peerStatusChanged', { ...state })
  }
}
