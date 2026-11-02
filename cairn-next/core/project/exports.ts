import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Zip, ZipPassThrough } from 'fflate';
import { createTwoFilesPatch } from 'diff';
import ignore, { type Ignore } from 'ignore';
import { CairnError, hash } from '../common.js';
import {
  builtinExclusion,
  validateProjectPath as validatePath,
  classifyBytes,
  MAX_BLOB_BYTES,
  MAX_ENTRIES,
  MAX_PROJECT_BYTES,
} from './filesystem.js';
import type { ProjectFile, SnapshotManifest } from '../../shared/project.js';

export type ReadExportBlob = (hash: string) => Promise<Uint8Array> | Uint8Array;
export const SNAPSHOT_MANIFEST_NAME = '.cairn-snapshot-manifest.json';
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const EMPTY_HASH = hash(new Uint8Array());
const MAX_DIFF_BYTES = 128 * 1024;
const MAX_TOTAL_DIFF_BYTES = 4 * 1024 * 1024;
const fold = (value: string) => value.toUpperCase().toLowerCase().normalize('NFC');

interface ExportFile {
  path: string;
  kind: ProjectFile['kind'];
  hash: string;
  size: number;
}
interface PreparedSnapshot {
  projectId: string;
  id: string;
  revision: number;
  createdAt: number;
  files: ExportFile[];
  excluded: { path: string; reason: string }[];
  rules: { base: string; matcher: Ignore }[];
}

function snapshotCopy(snapshot: SnapshotManifest): PreparedSnapshot {
  if (
    !snapshot ||
    !Array.isArray(snapshot.files) ||
    snapshot.files.length > MAX_ENTRIES ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    !Number.isSafeInteger(snapshot.createdAt) ||
    snapshot.createdAt < 0 ||
    typeof snapshot.id !== 'string' ||
    snapshot.id.length > 200 ||
    typeof snapshot.projectId !== 'string' ||
    snapshot.projectId.length > 200
  )
    throw new CairnError(
      'INVALID_SNAPSHOT',
      'The snapshot is invalid or exceeds the supported limits.',
    );
  const patterns = snapshot.metadata?.ignorePatterns ?? [];
  if (
    !Array.isArray(patterns) ||
    patterns.length > MAX_ENTRIES ||
    patterns.some((value) => typeof value !== 'string' || value.length > 4096) ||
    Buffer.byteLength(patterns.join('\n')) > 1024 * 1024
  )
    throw new CairnError('INVALID_IGNORE', 'The snapshot ignore rules exceed the supported limit.');
  const prepared: PreparedSnapshot = {
    projectId: snapshot.projectId,
    id: snapshot.id,
    revision: snapshot.revision,
    createdAt: snapshot.createdAt,
    files: [],
    excluded: [],
    rules: [{ base: '', matcher: ignore().add([...patterns]) }],
  };
  let total = 0;
  for (const file of snapshot.files) {
    if (!file || typeof file.deleted !== 'boolean')
      throw new CairnError('INVALID_SNAPSHOT', 'Invalid snapshot file.');
    if (file.deleted) continue;
    validatePath(file.path);
    if (!['text', 'binary', 'directory'].includes(file.kind))
      throw new CairnError('INVALID_SNAPSHOT', 'Unsupported snapshot file type.');
    const reason = builtinExclusion(file.path, file.kind === 'directory');
    if (reason) {
      prepared.excluded.push({ path: file.path, reason });
      continue;
    }
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_BLOB_BYTES ||
      (file.kind === 'directory' ? file.size !== 0 : !SHA256.test(file.hash))
    )
      throw new CairnError('INVALID_SNAPSHOT', 'Invalid snapshot content descriptor.');
    total += file.size;
    if (total > MAX_PROJECT_BYTES)
      throw new CairnError('SIZE_LIMIT', 'The export exceeds the project size limit.');
    prepared.files.push({
      path: file.path,
      kind: file.kind,
      hash: file.kind === 'directory' ? EMPTY_HASH : file.hash,
      size: file.size,
    });
  }
  prepared.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  validateCollisions(prepared.files);
  return prepared;
}

function validateCollisions(files: Pick<ExportFile, 'path' | 'kind'>[]): void {
  const paths = new Map<string, { path: string; directory: boolean; explicit: boolean }>();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const value = parts.slice(0, depth).join('/'),
        key = fold(value);
      const directory = depth < parts.length || file.kind === 'directory',
        explicit = depth === parts.length;
      const before = paths.get(key);
      if (
        before &&
        (before.path !== value || before.directory !== directory || (before.explicit && explicit))
      )
        throw new CairnError(
          'PATH_COLLISION',
          'The snapshot contains duplicate, conflicting, or case-colliding paths.',
        );
      paths.set(key, { path: value, directory, explicit: explicit || before?.explicit || false });
    }
  }
}

