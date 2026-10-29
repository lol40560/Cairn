import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  acquireOwnership,
  ensureRoot,
  fileName,
  hash,
  openDb,
  projectFile,
  textBytes,
  transaction,
  utf8,
} from '../core/common.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-next-fs-'));
  const recovery = path.join(root, 'recovery');
  fs.mkdirSync(recovery);
  return {
    root,
    recovery,
    file: path.join(root, 'note.txt'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}
function contents(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.txt'))
    .map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));
}

test('filesystem projection preserves the original and an unexpected external version', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.file, 'original');
    assert.equal(
      projectFile(f.root, 'note.txt', 'remote', hash('original'), f.recovery).state,
      'applied',
    );
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'remote');
    assert.ok(contents(f.recovery).includes('original'));
    fs.writeFileSync(f.file, 'external');
    assert.equal(
      projectFile(f.root, 'note.txt', 'next', hash('remote'), f.recovery).state,
      'blocked',
    );
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'external');
    assert.ok(contents(f.recovery).includes('external'));
    const count = fs.readdirSync(f.recovery).length;
    projectFile(f.root, 'note.txt', 'next', hash('remote'), f.recovery);
    assert.equal(
      fs.readdirSync(f.recovery).length,
      count,
      'same divergent bytes are not endlessly copied',
    );
  } finally {
    f.cleanup();
  }
});

