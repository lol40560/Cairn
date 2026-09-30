export function formatLineCount(count: number): string {
  if (count < 1_000) return String(count)
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`
  return `${Math.round(count / 1_000)}k`
}