async function verifiedBlob(
  file: Pick<ExportFile, 'hash' | 'size'>,
  readBlob: ReadExportBlob,
): Promise<Uint8Array> {
  const source = await readBlob(file.hash);
  if (
    !(source instanceof Uint8Array) ||
    source.byteLength !== file.size ||
    source.byteLength > MAX_BLOB_BYTES
  )
    throw new CairnError(
      'BLOB_SIZE_MISMATCH',
      'Snapshot content no longer matches its recorded size.',
    );
  // Own the bytes so a mutable callback buffer cannot change after verification.
  const bytes = new Uint8Array(source);
  if (hash(bytes) !== file.hash)
    throw new CairnError('BLOB_HASH_MISMATCH', 'Snapshot content failed its SHA-256 check.');
  return bytes;
}

function ignoredBySnapshot(
  prepared: PreparedSnapshot,
  relative: string,
  directory: boolean,
): boolean {
  const parts = relative.split('/');
  for (let depth = 1; depth <= parts.length; depth++) {
    const value = parts.slice(0, depth).join('/') + (depth < parts.length || directory ? '/' : '');
    let ignored = false;
    for (const rule of prepared.rules) {
      if (rule.base && !value.startsWith(`${rule.base}/`)) continue;
      const candidate = rule.base ? value.slice(rule.base.length + 1) : value;
      if (!candidate) continue;
      const match = rule.matcher.test(candidate);
      if (match.ignored) ignored = true;
      // Project rules are an additional restriction; nested .gitignore cannot undo them.
      if (rule.base === '' && rule === prepared.rules[0] && match.ignored) return true;
      if (match.unignored) ignored = false;
    }
    if (ignored) return true;
  }
  return false;
}

async function prepareSnapshot(
  snapshot: SnapshotManifest,
  readBlob: ReadExportBlob,
): Promise<PreparedSnapshot> {
  const prepared = snapshotCopy(snapshot); // Copy descriptors before the first asynchronous read.
  for (const file of prepared.files
    .filter((file) => file.path.split('/').at(-1) === '.gitignore' && file.kind !== 'directory')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    if (ignoredBySnapshot(prepared, file.path, false)) continue;
    const bytes = await verifiedBlob(file, readBlob);
    if (bytes.length > 1024 * 1024)
      throw new CairnError('INVALID_IGNORE', 'The snapshot ignore file is too large.');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new CairnError('INVALID_IGNORE', 'The snapshot ignore file is not UTF-8.');
    }
    const slash = file.path.lastIndexOf('/');
    prepared.rules.push({
      base: slash < 0 ? '' : file.path.slice(0, slash),
      matcher: ignore().add(text),
    });
  }
  prepared.files = prepared.files.filter((file) => {
    if (!ignoredBySnapshot(prepared, file.path, file.kind === 'directory')) return true;
    prepared.excluded.push({ path: file.path, reason: 'Excluded by snapshot ignore rules.' });
    return false;
  });
  return prepared;
}

function safeOutputParent(outputPath: string): string {
  const output = path.resolve(outputPath),
    parent = path.dirname(output),
    root = path.parse(parent).root;
  let current = root;
  for (const part of parent.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = fs.lstatSync(current);
    const real = fs.realpathSync.native(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform === 'win32'
        ? real.toLowerCase() !== current.toLowerCase()
        : real !== current)
    )
      throw new CairnError('UNSAFE_PATH', 'The export destination must use ordinary directories.');
  }
  return output;
}

export class SnapshotExportError extends CairnError {
  constructor(
    code: string,
    message: string,
    public readonly recoveryPath?: string,
  ) {
    super(code, message);
  }
}

