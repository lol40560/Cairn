import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
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
}: {
  open: boolean
  onClose(): void
  onConfigured(value: boolean): void
}) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [token, setToken] = useState('')
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [rememberLastFolder, setRememberLastFolder] = useState(true)
  const [autoStartWatching, setAutoStartWatching] = useState(true)
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

  if (!open) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-bg-0/80"
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
      <section className="w-96 space-y-3 rounded-lg bg-popover p-6 shadow">
        <p>{t('settings')}</p>
        <fieldset className="space-y-2">
          <legend>{t('settingsGeneral')}</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              checked={rememberLastFolder}
              className="mt-0.5 accent-primary"
              type="checkbox"
              onChange={(event) => changeRememberLastFolder(event.target.checked)}
            />
            {t('rememberLastFolder')}
          </label>
          <p className="text-xs text-muted-foreground">{t('rememberLastFolderHint')}</p>
          <label className="flex items-start gap-2 text-sm">
            <input
              checked={autoStartWatching}
              className="mt-0.5 accent-primary"
              type="checkbox"
              onChange={(event) => changeAutoStartWatching(event.target.checked)}
            />
            {t('autoStartWatching')}
          </label>
          <p className="text-xs text-muted-foreground">{t('autoStartWatchingHint')}</p>
        </fieldset>
        <input
          ref={inputRef}
          className="w-full max-w-md rounded-md border bg-popover p-2"
          placeholder={hasToken ? t('savedToken') : t('githubToken')}
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <input
          className="w-full max-w-md rounded-md border bg-popover p-2"
          placeholder={t('githubOwner')}
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
        />
        <input
          className="w-full max-w-md rounded-md border bg-popover p-2"
          placeholder={t('githubRepo')}
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
        />
        {error && (
          <div className="space-y-1 text-sm text-danger">
            <p>{error.message}</p>
            {error.hint && <p>{error.hint}</p>}
            <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(error.raw)}>
              {t('errorCopyRaw')}
            </Button>
          </div>
        )}
        {hasToken && <p className="text-sm text-success">{t('configured')}</p>}
        <div className="flex items-center gap-3">
        <Button disabled={saving} onClick={() => void save()}>
          {saving ? t('saving') : t('save')}
        </Button>
        <Button
          variant="ghost"
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
        </Button>
        </div>
      </section>
    </div>
  )
}
