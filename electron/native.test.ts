import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

describe('better-sqlite3 Node ABI', () => {
  it('opens and queries an in-memory database', () => {
    const database = new Database(':memory:')
    const result = database.prepare('SELECT 1 AS value').get() as {
      value: number
    }

    expect(result.value).toBe(1)
    database.close()
  })
})
