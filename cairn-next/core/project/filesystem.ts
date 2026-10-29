import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import ignore, { type Ignore } from 'ignore';
import { CairnError, hash, readBounded, writeDurable } from '../common.js';
import { MAX_TEXT_BYTES } from '../../shared/types.js';

export const MAX_BLOB_BYTES = 16 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRIES = 5000;

export interface ScannedEntry {
  path: string;
  kind: 'text' | 'binary' | 'directory';
  bytes?: Uint8Array;
  lineEnding?: 'lf' | 'crlf';
  reason?: string;
}
export interface ProjectProjectionResult {
  state: 'applied' | 'blocked' | 'error';
  hash?: string;
  error?: string;
  recovery?: string;
}

const MAX_PATH_BYTES = 1024;
const MAX_IGNORE_BYTES = MAX_TEXT_BYTES;
const MAX_INTENT_BYTES = 8192;
const blockedDirectories = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.svelte-kit',
  '.vercel',
  '.netlify',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  '.gradle',
  'tmp',
  'temp',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.gcloud',
]);
const binaryExtensions = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'icns',
  'tif',
  'tiff',
  'svg',
  'psd',
  'ai',
  'eps',
  'heic',
  'raw',
  'pdf',
  'doc',
  'docx',
  'docm',
  'dotx',
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  'ppt',
  'pptx',
  'pptm',
  'odt',
  'ods',
  'odp',
  'pages',
  'numbers',
  'keynote',
  'rtf',
  'mp3',
  'mp4',
  'm4a',
  'm4v',
  'wav',
  'ogg',
  'flac',
  'aac',
  'aiff',
  'avi',
  'mov',
  'webm',
  'mkv',
  'wmv',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'zip',
  'gz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'tar',
  'jar',
  'exe',
  'dll',
  'so',
  'dylib',
  'wasm',
  'bin',
  'db',
  'sqlite',
  'sqlite3',
  'pak',
  'glb',
  'fbx',
  'blend',
  'unitypackage',
  'apk',
  'aab',
  'ipa',
  'dmg',
  'iso',
]);

/** A portable, conservative Unicode caseless key (including sharp-s and final sigma). */
const folded = (value: string): string => value.toUpperCase().toLowerCase().normalize('NFC');
const sameNativePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function unsafe(message: string): never {
  throw new CairnError('UNSAFE_PATH', message);
}
function portableParts(relative: string): string[] {
  if (
    typeof relative !== 'string' ||
    !relative ||
    !relative.isWellFormed() ||
    relative !== relative.normalize('NFC') ||
    Buffer.byteLength(relative) > MAX_PATH_BYTES ||
    /[\\\x00-\x1f\x7f:*?"<>|]/.test(relative) ||
    relative.startsWith('/') ||
    relative.endsWith('/')
  )
    unsafe('Use a portable, NFC-normalized relative path with forward slashes.');
  const parts = relative.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        Buffer.byteLength(part) > 255 ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    )
  )
    unsafe('This path contains an empty, reserved, or non-portable name.');
  return parts;
}
function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Check every absolute ancestor: testing only the final component misses junctions. */
function safeAbsolute(target: string, allowMissing: boolean, directoryOnly = false): void {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const segments = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  const rootStat = statOrNull(root);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink())
    unsafe('Unsafe filesystem root.');
  for (let i = 0; i < segments.length; i++) {
    const next = path.join(current, segments[i]);
    const info = statOrNull(next);
    if (!info) {
      if (allowMissing) {
        if (!sameNativePath(fs.realpathSync.native(current), current))
          unsafe('Redirected paths are excluded.');
        return;
      }
      throw new CairnError('MISSING_PATH', 'The project path no longer exists.');
    }
    current = next;
    if (info.isSymbolicLink())
      unsafe('Symbolic links, junctions, and redirected paths are excluded.');
    if ((i < segments.length - 1 || directoryOnly) && !info.isDirectory())
      unsafe('A path ancestor is not a normal directory.');
    if (!info.isDirectory() && !info.isFile())
      unsafe('Only ordinary files and directories are supported.');
  }
  // One native resolution checks the complete chain after every ancestor's lstat.
  if (!sameNativePath(fs.realpathSync.native(current), current))
    unsafe('Redirected paths are excluded.');
}

