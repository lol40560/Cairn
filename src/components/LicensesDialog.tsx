import { useMemo, useState } from 'react'

import licenseData from '../../build/licenses.json'
import { useTranslation } from '@/i18n'
import { filterLicenses, type LicenseEntry } from '@/lib/licenses'
import { shouldCloseDialogFromBackdrop, shouldCloseDialogFromKey } from '@/lib/settingsDialog'

interface LicenseInfo {
  licenses?: string | string[]
  licenseText?: string
  repository?: string | { url?: string }
}

type LicenseMap = Record<string, LicenseInfo>

function licenseLabel(licenses: LicenseInfo['licenses']): string {
  return Array.isArray(licenses) ? licenses.join(', ') : (licenses ?? 'Unknown')
}

function repositoryLabel(repository: LicenseInfo['repository']): string | undefined {
  return typeof repository === 'string' ? repository : repository?.url
}

const allLicenses: LicenseEntry[] = Object.entries(licenseData as LicenseMap)
  .map(([name, info]) => ({
    license: licenseLabel(info.licenses),
    licenseText: info.licenseText,
    name,
    repository: repositoryLabel(info.repository),
  }))
  .sort((left, right) => left.name.localeCompare(right.name))

export function LicensesDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [expandedName, setExpandedName] = useState<string | undefined>()
  const visibleLicenses = useMemo(() => filterLicenses(allLicenses, query), [query])

  const openRepository = async (repository: string): Promise<void> => {
    const result = await window.cairn.openExternal(repository)
    if (!result.ok) {
      console.error('[cairn] 无法打开依赖仓库', result.error)
    }
  }

  if (!open) return null

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (shouldCloseDialogFromBackdrop(event.target, event.currentTarget)) onClose()
      }}
      onKeyDown={(event) => {
        if (shouldCloseDialogFromKey(event.key)) onClose()
      }}
    >
      <section className="modal licenses-modal" aria-labelledby="licenses-dialog-title">
        <header className="modal-header">
          <h2 id="licenses-dialog-title" className="modal-title">{t('licensesTitle')}</h2>
          <button aria-label={t('close')} className="btn btn-ghost modal-close" type="button" onClick={onClose}>×</button>
        </header>
        <div className="modal-body licenses-body">
          <input
            autoFocus
            aria-label={t('licensesSearch')}
            className="input"
            placeholder={t('licensesSearch')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {allLicenses.length === 0 ? (
            <p className="licenses-empty">{t('licensesUnavailable')}</p>
          ) : visibleLicenses.length === 0 ? (
            <p className="licenses-empty">{t('licensesNoResults')}</p>
          ) : (
            <div className="licenses-list">
              {visibleLicenses.map((entry) => {
                const expanded = expandedName === entry.name
                return (
                  <div className="license-entry" key={entry.name}>
                    <button
                      aria-expanded={expanded}
                      className="license-row"
                      type="button"
                      onClick={() => setExpandedName(expanded ? undefined : entry.name)}
                    >
                      <span className="license-name">{entry.name}</span>
                      <span className="license-type">{entry.license}</span>
                    </button>
                    {expanded && (
                      <div className="license-details">
                        {entry.repository && (
                          <button
                            className="license-repository"
                            type="button"
                            onClick={() => void openRepository(entry.repository!)}
                          >
                            {entry.repository}
                          </button>
                        )}
                        {entry.licenseText && <pre>{entry.licenseText}</pre>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <footer className="modal-actions">
            <button className="btn btn-ghost" type="button" onClick={onClose}>{t('close')}</button>
          </footer>
        </div>
      </section>
    </div>
  )
}
