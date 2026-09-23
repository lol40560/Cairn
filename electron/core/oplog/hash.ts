import { createHash } from 'node:crypto'

import type { NewOp } from './types'

export function computeHash(input: NewOp): string {
  const serialized = JSON.stringify([
    input.id,
    input.author,
    [...input.parentHashes].sort(),
    input.timestamp,
    input.filePath,
    input.diff,
  ])

  return createHash('sha256').update(serialized).digest('hex')
}