function builtinReason(parts: string[], isDirectory: boolean): string | undefined {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].toLowerCase();
    if (part.startsWith('.cairn')) return 'Private Cairn metadata is excluded.';
    if (
      /^\.env(?:[._-]|$)/.test(part) ||
      /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials|credentials\.json)$/i.test(
        part,
      ) ||
      /\.(?:pem|key|pfx|p12|jks|keystore)$/i.test(part)
    )
      return 'Secret and credential files are excluded.';
    if (blockedDirectories.has(part))
      return 'Dependency, build, temporary, or private directories are excluded.';
    if (
      part === '.ds_store' ||
      part === 'thumbs.db' ||
      part === 'desktop.ini' ||
      /(?:\.(?:tmp|temp|swp|swo)|~)$/.test(part) ||
      part.startsWith('~$') ||
      part.startsWith('.#') ||
      (part.startsWith('#') && part.endsWith('#'))
    )
      return 'Temporary and operating-system files are excluded.';
  }
  return undefined;
}

/** Validate immutable manifest paths without consulting a live working directory. */
export function validateProjectPath(relative: string): string {
  return portableParts(relative).join('/');
}

/** Default exclusions are invariant for live projects, snapshots, sync, and exports. */
export function builtinExclusion(relative: string, isDirectory = false): string | undefined {
  return builtinReason(portableParts(relative), isDirectory);
}

interface IgnoreContext {
  base: number;
  matcher: Ignore;
}
function assertNotIgnored(
  parts: string[],
  isDirectory: boolean,
  matchers: IgnoreContext[],
  extra: Ignore,
): void {
  const suffix = isDirectory ? '/' : '';
  if (extra.ignores(parts.join('/') + suffix))
    throw new CairnError('IGNORED_PATH', 'Excluded by project ignore patterns.');
  let ignored = false;
  for (const entry of matchers) {
    const result = entry.matcher.test(parts.slice(entry.base).join('/') + suffix);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  if (ignored) throw new CairnError('IGNORED_PATH', 'Excluded by .gitignore.');
}

/** Classification always inspects bytes; a text extension cannot disguise binary data. */
export function classifyBytes(
  relative: string,
  bytes: Uint8Array,
): Omit<ScannedEntry, 'path' | 'bytes'> {
  if (bytes.byteLength > MAX_BLOB_BYTES)
    throw new CairnError('FILE_SIZE_LIMIT', 'The file exceeds the 16 MiB transfer limit.');
  const extension = relative.split('.').pop()?.toLowerCase() ?? '';
  if (binaryExtensions.has(extension))
    return { kind: 'binary', reason: 'This format is shared as a binary file.' };
  if (bytes.byteLength > MAX_TEXT_BYTES)
    return {
      kind: 'binary',
      reason: 'Files larger than 1 MiB are shared as binary and are not collaboratively edited.',
    };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { kind: 'binary', reason: 'The original byte-order mark is preserved in binary mode.' };
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'binary', reason: 'The file is not valid UTF-8 text.' };
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    return {
      kind: 'binary',
      reason: 'Binary control bytes are preserved without text conversion.',
    };
  if (/\r(?!\n)/.test(value) || (value.includes('\r\n') && /(?<!\r)\n/.test(value)))
    return {
      kind: 'binary',
      reason: 'Mixed or unsupported line endings are preserved in binary mode.',
    };
  return { kind: 'text', lineEnding: value.includes('\r\n') ? 'crlf' : 'lf' };
}

export class ProjectPolicy {
  readonly root: string;
  private extraPatterns: string[] = [];
  private extra: Ignore = ignore();
  private ignoreFileResolver?: (relative: string) => string | undefined;

