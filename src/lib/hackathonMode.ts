import type { ConflictRecord, Op } from '@/types/cairn'

export type HackathonExecutionMode = 'live' | 'simulation'
export type HackathonSceneId = 'ready' | 'human-change' | 'ai-change' | 'overlap' | 'conflict' | 'recovery' | 'summary'
export interface HackathonState { enabled: boolean; executionMode: HackathonExecutionMode; currentScene: HackathonSceneId; presentationMode: boolean }
export interface DemoScene { id: HackathonSceneId; title: string; description: string }
export interface DemoScenarioState { ops: Op[]; conflicts: ConflictRecord[]; dirtyFilePath?: string; checkpointRestored: boolean; resolvedConflicts: number }

export const DEMO_SCENES: DemoScene[] = [
  { id: 'ready', title: 'Ready', description: 'You, Alice, and Cursor are ready to collaborate.' },
  { id: 'human-change', title: 'Human change', description: 'Alice changes src/auth.ts.' },
  { id: 'ai-change', title: 'AI change', description: 'Cursor updates API and type definitions.' },
  { id: 'overlap', title: 'Potential overlap', description: 'You have unsaved edits while Alice changes the same region.' },
  { id: 'conflict', title: 'Confirmed conflict', description: 'A real-shaped conflict record is ready for inspection.' },
  { id: 'recovery', title: 'Recovery', description: 'An isolated recovery checkpoint protects the sample project.' },
  { id: 'summary', title: 'Summary', description: 'Review the collaboration and recovery story.' },
]

const baseHash = 'demo-base-auth-v1'
const scenarioDurationMs = 4_000

/** 封裝 demo 時鐘，讓純分類器能明確接收 simulation 的時間來源。 */
export function getDemoNow(): number { return Date.now() }

function op(id: string, author: string, filePath: string, diff: string, source: 'local' | 'remote', offset: number, baseTime: number): Op {
  return { id, hash: id.padEnd(64, '0'), author, parentHashes: [], timestamp: baseTime + offset, filePath, diff, source, baseHash }
}

/** 由 scene 索引重播；前進、後退與重開都沒有反向副作用。 */
export function getDemoScenario(sceneId: HackathonSceneId, now = getDemoNow()): DemoScenarioState {
  const scene = DEMO_SCENES.findIndex((item) => item.id === sceneId)
  const baseTime = now - scenarioDurationMs
  const ops: Op[] = []
  if (scene >= 1) ops.push(op('alice-auth', 'Alice', 'src/auth.ts', '@@ -3,3 +3,5 @@\n export async function login(email: string, password: string) {\n+  if (!email.includes(\'@\')) throw new Error(\'Invalid email\')\n   return api.post(\'/login\', { email, password })\n }', 'remote', 1_000, baseTime))
  if (scene >= 2) ops.push(op('cursor-api', 'Cursor', 'src/api.ts', '@@ -1,2 +1,3 @@\n export const api = createClient()\n+api.timeout = 8_000', 'remote', 2_000, baseTime), op('cursor-types', 'Cursor', 'src/types.ts', '@@ -1,1 +1,2 @@\n export interface User { id: string }\n+export type LoginResult = { token: string }', 'remote', 2_100, baseTime))
  if (scene >= 3) ops.push(op('you-auth', 'You', 'src/auth.ts', '@@ -3,3 +3,5 @@\n export async function login(email: string, password: string) {\n+  if (password.length < 12) throw new Error(\'Password too short\')\n   return api.post(\'/login\', { email, password })\n }', 'local', 3_000, baseTime))
  const conflicts: ConflictRecord[] = scene >= 4 ? [{
    filePath: 'src/auth.ts', opHash: 'd'.repeat(64), author: 'Alice', timestamp: baseTime + 4_000,
    baseContent: "export type LoginResult = { token: string }\n\nexport async function login(email: string, password: string): Promise<LoginResult> {\n  const timeout = 5000\n  const response = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ email, password, timeout }) })\n  return response.json()\n}\n",
    localContent: "export type LoginResult = { token: string }\n\nexport async function login(email: string, password: string): Promise<LoginResult> {\n  const timeout = 8000\n  const response = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ email, password, timeout }) })\n  return response.json()\n}\n",
    remoteContent: "export type LoginResult = { token: string }\n\nexport async function login(email: string, password: string): Promise<LoginResult> {\n  const timeout = 3000\n  const response = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ email, password, timeout }) })\n  return response.json()\n}\n",
  }] : []
  return { ops: ops.reverse(), conflicts, dirtyFilePath: scene >= 3 ? 'src/auth.ts' : undefined, checkpointRestored: scene >= 5, resolvedConflicts: scene >= 6 ? 1 : 0 }
}

export function sceneIndex(id: HackathonSceneId): number { return DEMO_SCENES.findIndex((scene) => scene.id === id) }
