import { useState } from 'react'

import { useTranslation } from '@/i18n'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { useAppStore } from '@/store/appStore'

type OnboardingStep = 'welcome' | 'project' | 'join' | 'done'

function isInviteCode(value: string): boolean {
  return /^[A-Z0-9]{6}$/i.test(value)
}

function parseDirectAddress(value: string): { host: string; port: number } | undefined {
  const match = value.match(/^([\d.]+):(\d+)$/)
  if (!match) return undefined

  const port = Number.parseInt(match[2]!, 10)
  return port >= 1 && port <= 65_535 ? { host: match[1]!, port } : undefined
}

export function Onboarding({ onComplete }: { onComplete(): void }) {
  const { t } = useTranslation()
  const [step, setStep] = useState<OnboardingStep>('welcome')
  const [selectedFolder, setSelectedFolder] = useState('')
  const [inviteInput, setInviteInput] = useState('')
  const [directAddressInput, setDirectAddressInput] = useState('')
  const [showAdvancedConnection, setShowAdvancedConnection] = useState(false)
  const [error, setError] = useState<NormalizedError | null>(null)
  const [busy, setBusy] = useState(false)
  const roomCode = useAppStore((state) => state.roomCode)
  const isHost = useAppStore((state) => state.isHost)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const setDirectAddress = useAppStore((state) => state.setDirectAddress)
  const setFolder = useAppStore((state) => state.setFolder)
  const setIsHost = useAppStore((state) => state.setIsHost)
  const setIsSharing = useAppStore((state) => state.setIsSharing)
  const setMySnapshotId = useAppStore((state) => state.setMySnapshotId)
  const setPendingAutoDownload = useAppStore((state) => state.setPendingAutoDownload)
  const setPeers = useAppStore((state) => state.setPeers)
  const replaceOps = useAppStore((state) => state.replaceOps)
  const setRoomCode = useAppStore((state) => state.setRoomCode)
  const setStatus = useAppStore((state) => state.setStatus)

  const setMessage = (message: string): void => {
    setError({ category: 'unknown', message, raw: message })
  }

  const chooseFolder = async (): Promise<void> => {
    try {
      const result = await window.cairn.selectFolder()
      if (!result.ok) {
        setError(normalizeError(result.error, t))
        return
      }
      if (result.data) setSelectedFolder(result.data)
    } catch (cause) {
      setError(normalizeError(cause, t))
    }
  }

  const startWatchingFolder = async (folder = selectedFolder): Promise<boolean> => {
    const result = await window.cairn.startWatching(folder)
    if (!result.ok) {
      setError(normalizeError(result.error, t))
      return false
    }

    setFolder(folder)
    setStatus('watching')
    const opsResult = await window.cairn.listRecentOps(200)
    if (opsResult.ok) replaceOps(opsResult.data)
    return true
  }

  const startProject = async (folder = selectedFolder): Promise<void> => {
    if (!folder) {
      setMessage(t('onboardingFolderRequired'))
      return
    }

    setBusy(true)
    setError(null)
    try {
      if (!await startWatchingFolder(folder)) return

      const roomResult = await window.cairn.createRoom()
      if (!roomResult.ok) {
        setError(normalizeError(roomResult.error, t))
        return
      }
      setRoomCode(roomResult.data)
      setIsHost(true)
      setDirectAddress(undefined)

      const peersResult = await window.cairn.listPeers()
      if (peersResult.ok) setPeers(peersResult.data)

      // 分享失败不撤销已创建的团队，用户仍可在 Team 视图中重新开始分享。
      const shareResult = await window.cairn.startSharing()
      if (shareResult.ok) {
        setIsSharing(true)
        setMySnapshotId(shareResult.data.snapshotId)
      } else {
        setError(normalizeError(shareResult.error, t))
      }
      setActiveView('room')
      setStep('done')
    } catch (cause) {
      setError(normalizeError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const chooseProjectFolder = async (): Promise<void> => {
    try {
      const result = await window.cairn.selectFolder()
      if (!result.ok) {
        setError(normalizeError(result.error, t))
        return
      }
      if (!result.data) return
      setSelectedFolder(result.data)
      await startProject(result.data)
    } catch (cause) {
      setError(normalizeError(cause, t))
    }
  }

  const joinTeam = async (): Promise<void> => {
    const value = inviteInput.trim()
    if (!selectedFolder) {
      setMessage(t('onboardingFolderRequired'))
      return
    }
    if (!value) {
      setMessage(t('onboardingCodeRequired'))
      return
    }

    if (!isInviteCode(value)) {
      setMessage(t('onboardingInvalidCode'))
      return
    }
    const directAddress = directAddressInput.trim() ? parseDirectAddress(directAddressInput.trim()) : undefined
    if (directAddressInput.trim() && !directAddress) {
      setMessage(t('onboardingInvalidCode'))
      return
    }

    setBusy(true)
    setError(null)
    try {
      // Sync 依赖活动项目，因此必须先启动监控再加入团队。
      if (!await startWatchingFolder()) return

      const roomCodeValue = value.toUpperCase()
      const result = await window.cairn.joinRoom(roomCodeValue)
      if (!result.ok) {
        setError(normalizeError(result.error, t))
        return
      }
      setRoomCode(roomCodeValue)
      if (directAddress) {
        const directResult = await window.cairn.connectToAddress({ ...directAddress, roomCode: roomCodeValue })
        if (!directResult.ok) {
          setError({ category: 'network', message: t('authFailed'), raw: directResult.error.raw })
          return
        }
        setDirectAddress(`${directAddress.host}:${directAddress.port}`)
      } else {
        setDirectAddress(undefined)
      }

      setIsHost(false)
      setIsSharing(false)
      setPendingAutoDownload(true)
      const peersResult = await window.cairn.listPeers()
      if (peersResult.ok) setPeers(peersResult.data)
      setActiveView('room')
      setStep('done')
    } catch (cause) {
      setError(normalizeError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const finish = async (): Promise<void> => {
    try {
      const result = await window.cairn.completeOnboarding()
      if (!result.ok) {
        setError(normalizeError(result.error, t))
        return
      }
      onComplete()
    } catch (cause) {
      setError(normalizeError(cause, t))
    }
  }

  const copyInviteCode = async (): Promise<void> => {
    if (!roomCode) return
    try {
      await navigator.clipboard.writeText(roomCode)
    } catch {
      await window.cairn.copyToClipboard(roomCode)
    }
  }

  const back = (): void => {
    setError(null)
    setStep('welcome')
  }

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <section className="onboarding-card">
        <button className="onboarding-skip" type="button" onClick={() => void finish()}>{t('onboardingSkip')} →</button>

        {step === 'welcome' && (
          <>
            <h1 id="onboarding-title" className="onboarding-title">{t('onboardingWelcomeTitle')}</h1>
            <p className="onboarding-subtitle">{t('onboardingWelcomeSubtitle')}</p>
            <div className="onboarding-actions">
              <button className="btn btn-primary onboarding-btn" type="button" onClick={() => setStep('project')}>{t('onboardingStartProject')}</button>
              <button className="btn onboarding-btn" type="button" onClick={() => setStep('join')}>{t('onboardingJoinTeam')}</button>
            </div>
            <p className="onboarding-trust-line">{t('onboardingTrustLine')}</p>
          </>
        )}

        {step === 'project' && (
          <>
            <h1 id="onboarding-title" className="onboarding-title">{t('onboardingChooseFolderTitle')}</h1>
            <p className="onboarding-subtitle">{t('onboardingChooseFolderSubtitle')}</p>
            <div className="onboarding-actions">
              <button aria-busy={busy} className="btn btn-primary" disabled={busy} type="button" onClick={() => void chooseProjectFolder()}>{busy ? t('creating') : t('onboardingChooseFolder')}</button>
              {selectedFolder && <p className="onboarding-folder-path" title={selectedFolder}>{selectedFolder}</p>}
            </div>
            <button className="onboarding-back" type="button" onClick={back}>{t('onboardingBack')}</button>
          </>
        )}

        {step === 'join' && (
          <>
            <h1 id="onboarding-title" className="onboarding-title">{t('onboardingJoinTitle')}</h1>
            <p className="onboarding-subtitle">{t('onboardingJoinSubtitle')}</p>
            <label className="onboarding-field">
              <span>{t('inviteCodeLabel')}</span>
              <input className="onboarding-input" placeholder={t('inviteCodeLabel')} value={inviteInput} onChange={(event) => setInviteInput(event.target.value)} />
            </label>
            <button
              aria-expanded={showAdvancedConnection}
              className="onboarding-advanced-toggle"
              type="button"
              onClick={() => setShowAdvancedConnection((value) => !value)}
            >
              {t('advancedConnection')}
            </button>
            {showAdvancedConnection ? (
              <label className="onboarding-field">
                <span>{t('directAddressLabel')}</span>
                <input className="onboarding-input" placeholder={t('directAddressPlaceholder')} value={directAddressInput} onChange={(event) => setDirectAddressInput(event.target.value)} />
              </label>
            ) : null}
            <div className="onboarding-folder-row">
              <div>
                <span className="onboarding-field-label">{t('onboardingFolderLabel')}</span>
                <p className="onboarding-folder-path">{selectedFolder || t('onboardingNoFolder')}</p>
              </div>
              <button className="btn btn-ghost" disabled={busy} type="button" onClick={() => void chooseFolder()}>{t('onboardingChooseFolderAction')}</button>
            </div>
            <div className="onboarding-actions">
              <button aria-busy={busy} className="btn btn-primary" disabled={!selectedFolder || !inviteInput.trim() || busy} type="button" onClick={() => void joinTeam()}>{busy ? t('joining') : t('onboardingJoin')}</button>
            </div>
            <button className="onboarding-back" type="button" onClick={back}>{t('onboardingBack')}</button>
          </>
        )}

        {step === 'done' && (
          <>
            <h1 id="onboarding-title" className="onboarding-title">{t('onboardingDoneTitle')}</h1>
            {isHost && roomCode ? (
              <div className="onboarding-done-code">
                <p>{t('onboardingDoneShareCode')}</p>
                <div><code>{roomCode}</code><button className="btn btn-ghost" type="button" onClick={() => void copyInviteCode()}>{t('copy')}</button></div>
              </div>
            ) : (
              <p className="onboarding-subtitle">{t('onboardingDoneWaiting')}</p>
            )}
            <div className="onboarding-actions">
              <button className="btn btn-primary" type="button" onClick={() => void finish()}>{t('onboardingOpen')}</button>
            </div>
          </>
        )}

        {error && <p className="onboarding-error">{error.message}</p>}
      </section>
    </div>
  )
}
