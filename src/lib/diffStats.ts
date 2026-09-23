export function countDiff(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0

  for (const line of diff.split('\n')) {
    if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('@@')
    ) {
      continue
    }

    if (line.startsWith('+')) {
      added += 1
    } else if (line.startsWith('-')) {
      removed += 1
    }
  }

  return { added, removed }
}