  constructor(root: string, extraPatterns: string[] = []) {
    this.root = path.resolve(root);
    safeAbsolute(this.root, false, true);
    this.refresh(extraPatterns);
  }

  refresh(extraPatterns?: string[]): void {
    if (extraPatterns !== undefined) {
      if (
        !Array.isArray(extraPatterns) ||
        extraPatterns.length > 5000 ||
        extraPatterns.some((pattern) => typeof pattern !== 'string' || pattern.length > 4096) ||
        Buffer.byteLength(extraPatterns.join('\n')) > MAX_IGNORE_BYTES
      )
        throw new CairnError('INVALID_IGNORE', 'Ignore patterns exceed the supported limit.');
      this.extraPatterns = [...extraPatterns];
    }
    this.extra = ignore().add(this.extraPatterns);
    safeAbsolute(this.root, false, true);
  }

  /** A store can use its canonical catalog before disk projection catches up.
   * Undefined from an installed resolver means absent, never a fallback to stale disk.
   * Read current transaction state in the callback so rollback restores policy too. */
  setIgnoreFileResolver(resolver?: (relative: string) => string | undefined): void {
    if (resolver !== undefined && typeof resolver !== 'function')
      throw new CairnError('INVALID_IGNORE', 'The ignore-file resolver must be a function.');
    this.ignoreFileResolver = resolver;
  }

  private ignoreMatcher(relative: string): Ignore | undefined {
    let text: string;
    if (this.ignoreFileResolver) {
      const canonical = this.ignoreFileResolver(relative);
      if (canonical === undefined) return undefined;
      if (
        typeof canonical !== 'string' ||
        !canonical.isWellFormed() ||
        Buffer.byteLength(canonical) > MAX_IGNORE_BYTES
      )
        throw new CairnError(
          'INVALID_IGNORE',
          'Canonical .gitignore content is invalid or too large.',
        );
      text = canonical;
    } else {
      const target = path.join(this.root, ...portableParts(relative));
      if (!statOrNull(target)) return undefined;
      safeAbsolute(target, false);
      text = new TextDecoder('utf-8', { fatal: true }).decode(
        readBounded(target, MAX_IGNORE_BYTES),
      );
    }
    return ignore().add(text);
  }

  private evaluate(relative: string, isDirectory: boolean, caseAlias?: string): void {
    const parts = portableParts(relative);
    const builtIn = builtinReason(parts, isDirectory);
    if (builtIn) throw new CairnError('EXCLUDED_PATH', builtIn);
    safeAbsolute(this.root, false, true);
    const matchers: IgnoreContext[] = [];
    for (let depth = 0; depth < parts.length; depth++) {
      const parent = path.join(this.root, ...parts.slice(0, depth));
      safeAbsolute(parent, true, true);
      const parentStat = statOrNull(parent);
      if (parentStat) {
        const names = fs.readdirSync(parent);
        const matches = names.filter((name) => folded(name) === folded(parts[depth]));
        const aliasParts = caseAlias?.split('/');
        const permittedAlias =
          aliasParts &&
          folded(relative) === folded(caseAlias!) &&
          matches.length === 1 &&
          matches[0] === aliasParts[depth];
        if (
          matches.length > 1 ||
          (matches.length === 1 && matches[0] !== parts[depth] && !permittedAlias)
        )
          throw new CairnError(
            'CASE_COLLISION',
            'A portable case-insensitive path collision was found.',
          );
      }
      const matcher = this.ignoreMatcher([...parts.slice(0, depth), '.gitignore'].join('/'));
      if (matcher) matchers.push({ base: depth, matcher });
      const directory = depth < parts.length - 1 || isDirectory;
      assertNotIgnored(parts.slice(0, depth + 1), directory, matchers, this.extra);
    }
    safeAbsolute(path.join(this.root, ...parts), true, isDirectory);
  }

