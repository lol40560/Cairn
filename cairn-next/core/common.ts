import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_TEXT_BYTES, MAX_UPDATE_BYTES, type Projection } from '../shared/types.js';

export class CairnError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CairnError';
  }
}
export const hash = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
export const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64');
export function unb64(data: string, max = MAX_UPDATE_BYTES): Uint8Array {
  if (
    typeof data !== 'string' ||
    data.length > Math.ceil(max / 3) * 4 ||
    data.length % 4 !== 0
  )
    throw new CairnError('INVALID_UPDATE', '잘못되었거나 너무 큰 binary update입니다.');
  const bytes = Buffer.from(data, 'base64');
  // Buffer decoding alone is permissive. A canonical round trip validates in
  // linear space/time without recursive regexp stack exhaustion on binary files.
  if (bytes.toString('base64') !== data)
    throw new CairnError('INVALID_UPDATE', '올바른 base64 데이터가 아닙니다.');
  if (bytes.length > max) throw new CairnError('SIZE_LIMIT', '크기 제한을 초과했습니다.');
  return bytes;
}
export function textBytes(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES)
    throw new CairnError(
      'SIZE_LIMIT',
      '1단계 텍스트 한도는 1 MiB입니다. 입력은 로컬 복구 대상으로 보존하세요.',
    );
  if (text.includes('\u0000'))
    throw new CairnError(
      'UNSUPPORTED_FORMAT',
      'NUL을 포함한 파일은 1단계 텍스트 편집 대상이 아닙니다.',
    );
  if (/\r(?!\n)/.test(text) || (text.includes('\r\n') && /(?<!\r)\n/.test(text)))
    throw new CairnError(
      'UNSUPPORTED_LINE_ENDINGS',
      '1단계는 일관된 LF 또는 CRLF 줄바꿈을 지원합니다. 혼합 줄바꿈 원본은 보존하고 변환한 사본을 사용하세요.',
    );
  if (!text.isWellFormed())
    throw new CairnError(
      'UNSUPPORTED_ENCODING',
      '올바르지 않은 Unicode 문자가 포함되어 있습니다. 원본을 보존하세요.',
    );
}
export function utf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CairnError(
      'UNSUPPORTED_ENCODING',
      '올바른 UTF-8 텍스트가 아닙니다. 원본은 보존했습니다. 바이너리 파일 공유는 후속 단계입니다.',
    );
  }
  textBytes(text);
  return text;
}
export function checkLineEnding(text: string, ending: 'lf' | 'crlf'): void {
  if ((ending === 'lf' && text.includes('\r')) || (ending === 'crlf' && /(?<!\r)\n/.test(text)))
    throw new CairnError(
      'LINE_ENDING_MISMATCH',
      '이 파일에 지정된 줄바꿈 형식이 다릅니다. 입력을 보존하고 파일의 LF/CRLF 형식을 유지하세요.',
    );
}
export function fileName(name: string): string {
  if (
    !name ||
    name.length > 120 ||
    name !== path.basename(name) ||
    /[\\/:*?"<>|\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    name.startsWith('.') ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    /\.(pem|key|pfx|p12)$/i.test(name)
  )
    throw new CairnError(
      'UNSAFE_PATH',
      '일반 텍스트 파일 이름만 사용할 수 있습니다. 경로와 비밀 키 파일은 허용되지 않습니다.',
    );
  return name;
}
export function ensureRoot(input: string, kind: 'server' | 'client'): string {
  const absolute = path.resolve(input);
  fs.mkdirSync(absolute, { recursive: true });
  const real = fs.realpathSync.native(absolute);
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (norm(real) !== norm(absolute) || fs.lstatSync(absolute).isSymbolicLink())
    throw new CairnError('UNSAFE_PATH', 'symlink/junction 폴더는 이 버전에서 지원하지 않습니다.');
  if (fs.existsSync(path.join(real, '.cairn')))
    throw new CairnError(
      'LEGACY_PROJECT',
      '구버전 .cairn이 있는 폴더는 직접 열 수 없습니다. 새 전용 폴더에 파일 사본을 가져오세요.',
    );
  const other = kind === 'server' ? '.cairn-next-client' : '.cairn-next';
  if (fs.existsSync(path.join(real, other)))
    throw new CairnError(
      'ROOT_IN_USE',
      '서버와 클라이언트는 서로 다른 작업 폴더를 사용해야 합니다.',
    );
  return real;
}
export function safeChild(root: string, name: string): string {
  fileName(name);
  const target = path.join(root, name);
  if (
    fs.existsSync(target) &&
    (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())
  )
    throw new CairnError('UNSAFE_PATH', '일반 파일만 접근할 수 있습니다.');
  return target;
}
export function privateDir(root: string, name: string): string {
  const target = path.join(root, name);
  if (
    fs.existsSync(target) &&
    (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())
  )
    throw new CairnError('UNSAFE_PATH', '앱 데이터 경로가 일반 디렉터리가 아닙니다.');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  return target;
}
export function openDb(file: string): DatabaseSync {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
    throw new CairnError('UNSAFE_PATH', 'DB symlink를 거부했습니다.');
  const db = new DatabaseSync(file);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
  );
  return db;
}
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
export function acquireOwnership(dataDir: string): () => void {
  const lockPath = path.join(dataDir, 'ownership.sqlite');
  if (fs.existsSync(lockPath) && fs.lstatSync(lockPath).isSymbolicLink())
    throw new CairnError('UNSAFE_PATH', '소유권 파일이 symlink입니다.');
  const db = new DatabaseSync(lockPath);
  try {
    db.exec(
      'PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER);',
    );
  } catch {
    db.close();
    throw new CairnError(
      'PROJECT_BUSY',
      '다른 서버 또는 클라이언트가 이 작업 폴더를 관리 중입니다.',
    );
  }
  return () => {
    try {
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  };
}
export function writeDurable(file: string, data: string | Uint8Array): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
/** Bound the read itself, not only an earlier stat: editors can replace/grow files. */
export function readBounded(file: string, max = MAX_TEXT_BYTES): Buffer {
  if (fs.lstatSync(file).isSymbolicLink())
    throw new CairnError('UNSAFE_PATH', 'symlink 파일은 읽지 않습니다.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) throw new CairnError('UNSAFE_PATH', '일반 파일만 읽을 수 있습니다.');
    const tooLarge = () =>
      new CairnError(
        'FILE_SIZE_LIMIT',
        '파일 크기가 지원 한도를 초과했습니다. 원본을 보존하고 반영을 보류했습니다.',
      );
    if (info.size > max) throw tooLarge();
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= max) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, max + 1 - total));
      const size = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!size) break;
      total += size;
      if (total > max) throw tooLarge();
      chunks.push(chunk.subarray(0, size));
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(fd);
  }
}
export interface ProjectionResult {
  state: Projection;
  hash?: string;
  error?: string;
  recovery?: string;
}
/** No destructive overwrite: move old target into recovery, then hard-link a fully fsynced
 * temporary file into the now-vacant destination (fails if an external writer wins).
 * The journal owner retries crashes; moved bytes remain available even on error. */
