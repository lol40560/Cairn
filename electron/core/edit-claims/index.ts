import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { ensureCairnDataDir } from '../data-dir'

export type EditClaimStatus = 'active' | 'completed' | 'cancelled' | 'expired'

export interface ClaimOwner {
  id: string
  name: string
  kind: 'human' | 'agent'
}

export interface EditClaim {
  id: string
  path: string
  owner: ClaimOwner
  summary: string
  status: EditClaimStatus
  baseHash: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  releasedAt?: number
}

export interface CollaborationMessage {
  id: string
  claimId?: string
  type: 'claim-created' | 'claim-completed' | 'claim-cancelled' | 'claim-expired' | 'conflict'
  body: string
  createdAt: number
}

export interface CreateEditClaimInput {
  path: string
  owner: ClaimOwner
  summary: string
  baseContent: string
}

interface StoredClaims {
  claims: EditClaim[]
  messages: CollaborationMessage[]
  projectOwnerId?: string
}

const LEASE_MS = 10 * 60 * 1000
const MAX_MESSAGES = 200

/**
 * Local-first, advisory edit claims. The file is intentionally stored inside
 * .cairn so it travels with a shared project, while expiry prevents stale
 * claims from blocking work forever.
 */
export class EditClaimsManager extends EventEmitter {
  private readonly storagePath: string

  constructor(projectRoot: string) {
    super()
    this.storagePath = join(ensureCairnDataDir(projectRoot), 'edit-claims.json')
  }