/** Store-only ZIP keeps peak memory to one bounded blob; source bytes never change. */
export async function exportSnapshot(input: {
  snapshot: SnapshotManifest;
  readBlob: ReadExportBlob;
  outputPath: string;
}): Promise<{ path: string; files: number; bytes: number }> {
  const output = safeOutputParent(input.outputPath);
  try {
    fs.lstatSync(output);
    throw new CairnError(
      'EXPORT_EXISTS',
      'Choose a new export filename; the existing destination is preserved.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const prepared = await prepareSnapshot(input.snapshot, input.readBlob);
  const temp = path.join(path.dirname(output), `.cairn-export-${randomUUID()}.tmp`);
  let fd: number | undefined,
    published = false,
    archive: Zip | undefined,
    bytes = 0,
    finalized = false;
  try {
    safeOutputParent(output);
    fd = fs.openSync(temp, 'wx', 0o600);
    archive = new Zip((error, data, final) => {
      if (error) throw error;
      if (data) {
        let offset = 0;
        while (offset < data.length) {
          const written = fs.writeSync(fd!, data, offset, data.length - offset);
          if (!written)
            throw new CairnError(
              'EXPORT_WRITE_FAILED',
              'The export could not be written completely.',
            );
          offset += written;
        }
        bytes += data.length;
      }
      if (final) finalized = true;
    });
    const add = (name: string, content: Uint8Array, directory = false) => {
      const entry = new ZipPassThrough(name);
      entry.mtime = new Date(
        Math.max(Date.UTC(1980, 0, 1), Math.min(Date.UTC(2099, 11, 31), prepared.createdAt)),
      );
      entry.os = 3;
      entry.attrs = directory ? (0o40755 << 16) | 16 : 0o100644 << 16;
      archive!.add(entry);
      entry.push(content, true);
    };
    for (const file of prepared.files)
      add(
        file.path + (file.kind === 'directory' ? '/' : ''),
        file.kind === 'directory' ? new Uint8Array() : await verifiedBlob(file, input.readBlob),
        file.kind === 'directory',
      );
    const entries = prepared.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      sha256: file.hash,
      size: file.size,
    }));
    add(
      SNAPSHOT_MANIFEST_NAME,
      Buffer.from(
        JSON.stringify(
          {
            format: 'cairn-snapshot',
            version: 1,
            revision: prepared.revision,
            createdAt: prepared.createdAt,
            contentHash: hash(JSON.stringify(entries)),
            files: entries,
          },
          null,
          2,
        ) + '\n',
      ),
    );
    archive.end();
    if (!finalized) throw new CairnError('EXPORT_WRITE_FAILED', 'The ZIP archive did not finish.');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    safeOutputParent(output);
    // Atomic no-replace publication. A competing writer's destination always wins.
    fs.linkSync(temp, output);
    published = true;
    try {
      fs.unlinkSync(temp);
    } catch {
      /* A complete extra recovery copy is harmless. */
    }
    return {
      path: output,
      files: prepared.files.filter((file) => file.kind !== 'directory').length,
      bytes,
    };
  } catch (error) {
    archive?.terminate();
    if (fd !== undefined) {
      try {
        fs.fsyncSync(fd);
      } catch {
        /* Preserve partial bytes too. */
      }
      fs.closeSync(fd);
    }
    const code = (error as NodeJS.ErrnoException).code;
    throw new SnapshotExportError(
      code === 'EEXIST'
        ? 'EXPORT_EXISTS'
        : error instanceof CairnError
          ? error.code
          : 'EXPORT_WRITE_FAILED',
      error instanceof CairnError
        ? error.message
        : 'The export was not completed; existing files and available recovery bytes were preserved.',
      !published && fs.existsSync(temp) ? temp : undefined,
    );
  }
}

export interface GitHubPreviewFile {
  path: string;
  action: 'add' | 'modify' | 'delete';
  kind: 'text' | 'binary';
  /** SHA-256 of snapshot bytes, null only for an explicitly selected deletion. */
  hash: string | null;
  size: number;
  beforeSha: string | null;
  mode: '100644' | '100755';
  diff: string | null;
  diffUnavailable?: string;
  selected: boolean;
}

/** Main retains this receipt. Renderer input should only select paths from it. */
export interface GitHubPreview {
  previewId: string;
  owner: string;
  repo: string;
  baseBranch: string;
  baseHead: string;
  baseTree: string;
  projectId: string;
  snapshotId: string;
  revision: number;
  createdAt: number;
  files: GitHubPreviewFile[];
  excluded: { path: string; reason: string }[];
  /** All immutable fields are covered; only file.selected may change after review. */
  digest: string;
}

export interface GitHubRequestOptions {
  apiBase?: string;
  /** Trusted test harness only. Never expose this option in renderer IPC. */
  allowTestApi?: boolean;
  /** Trusted dependency injection only; the default uses the built-in fetch. */
  transport?: typeof fetch;
}