export function projectFile(
  root: string,
  name: string,
  text: string,
  expectedHash: string | null,
  recoveryDir: string,
): ProjectionResult {
  try {
    textBytes(text);
    const target = safeChild(root, name),
      desired = hash(text),
      intentPrefix = `intent-${hash(name).slice(0, 16)}-`;
    // Recover the precise crash window after moving the old file but before publication.
    // Immutable intent names are validated; no path supplied by an intent may escape recovery.
    if (!fs.existsSync(target) && expectedHash !== null) {
      const candidates = fs
        .readdirSync(recoveryDir)
        .filter((n) => n.startsWith(intentPrefix) && n.endsWith('.json'));
      for (const candidate of candidates) {
        let intent: { name?: unknown; expectedHash?: unknown; backup?: unknown };
        try {
          intent = JSON.parse(
            readBounded(path.join(recoveryDir, candidate), 4096).toString('utf8'),
          );
        } catch {
          continue;
        }
        if (
          intent.name !== name ||
          intent.expectedHash !== expectedHash ||
          typeof intent.backup !== 'string' ||
          !/^moved-[a-f0-9-]+\.txt$/.test(intent.backup)
        )
          continue;
        const backup = path.join(recoveryDir, intent.backup);
        if (
          fs.existsSync(backup) &&
          fs.lstatSync(backup).isFile() &&
          !fs.lstatSync(backup).isSymbolicLink() &&
          fs.statSync(backup).size <= MAX_TEXT_BYTES &&
          hash(readBounded(backup)) === expectedHash
        ) {
          // Copy, not hard-link: later external writes must not mutate a preserved backup.
          try {
            fs.copyFileSync(backup, target, fs.constants.COPYFILE_EXCL);
            const fd = fs.openSync(target, 'r+');
            try {
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          }
          break;
        }
      }
    }
    if (fs.existsSync(target) && fs.statSync(target).size > MAX_TEXT_BYTES)
      return {
        state: 'blocked',
        error:
          '외부 파일이 1 MiB 텍스트 한도를 초과했습니다. 파일은 원래 위치에, 서버 내용은 DB에 보존했습니다.',
      };
    const existing = fs.existsSync(target) ? readBounded(safeChild(root, name)) : null;
    const actual = existing === null ? null : hash(existing);
    if (actual === desired) return { state: 'applied', hash: desired };
    if (actual !== expectedHash) {
      const copy = existing === null ? undefined : path.join(recoveryDir, `external-${actual}.txt`);
      if (copy && !fs.existsSync(copy)) writeDurable(copy, existing!);
      return {
        state: 'blocked',
        error: '외부 파일이 마지막 반영 버전과 다릅니다. 양쪽 내용을 보존했습니다.',
        recovery: copy,
      };
    }
    const operation = randomUUID(),
      tempName = `.cairn-write-${operation}.tmp`,
      backupName = `moved-${operation}.txt`;
    const temp = path.join(root, tempName),
      backup = path.join(recoveryDir, backupName);
    const intentFile = path.join(recoveryDir, `${intentPrefix}${operation}.json`);
    // Freeze the bytes read before a rename: an editor may still hold the old inode open.
    if (existing !== null) {
      const frozen = path.join(recoveryDir, `version-${actual}.txt`);
      if (!fs.existsSync(frozen)) writeDurable(frozen, existing);
    }
    writeDurable(temp, text);
    writeDurable(
      intentFile,
      JSON.stringify({
        name,
        expectedHash,
        targetHash: desired,
        temp: tempName,
        backup: backupName,
      }),
    );
    if (existing !== null) {
      safeChild(root, name);
      fs.renameSync(target, backup);
      if (!fs.lstatSync(backup).isFile() || fs.lstatSync(backup).isSymbolicLink())
        return { state: 'blocked', error: '파일 종류가 교체 중 변경되어 작업을 보류했습니다.' };
      let moved: Buffer;
      try {
        moved = readBounded(backup);
      } catch (error) {
        if (error instanceof CairnError && error.code === 'FILE_SIZE_LIMIT') {
          try {
            fs.linkSync(backup, target);
          } catch {
            /* no replacement if another writer recreated target */
          }
          return {
            state: 'blocked',
            error: '교체 중 큰 외부 파일이 발견되어 보존하고 반영을 보류했습니다.',
            recovery: backup,
          };
        }
        throw error;
      }
      if (hash(moved) !== expectedHash) {
        try {
          fs.copyFileSync(backup, target, fs.constants.COPYFILE_EXCL);
        } catch {
          /* preserve both external target and moved bytes */
        }
        return {
          state: 'blocked',
          error: '파일 교체 중 외부 저장이 발견되었습니다. 복구 사본을 보존했습니다.',
          recovery: backup,
        };
      }
    }
    // Atomic no-replace publication. An externally-created destination always wins.
    fs.linkSync(temp, target);
    fs.unlinkSync(temp);
    if (hash(readBounded(safeChild(root, name))) !== desired)
      return { state: 'blocked', error: '반영 직후 외부 변경이 발견되었습니다.' };
    // This is only our completed, content-free intent. Versions and moved files stay intact.
    fs.unlinkSync(intentFile);
    return { state: 'applied', hash: desired };
  } catch (e) {
    return {
      state: e instanceof CairnError && e.code === 'FILE_SIZE_LIMIT' ? 'blocked' : 'error',
      error: publicError(e).message,
    };
  }
}
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof CairnError) return { code: error.code, message: error.message };
  const e = error as NodeJS.ErrnoException;
  const code = e?.code ?? 'INTERNAL_ERROR';
  const messages: Record<string, string> = {
    ENOSPC: '디스크 공간이 부족합니다. 공간을 확보한 뒤 재시도하세요.',
    EACCES: '파일 쓰기 권한이 없습니다.',
    EPERM: '파일이 잠겨 있거나 쓰기 권한이 없습니다.',
    EADDRINUSE: '포트를 다른 프로그램이 사용 중입니다.',
    ECONNREFUSED: '서버가 실행되지 않거나 주소/포트가 잘못되었습니다.',
    ETIMEDOUT: '연결 시간이 초과되었습니다. 네트워크와 방화벽을 확인하세요.',
  };
  return {
    code,
    message: messages[code] ?? '작업에 실패했습니다. 입력과 보관된 변경은 유지됩니다.',
  };
}
