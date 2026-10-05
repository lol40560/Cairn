import { useEffect, useState } from 'react'

import { ChevronLeft, ChevronRight, MonitorUp, RotateCcw, X } from 'lucide-react'

import { useTranslation } from '@/i18n'
import { DEMO_SCENES, sceneIndex, type HackathonExecutionMode, type HackathonSceneId } from '@/lib/hackathonMode'

interface HackathonControllerProps {
  mode: HackathonExecutionMode
  scene: HackathonSceneId
  presentationMode: boolean
  onExit(): void
  onModeChange(mode: HackathonExecutionMode): void
  onPresentationChange(value: boolean): void
  onSceneChange(scene: HackathonSceneId): void
}

/** 獨立的簡報控制器；它只改 renderer 中的 demo state，沒有任何核心副作用。 */
export function HackathonController({ mode, scene, presentationMode, onExit, onModeChange, onPresentationChange, onSceneChange }: HackathonControllerProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const index = sceneIndex(scene)
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement
      if (target.matches('input, textarea, [contenteditable=true]')) return
      if (event.key === 'ArrowLeft' && index > 0) onSceneChange(DEMO_SCENES[index - 1]!.id)
      if (event.key === 'ArrowRight' && index < DEMO_SCENES.length - 1) onSceneChange(DEMO_SCENES[index + 1]!.id)
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [index, onSceneChange])

  return (
    <aside className={`hackathon-controller${collapsed ? ' collapsed' : ''}`} aria-label={t('hackathonMode')}>
      <button className="hackathon-badge" type="button" onClick={() => setCollapsed((value) => !value)}>{mode === 'simulation' ? t('simulation') : t('liveDemo')}</button>
      {!collapsed ? <>
        <div className="hackathon-scene"><strong>{index + 1}. {DEMO_SCENES[index]?.title}</strong><span>{DEMO_SCENES[index]?.description}</span></div>
        <div className="hackathon-scene-list">{DEMO_SCENES.map((item, itemIndex) => <button aria-current={item.id === scene ? 'step' : undefined} className={item.id === scene ? 'active' : ''} key={item.id} type="button" onClick={() => onSceneChange(item.id)}>{itemIndex + 1} {item.title}</button>)}</div>
        <div className="hackathon-actions">
          <button aria-label={t('previous')} className="btn btn-ghost btn-sm" disabled={index === 0} type="button" onClick={() => onSceneChange(DEMO_SCENES[index - 1]!.id)}><ChevronLeft size={14} />{t('previous')}</button>
          <button aria-label={t('next')} className="btn btn-secondary btn-sm" disabled={index === DEMO_SCENES.length - 1} type="button" onClick={() => onSceneChange(DEMO_SCENES[index + 1]!.id)}>{t('next')}<ChevronRight size={14} /></button>
        </div>
        <div className="hackathon-actions">
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => onSceneChange('ready')}><RotateCcw size={14} />{t('restartDemo')}</button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => onPresentationChange(!presentationMode)}><MonitorUp size={14} />{t('presentationMode')}</button>
        </div>
        <div className="hackathon-actions">
          {mode === 'live' ? <button className="btn btn-ghost btn-sm" type="button" onClick={() => onModeChange('simulation')}>{t('switchToSimulation')}</button> : <button className="btn btn-ghost btn-sm" type="button" onClick={() => onModeChange('live')}>{t('liveDemo')}</button>}
          <button className="btn btn-ghost btn-sm" type="button" onClick={onExit}><X size={14} />{t('exitHackathonMode')}</button>
        </div>
      </> : null}
    </aside>
  )
}