export class GitHubExportError extends CairnError {
  status?: number;
  stage?: string;
  branch?: string;
  commit?: string;
  constructor(
    code: string,
    message: string,
    details: { status?: number; stage?: string; branch?: string; commit?: string } = {},
  ) {
    super(code, message);
    Object.assign(this, details);
  }
}

function validateTarget(owner: string, repo: string, baseBranch: string): void {
  if (
    typeof owner !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) ||
    typeof repo !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) ||
    repo === '.' ||
    repo === '..' ||
    typeof baseBranch !== 'string' ||
    !baseBranch ||
    baseBranch.length > 240 ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(baseBranch) ||
    baseBranch.includes('..') ||
    baseBranch.includes('@{') ||
    baseBranch === '@' ||
    baseBranch.startsWith('-') ||
    baseBranch
      .split('/')
      .some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  )
    throw new GitHubExportError(
      'GITHUB_TARGET_INVALID',
      'Enter a valid GitHub owner, repository, and base branch.',
    );
}

function checkedApiBase(options: GitHubRequestOptions): string {
  const base = options.apiBase ?? 'https://api.github.com';
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new GitHubExportError('GITHUB_API_INVALID', 'The GitHub API address is invalid.');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.origin === 'https://api.github.com' ||
      (options.allowTestApi === true &&
        url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw new GitHubExportError('GITHUB_API_INVALID', 'Only the official GitHub API is permitted.');
  return url.origin;
}

function githubClient(owner: string, repo: string, token: string, options: GitHubRequestOptions) {
  const base = checkedApiBase(options);
  if (typeof token !== 'string' || !token || token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(token))
    throw new GitHubExportError('GITHUB_AUTH', 'Provide a valid GitHub token.');
  const transport = options.transport ?? fetch;
  return async (
    method: 'GET' | 'POST',
    route: string,
    stage: string,
    body?: unknown,
  ): Promise<any> => {
    let response: Response;
    try {
      response = await transport(
        `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${route}`,
        {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2026-03-10',
            'User-Agent': 'Cairn-Next',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    } catch {
      throw new GitHubExportError(
        'GITHUB_NETWORK',
        'The GitHub request failed. Check the connection before retrying.',
        { stage },
      );
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* Never expose a server's reflected error body. */
      }
      const code =
        response.status === 401
          ? 'GITHUB_AUTH'
          : response.status === 403
            ? 'GITHUB_PERMISSION'
            : response.status === 404
              ? 'GITHUB_NOT_FOUND'
              : response.status === 429
                ? 'GITHUB_RATE_LIMIT'
                : 'GITHUB_API_ERROR';
      throw new GitHubExportError(
        code,
        response.status === 401
          ? 'GitHub rejected the token.'
          : response.status === 403
            ? 'The token lacks permission, or GitHub has temporarily restricted this request.'
            : 'GitHub could not complete the request. Review repository access and retry after checking its state.',
        { status: response.status, stage },
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new GitHubExportError('GITHUB_RESPONSE_INVALID', 'GitHub returned an empty response.', {
        stage,
      });
    const chunks: Uint8Array[] = [];
    let count = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        count += next.value.length;
        if (count > 24 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('limit');
        }
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks, count).toString('utf8'));
    } catch {
      throw new GitHubExportError(
        'GITHUB_RESPONSE_INVALID',
        'GitHub returned an invalid or oversized response.',
        { stage },
      );
    } finally {
      reader.releaseLock();
    }
  };
}

type GitHubClient = ReturnType<typeof githubClient>;
const branchRoute = (branch: string) =>
  `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
function gitSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}
function responseSha(value: unknown, stage: string): string {
  if (typeof value !== 'string' || !SHA1.test(value))
    throw new GitHubExportError(
      'GITHUB_RESPONSE_INVALID',
      'GitHub returned an invalid object identifier.',
      { stage },
    );
  return value;
}
async function branchHead(client: GitHubClient, branch: string): Promise<string> {
  const result = await client('GET', branchRoute(branch), 'base');
  if (result.ref !== `refs/heads/${branch}` || result.object?.type !== 'commit')
    throw new GitHubExportError(
      'GITHUB_RESPONSE_INVALID',
      'GitHub returned an unexpected branch.',
      { stage: 'base' },
    );
  return responseSha(result.object.sha, 'base');
}

interface RemoteEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}
async function remoteBlob(client: GitHubClient, entry: RemoteEntry): Promise<Uint8Array> {
  const response = await client('GET', `/git/blobs/${entry.sha}`, 'read-blob');
  if (
    response.sha !== entry.sha ||
    response.encoding !== 'base64' ||
    !Number.isSafeInteger(response.size) ||
    response.size < 0 ||
    response.size > MAX_BLOB_BYTES ||
    typeof response.content !== 'string'
  )
    throw new GitHubExportError(
      'GITHUB_RESPONSE_INVALID',
      'GitHub returned invalid file content.',
      { stage: 'read-blob' },
    );
  const encoded = response.content.replace(/[\r\n]/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new GitHubExportError(
      'GITHUB_RESPONSE_INVALID',
      'GitHub returned invalid base64 content.',
      { stage: 'read-blob' },
    );
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length !== response.size ||
    (entry.size !== undefined && bytes.length !== entry.size) ||
    gitSha(bytes) !== entry.sha
  )
    throw new GitHubExportError(
      'GITHUB_CONTENT_MISMATCH',
      'GitHub content failed its integrity check.',
      { stage: 'read-blob' },
    );
  return bytes;
}

function previewDigest(preview: Omit<GitHubPreview, 'digest'> | GitHubPreview): string {
  return hash(
    JSON.stringify({
      previewId: preview.previewId,
      owner: preview.owner,
      repo: preview.repo,
      baseBranch: preview.baseBranch,
      baseHead: preview.baseHead,
      baseTree: preview.baseTree,
      projectId: preview.projectId,
      snapshotId: preview.snapshotId,
      revision: preview.revision,
      createdAt: preview.createdAt,
      excluded: preview.excluded,
      files: preview.files.map(({ selected: _selected, ...file }) => file),
    }),
  );
}

export async function previewGitHub(
  input: GitHubRequestOptions & {
    snapshot: SnapshotManifest;
    readBlob: ReadExportBlob;
    owner: string;
    repo: string;
    baseBranch: string;
    token: string;
  },
): Promise<GitHubPreview> {
  const { owner, repo, baseBranch } = input;
  validateTarget(owner, repo, baseBranch);
  const client = githubClient(owner, repo, input.token, input);
  const prepared = await prepareSnapshot(input.snapshot, input.readBlob);
  const baseHead = await branchHead(client, baseBranch);
  const commit = await client('GET', `/git/commits/${baseHead}`, 'base-commit');
  if (commit.sha !== baseHead)
    throw new GitHubExportError('GITHUB_RESPONSE_INVALID', 'GitHub returned an unexpected commit.');
  const baseTree = responseSha(commit.tree?.sha, 'base-commit');
  const response = await client('GET', `/git/trees/${baseTree}?recursive=1`, 'base-tree');
  if (
    response.sha !== baseTree ||
    response.truncated !== false ||
    !Array.isArray(response.tree) ||
    response.tree.length > 100_000
  )
    throw new GitHubExportError(
      'GITHUB_TREE_INCOMPLETE',
      'The repository tree is incomplete or too large to preview safely.',
    );
  const remote = new Map<string, RemoteEntry>();
  for (const entry of response.tree as RemoteEntry[]) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      typeof entry.mode !== 'string' ||
      typeof entry.type !== 'string'
    )
      throw new GitHubExportError(
        'GITHUB_RESPONSE_INVALID',
        'GitHub returned an invalid tree entry.',
      );
    responseSha(entry.sha, 'base-tree');
    if (remote.has(entry.path))
      throw new GitHubExportError(
        'GITHUB_RESPONSE_INVALID',
        'GitHub returned duplicate tree entries.',
      );
    remote.set(entry.path, entry);
  }
  const files: GitHubPreviewFile[] = [],
    excluded = [...prepared.excluded];
  const localPaths = new Set(prepared.files.map((file) => file.path));
  const remoteFolded = new Map<string, string[]>();
  for (const entry of remote.values()) {
    const key = fold(entry.path),
      found = remoteFolded.get(key) ?? [];
    found.push(entry.path);
    remoteFolded.set(key, found);
  }
  let diffBytes = 0,
    remotePreviewBytes = 0;
  const record = async (file: ExportFile | null, entry: RemoteEntry | undefined) => {
    if (files.length >= MAX_ENTRIES)
      throw new GitHubExportError('SIZE_LIMIT', 'Too many changed files to preview safely.');
    const relative = file?.path ?? entry!.path;
    const local = file ? await verifiedBlob(file, input.readBlob) : null;
    if (local && entry && gitSha(local) === entry.sha) return;
    const oldBytes =
      entry &&
      (entry.size ?? Infinity) <= MAX_DIFF_BYTES &&
      remotePreviewBytes + (entry.size ?? Infinity) <= MAX_TOTAL_DIFF_BYTES
        ? await remoteBlob(client, entry)
        : null;
    remotePreviewBytes += oldBytes?.byteLength ?? 0;
    const kind = local
      ? classifyBytes(relative, local).kind
      : oldBytes
        ? classifyBytes(relative, oldBytes).kind
        : 'binary';
    let diff: string | null = null,
      diffUnavailable: string | undefined;
    if (
      kind === 'text' &&
      (!entry || oldBytes) &&
      (!local || local.length <= MAX_DIFF_BYTES) &&
      diffBytes < MAX_TOTAL_DIFF_BYTES
    ) {
      const before = oldBytes ? classifyBytes(relative, oldBytes) : null;
      if (before && before.kind !== 'text') diffUnavailable = 'The previous content is binary.';
      else {
        const patch = createTwoFilesPatch(
          entry ? `a/${relative}` : '/dev/null',
          file ? `b/${relative}` : '/dev/null',
          oldBytes ? Buffer.from(oldBytes).toString('utf8') : '',
          local ? Buffer.from(local).toString('utf8') : '',
          '',
          '',
          { context: 3, timeout: 100, maxEditLength: 10_000 },
        );
        if (
          patch !== undefined &&
          Buffer.byteLength(patch) <= MAX_DIFF_BYTES &&
          diffBytes + Buffer.byteLength(patch) <= MAX_TOTAL_DIFF_BYTES
        ) {
          diff = patch;
          diffBytes += Buffer.byteLength(patch);
        } else diffUnavailable = 'The text difference exceeds the preview limit.';
      }
    } else
      diffUnavailable =
        kind === 'binary'
          ? 'Binary content is preserved byte for byte.'
          : 'The text difference exceeds the preview limit.';
    files.push({
      path: relative,
      action: !file ? 'delete' : entry ? 'modify' : 'add',
      kind: kind === 'text' ? 'text' : 'binary',
      hash: file?.hash ?? null,
      size: file?.size ?? entry?.size ?? 0,
      beforeSha: entry?.sha ?? null,
      mode: entry?.mode === '100755' ? '100755' : '100644',
      diff,
      ...(diffUnavailable ? { diffUnavailable } : {}),
      selected: false,
    });
  };
  for (const file of prepared.files) {
    if (file.kind === 'directory') continue;
    const entry = remote.get(file.path);
    if (
      entry &&
      entry.type === 'blob' &&
      (!Number.isSafeInteger(entry.size) || entry.size! < 0 || entry.size! > MAX_BLOB_BYTES)
    ) {
      excluded.push({
        path: file.path,
        reason: 'The repository file exceeds the supported size limit.',
      });
      continue;
    }
    const components = file.path.split('/');
    let obstructed = false;
    for (let depth = 1; depth <= components.length; depth++) {
      const prefix = components.slice(0, depth).join('/'),
        at = remote.get(prefix),
        aliases = remoteFolded.get(fold(prefix));
      if (
        (aliases && (aliases.length !== 1 || aliases[0] !== prefix)) ||
        (at &&
          (depth < components.length
            ? at.type !== 'tree'
            : at.type !== 'blob' || !['100644', '100755'].includes(at.mode)))
      )
        obstructed = true;
    }
    if (obstructed) {
      excluded.push({
        path: file.path,
        reason: 'The repository contains a conflicting path, symlink, or submodule.',
      });
      continue;
    }
    await record(file, entry);
  }
  for (const entry of remote.values()) {
    if (localPaths.has(entry.path) || entry.type === 'tree') continue;
    let reason: string | undefined;
    try {
      validatePath(entry.path);
      reason = builtinExclusion(entry.path, false);
    } catch {
      reason = 'The repository path is not portable.';
    }
    if (!reason && (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)))
      reason = 'Symlinks and submodules are excluded.';
    if (
      !reason &&
      (!Number.isSafeInteger(entry.size) || entry.size! < 0 || entry.size! > MAX_BLOB_BYTES)
    )
      reason = 'The repository file exceeds the supported size limit.';
    if (!reason && ignoredBySnapshot(prepared, entry.path, false))
      reason = 'Excluded by snapshot ignore rules.';
    if (!reason && remoteFolded.get(fold(entry.path))!.length !== 1)
      reason = 'The repository has case-colliding paths.';
    if (reason) {
      excluded.push({ path: entry.path, reason });
      continue;
    }
    // Remote-only files are candidates, never implicit deletions.
    await record(null, entry);
  }
  if (files.length > MAX_ENTRIES)
    throw new GitHubExportError('SIZE_LIMIT', 'Too many changed files to preview safely.');
  if ((await branchHead(client, baseBranch)) !== baseHead)
    throw new GitHubExportError(
      'GITHUB_BASE_CHANGED',
      'The base branch changed during preview. Create a fresh preview.',
    );
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const preview: GitHubPreview = {
    previewId: randomUUID(),
    owner,
    repo,
    baseBranch,
    baseHead,
    baseTree,
    projectId: prepared.projectId,
    snapshotId: prepared.id,
    revision: prepared.revision,
    createdAt: Date.now(),
    files,
    excluded,
    digest: '',
  };
  preview.digest = previewDigest(preview);
  return preview;
}

export async function publishGitHub(
  input: GitHubRequestOptions & {
    preview: GitHubPreview;
    readBlob: ReadExportBlob;
    token: string;
    title: string;
    body: string;
    selectedPaths?: string[];
  },
): Promise<{ url: string; branch: string }> {
  const { title, body } = input;
  // Copy before awaiting; edits to the UI's original object cannot alter a running publication.
  let preview: GitHubPreview;
  try {
    preview = structuredClone(input.preview);
  } catch {
    throw new GitHubExportError('GITHUB_PREVIEW_INVALID', 'Create a fresh GitHub preview.');
  }
  if (
    !preview ||
    !Array.isArray(preview.files) ||
    preview.files.some((file) => !file || typeof file !== 'object') ||
    preview.files.length > MAX_ENTRIES ||
    !SHA256.test(preview.digest) ||
    previewDigest(preview) !== preview.digest
  )
    throw new GitHubExportError(
      'GITHUB_PREVIEW_CHANGED',
      'The preview changed. Review a fresh preview before publishing.',
    );
  validateTarget(preview.owner, preview.repo, preview.baseBranch);
  responseSha(preview.baseHead, 'preview');
  responseSha(preview.baseTree, 'preview');
  if (
    typeof title !== 'string' ||
    !title.trim() ||
    title.length > 256 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(title) ||
    typeof body !== 'string' ||
    body.length > 65_536
  )
    throw new GitHubExportError(
      'GITHUB_PR_INVALID',
      'Provide a pull request title and a body within GitHub limits.',
    );
  if (input.selectedPaths !== undefined) {
    if (
      !Array.isArray(input.selectedPaths) ||
      input.selectedPaths.length > MAX_ENTRIES ||
      input.selectedPaths.some((value) => typeof value !== 'string') ||
      new Set(input.selectedPaths).size !== input.selectedPaths.length ||
      input.selectedPaths.some((value) => !preview.files.some((file) => file.path === value))
    )
      throw new GitHubExportError(
        'GITHUB_SELECTION_INVALID',
        'Select only files from this preview.',
      );
    const paths = new Set(input.selectedPaths);
    for (const file of preview.files) file.selected = paths.has(file.path);
  }
  const selected = preview.files.filter((file) => file.selected === true);
  if (!selected.length)
    throw new GitHubExportError(
      'GITHUB_SELECTION_EMPTY',
      'Select at least one reviewed change to publish.',
    );
  for (const file of selected) {
    validatePath(file.path);
    if (
      builtinExclusion(file.path, false) ||
      !['add', 'modify', 'delete'].includes(file.action) ||
      !['text', 'binary'].includes(file.kind) ||
      !['100644', '100755'].includes(file.mode) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_BLOB_BYTES ||
      (file.action === 'delete'
        ? file.hash !== null || !SHA1.test(file.beforeSha ?? '')
        : !SHA256.test(file.hash ?? '')) ||
      (file.action === 'add' ? file.beforeSha !== null : !SHA1.test(file.beforeSha ?? ''))
    )
      throw new GitHubExportError(
        'GITHUB_PREVIEW_INVALID',
        'The selected change is not safe to publish.',
      );
  }
  validateCollisions(selected.map((file) => ({ path: file.path, kind: file.kind })));
  const client = githubClient(preview.owner, preview.repo, input.token, input);
  const checkBase = async () => {
    if ((await branchHead(client, preview.baseBranch)) !== preview.baseHead)
      throw new GitHubExportError(
        'GITHUB_BASE_CHANGED',
        'The base branch changed. Review a fresh preview before publishing.',
      );
  };
  await checkBase();
  const commit = await client('GET', `/git/commits/${preview.baseHead}`, 'verify-commit');
  if (commit.sha !== preview.baseHead || commit.tree?.sha !== preview.baseTree)
    throw new GitHubExportError(
      'GITHUB_PREVIEW_CHANGED',
      'The preview base tree no longer matches GitHub.',
    );
  const contents = new Map<string, Uint8Array>();
  let total = 0;
  for (const file of selected) {
    if (file.action === 'delete') continue;
    total += file.size;
    if (total > MAX_PROJECT_BYTES)
      throw new GitHubExportError('SIZE_LIMIT', 'The selected content exceeds the project limit.');
    contents.set(
      file.path,
      await verifiedBlob({ hash: file.hash!, size: file.size }, input.readBlob),
    );
  }
  // Validate every selected blob before making the first remote write.
  await checkBase();
  let branch: string | undefined, commitSha: string | undefined;
  try {
    const tree: { path: string; mode: string; type: 'blob'; sha: string | null }[] = [];
    for (const file of selected) {
      let sha: string | null = null;
      if (file.action !== 'delete') {
        const bytes = contents.get(file.path)!;
        const blob = await client('POST', '/git/blobs', 'create-blob', {
          content: Buffer.from(bytes).toString('base64'),
          encoding: 'base64',
        });
        sha = responseSha(blob.sha, 'create-blob');
        if (sha !== gitSha(bytes))
          throw new GitHubExportError(
            'GITHUB_CONTENT_MISMATCH',
            'GitHub did not acknowledge the uploaded bytes.',
          );
      }
      tree.push({ path: file.path, mode: file.mode, type: 'blob', sha });
    }
    const treeResult = await client('POST', '/git/trees', 'create-tree', {
      base_tree: preview.baseTree,
      tree,
    });
    const treeSha = responseSha(treeResult.sha, 'create-tree');
    const commitResult = await client('POST', '/git/commits', 'create-commit', {
      message: title.trim(),
      tree: treeSha,
      parents: [preview.baseHead],
    });
    commitSha = responseSha(commitResult.sha, 'create-commit');
    await checkBase();
    for (let attempt = 0; attempt < 4; attempt++) {
      branch = `cairn-export-r${preview.revision}-${randomUUID()}`;
      try {
        const ref = await client('POST', '/git/refs', 'create-branch', {
          ref: `refs/heads/${branch}`,
          sha: commitSha,
        });
        if (ref.ref !== `refs/heads/${branch}` || ref.object?.sha !== commitSha)
          throw new GitHubExportError(
            'GITHUB_RESPONSE_INVALID',
            'GitHub did not acknowledge the new branch.',
          );
        break;
      } catch (error) {
        if (!(error instanceof GitHubExportError) || error.status !== 422 || attempt === 3)
          throw error;
        // A 422 is retried only when that exact random branch actually exists.
        await branchHead(client, branch);
        branch = undefined;
      }
    }
    if (!branch)
      throw new GitHubExportError(
        'GITHUB_BRANCH_COLLISION',
        'A fresh branch could not be created.',
      );
    await checkBase();
    if ((await branchHead(client, branch)) !== commitSha)
      throw new GitHubExportError(
        'GITHUB_BRANCH_CHANGED',
        'The new branch changed before pull request creation.',
      );
    const pr = await client('POST', '/pulls', 'create-pr', {
      title: title.trim(),
      body,
      head: branch,
      base: preview.baseBranch,
    });
    let url: URL;
    try {
      url = new URL(pr.html_url);
    } catch {
      throw new GitHubExportError(
        'GITHUB_RESPONSE_INVALID',
        'GitHub did not return a valid pull request link.',
      );
    }
    const expectedPrefix = `/${preview.owner}/${preview.repo}/pull/`;
    if (
      url.origin !== 'https://github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(expectedPrefix) ||
      !/^[1-9]\d*$/.test(url.pathname.slice(expectedPrefix.length))
    )
      throw new GitHubExportError(
        'GITHUB_RESPONSE_INVALID',
        'GitHub returned an unexpected pull request link.',
      );
    return { url: url.href, branch };
  } catch (error) {
    // Git objects and a possibly-created branch remain recoverable. Never delete a ref.
    if (error instanceof GitHubExportError) {
      error.branch = branch;
      error.commit = commitSha;
      throw error;
    }
    throw new GitHubExportError(
      'GITHUB_PUBLISH_FAILED',
      'Publication stopped. Check the preserved branch before retrying.',
      { branch, commit: commitSha },
    );
  }
}