  resolve(relative: string, { allowMissing = false }: { allowMissing?: boolean } = {}): string {
    const parts = portableParts(relative);
    const target = path.join(this.root, ...parts);
    // Existing directories must use directory ignore semantics even without a trailing slash.
    safeAbsolute(target, allowMissing);
    this.evaluate(relative, statOrNull(target)?.isDirectory() ?? false);
    if (!allowMissing && !statOrNull(target))
      throw new CairnError('MISSING_PATH', 'The project path no longer exists.');
    return target;
  }

  check(relative: string, isDirectory = false): { allowed: boolean; reason?: string } {
    try {
      const parts = portableParts(relative);
      const target = path.join(this.root, ...parts);
      safeAbsolute(target, true);
      this.evaluate(relative, isDirectory || (statOrNull(target)?.isDirectory() ?? false));
      return { allowed: true };
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : 'The path is excluded.',
      };
    }
  }

  /** Used only by a projection that has independently checked its exact rename source. */
  resolveRenameTarget(relative: string, source: string): string {
    const parts = portableParts(relative);
    portableParts(source);
    this.evaluate(relative, false, source);
    return path.join(this.root, ...parts);
  }

  scan(): { entries: ScannedEntry[]; excluded: { path: string; reason: string }[] } {
    const entries: ScannedEntry[] = [];
    const excluded: { path: string; reason: string }[] = [];
    let total = 0;
    let visited = 0;
    const visit = (directory: string, prefix: string, inherited: IgnoreContext[]): void => {
      safeAbsolute(directory, false, true);
      const items = fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name, 'en'));
      const siblingCounts = new Map<string, number>();
      for (const item of items)
        siblingCounts.set(folded(item.name), (siblingCounts.get(folded(item.name)) ?? 0) + 1);
      const matchers = [...inherited];
      let ignoreError: string | undefined;
      try {
        const matcher = this.ignoreMatcher(prefix ? `${prefix}/.gitignore` : '.gitignore');
        if (matcher) {
          matchers.push({
            base: prefix ? prefix.split('/').length : 0,
            matcher,
          });
        }
      } catch {
        ignoreError =
          'The directory’s .gitignore could not be read safely; its contents stay local.';
      }
      for (const item of items) {
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        // Bound traversal, including excluded entries, without reading their contents.
        if (++visited > MAX_ENTRIES * 4) {
          excluded.push({
            path: prefix || '.',
            reason: 'The directory scan limit was reached; remaining files stay on disk.',
          });
          return;
        }
        if (entries.length >= MAX_ENTRIES) {
          excluded.push({
            path: relative,
            reason: 'The project entry limit is 5000; this entry stays on disk.',
          });
          continue;
        }
        try {
          if (ignoreError) throw new CairnError('INVALID_IGNORE', ignoreError);
          const parts = portableParts(relative);
          const reason = builtinReason(parts, item.isDirectory());
          if (reason) throw new CairnError('EXCLUDED_PATH', reason);
          if (siblingCounts.get(folded(item.name))! > 1)
            throw new CairnError(
              'CASE_COLLISION',
              'A portable case-insensitive path collision was found.',
            );
          const target = path.join(this.root, ...parts);
          // Scan shares the exact ignore evaluator, but reads each directory's ignore
          // file once. Every content read still verifies the complete live ancestor chain.
          safeAbsolute(target, false);
          const info = fs.lstatSync(target);
          assertNotIgnored(parts, info.isDirectory(), matchers, this.extra);
          if (info.isDirectory()) {
            entries.push({ path: relative, kind: 'directory' });
            visit(target, relative, matchers);
          } else {
            const bytes = readBounded(target, MAX_BLOB_BYTES);
            if (total + bytes.byteLength > MAX_PROJECT_BYTES) {
              excluded.push({
                path: relative,
                reason: 'The project content limit is 256 MiB; this file stays on disk.',
              });
              continue;
            }
            entries.push({ path: relative, bytes, ...classifyBytes(relative, bytes) });
            total += bytes.byteLength;
          }
        } catch (error) {
          excluded.push({
            path: relative,
            reason:
              error instanceof CairnError && error.code === 'FILE_SIZE_LIMIT'
                ? 'The file exceeds 16 MiB; the original stays on disk.'
                : error instanceof Error
                  ? error.message
                  : 'The file could not be read safely.',
          });
        }
      }
    };
    visit(this.root, '', []);
    return { entries, excluded };
  }
}

