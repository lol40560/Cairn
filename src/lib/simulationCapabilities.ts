/**
 * Hackathon Simulation 的單一能力邊界。
 * 判斷在執行時進行，避免模式切換前建立的 callback 繞過隔離。
 */
export type RealWorkspaceAction =
  | 'quick-open'
  | 'switch-project'
  | 'project-file'
  | 'copy-invite'
  | 'leave-team'
  | 'export-snapshot'
  | 'export-pr'
  | 'room-connect'
  | 'conflict-mutation'
  | 'checkpoint-mutation'
  | 'trash-mutation'

export interface SimulationCapabilityGate {
  permit(action: RealWorkspaceAction): boolean
}

export interface SimulationCapabilityController extends SimulationCapabilityGate {
  isSimulationActive(): boolean
  setSimulationActive(active: boolean): void
}

export function createSimulationCapabilityGate(
  isSimulationActive: () => boolean,
  onBlocked: (action: RealWorkspaceAction) => void,
): SimulationCapabilityGate {
  return {
    permit(action) {
      if (!isSimulationActive()) return true
      onBlocked(action)
      return false
    },
  }
}

/** renderer 使用的可變能力控制器，不依賴 callback 建立時的 React state。 */
export function createSimulationCapabilityController(
  onBlocked: (action: RealWorkspaceAction) => void,
): SimulationCapabilityController {
  let active = false
  const gate = createSimulationCapabilityGate(() => active, onBlocked)
  return {
    ...gate,
    isSimulationActive: () => active,
    setSimulationActive(value) {
      active = value
    },
  }
}