test('crash window after moving target is recoverable through durable intent', (t) => {
  const f = fixture();
  const original = fs.linkSync;
  try {
    fs.writeFileSync(f.file, 'before');
    t.mock.method(fs, 'linkSync', () => {
      throw Object.assign(new Error('injected interruption'), { code: 'EIO' });
    });
    syncBuiltinESMExports();
    assert.equal(
      projectFile(f.root, 'note.txt', 'after', hash('before'), f.recovery).state,
      'error',
    );
    assert.ok(contents(f.recovery).includes('before'));
    assert.ok(fs.readdirSync(f.recovery).some((n) => n.startsWith('intent-')));
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(fs.linkSync, original);
    assert.equal(
      projectFile(f.root, 'note.txt', 'after', hash('before'), f.recovery).state,
      'applied',
    );
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'after');
    assert.ok(contents(f.recovery).includes('before'));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('external save in the final race wins and both versions remain recoverable', (t) => {
  const f = fixture();
  const rename = fs.renameSync;
  try {
    fs.writeFileSync(f.file, 'base');
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === f.file) fs.writeFileSync(f.file, 'external-in-race');
      return rename(from, to);
    });
    syncBuiltinESMExports();
    assert.equal(
      projectFile(f.root, 'note.txt', 'remote', hash('base'), f.recovery).state,
      'blocked',
    );
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'external-in-race');
    assert.ok(contents(f.recovery).includes('base'));
    assert.ok(contents(f.recovery).includes('external-in-race'));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('a newly-created external destination is never silently replaced', (t) => {
  const f = fixture();
  const link = fs.linkSync;
  try {
    fs.writeFileSync(f.file, 'base');
    t.mock.method(fs, 'linkSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === f.file) fs.writeFileSync(f.file, 'external-new');
      return link(from, to);
    });
    syncBuiltinESMExports();
    assert.equal(
      projectFile(f.root, 'note.txt', 'remote', hash('base'), f.recovery).state,
      'error',
    );
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'external-new');
    assert.ok(contents(f.recovery).includes('base'));
    assert.ok(
      fs.readdirSync(f.root).some((n) => n.startsWith('.cairn-write-')),
      'fsynced remote intent survives',
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('a large external atomic save during the rename race stays intact and bounded', (t) => {
  const f = fixture();
  const rename = fs.renameSync;
  try {
    fs.writeFileSync(f.file, 'base');
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === f.file) {
        const fd = fs.openSync(f.file, 'w');
        fs.ftruncateSync(fd, 2 * 1024 * 1024);
        fs.closeSync(fd);
      }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    const result = projectFile(f.root, 'note.txt', 'remote', hash('base'), f.recovery);
    assert.equal(result.state, 'blocked');
    assert.equal(fs.statSync(f.file).size, 2 * 1024 * 1024);
    assert.ok(
      fs
        .readdirSync(f.recovery)
        .some(
          (n) =>
            n.startsWith('moved-') &&
            fs.statSync(path.join(f.recovery, n)).size === 2 * 1024 * 1024,
        ),
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('ENOSPC before publication preserves disk data and reports failure', (t) => {
  const f = fixture();
  const open = fs.openSync;
  try {
    fs.writeFileSync(f.file, 'before');
    t.mock.method(fs, 'openSync', ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(file).includes('.cairn-write-'))
        throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
      return open(file, flags, mode);
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    const result = projectFile(f.root, 'note.txt', 'after', hash('before'), f.recovery);
    assert.equal(result.state, 'error');
    assert.match(result.error!, /공간/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'before');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('reserved, hidden, secret-key and traversal file paths are rejected', () => {
  for (const name of [
    '../x',
    'x/y',
    'x\\y',
    'CON.txt',
    '.env',
    'my.key',
    'file.',
    'NUL',
    'a:b',
    '',
  ])
    assert.throws(() => fileName(name));
  assert.equal(fileName('작업.ts'), '작업.ts');
});

test('write permission denial preserves the original and supports a later retry', (t) => {
  const f = fixture();
  const open = fs.openSync;
  try {
    fs.writeFileSync(f.file, 'before');
    t.mock.method(fs, 'openSync', ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(file).includes('.cairn-write-'))
        throw Object.assign(new Error('injected permission denial'), { code: 'EACCES' });
      return open(file, flags, mode);
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    const failed = projectFile(f.root, 'note.txt', 'after', hash('before'), f.recovery);
    assert.equal(failed.state, 'error');
    assert.match(failed.error!, /권한/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'before');
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(
      projectFile(f.root, 'note.txt', 'after', hash('before'), f.recovery).state,
      'applied',
    );
    assert.ok(contents(f.recovery).includes('before'));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('uniform LF and CRLF are valid; mixed line endings, NUL and invalid Unicode are preserved by rejection', () => {
  assert.throws(() => utf8(Uint8Array.from([0xff, 0xfe, 0x80])), { code: 'UNSUPPORTED_ENCODING' });
  textBytes('가\n中文\n');
  textBytes('가\r\n中文\r\n');
  for (const text of ['a\r\nb\n', 'a\rb', 'a\u0000b', '\ud800'])
    assert.throws(() => textBytes(text));
});

test('oversized external file is left in place without reading or copying it', () => {
  const f = fixture();
  try {
    const fd = fs.openSync(f.file, 'w');
    fs.ftruncateSync(fd, 2 * 1024 * 1024);
    fs.closeSync(fd);
    const result = projectFile(f.root, 'note.txt', 'server text', hash('old'), f.recovery);
    assert.equal(result.state, 'blocked');
    assert.match(result.error!, /1 MiB/);
    assert.equal(fs.statSync(f.file).size, 2 * 1024 * 1024);
    assert.deepEqual(fs.readdirSync(f.recovery), []);
  } finally {
    f.cleanup();
  }
});

test(
  'an actual Windows exclusive file lock blocks projection without losing bytes',
  { skip: process.platform !== 'win32', timeout: 15000 },
  async () => {
    const f = fixture();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      fs.writeFileSync(f.file, 'locked-original');
      const escaped = f.file.replaceAll("'", "''");
      const command = `$stream = [System.IO.File]::Open('${escaped}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null; $stream.Dispose()`;
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stderr?.resume();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('File lock helper did not become ready')),
          5000,
        );
        child!.stdout!.on('data', (data) => {
          if (String(data).includes('locked')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child!.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      assert.equal(
        projectFile(f.root, 'note.txt', 'remote', hash('locked-original'), f.recovery).state,
        'error',
      );
      const exited = once(child, 'exit');
      child.stdin!.end('\n');
      await exited;
      assert.equal(fs.readFileSync(f.file, 'utf8'), 'locked-original');
      assert.equal(
        projectFile(f.root, 'note.txt', 'remote', hash('locked-original'), f.recovery).state,
        'applied',
      );
      assert.ok(contents(f.recovery).includes('locked-original'));
    } finally {
      if (child && child.exitCode === null) {
        child.kill();
        await once(child, 'exit').catch(() => {});
      }
      f.cleanup();
    }
  },
);

test('legacy metadata remains untouched and a project has one owner', () => {
  const f = fixture();
  try {
    const legacy = path.join(f.root, '.cairn');
    fs.mkdirSync(legacy);
    const marker = randomUUID();
    fs.writeFileSync(path.join(legacy, 'marker'), marker);
    assert.throws(() => ensureRoot(f.root, 'server'), /구버전/);
    assert.equal(fs.readFileSync(path.join(legacy, 'marker'), 'utf8'), marker);
    const release = acquireOwnership(f.recovery);
    try {
      assert.throws(() => acquireOwnership(f.recovery), /다른 서버/);
    } finally {
      release();
    }
    acquireOwnership(f.recovery)();
  } finally {
    f.cleanup();
  }
});

test('SQLite FULL WAL transaction rolls back state and operation together', () => {
  const f = fixture();
  const db = openDb(path.join(f.root, 'state.sqlite'));
  try {
    db.exec('CREATE TABLE state (n INTEGER); CREATE TABLE ops (n INTEGER);');
    assert.throws(() =>
      transaction(db, () => {
        db.exec('INSERT INTO state VALUES(1); INSERT INTO ops VALUES(1);');
        throw new Error('interrupt');
      }),
    );
    assert.equal((db.prepare('SELECT count(*) AS n FROM state').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM ops').get() as { n: number }).n, 0);
    assert.equal(
      (db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous,
      2,
    );
    assert.equal(
      (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
      'wal',
    );
  } finally {
    db.close();
    f.cleanup();
  }
});
