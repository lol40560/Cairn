import { EventEmitter } from 'node:events'
import { isIP } from 'node:net'

import Bonjour from 'bonjour-service'

import type { PeerInfo } from './protocol'

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

  publish(options: { roomCode: string; peerId: string; port: number }): void {
    this.stopPublish()
    this.publishedService = this.bonjour.publish({
      name: `cairn-${options.roomCode}-${options.peerId}`,
      port: options.port,
      protocol: 'tcp',
      type: 'cairn',
      txt: {
        peerId: options.peerId,
        roomCode: options.roomCode,
        version: '1',
      },
    })
  }

  stopPublish(): void {
    this.publishedService?.stop()
    this.publishedService = undefined
  }

  startBrowse(roomCode: string, peerId = ''): void {
    this.stopBrowse()
    const browser = this.bonjour.find({ protocol: 'tcp', type: 'cairn' }) as BonjourBrowser
    this.browser = browser

    browser.on('up', (service: BonjourService) => {
      const info = this.toPeerInfo(service, roomCode, peerId)
      if (info !== undefined) {
        this.emit('peer', info)
      }
    })
    browser.on('down', (service: BonjourService) => {
      const remotePeerId = service.txt?.peerId
      if (service.txt?.roomCode === roomCode && remotePeerId && remotePeerId !== peerId) {
        this.emit('peerLeft', remotePeerId)
      }
    })
  }

  stopBrowse(): void {
    this.browser?.stop()
    this.browser = undefined
  }

  destroy(): void {
    this.stopPublish()
    this.stopBrowse()
    this.bonjour.destroy()
  }

  private toPeerInfo(
    service: BonjourService,
    roomCode: string,
    ownPeerId: string,
  ): PeerInfo | undefined {
    const peerId = service.txt?.peerId
    if (service.txt?.roomCode !== roomCode || !peerId || peerId === ownPeerId) {
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