  async list(): Promise<EditClaim[]> {
    const data = await this.expireStale(await this.read())
    return data.claims.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async listMessages(): Promise<CollaborationMessage[]> {
    const data = await this.expireStale(await this.read())
    return data.messages.sort((left, right) => right.createdAt - left.createdAt)
  }

  async create(input: CreateEditClaimInput): Promise<EditClaim> {
    validateCreateInput(input)
    const data = await this.expireStale(await this.read())
    const existing = data.claims.find((claim) => claim.status === 'active' && claim.path === input.path && claim.owner.id === input.owner.id)
    if (existing) {
      existing.summary = input.summary.trim()
      existing.baseHash = contentHash(input.baseContent)
      existing.updatedAt = Date.now()
      existing.expiresAt = existing.updatedAt + LEASE_MS
      await this.write(data)
      this.emit('changed', existing, true)
      return existing
    }

    const now = Date.now()
    const claim: EditClaim = {
      id: randomUUID(),
      path: input.path,
      owner: input.owner,
      summary: input.summary.trim(),
      status: 'active',
      baseHash: contentHash(input.baseContent),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + LEASE_MS,
    }
    data.projectOwnerId ??= input.owner.id
    data.claims.push(claim)
    this.addMessage(data, {
      claimId: claim.id,
      type: 'claim-created',
      body: `${claim.owner.name} is editing ${claim.path}: ${claim.summary}`,
    })
    await this.write(data)
    this.emit('changed', claim, true)
    return claim
  }

  async heartbeat(id: string, actorId: string): Promise<EditClaim> {
    const data = await this.expireStale(await this.read())
    const claim = this.requireOwnedActiveClaim(data, id, actorId)
    claim.updatedAt = Date.now()
    claim.expiresAt = claim.updatedAt + LEASE_MS
    await this.write(data)
    this.emit('changed', claim, true)
    return claim
  }

  async complete(id: string, actorId: string): Promise<void> {
    await this.release(id, actorId, 'completed')
  }

  async cancel(id: string, actorId: string): Promise<void> {
    await this.release(id, actorId, 'cancelled')
  }

  async assertWritable(path: string, actorId: string, strict: boolean): Promise<void> {
    const data = await this.expireStale(await this.read())
    const conflicting = data.claims.find((claim) => claim.status === 'active' && claim.path === path && claim.owner.id !== actorId)
    if (!conflicting) return
    this.addMessage(data, {
      claimId: conflicting.id,
      type: 'conflict',
      body: `${actorId} needs ${path}, but ${conflicting.owner.name} is editing it.`,
    })
    await this.write(data)
    this.emit('changed', conflicting, true)
    if (strict) {
      throw new Error(`${conflicting.owner.name} currently holds an edit claim for ${path}`)
    }
  }

  /** Stores a claim received from an authenticated room peer without echoing it back. */
  async receiveRemote(claim: EditClaim): Promise<void> {
    if (!isEditClaim(claim)) throw new Error('Invalid remote edit claim')
    const data = await this.expireStale(await this.read())
    const index = data.claims.findIndex((item) => item.id === claim.id)
    if (index >= 0 && data.claims[index].updatedAt >= claim.updatedAt) return
    if (index >= 0) data.claims[index] = claim
    else data.claims.push(claim)
    const action = claim.status === 'active' ? 'is editing' : claim.status === 'completed' ? 'finished editing' : 'released editing rights for'
    this.addMessage(data, {
      claimId: claim.id,
      type: claim.status === 'active' ? 'claim-created' : 'claim-completed',
      body: `${claim.owner.name} ${action} ${claim.path}.`,
    })
    await this.write(data)
    this.emit('changed', claim, false)
  }

  private async release(id: string, actorId: string, status: 'completed' | 'cancelled'): Promise<void> {
    const data = await this.expireStale(await this.read())
    const claim = data.claims.find((item) => item.id === id)
    if (!claim) throw new Error('Edit claim not found')
    if (claim.owner.id !== actorId && data.projectOwnerId !== actorId) {
      throw new Error('Only the claim holder or project owner can release this claim')
    }
    if (claim.status !== 'active') return
    const now = Date.now()
    claim.status = status
    claim.updatedAt = now
    claim.releasedAt = now
    this.addMessage(data, {
      claimId: claim.id,
      type: status === 'completed' ? 'claim-completed' : 'claim-cancelled',
      body: `${claim.owner.name} ${status === 'completed' ? 'finished editing' : 'cancelled work on'} ${claim.path}.`,
    })
    await this.write(data)
    this.emit('changed', claim, true)
  }

  private requireOwnedActiveClaim(data: StoredClaims, id: string, actorId: string): EditClaim {
    const claim = data.claims.find((item) => item.id === id && item.status === 'active')
    if (!claim) throw new Error('Active edit claim not found')
    if (claim.owner.id !== actorId) throw new Error('Only the claim holder can renew this claim')
    return claim
  }

  private async expireStale(data: StoredClaims): Promise<StoredClaims> {
    const now = Date.now()
    const expired = data.claims.filter((claim) => claim.status === 'active' && claim.expiresAt <= now)
    if (expired.length === 0) return data
    for (const claim of expired) {
      claim.status = 'expired'
      claim.updatedAt = now
      claim.releasedAt = now
      this.addMessage(data, { claimId: claim.id, type: 'claim-expired', body: `Edit claim expired for ${claim.path}.` })
    }
    await this.write(data)
    for (const claim of expired) this.emit('changed', claim, true)
    return data
  }

  private addMessage(data: StoredClaims, message: Omit<CollaborationMessage, 'id' | 'createdAt'>): void {
    data.messages.push({ ...message, id: randomUUID(), createdAt: Date.now() })
    if (data.messages.length > MAX_MESSAGES) data.messages.splice(0, data.messages.length - MAX_MESSAGES)
  }

  private async read(): Promise<StoredClaims> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.storagePath, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return { claims: [], messages: [] }
      const value = parsed as Partial<StoredClaims>
      return {
        claims: Array.isArray(value.claims) ? value.claims.filter(isEditClaim) : [],
        messages: Array.isArray(value.messages) ? value.messages.filter(isMessage) : [],
        projectOwnerId: typeof value.projectOwnerId === 'string' ? value.projectOwnerId : undefined,
      }
    } catch {
      return { claims: [], messages: [] }
    }
  }

  private async write(data: StoredClaims): Promise<void> {
    await mkdir(dirname(this.storagePath), { recursive: true })
    const temporaryPath = `${this.storagePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf8')
    await rename(temporaryPath, this.storagePath)
  }
}

function contentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function validateCreateInput(input: CreateEditClaimInput): void {
  if (!input || typeof input.path !== 'string' || !input.path || input.path.length > 1_024) throw new Error('Invalid claim path')
  if (!input.owner || typeof input.owner.id !== 'string' || !input.owner.id || typeof input.owner.name !== 'string' || !input.owner.name) throw new Error('Invalid claim owner')
  if (input.owner.kind !== 'human' && input.owner.kind !== 'agent') throw new Error('Invalid claim owner type')
  if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 500) throw new Error('A claim summary is required')
  if (typeof input.baseContent !== 'string') throw new Error('Invalid claim base content')
}

function isEditClaim(value: unknown): value is EditClaim {
  if (!value || typeof value !== 'object') return false
  const claim = value as Partial<EditClaim>
  return typeof claim.id === 'string' && typeof claim.path === 'string' && typeof claim.summary === 'string'
    && typeof claim.baseHash === 'string' && typeof claim.createdAt === 'number' && typeof claim.updatedAt === 'number'
    && typeof claim.expiresAt === 'number' && ['active', 'completed', 'cancelled', 'expired'].includes(String(claim.status))
    && Boolean(claim.owner) && typeof claim.owner?.id === 'string' && typeof claim.owner.name === 'string'
    && (claim.owner.kind === 'human' || claim.owner.kind === 'agent')
}

function isMessage(value: unknown): value is CollaborationMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<CollaborationMessage>
  return typeof message.id === 'string' && typeof message.body === 'string' && typeof message.createdAt === 'number'
    && ['claim-created', 'claim-completed', 'claim-cancelled', 'claim-expired', 'conflict'].includes(String(message.type))
}
