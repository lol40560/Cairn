import type { HackathonSceneId } from './hackathonMode'

export interface DemoFile { path: string; content: string; language?: string }
export interface DemoCheckpoint { id: string; createdAt: number; label: string; source: 'scenario' | 'auto-before-restore'; files: Map<string, DemoFile>; revision: string }
export interface DemoComparisonFile { path: string; status: 'added' | 'modified' | 'deleted' }

const BASE_FILES: DemoFile[] = [
  { path: 'src/auth.ts', content: "export type LoginResult = { token: string }\n\nexport async function login(email: string, password: string): Promise<LoginResult> {\n  const response = await fetch('/api/login', {\n    method: 'POST',\n    body: JSON.stringify({ email, password }),\n  })\n\n  return response.json()\n}\n" },
  { path: 'src/api.ts', content: "export const api = {\n  timeout: 5000,\n  baseUrl: '/api',\n}\n" },
  { path: 'src/users.ts', content: "export type User = {\n  id: string\n  email: string\n}\n" },
  { path: 'src/types.ts', content: "export type ApiError = {\n  message: string\n}\n" },
  { path: 'src/dashboard.tsx', content: "export function Dashboard() {\n  return <main>Welcome back</main>\n}\n" },
  { path: 'src/session.ts', content: "export function sessionKey(userId: string) {\n  return `session:${userId}`\n}\n" },
]

/** 完全 in-memory 的示範工作區；沒有 IPC、檔案系統、room 或 checkpoint core 依賴。 */
export class DemoWorkspace {
  private readonly files = new Map<string, DemoFile>()
  private checkpoints: DemoCheckpoint[] = []
  private sequence = 0

  constructor(scene: HackathonSceneId) {
    BASE_FILES.forEach((file) => this.files.set(file.path, { ...file }))
    this.applyScene(scene)
  }

  listFiles(): DemoFile[] { return [...this.files.values()].sort((left, right) => left.path.localeCompare(right.path)).map((file) => ({ ...file })) }
  readFile(path: string): DemoFile | undefined { const file = this.files.get(path); return file ? { ...file } : undefined }
  saveFile(path: string, content: string): void { const file = this.files.get(path); if (!file) throw new Error(`Demo file not found: ${path}`); this.files.set(path, { ...file, content }) }
  /** 使用瀏覽器安全的穩定雜湊，避免 renderer 依賴 Node API。 */
  revision(): string { return `demo-${stableHash(this.listFiles().map((file) => `${file.path}\0${file.content}`).join('\n'))}` }
  listCheckpoints(): DemoCheckpoint[] { return this.checkpoints.map((checkpoint) => ({ ...checkpoint, files: cloneFiles(checkpoint.files) })) }
  compareCheckpoint(id: string): DemoComparisonFile[] { const checkpoint = this.requireCheckpoint(id); return compare(checkpoint.files, this.files) }
  readComparisonFile(id: string, path: string): { checkpoint?: DemoFile; current?: DemoFile } { const checkpoint = this.requireCheckpoint(id); return { checkpoint: checkpoint.files.get(path), current: this.files.get(path) } }
  restoreCheckpoint(id: string): DemoCheckpoint {
    const safety = this.snapshot('Before restoring checkpoint', 'auto-before-restore')
    const target = this.requireCheckpoint(id)
    this.files.clear(); for (const file of target.files.values()) this.files.set(file.path, { ...file })
    return safety
  }

  private applyScene(scene: HackathonSceneId): void {
    const index = ['ready', 'human-change', 'ai-change', 'overlap', 'conflict', 'recovery', 'summary'].indexOf(scene)
    if (index >= 1) this.saveFile('src/auth.ts', this.readFile('src/auth.ts')!.content.replace("method: 'POST',", "method: 'POST',\n    headers: { 'x-client': 'alice' },"))
    if (index >= 2) { this.saveFile('src/api.ts', "export const api = {\n  timeout: 8000,\n  baseUrl: '/api',\n}\n"); this.saveFile('src/types.ts', "export type ApiError = { message: string }\nexport type LoginResult = { token: string }\n") }
    if (index >= 4) this.saveFile('src/auth.ts', "export type LoginResult = { token: string }\n\nexport async function login(email: string, password: string): Promise<LoginResult> {\n  const timeout = 8000\n  const response = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ email, password, timeout }) })\n  return response.json()\n}\n")
    if (index >= 5) {
      this.snapshot('Before Cursor changes', 'scenario')
      this.saveFile('src/users.ts', "export type User = { id: string; email: string; role: 'admin' | 'member' }\n")
      this.saveFile('src/dashboard.tsx', "export function Dashboard() {\n  return <main><h1>Workspace</h1><p>Recent activity</p></main>\n}\n")
      this.saveFile('src/session.ts', "export function sessionKey(userId: string) {\n  return `cairn:session:${userId}`\n}\nexport const sessionTtl = 60 * 60\n")
    }
  }

  private snapshot(label: string, source: DemoCheckpoint['source']): DemoCheckpoint { const checkpoint = { id: `demo-cp-${++this.sequence}`, createdAt: 1_700_000_000_000 + this.sequence, label, source, files: cloneFiles(this.files), revision: this.revision() }; this.checkpoints.unshift(checkpoint); return checkpoint }
  private requireCheckpoint(id: string): DemoCheckpoint { const checkpoint = this.checkpoints.find((item) => item.id === id); if (!checkpoint) throw new Error(`Demo checkpoint not found: ${id}`); return checkpoint }
}

function cloneFiles(files: Map<string, DemoFile>): Map<string, DemoFile> { return new Map([...files].map(([path, file]) => [path, { ...file }])) }
function compare(base: Map<string, DemoFile>, current: Map<string, DemoFile>): DemoComparisonFile[] { const paths = new Set([...base.keys(), ...current.keys()]); const changed: DemoComparisonFile[] = []; for (const path of paths) { const left = base.get(path); const right = current.get(path); if (!left) changed.push({ path, status: 'added' }); else if (!right) changed.push({ path, status: 'deleted' }); else if (left.content !== right.content) changed.push({ path, status: 'modified' }) } return changed }
function stableHash(value: string): string { let hash = 2_166_136_261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16_777_619) } return (hash >>> 0).toString(16).padStart(8, '0') }

export function createDemoWorkspace(scene: HackathonSceneId): DemoWorkspace { return new DemoWorkspace(scene) }
