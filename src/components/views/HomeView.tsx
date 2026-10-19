import { useMemo, useState } from 'react'

import { ArrowRight, Plus } from 'lucide-react'

import { Toast, type ToastMessage } from '@/components/Toast'
import { useTranslation } from '@/i18n'
import { normalizeError, type NormalizedError } from '@/lib/errors'
import { useProfile } from '@/lib/profile'
import { useAppStore } from '@/store/appStore'
import type { IpcResult, Op } from '@/types/cairn'

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

function getIpcData<T>(result: IpcResult<T>): T {
  if (!result.ok) throw result.error
  return result.data
}

interface HomeViewProps {
  ops?: Op[]
}

/** Dashboard for the currently open project. Project selection lives in ProjectsView. */
export function HomeView({ ops: opsOverride }: HomeViewProps) {
  const { t } = useTranslation()
  const folder = useAppStore((state) => state.folder)
  const storedOps = useAppStore((state) => state.ops)
  const ops = opsOverride ?? storedOps
  const peers = useAppStore((state) => state.peers)
  const conflicts = useAppStore((state) => state.conflicts)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const { profile } = useProfile()
  const [creatingCheckpoint, setCreatingCheckpoint] = useState(false)
  const [toast, setToast] = useState<ToastMessage | NormalizedError | null>(null)
  const firstName = profile.displayName.trim().split(/\s+/)[0] || 'there'

  const weeklyBars = useMemo(() => {
    const now = new Date()
    const monday = new Date(now)
    monday.setHours(0, 0, 0, 0)
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
    const counts = WEEKDAY_LABELS.map(() => 0)
    for (const op of ops) {
      const dayIndex = Math.floor((op.timestamp - monday.getTime()) / 86_400_000)
      if (dayIndex >= 0 && dayIndex < counts.length) counts[dayIndex] += 1
    }
    const peak = Math.max(1, ...counts)
    const activeIndex = (now.getDay() + 6) % 7
    return WEEKDAY_LABELS.map((day, index) => ({
      active: index === activeIndex,
      count: counts[index],
      day,
      height: counts[index] === 0 ? 8 : Math.max(18, Math.round((counts[index] / peak) * 92)),
    }))
  }, [ops])
  const weeklyChangeCount = weeklyBars.reduce((total, bar) => total + bar.count, 0)

  const syncedSeries = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = new Date(today)
    start.setDate(today.getDate() - 6)
    const dailyCounts = [0, 0, 0, 0, 0, 0, 0]
    for (const op of ops) {
      if (op.source !== 'remote') continue
      const dayIndex = Math.floor((op.timestamp - start.getTime()) / 86_400_000)
      if (dayIndex >= 0 && dayIndex < dailyCounts.length) dailyCounts[dayIndex] += 1
    }
    let runningTotal = 0
    const cumulative = dailyCounts.map((count) => (runningTotal += count))
    const total = cumulative.at(-1) ?? 0
    const peak = Math.max(1, total)
    const points = cumulative.map((count, index) => ({ x: (index / 6) * 400, y: 165 - (count / peak) * 125 }))
    const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')
    return { areaPath: `${linePath} L400 180 L0 180Z`, last: points.at(-1)!, linePath, total }
  }, [ops])

  const createCheckpoint = async (): Promise<void> => {
    if (!folder) {
      setToast({ message: t('chooseProjectHint'), tone: 'error' })
      return
    }
    setCreatingCheckpoint(true)
    try {
      getIpcData(await window.cairn.createCheckpoint())
      setToast({ message: t('checkpointCreated'), tone: 'success' })
    } catch (error) {
      setToast(normalizeError(error, t))
    } finally {
      setCreatingCheckpoint(false)
    }
  }

  return (
    <section className="view active">
      <div className="view-header home-view-header cairn-hero" data-tour="home-overview">
        <div>
          <h1 className="view-title">Welcome, {firstName}!</h1>
          <p className="view-description">Every change saved, every file recoverable.</p>
          <div className="hero-actions">
            <button aria-busy={creatingCheckpoint} className="btn btn-primary" disabled={creatingCheckpoint} type="button" onClick={() => void createCheckpoint()}><Plus aria-hidden="true" size={18} />{creatingCheckpoint ? t('creating') : t('createCheckpoint')}</button>
            <button className="btn btn-black" type="button" onClick={() => setActiveView('activity')}>View Activity</button>
          </div>
        </div>
      </div>

      <div className="overview-grid">
        <article className="overview-card overview-card-white">
          <div className="overview-card-header"><h2>Changes this week</h2></div>
          <div className="overview-bars" aria-label={`${weeklyChangeCount} saved changes this week`}>
            {weeklyBars.map(({ active, count, day, height }) => <div aria-label={`${day}: ${count} changes`} className="overview-bar-column" key={day}><span className={`overview-bar ${active ? 'active' : ''}`} style={{ height: `${height}%` }} /><span className={active ? 'active' : ''}>{day}</span></div>)}
          </div>
        </article>
        <article className="overview-card overview-synced-card">
          <div className="overview-card-header"><div><h2>Synced changes</h2><p>{syncedSeries.total} received in the last 7 days</p></div><span className="overview-positive">{peers.length ? `${peers.length} connected` : 'Local first'}</span></div>
          {syncedSeries.total > 0 ? (
            <svg aria-label={`${syncedSeries.total} synced changes in the last 7 days`} className="overview-line-chart" preserveAspectRatio="none" role="img" viewBox="0 0 400 200">
              <defs><linearGradient id="cairn-line-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".3"/><stop offset="1" stopColor="var(--accent)" stopOpacity="0"/></linearGradient></defs>
              <path className="overview-grid-line" d="M0 40H400M0 82H400M0 124H400M0 166H400" />
              <path className="overview-line-area" d={syncedSeries.areaPath} />
              <path className="overview-line" d={syncedSeries.linePath} pathLength="1" />
              <circle cx={syncedSeries.last.x} cy={syncedSeries.last.y} r="5" />
            </svg>
          ) : (
            <div className="overview-chart-empty"><strong>0</strong><p>No team changes have synced yet.</p></div>
          )}
          <button className="overview-card-link" type="button" onClick={() => setActiveView('activity')}>View activity <ArrowRight aria-hidden="true" size={15} /></button>
        </article>
      </div>

      {conflicts.length > 0 ? <article className="overview-alert-card"><div><h2>Review {conflicts.length === 1 ? 'one overlap' : `${conflicts.length} overlaps`}</h2><p>Your team edited some of the same lines. Review the changes before continuing.</p></div><button className="btn btn-black" type="button" onClick={() => setActiveView('conflicts')}>Review Conflict <ArrowRight aria-hidden="true" size={16}/></button></article> : null}
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </section>
  )
}
