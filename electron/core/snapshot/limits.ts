/** 快照传输与解压共享的硬性资源上限。 */
export const MAX_SNAPSHOT_COMPRESSED_BYTES = 50 * 1024 * 1024
export const MAX_SNAPSHOT_UNCOMPRESSED_BYTES = 250 * 1024 * 1024
export const MAX_SNAPSHOT_ENTRY_BYTES = 64 * 1024 * 1024
export const MAX_SNAPSHOT_ENTRIES = 10_000

export interface SnapshotExtractionLimits {
  maxEntries: number
  maxEntryBytes: number
  maxTotalUncompressedBytes: number
}

export type SnapshotExtractionLimitOverrides = Partial<SnapshotExtractionLimits>

export const DEFAULT_SNAPSHOT_EXTRACTION_LIMITS: SnapshotExtractionLimits = {
  maxEntries: MAX_SNAPSHOT_ENTRIES,
  maxEntryBytes: MAX_SNAPSHOT_ENTRY_BYTES,
  maxTotalUncompressedBytes: MAX_SNAPSHOT_UNCOMPRESSED_BYTES,
}

export function resolveSnapshotExtractionLimits(
  overrides: SnapshotExtractionLimitOverrides | undefined,
): SnapshotExtractionLimits {
  const limits = { ...DEFAULT_SNAPSHOT_EXTRACTION_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`无效的快照解压上限 ${name}：${value}`)
    }
  }
  return limits
}
