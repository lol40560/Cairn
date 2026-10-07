import { EventEmitter } from 'node:events'
import { isIP } from 'node:net'

import Bonjour from 'bonjour-service'

import { deriveRoomHash, SYNC_PROTOCOL_VERSION, type PeerInfo } from './protocol'

interface BonjourService {
  addresses?: string[]
  host: string
  port: number
  txt?: Record<string, string>
}

interface BonjourBrowser extends EventEmitter {
  stop(): void
}

interface PublishedService {
  stop: CallableFunction
}

/** mDNS 发现模块的只读诊断状态。 */
export interface DiscoveryStatus {
  published: boolean
  browsing: boolean
  publishedName: string | undefined
  error: string | undefined
}

// 主进程一次只维护一个活动房间；保留最近状态仅用于诊断 IPC，不参与发现逻辑。
let currentDiscoveryStatus: DiscoveryStatus = {
  published: false,
  browsing: false,
  publishedName: undefined,
  error: undefined,
}

/** 读取当前活动 Discovery 的诊断状态。 */
export function getCurrentDiscoveryStatus(): DiscoveryStatus {
  return currentDiscoveryStatus
}

export function selectPeerHost(addresses: string[] | undefined, fallback: string): string {
  return (
    addresses?.find((address) => isIP(address) === 4) ??
    addresses?.find((address) => !address.toLowerCase().startsWith('fe80:')) ??
    fallback
  )
}

export class Discovery extends EventEmitter {
  private readonly bonjour = new Bonjour()
  private browser: BonjourBrowser | undefined
  private publishedService: PublishedService | undefined
  private publishedName: string | undefined
  private lastError: string | undefined

  publish(options: { roomCode: string; peerId: string; port: number }): void {
    this.stopPublish()
    const roomHash = deriveRoomHash(options.roomCode)
    const publishedName = `cairn-${roomHash}-${options.peerId}`
    console.info('[cairn:discovery] mDNS publish requested', {
      peerId: options.peerId,
      port: options.port,
      roomHash,
    })

    try {
      const service = this.bonjour.publish({
        name: publishedName,
        port: options.port,
        protocol: 'tcp',
        type: 'cairn',
        txt: {
          peerId: options.peerId,
          roomHash,
          version: String(SYNC_PROTOCOL_VERSION),
        },
      })
      this.publishedService = service
      this.publishedName = publishedName
      this.lastError = undefined
      this.updateDiagnosticStatus()
      console.info('[cairn:discovery] mDNS publish created', {
        peerId: options.peerId,
        port: options.port,
        publishedName,
        roomHash,
        service,
      })
    } catch (error) {
      this.lastError = error instanceof Error ? (error.stack ?? error.message) : String(error)
      this.updateDiagnosticStatus()
      console.error('[cairn:discovery] mDNS publish failed', {
        error,
        peerId: options.peerId,
        port: options.port,
        roomHash,
      })
      throw error
    }
  }

  stopPublish(): void {
    this.publishedService?.stop()
    this.publishedService = undefined
    this.publishedName = undefined
    this.updateDiagnosticStatus()
  }

  startBrowse(roomCode: string, peerId = ''): void {
    this.stopBrowse()
    const roomHash = deriveRoomHash(roomCode)
    console.info('[cairn:discovery] mDNS browse requested', { peerId, roomHash })

    let browser: BonjourBrowser
    try {
      browser = this.bonjour.find({ protocol: 'tcp', type: 'cairn' }) as BonjourBrowser
      this.browser = browser
      this.lastError = undefined
      this.updateDiagnosticStatus()
      console.info('[cairn:discovery] mDNS browse started', { peerId, roomHash })
    } catch (error) {
      this.lastError = error instanceof Error ? (error.stack ?? error.message) : String(error)
      this.updateDiagnosticStatus()
      console.error('[cairn:discovery] mDNS browse failed', { error, peerId, roomHash })
      throw error
    }

    browser.on('error', (error: Error) => {
      this.lastError = error.stack ?? error.message
      this.updateDiagnosticStatus()
      console.error('[cairn:discovery] mDNS browse error', { error, peerId, roomHash })
    })

    browser.on('up', (service: BonjourService) => {
      const info = this.toPeerInfo(service, roomCode, peerId)
      if (info !== undefined) {
        this.emit('peer', info)
      }
    })
    browser.on('down', (service: BonjourService) => {
      const remotePeerId = service.txt?.peerId
      if (service.txt?.roomHash === roomHash && remotePeerId && remotePeerId !== peerId) {
        this.emit('peerLeft', remotePeerId)
      }
    })
  }

  stopBrowse(): void {
    this.browser?.stop()
    this.browser = undefined
    this.updateDiagnosticStatus()
  }

  destroy(): void {
    this.stopPublish()
    this.stopBrowse()
    this.bonjour.destroy()
  }

  getStatus(): DiscoveryStatus {
    return {
      published: this.publishedService !== undefined,
      browsing: this.browser !== undefined,
      publishedName: this.publishedName,
      error: this.lastError,
    }
  }

  private updateDiagnosticStatus(): void {
    currentDiscoveryStatus = this.getStatus()
  }

  private toPeerInfo(
    service: BonjourService,
    roomCode: string,
    ownPeerId: string,
  ): PeerInfo | undefined {
    const peerId = service.txt?.peerId
    if (
      service.txt?.roomHash !== deriveRoomHash(roomCode)
      || service.txt?.version !== String(SYNC_PROTOCOL_VERSION)
      || !peerId
      || peerId === ownPeerId
    ) {
      return undefined
    }

    const host = selectPeerHost(service.addresses, service.host)
    if (!host || !Number.isInteger(service.port) || service.port <= 0) {
      this.emit('error', new Error(`发现的 peer 信息不完整：${peerId}`))
      return undefined
    }

    return { host, lastSeen: Date.now(), peerId, port: service.port }
  }
}
