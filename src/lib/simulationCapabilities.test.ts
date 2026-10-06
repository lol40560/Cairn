import { describe, expect, it, vi } from 'vitest'

import { createSimulationCapabilityGate, type RealWorkspaceAction } from './simulationCapabilities'

describe('Hackathon Simulation capability boundary', () => {
  const protectedActions: RealWorkspaceAction[] = [
    'quick-open', 'switch-project', 'project-file', 'copy-invite', 'leave-team',
    'export-snapshot', 'export-pr', 'room-connect', 'conflict-mutation',
    'checkpoint-mutation', 'trash-mutation',
  ]

  it('blocks every real-project capability while simulation is active', () => {
    const blocked = vi.fn()
    const invokeRealIpc = vi.fn()
    const gate = createSimulationCapabilityGate(() => true, blocked)

    for (const action of protectedActions) {
      if (gate.permit(action)) invokeRealIpc(action)
    }

    expect(invokeRealIpc).not.toHaveBeenCalled()
    expect(blocked).toHaveBeenCalledTimes(protectedActions.length)
  })

  it('evaluates the current mode for callbacks created before simulation starts (regression)', () => {
    let simulationActive = false
    const invokeRealIpc = vi.fn()
    const gate = createSimulationCapabilityGate(() => simulationActive, () => undefined)
    const staleExportHandler = () => {
      if (gate.permit('export-pr')) invokeRealIpc()
    }

    simulationActive = true
    staleExportHandler()

    expect(invokeRealIpc).not.toHaveBeenCalled()
  })

  it('restores normal capabilities immediately after simulation exits', () => {
    let simulationActive = true
    const invokeRealIpc = vi.fn()
    const gate = createSimulationCapabilityGate(() => simulationActive, () => undefined)

    expect(gate.permit('export-snapshot')).toBe(false)
    simulationActive = false
    if (gate.permit('export-snapshot')) invokeRealIpc()

    expect(invokeRealIpc).toHaveBeenCalledTimes(1)
  })
})