function recoveryDirectory(policy: ProjectPolicy, input: string): string {
  const target = path.resolve(input);
  const relative = path.relative(policy.root, target);
  const parts = relative.split(path.sep);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    parts[0] !== '.cairn-next' ||
    parts.length < 2 ||
    parts.some((part) => !part || part === '.' || part === '..') ||
    parts.some((part) => !/^[a-zA-Z0-9._-]+$/.test(part))
  )
    unsafe('Recovery must be a private directory inside this project’s .cairn-next directory.');
  safeAbsolute(policy.root, false, true);
  let current = policy.root;
  for (const part of parts) {
    current = path.join(current, part);
    safeAbsolute(current, true, true);
    if (!statOrNull(current)) fs.mkdirSync(current, { mode: 0o700 });
    safeAbsolute(current, false, true);
  }
  return target;
}

function preserve(recovery: string, bytes: Uint8Array, prefix = 'version'): string {
  safeAbsolute(recovery, false, true);
  const target = path.join(recovery, `${prefix}-${hash(bytes)}.bin`);
  if (!statOrNull(target)) writeDurable(target, bytes);
  safeAbsolute(target, false);
  if (hash(readBounded(target, MAX_BLOB_BYTES)) !== hash(bytes))
    throw new CairnError('RECOVERY_MISMATCH', 'A recovery file was changed; projection is paused.');
  return target;
}
function readCurrent(policy: ProjectPolicy, relative: string): Buffer | null {
  const target = policy.resolve(relative, { allowMissing: true });
  return statOrNull(target) ? readBounded(target, MAX_BLOB_BYTES) : null;
}
function exactPathExists(policy: ProjectPolicy, relative: string): boolean {
  let current = policy.root;
  for (const part of portableParts(relative)) {
    safeAbsolute(current, false, true);
    if (!fs.readdirSync(current).includes(part)) return false;
    current = path.join(current, part);
  }
  safeAbsolute(current, false);
  return true;
}
function mkdirParents(policy: ProjectPolicy, relative: string): void {
  const parts = portableParts(relative);
  for (let i = 1; i < parts.length; i++) {
    const name = parts.slice(0, i).join('/');
    const checked = policy.check(name, true);
    if (!checked.allowed) throw new CairnError('EXCLUDED_PATH', checked.reason!);
    const target = policy.resolve(name, { allowMissing: true });
    if (!statOrNull(target)) {
      try {
        fs.mkdirSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    safeAbsolute(target, false, true);
  }
}

interface Intent {
  version: 1;
  operation: 'write' | 'delete';
  source: string;
  target: string;
  expectedHash: string | null;
  targetHash: string | null;
  backup: string;
  frozen?: string;
  temp?: string;
}
const intentPrefix = (intent: Omit<Intent, 'version' | 'backup' | 'frozen' | 'temp'>): string =>
  `intent-${hash(JSON.stringify(intent))}-`;

function restoreNoReplace(policy: ProjectPolicy, relative: string, backup: string): void {
  const target = policy.resolve(relative, { allowMissing: true });
  if (statOrNull(target)) return;
  safeAbsolute(backup, false);
  const info = fs.lstatSync(backup);
  if (!info.isFile()) unsafe('The moved recovery object is not a regular file.');
  try {
    // Bounded reads also cover a file growing through an editor's still-open handle.
    const bytes = readBounded(backup, MAX_BLOB_BYTES);
    const temp = path.join(path.dirname(backup), `restore-${randomUUID()}.bin`);
    writeDurable(temp, bytes);
    try {
      fs.linkSync(temp, policy.resolve(relative, { allowMissing: true }));
    } finally {
      fs.unlinkSync(temp);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    if (error instanceof CairnError && error.code === 'FILE_SIZE_LIMIT') {
      // Do not read/copy an unbounded raced file. A no-replace link returns it to disk.
      try {
        fs.linkSync(backup, policy.resolve(relative, { allowMissing: true }));
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError;
      }
      return;
    }
    throw error;
  }
}

function recoverMissingSource(
  policy: ProjectPolicy,
  recovery: string,
  intent: Omit<Intent, 'version' | 'backup' | 'frozen' | 'temp'>,
): void {
  if (
    intent.expectedHash === null ||
    statOrNull(policy.resolve(intent.source, { allowMissing: true }))
  )
    return;
  const prefix = intentPrefix(intent);
  safeAbsolute(recovery, false, true);
  for (const name of fs.readdirSync(recovery)) {
    if (!name.startsWith(prefix) || !/^intent-[a-f0-9]{64}-[a-f0-9-]{36}\.json$/.test(name))
      continue;
    let saved: Intent;
    try {
      const intentFile = path.join(recovery, name);
      safeAbsolute(intentFile, false);
      saved = JSON.parse(readBounded(intentFile, MAX_INTENT_BYTES).toString('utf8')) as Intent;
    } catch {
      continue;
    }
    if (
      saved.version !== 1 ||
      saved.operation !== intent.operation ||
      saved.source !== intent.source ||
      saved.target !== intent.target ||
      saved.expectedHash !== intent.expectedHash ||
      saved.targetHash !== intent.targetHash ||
      typeof saved.backup !== 'string' ||
      !/^moved-[a-f0-9-]{36}\.bin$/.test(saved.backup)
    )
      continue;
    const backup = path.join(recovery, saved.backup);
    if (!statOrNull(backup)) continue;
    restoreNoReplace(policy, intent.source, backup);
    return;
  }
}

function resultError(error: unknown, recovery?: string): ProjectProjectionResult {
  const code = (error as NodeJS.ErrnoException)?.code;
  return {
    state:
      error instanceof CairnError ||
      ['EEXIST', 'ENOENT', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR'].includes(code ?? '')
        ? 'blocked'
        : 'error',
    error:
      error instanceof CairnError
        ? error.message
        : code === 'EEXIST'
          ? 'An external file appeared at the destination. All versions were preserved.'
          : code === 'ENOSPC'
            ? 'There is not enough disk space; preserved versions remain available.'
            : 'The filesystem operation could not complete. Existing and recovery files were preserved.',
    ...(recovery ? { recovery } : {}),
  };
}
function validExpected(expected: string | null): void {
  if (expected !== null && !/^[a-f0-9]{64}$/.test(expected))
    throw new CairnError('INVALID_HASH', 'Expected content must be a SHA-256 hash or null.');
}

export function projectBytes(
  policy: ProjectPolicy,
  input: {
    path: string;
    bytes: Uint8Array;
    expectedHash: string | null;
    recoveryDir: string;
    previousPath?: string;
  },
): ProjectProjectionResult {
  let backup: string | undefined;
  try {
    validExpected(input.expectedHash);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > MAX_BLOB_BYTES)
      throw new CairnError('FILE_SIZE_LIMIT', 'The file exceeds the 16 MiB transfer limit.');
    const bytes = Buffer.from(input.bytes);
    const desired = hash(bytes);
    const source = input.previousPath ?? input.path;
    const renaming = source !== input.path;
    const caseOnly = renaming && folded(source) === folded(input.path);
    if (caseOnly && !exactPathExists(policy, source) && exactPathExists(policy, input.path)) {
      const current = readCurrent(policy, input.path);
      return current && hash(current) === desired
        ? { state: 'applied', hash: desired }
        : { state: 'blocked', error: 'The rename destination changed outside Cairn.' };
    }
    // Parent-directory casing changes are directory operations, not a file rename.
    if (
      renaming &&
      source.split('/').slice(0, -1).join('/') !== input.path.split('/').slice(0, -1).join('/') &&
      folded(source.split('/').slice(0, -1).join('/')) ===
        folded(input.path.split('/').slice(0, -1).join('/'))
    )
      throw new CairnError(
        'CASE_COLLISION',
        'Rename directory casing separately before moving its files.',
      );
    policy.resolve(source, { allowMissing: true });
    policy.resolveRenameTarget(input.path, source);
    const recovery = recoveryDirectory(policy, input.recoveryDir);
    const intentBase = {
      operation: 'write' as const,
      source,
      target: input.path,
      expectedHash: input.expectedHash,
      targetHash: desired,
    };
    if (renaming && !caseOnly && statOrNull(policy.resolve(input.path, { allowMissing: true }))) {
      // A completed rename can be retried; an existing source means this is a collision.
      if (
        !statOrNull(policy.resolve(source, { allowMissing: true })) &&
        hash(readCurrent(policy, input.path)!) === desired
      )
        return { state: 'applied', hash: desired };
      return {
        state: 'blocked',
        error: 'The rename destination already exists. Both files were preserved.',
      };
    }
    recoverMissingSource(policy, recovery, intentBase);
    const existing = readCurrent(policy, source);
    const actual = existing === null ? null : hash(existing);
    if (!renaming && actual === desired) return { state: 'applied', hash: desired };
    if (actual !== input.expectedHash)
      return {
        state: 'blocked',
        error: 'The file changed outside Cairn. Both versions were preserved.',
        ...(existing ? { recovery: preserve(recovery, existing, 'external') } : {}),
      };
    if (renaming && existing === null)
      return {
        state: 'blocked',
        error:
          'The rename source is missing. The requested content remains preserved by the project.',
      };
    mkdirParents(policy, input.path);
    const id = randomUUID();
    const tempName = `write-${id}.bin`;
    const backupName = `moved-${id}.bin`;
    const temp = path.join(recovery, tempName);
    backup = path.join(recovery, backupName);
    const frozen = existing === null ? undefined : path.basename(preserve(recovery, existing));
    const intentFile = path.join(recovery, `${intentPrefix(intentBase)}${id}.json`);
    safeAbsolute(recovery, false, true);
    writeDurable(temp, bytes);
    writeDurable(
      intentFile,
      JSON.stringify({
        version: 1,
        ...intentBase,
        backup: backupName,
        frozen,
        temp: tempName,
      } satisfies Intent),
    );
    // This read is immediately before the move, after all potentially slow durable writes.
    const latest = readCurrent(policy, source);
    if ((latest === null ? null : hash(latest)) !== input.expectedHash)
      return {
        state: 'blocked',
        error: 'An external save happened before projection. All versions were preserved.',
        ...(latest ? { recovery: preserve(recovery, latest, 'external') } : {}),
      };
    if (existing !== null) {
      safeAbsolute(recovery, false, true);
      if (statOrNull(backup)) unsafe('The recovery destination is already occupied.');
      fs.renameSync(policy.resolve(source), backup);
      safeAbsolute(backup, false);
      try {
        if (hash(readBounded(backup, MAX_BLOB_BYTES)) !== input.expectedHash) {
          restoreNoReplace(policy, source, backup);
          return {
            state: 'blocked',
            error: 'An external save raced with projection. The moved file was preserved.',
            recovery: backup,
          };
        }
      } catch (error) {
        restoreNoReplace(policy, source, backup);
        return resultError(error, backup);
      }
    }
    const target = policy.resolve(input.path, { allowMissing: true });
    safeAbsolute(temp, false);
    // link is atomic and never replaces a destination created by an external editor.
    fs.linkSync(temp, target);
    fs.unlinkSync(temp);
    if (hash(readBounded(policy.resolve(input.path), MAX_BLOB_BYTES)) !== desired)
      return {
        state: 'blocked',
        error: 'The destination changed immediately after projection.',
        ...(existing ? { recovery: backup } : {}),
      };
    fs.unlinkSync(intentFile);
    return { state: 'applied', hash: desired };
  } catch (error) {
    return resultError(error, backup && statOrNull(backup) ? backup : undefined);
  }
}

export function removeProjected(
  policy: ProjectPolicy,
  relative: string,
  expectedHash: string | null,
  recoveryDir: string,
): ProjectProjectionResult {
  let backup: string | undefined;
  try {
    validExpected(expectedHash);
    const recovery = recoveryDirectory(policy, recoveryDir);
    const existing = readCurrent(policy, relative);
    if (existing === null) return { state: 'applied' };
    if (hash(existing) !== expectedHash)
      return {
        state: 'blocked',
        error: 'The file changed outside Cairn; deletion was paused.',
        recovery: preserve(recovery, existing, 'external'),
      };
    const id = randomUUID();
    const intentBase = {
      operation: 'delete' as const,
      source: relative,
      target: relative,
      expectedHash,
      targetHash: null,
    };
    const backupName = `moved-${id}.bin`;
    backup = path.join(recovery, backupName);
    const frozen = path.basename(preserve(recovery, existing));
    const intentFile = path.join(recovery, `${intentPrefix(intentBase)}${id}.json`);
    writeDurable(
      intentFile,
      JSON.stringify({ version: 1, ...intentBase, backup: backupName, frozen } satisfies Intent),
    );
    const latest = readCurrent(policy, relative);
    if (latest === null || hash(latest) !== expectedHash)
      return {
        state: 'blocked',
        error: 'An external save happened before deletion. Existing versions were preserved.',
      };
    safeAbsolute(recovery, false, true);
    if (statOrNull(backup)) unsafe('The recovery destination is already occupied.');
    fs.renameSync(policy.resolve(relative), backup);
    safeAbsolute(backup, false);
    try {
      if (hash(readBounded(backup, MAX_BLOB_BYTES)) !== expectedHash) {
        restoreNoReplace(policy, relative, backup);
        return {
          state: 'blocked',
          error: 'An external save raced with deletion. The moved file was preserved.',
          recovery: backup,
        };
      }
    } catch (error) {
      restoreNoReplace(policy, relative, backup);
      return resultError(error, backup);
    }
    // A newly created external destination is not part of this deletion.
    if (statOrNull(policy.resolve(relative, { allowMissing: true })))
      return {
        state: 'blocked',
        error: 'An external file appeared during deletion. Both versions were preserved.',
        recovery: backup,
      };
    fs.unlinkSync(intentFile);
    return { state: 'applied', recovery: backup };
  } catch (error) {
    return resultError(error, backup && statOrNull(backup) ? backup : undefined);
  }
}

export function mkdirProjected(policy: ProjectPolicy, relative: string): ProjectProjectionResult {
  try {
    const check = policy.check(relative, true);
    if (!check.allowed) throw new CairnError('EXCLUDED_PATH', check.reason!);
    mkdirParents(policy, `${relative}/placeholder`);
    safeAbsolute(policy.resolve(relative), false, true);
    return { state: 'applied' };
  } catch (error) {
    return resultError(error);
  }
}

export function removeEmptyDirectory(
  policy: ProjectPolicy,
  relative: string,
): ProjectProjectionResult {
  try {
    const check = policy.check(relative, true);
    if (!check.allowed) throw new CairnError('EXCLUDED_PATH', check.reason!);
    const target = policy.resolve(relative, { allowMissing: true });
    if (!statOrNull(target)) return { state: 'applied' };
    safeAbsolute(target, false, true);
    fs.rmdirSync(target); // Never recursive: unknown or externally-created children win.
    return { state: 'applied' };
  } catch (error) {
    return resultError(error);
  }
}
