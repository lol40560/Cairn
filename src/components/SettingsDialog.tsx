import { useEffect, useRef, useState } from 'react'

import { useTranslation } from '@/i18n'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import {
  shouldCloseDialogFromBackdrop,
  shouldCloseDialogFromKey,
  updateGeneralSettings,
} from '@/lib/settingsDialog'
import type { IpcResult } from '@/types/cairn'

function getIpcData<T>(result: IpcResult<T>): T {
  if (!result.ok) {
    throw result.error
  }
  return result.data
}

export function SettingsDialog({
  open,
  onClose,
  onConfigured,
  onShowOnboarding,
}: {
  open: boolean
  onClose(): void
  onConfigured(value: boolean): void
  onShowOnboarding(): void
}) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [token, setToken] = useState('')
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [rememberLastFolder, setRememberLastFolder] = useState(true)
  const [autoStartWatching, setAutoStartWatching] = useState(true)
  const [trashRetentionDays, setTrashRetentionDays] = useState(30)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<NormalizedError | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

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
        inputRef.current?.focus()
      })
      .catch((cause) => {
        console.error('[cairn] 无法读取设置', cause)
        setError(normalizeError(cause, t))
        inputRef.current?.focus()
      })
  }, [open, t])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      getIpcData(await window.cairn.saveGithubConfig({ token: token || undefined, owner, repo }))
      setHasToken(true)
      onConfigured(true)
      onClose()
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

  if (!open) {
    return null
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (shouldCloseDialogFromBackdrop(event.target, event.currentTarget)) {
          onClose()
        }
      }}
      onKeyDown={(event) => {
        if (shouldCloseDialogFromKey(event.key)) {
          onClose()
        }
      }}
    >
      <section className="modal" aria-labelledby="settings-dialog-title">
        <header className="modal-header">
          <h2 id="settings-dialog-title" className="modal-title">{t('settings')}</h2>
          <button aria-label={t('close')} className="btn btn-ghost modal-close" type="button" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
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
                    onClose()
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
                ref={inputRef}
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
      </section>
    </div>
  )
}
