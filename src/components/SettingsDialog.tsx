import { useEffect, useState } from 'react'

import appPackage from '../../package.json'
import { useTranslation } from '@/i18n'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { PRIVACY_SUMMARY_EN, PRIVACY_SUMMARY_ZH } from '@/lib/legal-content'
import { LicensesDialog } from './LicensesDialog'
import { PrivacyDialog } from './PrivacyDialog'
import {
  updateGeneralSettings,
} from '@/lib/settingsDialog'
import type { IpcResult } from '@/types/cairn'

function getIpcData<T>(result: IpcResult<T>): T {
  if (!result.ok) {
    throw result.error
  }
  return result.data
}

/** 設定作為獨立工作區呈現，避免重要偏好被暫時性的彈窗遮住。 */
export function SettingsView({
  onConfigured,
  onShowOnboarding,
  onStartHackathonMode,
}: {
  onConfigured(value: boolean): void
  onShowOnboarding(): void
  onStartHackathonMode?(): void
}) {
  const { locale, t } = useTranslation()
  const [token, setToken] = useState('')
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [rememberLastFolder, setRememberLastFolder] = useState(true)
  const [autoStartWatching, setAutoStartWatching] = useState(true)
  const [trashRetentionDays, setTrashRetentionDays] = useState(30)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<NormalizedError | null>(null)
  const [licensesOpen, setLicensesOpen] = useState(false)
  const [privacyOpen, setPrivacyOpen] = useState(false)

  useEffect(() => {
    void Promise.all([window.cairn.getGithubConfig(), window.cairn.getSettings()])
      .then(([configResult, settingsResult]) => {
        const config = getIpcData(configResult)
        const settings = getIpcData(settingsResult)
        setToken('')
        setError(null)
        setOwner(config.owner)
        setRepo(config.repo)
        setHasToken(config.hasToken)
        setRememberLastFolder(settings.rememberLastFolder)
        setAutoStartWatching(settings.autoStartWatching)
        setTrashRetentionDays(settings.trashRetentionDays)
      })
      .catch((cause) => {
        console.error('[cairn] 无法读取设置', cause)
        setError(normalizeError(cause, t))
      })
  }, [t])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      getIpcData(await window.cairn.saveGithubConfig({ token: token || undefined, owner, repo }))
      setHasToken(true)
      onConfigured(true)
    } catch (cause) {
      console.error('[cairn] 无法保存 GitHub 配置', cause)
      setError(normalizeError(cause, t))
    } finally {
      setSaving(false)
    }
  }

  const changeRememberLastFolder = (value: boolean): void => {
    setRememberLastFolder(value)
    void updateGeneralSettings({ rememberLastFolder: value }).then((result) => {
      if (!result.ok) {
        console.error('[cairn] 无法更新通用设置', result.error)
        setError(normalizeError(result.error, t))
      }
    })
  }

  const changeAutoStartWatching = (value: boolean): void => {
    setAutoStartWatching(value)
    void updateGeneralSettings({ autoStartWatching: value }).then((result) => {
      if (!result.ok) {
        console.error('[cairn] 无法更新通用设置', result.error)
        setError(normalizeError(result.error, t))
      }
    })
  }

  const changeTrashRetentionDays = (value: number): void => {
    setTrashRetentionDays(value)
    if (!Number.isInteger(value) || value < 1 || value > 365) {
      setError(normalizeError(new Error('废纸篓保留天数必须是 1..365 的整数'), t))
      return
    }
    void window.cairn.setTrashRetentionDays(value).then((result) => {
      if (!result.ok) {
        console.error('[cairn] 无法更新废纸篓保留天数', result.error)
        setError(normalizeError(result.error, t))
      }
    })
  }

  const openExternal = async (url: string): Promise<void> => {
    const result = await window.cairn.openExternal(url)
    if (!result.ok) {
      setError(normalizeError(result.error, t))
    }
  }

  return (
    <section className="view active settings-view" aria-labelledby="settings-view-title">
      <header className="view-header settings-view-header">
        <div>
          <h1 id="settings-view-title" className="view-title">{t('settings')}</h1>
          <p className="settings-view-description">{t('settingsGeneral')}</p>
        </div>
      </header>
      <div className="settings-view-content">
        <div className="settings-view-body">
          <fieldset className="modal-section">
            <legend className="modal-section-title">{t('settingsGeneral')}</legend>
            <label className="checkbox-row">
              <input
                checked={rememberLastFolder}
                className="checkbox"
                type="checkbox"
                onChange={(event) => changeRememberLastFolder(event.target.checked)}
              />
              <span>
                <span className="checkbox-label">{t('rememberLastFolder')}</span>
                <span className="checkbox-hint">{t('rememberLastFolderHint')}</span>
              </span>
            </label>
            <label className="checkbox-row">
              <input
                checked={autoStartWatching}
                className="checkbox"
                type="checkbox"
                onChange={(event) => changeAutoStartWatching(event.target.checked)}
              />
              <span>
                <span className="checkbox-label">{t('autoStartWatching')}</span>
                <span className="checkbox-hint">{t('autoStartWatchingHint')}</span>
              </span>
            </label>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                    void window.cairn.resetOnboarding()
                  .then((result) => {
                    getIpcData(result)
                    onShowOnboarding()
                  })
                  .catch((cause) => {
                    console.error('[cairn] 无法重新开启首次引导', cause)
                    setError(normalizeError(cause, t))
                  })
              }}
            >
              {t('settingsShowOnboarding')}
            </button>
          </fieldset>

          {onStartHackathonMode ? <section className="modal-section">
            <h3 className="modal-section-title">{t('hackathonMode')}</h3>
            <p className="checkbox-hint">{t('demoSimulationNotice')}</p>
            <button className="btn btn-ghost" type="button" onClick={onStartHackathonMode}>{t('startHackathonMode')}</button>
          </section> : null}

          <section className="modal-section">
            <h3 className="modal-section-title">{t('trash')}</h3>
            <label className="field">
              <span className="field-label">{t('trashRetention')}</span>
              <div className="retention-field">
                <input
                  className="input"
                  max={365}
                  min={1}
                  type="number"
                  value={trashRetentionDays}
                  onChange={(event) => changeTrashRetentionDays(Number(event.target.value))}
                />
                <span>{t('trashRetentionDays')}</span>
              </div>
            </label>
          </section>

          <section className="modal-section">
            <h3 className="modal-section-title">{t('settingsGithub')}</h3>
            <label className="field">
              <span className="field-label">{t('githubToken')}</span>
              <input
                className="input"
                placeholder={hasToken ? t('savedToken') : t('githubToken')}
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">{t('githubOwner')}</span>
              <input
                className="input"
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">{t('githubRepo')}</span>
              <input
                className="input"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
              />
            </label>
          </section>

          <section className="modal-section about-section">
            <h3 className="modal-section-title">{t('about')}</h3>
            <dl className="about-meta">
              <div><dt>{t('aboutVersion')}</dt><dd>{appPackage.version}</dd></div>
              <div><dt>{t('aboutLicense')}</dt><dd>MIT</dd></div>
            </dl>
            <p className="about-privacy">{locale === 'zh' ? PRIVACY_SUMMARY_ZH : PRIVACY_SUMMARY_EN}</p>
            <div className="about-actions">
              <button className="btn btn-ghost" type="button" onClick={() => setLicensesOpen(true)}>{t('aboutViewLicenses')}</button>
              <button className="btn btn-ghost" type="button" onClick={() => setPrivacyOpen(true)}>{t('aboutViewPrivacy')}</button>
              <button className="btn btn-ghost" type="button" onClick={() => void openExternal('https://github.com/lol40560/Cairn')}>{t('aboutGithub')}</button>
            </div>
          </section>

          {error && (
            <div className="modal-error">
              <p>{error.message}</p>
              {error.hint && <p>{error.hint}</p>}
              <button className="btn btn-ghost" type="button" onClick={() => void navigator.clipboard.writeText(error.raw)}>
                {t('errorCopyRaw')}
              </button>
            </div>
          )}
          {hasToken && <p className="modal-configured">{t('configured')}</p>}

          <footer className="modal-actions">
            <button className="btn btn-primary" disabled={saving} type="button" onClick={() => void save()}>
              {saving ? t('saving') : t('save')}
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                void window.cairn.clearGithubConfig()
                  .then((result) => {
                    getIpcData(result)
                    setHasToken(false)
                    onConfigured(false)
                  })
                  .catch((cause) => {
                    console.error('[cairn] 无法清除 GitHub 配置', cause)
                    setError(normalizeError(cause, t))
                  })
              }}
            >
              {t('clear')}
            </button>
          </footer>
        </div>
      </div>
      <LicensesDialog open={licensesOpen} onClose={() => setLicensesOpen(false)} />
      <PrivacyDialog open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
    </section>
  )
}
