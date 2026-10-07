export interface LicenseEntry {
  attribution?: string
  license: string
  licenseText: string
  name: string
  repository?: string
  version: string
}

/** 按包名筛选许可证条目，供搜索框与测试共享。 */
export function filterLicenses(entries: LicenseEntry[], query: string): LicenseEntry[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return entries
  return entries.filter((entry) => entry.name.toLowerCase().includes(normalizedQuery))
}
