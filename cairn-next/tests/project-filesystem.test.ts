import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { b64, hash } from '../core/common.js';
import { ProjectStore } from '../core/project/store.js';
import {
  ProjectPolicy,
  MAX_BLOB_BYTES,
  MAX_ENTRIES,
  MAX_PROJECT_BYTES,
  classifyBytes,
  validateProjectPath,
  builtinExclusion,
  projectBytes,
  removeProjected,
  mkdirProjected,
  removeEmptyDirectory,
} from '../core/project/filesystem.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-project-fs-'));
  const recovery = path.join(root, '.cairn-next', 'recovery');
  const policy = new ProjectPolicy(root);
  return {
    root,
    recovery,
    policy,
    file: (relative: string) => path.join(root, ...relative.split('/')),
    write(relative: string, data: string | Uint8Array) {
      const file = path.join(root, ...relative.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    },
    project(
      relative: string,
      bytes: string | Uint8Array,
      expectedHash: string | null,
      previousPath?: string,
    ) {
      return projectBytes(policy, {
        path: relative,
        bytes: typeof bytes === 'string' ? Buffer.from(bytes) : bytes,
        expectedHash,
        recoveryDir: recovery,
        previousPath,
      });
    },
    cleanup() {
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('cairn-project-fs-'));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    },
  };
}
function savedBytes(directory: string): Buffer[] {
  return fs.existsSync(directory)
    ? fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.bin'))
        .map((name) => fs.readFileSync(path.join(directory, name)))
    : [];
}

test('portable paths reject traversal, ADS, reserved names, non-NFC and case aliases', () => {
  const f = fixture();
  try {
    f.write('Readme.md', 'hello');
    for (const relative of [
      '../escape',
      '/absolute',
      'a\\b',
      'a//b',
      'a/../b',
      'file:ads',
      'CON.txt',
      'lpt1',
      'COM¹.txt',
      'conout$',
      'file.',
      'file ',
      'a\u0000b',
      'cafe\u0301.txt',
      'readme.md',
    ]) {
      assert.equal(f.policy.check(relative).allowed, false, relative);
      assert.throws(() => f.policy.resolve(relative, { allowMissing: true }), relative);
    }
    assert.equal(f.policy.check('Readme.md').allowed, true);
    assert.equal(f.policy.check('새 폴더/새 파일.ts').allowed, true);
    assert.equal(
      f.policy.resolve('새 폴더/새 파일.ts', { allowMissing: true }),
      f.file('새 폴더/새 파일.ts'),
    );
    assert.throws(() => f.policy.resolve('missing.txt'));
    assert.equal(validateProjectPath('.github/workflows/check.yml'), '.github/workflows/check.yml');
    assert.throws(() => validateProjectPath('bad-\ud800.txt'));
    assert.match(builtinExclusion('.git', false)!, /excluded/);
  } finally {
    f.cleanup();
  }
});

test('canonical ignore rules take effect before projection and do not fall back to deleted disk rules', () => {
  const f = fixture();
  try {
    f.write('.gitignore', 'old.txt\n');
    f.write('old.txt', 'previously excluded');
    f.write('new.txt', 'newly excluded');
    const canonical = new Map<string, string>([
      ['.gitignore', 'new.txt\n'],
      ['missing/.gitignore', 'private.txt\n'],
    ]);
    f.policy.setIgnoreFileResolver((relative) => canonical.get(relative));
    assert.equal(f.policy.check('old.txt').allowed, true);
    assert.equal(f.policy.check('new.txt').allowed, false);
    assert.equal(f.policy.check('missing/private.txt').allowed, false);
    assert.equal(f.project('new.txt', 'remote', hash('newly excluded')).state, 'blocked');
    const included = f.policy.scan().entries.map((entry) => entry.path);
    assert.ok(included.includes('old.txt'));
    assert.equal(included.includes('new.txt'), false);
    canonical.delete('.gitignore');
    assert.equal(f.policy.check('new.txt').allowed, true);
    assert.equal(
      f.policy.check('old.txt').allowed,
      true,
      'canonical deletion must suppress stale disk rules',
    );
    assert.equal(fs.readFileSync(f.file('.gitignore'), 'utf8'), 'old.txt\n');
    assert.equal(fs.readFileSync(f.file('new.txt'), 'utf8'), 'newly excluded');
    f.policy.setIgnoreFileResolver();
    assert.equal(f.policy.check('old.txt').allowed, false);
    assert.equal(f.policy.check('new.txt').allowed, true);
  } finally {
    f.cleanup();
  }
});

test('secret/default exclusions and nested gitignore apply to scans and writes without altering ignore files', () => {
  const f = fixture();
  try {
    const rootIgnore = '*.log\nignored/\n!ignored/keep.txt\nsub/*.txt\n';
    const nestedIgnore = '!keep.txt\nprivate/\n';
    f.write('.gitignore', rootIgnore);
    f.write('sub/.gitignore', nestedIgnore);
    f.write('.editorconfig', 'root = true\n');
    f.write('.github/workflows/check.yml', 'name: check\n');
    f.write('sub/keep.txt', 'shared');
    f.write('sub/no.txt', 'excluded');
    f.write('sub/private/keep.txt', 'private');
    f.write('debug.log', 'log');
    f.write('ignored/keep.txt', 'cannot reopen ignored parent');
    for (const name of [
      '.env',
      '.env.local',
      '.env_test',
      'id_ed25519',
      'private.pem',
      '.git',
      'secret.key',
      'node_modules/mod/index.js',
      'dist/bundle.js',
      'temp/cache',
      '.cairn-next/cache',
      '.cairn-old/file',
      'note.txt~',
    ])
      f.write(name, 'private');
    f.policy.refresh(['*.skip']);
    f.write('file.skip', 'skip');
    const result = f.policy.scan();
    const included = result.entries.map((entry) => entry.path);
    assert.ok(included.includes('.gitignore'));
    assert.ok(included.includes('.editorconfig'));
    assert.ok(included.includes('.github/workflows/check.yml'));
    assert.ok(included.includes('sub/keep.txt'));
    for (const relative of [
      'sub/no.txt',
      'sub/private/keep.txt',
      'debug.log',
      'ignored/keep.txt',
      '.env',
      '.env.local',
      '.env_test',
      '.git',
      'file.skip',
    ]) {
      assert.equal(included.includes(relative), false, relative);
      assert.equal(f.project(relative, 'remote', null).state, 'blocked', relative);
    }
    assert.equal(fs.readFileSync(f.file('.gitignore'), 'utf8'), rootIgnore);
    assert.equal(fs.readFileSync(f.file('sub/.gitignore'), 'utf8'), nestedIgnore);
    // A changed ignore file is observed even if no watcher called refresh yet.
    f.write('sub/.gitignore', '!keep.txt\nlate.txt\n');
    assert.equal(f.policy.check('sub/late.txt').allowed, false);
    f.policy.refresh([]);
    assert.equal(f.policy.check('file.skip').allowed, true);
  } finally {
    f.cleanup();
  }
});

test('byte classification preserves formats, BOMs, binary control bytes and line endings', () => {
  assert.deepEqual(classifyBytes('file.txt', Buffer.from('one\ntwo\n')), {
    kind: 'text',
    lineEnding: 'lf',
  });
  assert.deepEqual(classifyBytes('file.txt', Buffer.from('one\r\ntwo\r\n')), {
    kind: 'text',
    lineEnding: 'crlf',
  });
  assert.equal(classifyBytes('image.svg', Buffer.from('<svg/>')).kind, 'binary');
  assert.equal(classifyBytes('document.docx', Buffer.from('looks like text')).kind, 'binary');
  for (const bytes of [
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0xef, 0xbb, 0xbf, 65]),
    Buffer.from('a\u0000b'),
    Buffer.from('a\rb'),
    Buffer.from('a\r\nb\n'),
    Buffer.from([65, 1, 66]),
  ])
    assert.equal(classifyBytes('data.txt', bytes).kind, 'binary');
  const largeText = classifyBytes('large.txt', Buffer.alloc(1024 * 1024 + 1, 65));
  assert.equal(largeText.kind, 'binary');
  assert.match(largeText.reason!, /1 MiB/);
  assert.throws(() => classifyBytes('huge.bin', Buffer.alloc(MAX_BLOB_BYTES + 1)));
});

test('scan keeps oversized originals and returns bounded editable text or binary bytes', () => {
  const f = fixture();
  try {
    f.write('lf.ts', 'const a = 1;\n');
    f.write('crlf.txt', 'a\r\nb\r\n');
    f.write('picture.png', Buffer.from([137, 80, 78, 71, 0, 255]));
    f.write('big.txt', Buffer.alloc(1024 * 1024 + 1, 65));
    const fd = fs.openSync(f.file('too-big.bin'), 'w');
    fs.ftruncateSync(fd, MAX_BLOB_BYTES + 1);
    fs.closeSync(fd);
    const result = f.policy.scan();
    const entries = new Map(result.entries.map((entry) => [entry.path, entry]));
    assert.equal(entries.get('lf.ts')?.lineEnding, 'lf');
    assert.equal(entries.get('crlf.txt')?.lineEnding, 'crlf');
    assert.equal(entries.get('picture.png')?.kind, 'binary');
    assert.equal(entries.get('big.txt')?.kind, 'binary');
    assert.ok(
      result.excluded.some(
        (entry) => entry.path === 'too-big.bin' && entry.reason.includes('16 MiB'),
      ),
    );
    assert.equal(fs.statSync(f.file('too-big.bin')).size, MAX_BLOB_BYTES + 1);
    assert.equal(f.project('too-big.bin', Buffer.from('remote'), hash('base')).state, 'blocked');
    assert.equal(fs.statSync(f.file('too-big.bin')).size, MAX_BLOB_BYTES + 1);
  } finally {
    f.cleanup();
  }
});

test('binary projection preserves old and divergent external bytes and uses private recovery', () => {
  const f = fixture();
  try {
    const before = Buffer.from([0, 1, 255, 128]);
    const after = Buffer.from([255, 0, 2, 33]);
    const external = Buffer.from([42, 0, 255]);
    f.write('assets/image.png', before);
    assert.equal(f.project('assets/image.png', after, hash(before)).state, 'applied');
    assert.deepEqual(fs.readFileSync(f.file('assets/image.png')), after);
    assert.ok(savedBytes(f.recovery).some((bytes) => bytes.equals(before)));
    f.write('assets/image.png', external);
    assert.equal(f.project('assets/image.png', after, hash(after)).state, 'blocked');
    assert.deepEqual(fs.readFileSync(f.file('assets/image.png')), external);
    assert.ok(savedBytes(f.recovery).some((bytes) => bytes.equals(external)));
    const entries = fs.readdirSync(f.recovery).length;
    f.project('assets/image.png', after, hash(after));
    assert.equal(fs.readdirSync(f.recovery).length, entries);
    assert.equal(
      projectBytes(f.policy, {
        path: 'other.bin',
        bytes: after,
        expectedHash: null,
        recoveryDir: path.join(f.root, 'public-recovery'),
      }).state,
      'blocked',
    );
    assert.equal(fs.existsSync(f.file('public-recovery')), false);
    assert.equal(
      f.policy.scan().entries.some((entry) => entry.path.startsWith('.cairn')),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('ordinary and case-only renames are retryable and preserve occupied destinations', () => {
  const f = fixture();
  try {
    f.write('source.txt', 'base');
    assert.equal(
      f.project('nested/renamed.txt', 'base', hash('base'), 'source.txt').state,
      'applied',
    );
    assert.equal(fs.existsSync(f.file('source.txt')), false);
    assert.equal(fs.readFileSync(f.file('nested/renamed.txt'), 'utf8'), 'base');
    assert.equal(
      f.project('nested/renamed.txt', 'base', hash('base'), 'source.txt').state,
      'applied',
    );
    assert.equal(
      f.project('nested/Renamed.txt', 'base', hash('base'), 'nested/renamed.txt').state,
      'applied',
    );
    assert.ok(fs.readdirSync(f.file('nested')).includes('Renamed.txt'));
    assert.equal(
      f.project('nested/Renamed.txt', 'base', hash('base'), 'nested/renamed.txt').state,
      'applied',
    );
    f.write('other.txt', 'occupied');
    assert.equal(
      f.project('other.txt', 'base', hash('base'), 'nested/Renamed.txt').state,
      'blocked',
    );
    assert.equal(fs.readFileSync(f.file('other.txt'), 'utf8'), 'occupied');
    assert.equal(fs.readFileSync(f.file('nested/Renamed.txt'), 'utf8'), 'base');
  } finally {
    f.cleanup();
  }
});

test('delete preserves recoverable bytes and refuses changed files or nonempty directories', () => {
  const f = fixture();
  try {
    f.write('note.txt', 'local');
    assert.equal(removeProjected(f.policy, 'note.txt', hash('old'), f.recovery).state, 'blocked');
    assert.equal(fs.readFileSync(f.file('note.txt'), 'utf8'), 'local');
    const result = removeProjected(f.policy, 'note.txt', hash('local'), f.recovery);
    assert.equal(result.state, 'applied');
    assert.equal(fs.existsSync(f.file('note.txt')), false);
    assert.equal(fs.readFileSync(result.recovery!, 'utf8'), 'local');
    assert.equal(removeProjected(f.policy, 'note.txt', hash('local'), f.recovery).state, 'applied');
    assert.equal(mkdirProjected(f.policy, 'folder/empty').state, 'applied');
    assert.equal(removeEmptyDirectory(f.policy, 'folder/empty').state, 'applied');
    f.write('folder/unknown.txt', 'external');
    assert.equal(removeEmptyDirectory(f.policy, 'folder').state, 'blocked');
    assert.equal(fs.readFileSync(f.file('folder/unknown.txt'), 'utf8'), 'external');
  } finally {
    f.cleanup();
  }
});

test('durable intents recover an interrupted binary publication', (t) => {
  const f = fixture();
  try {
    f.write('data.bin', Buffer.from([1, 2, 0, 255]));
    t.mock.method(fs, 'linkSync', () => {
      throw Object.assign(new Error('interrupted'), { code: 'EIO' });
    });
    syncBuiltinESMExports();
    assert.equal(
      f.project('data.bin', Buffer.from([9, 0, 8]), hash(Buffer.from([1, 2, 0, 255]))).state,
      'error',
    );
    assert.equal(fs.existsSync(f.file('data.bin')), false);
    assert.ok(fs.readdirSync(f.recovery).some((name) => name.startsWith('intent-')));
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(
      f.project('data.bin', Buffer.from([9, 0, 8]), hash(Buffer.from([1, 2, 0, 255]))).state,
      'applied',
    );
    assert.deepEqual(fs.readFileSync(f.file('data.bin')), Buffer.from([9, 0, 8]));
    assert.ok(savedBytes(f.recovery).some((bytes) => bytes.equals(Buffer.from([1, 2, 0, 255]))));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('an atomic editor rename immediately before projection is detected and preserved', (t) => {
  const f = fixture();
  const rename = fs.renameSync;
  try {
    f.write('data.bin', 'base');
    f.write('editor-save.tmp', 'external atomic save');
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === f.file('data.bin'))
        rename(f.file('editor-save.tmp'), f.file('data.bin'));
      rename(from, to);
    });
    syncBuiltinESMExports();
    const result = f.project('data.bin', 'remote', hash('base'));
    assert.equal(result.state, 'blocked');
    assert.equal(fs.readFileSync(f.file('data.bin'), 'utf8'), 'external atomic save');
    assert.ok(savedBytes(f.recovery).some((bytes) => bytes.equals(Buffer.from('base'))));
    assert.ok(
      savedBytes(f.recovery).some((bytes) => bytes.equals(Buffer.from('external atomic save'))),
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('an external destination created in the publication race always wins', (t) => {
  const f = fixture();
  const link = fs.linkSync;
  try {
    f.write('file.txt', 'base');
    t.mock.method(fs, 'linkSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === f.file('file.txt'))
        fs.writeFileSync(f.file('file.txt'), 'external destination');
      link(from, to);
    });
    syncBuiltinESMExports();
    assert.equal(f.project('file.txt', 'remote', hash('base')).state, 'blocked');
    assert.equal(fs.readFileSync(f.file('file.txt'), 'utf8'), 'external destination');
    assert.ok(savedBytes(f.recovery).some((bytes) => bytes.equals(Buffer.from('base'))));
    assert.ok(savedBytes(f.recovery).some((bytes) => bytes.equals(Buffer.from('remote'))));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('a file growing beyond the bound during rename is preserved without an unbounded read', (t) => {
  const f = fixture();
  const rename = fs.renameSync;
  try {
    f.write('data.bin', 'base');
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === f.file('data.bin')) {
        const fd = fs.openSync(f.file('data.bin'), 'r+');
        fs.ftruncateSync(fd, MAX_BLOB_BYTES + 1);
        fs.closeSync(fd);
      }
      rename(from, to);
    });
    syncBuiltinESMExports();
    const result = f.project('data.bin', 'remote', hash('base'));
    assert.equal(result.state, 'blocked');
    assert.equal(fs.statSync(f.file('data.bin')).size, MAX_BLOB_BYTES + 1);
    assert.equal(fs.statSync(result.recovery!).size, MAX_BLOB_BYTES + 1);
    assert.equal(
      fs.readFileSync(path.join(f.recovery, `version-${hash('base')}.bin`), 'utf8'),
      'base',
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('junctions and symbolic-link ancestors are excluded from scans, projection and recovery', () => {
  const f = fixture();
  const outside = fixture();
  try {
    outside.write('secret.txt', 'outside');
    fs.symlinkSync(
      outside.root,
      f.file('linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.equal(f.policy.check('linked/secret.txt').allowed, false);
    assert.equal(f.project('linked/secret.txt', 'remote', hash('outside')).state, 'blocked');
    assert.equal(
      f.policy.scan().entries.some((entry) => entry.path.startsWith('linked')),
      false,
    );
    assert.throws(() => new ProjectPolicy(f.file('linked')));
    fs.mkdirSync(f.file('.cairn-next'));
    fs.symlinkSync(
      outside.root,
      f.file('.cairn-next/recovery'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.equal(f.project('safe.txt', 'remote', null).state, 'blocked');
    assert.equal(fs.readFileSync(outside.file('secret.txt'), 'utf8'), 'outside');
    assert.deepEqual(fs.readdirSync(outside.root), ['secret.txt']);
  } finally {
    f.cleanup();
    outside.cleanup();
  }
});

test('project aggregate limits omit excess entries and bytes while keeping originals', () => {
  const f = fixture();
  try {
    // Sparse input avoids allocating hundreds of MiB while checking actual bounded reads.
    for (let i = 0; i < MAX_PROJECT_BYTES / MAX_BLOB_BYTES + 1; i++) {
      const fd = fs.openSync(f.file(`asset-${i.toString().padStart(2, '0')}.bin`), 'w');
      fs.ftruncateSync(fd, MAX_BLOB_BYTES);
      fs.closeSync(fd);
    }
    const result = f.policy.scan();
    assert.equal(
      result.entries.reduce((size, entry) => size + (entry.bytes?.byteLength ?? 0), 0),
      MAX_PROJECT_BYTES,
    );
    assert.equal(result.excluded.filter((entry) => entry.reason.includes('256 MiB')).length, 1);
    assert.equal(fs.readdirSync(f.root).length, 17);
    assert.equal(MAX_ENTRIES, 5000);
  } finally {
    f.cleanup();
  }
});

test('the 5000-entry bound includes directories and leaves all excess local files intact', () => {
  const f = fixture();
  try {
    for (let directory = 0; directory < 100; directory++) {
      for (let file = 0; file < 50; file++)
        f.write(
          `dir-${directory.toString().padStart(3, '0')}/file-${file.toString().padStart(2, '0')}.txt`,
          'x',
        );
    }
    const result = f.policy.scan();
    assert.equal(result.entries.length, MAX_ENTRIES);
    assert.ok(result.excluded.some((entry) => entry.reason.includes('5000')));
    assert.equal(fs.readFileSync(f.file('dir-099/file-49.txt'), 'utf8'), 'x');
    assert.equal(fs.readdirSync(f.root).length, 100);
  } finally {
    f.cleanup();
  }
});

test('a file growing after fstat is read at most 16 MiB plus one byte', (t) => {
  const f = fixture();
  const open = fs.openSync;
  const read = fs.readSync;
  let targetFd = -1;
  let grown = false;
  let totalRead = 0;
  try {
    f.write('data.bin', 'base');
    t.mock.method(fs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = open(file, flags, mode);
      if (String(file) === f.file('data.bin') && typeof flags === 'number') targetFd = fd;
      return fd;
    });
    t.mock.method(
      fs,
      'readSync',
      (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        if (fd === targetFd && !grown) {
          grown = true;
          const writer = open(f.file('data.bin'), 'r+');
          fs.ftruncateSync(writer, MAX_BLOB_BYTES * 2);
          fs.closeSync(writer);
        }
        const count = read(fd, buffer, offset, length, position);
        if (fd === targetFd) totalRead += count;
        return count;
      },
    );
    syncBuiltinESMExports();
    assert.equal(f.project('data.bin', 'remote', hash('base')).state, 'blocked');
    assert.equal(totalRead, MAX_BLOB_BYTES + 1);
    assert.equal(fs.statSync(f.file('data.bin')).size, MAX_BLOB_BYTES * 2);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('deletion detects a final editor save and restores its bytes without deleting them', (t) => {
  const f = fixture();
  const rename = fs.renameSync;
  try {
    f.write('note.txt', 'base');
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === f.file('note.txt'))
        fs.writeFileSync(f.file('note.txt'), 'external before delete');
      rename(from, to);
    });
    syncBuiltinESMExports();
    const result = removeProjected(f.policy, 'note.txt', hash('base'), f.recovery);
    assert.equal(result.state, 'blocked');
    assert.equal(fs.readFileSync(f.file('note.txt'), 'utf8'), 'external before delete');
    assert.ok(savedBytes(f.recovery).some((bytes) => bytes.equals(Buffer.from('base'))));
    assert.ok(
      savedBytes(f.recovery).some((bytes) => bytes.equals(Buffer.from('external before delete'))),
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test('projectBytes ENOSPC preserves original bytes and committed remote content across restart and retry', (t) => {
  const f = fixture();
  const open = fs.openSync;
  const before = Buffer.from([0, 17, 255, 83]);
  const remote = Buffer.from([255, 0, 63, 9, 128]);
  let store: ProjectStore | undefined;
  let failedTempOpens = 0;
  try {
    f.write('asset.bin', before);
    store = new ProjectStore({ root: f.root, mode: 'authority', autoProject: false });
    const file = store.files().find((entry) => entry.path === 'asset.bin')!;
    const event = store.apply(
      {
        opId: randomUUID(),
        kind: 'write',
        fileId: file.id,
        generation: file.generation,
        baseRevision: file.revision,
        baseHash: file.hash,
        data: b64(remote),
      },
      { id: store.ownerId, name: 'Test owner', role: 'owner', source: { kind: 'app' } },
    );
    assert.equal(store.file(file.id)!.hash, hash(remote));
    assert.deepEqual(Buffer.from(store.getBlob(hash(remote))), remote);
    t.mock.method(fs, 'openSync', (target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (
        path.dirname(String(target)) === f.recovery &&
        /^write-[a-f0-9-]+\.bin$/.test(path.basename(String(target)))
      ) {
        failedTempOpens++;
        throw Object.assign(new Error('Injected project temporary-file disk full'), {
          code: 'ENOSPC',
        });
      }
      return open(target, flags, mode);
    });
    syncBuiltinESMExports();
    const result = projectBytes(store.policy, {
      path: file.path,
      bytes: store.getBlob(hash(remote)),
      expectedHash: file.hash,
      recoveryDir: f.recovery,
    });
    assert.equal(failedTempOpens, 1, 'the actual new writer reached its private temporary file');
    assert.equal(result.state, 'error');
    assert.match(result.error!, /disk space/);
    assert.deepEqual(fs.readFileSync(f.file('asset.bin')), before);
    assert.deepEqual(Buffer.from(store.getBlob(hash(remote))), remote);
    assert.ok(savedBytes(f.recovery).some((bytes) => bytes.equals(before)));
    t.mock.restoreAll();
    syncBuiltinESMExports();
    store.close();
    store = new ProjectStore({ root: f.root, mode: 'authority', autoProject: false });
    assert.equal(store.revision(), event.revision);
    assert.equal(store.file(file.id)!.hash, hash(remote));
    assert.deepEqual(Buffer.from(store.getBlob(hash(remote))), remote);
    assert.deepEqual(fs.readFileSync(f.file('asset.bin')), before);
    store.projectPending();
    assert.equal(
      store.status().projections.find((entry) => entry.fileId === file.id)?.state,
      'applied',
    );
    assert.equal(hash(fs.readFileSync(f.file('asset.bin'))), hash(remote));
    assert.deepEqual(fs.readFileSync(f.file('asset.bin')), remote);
    assert.ok(savedBytes(f.recovery).some((bytes) => bytes.equals(before)));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    store?.close();
    f.cleanup();
  }
});

test(
  'projectBytes actual Windows FileShare.None lock preserves original bytes until unlock and retry',
  { skip: process.platform !== 'win32', timeout: 15000 },
  async () => {
    const f = fixture();
    const before = Buffer.from([0, 22, 255, 128, 7]);
    const remote = Buffer.from([255, 32, 0, 8]);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      f.write('locked.bin', before);
      const escaped = f.file('locked.bin').replaceAll("'", "''");
      const command = `$ErrorActionPreference = 'Stop'; $stream = [System.IO.File]::Open('${escaped}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); try { [Console]::WriteLine('cairn-locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $stream.Dispose() }`;
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stderr!.resume();
      await new Promise<void>((resolve, reject) => {
        let ready = false;
        let output = '';
        const timeout = setTimeout(
          () => reject(new Error('Exclusive lock helper did not become ready')),
          5000,
        );
        child!.stdout!.on('data', (data: Buffer) => {
          output = (output + data.toString()).slice(-1024);
          if (output.includes('cairn-locked')) {
            ready = true;
            clearTimeout(timeout);
            resolve();
          }
        });
        child!.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child!.once('exit', (code) => {
          clearTimeout(timeout);
          if (!ready)
            reject(new Error(`Exclusive lock helper exited before acquiring its lock (${code})`));
        });
      });
      const result = f.project('locked.bin', remote, hash(before));
      assert.ok(result.state === 'error' || result.state === 'blocked');
      assert.equal(result.hash, undefined);
      const exited = once(child, 'exit');
      child.stdin!.end('\n');
      await exited;
      assert.equal(child.exitCode, 0);
      assert.deepEqual(fs.readFileSync(f.file('locked.bin')), before);
      const retried = f.project('locked.bin', remote, hash(before));
      assert.equal(retried.state, 'applied');
      assert.equal(retried.hash, hash(remote));
      assert.deepEqual(fs.readFileSync(f.file('locked.bin')), remote);
      assert.ok(savedBytes(f.recovery).some((bytes) => bytes.equals(before)));
    } finally {
      if (child?.pid && child.exitCode === null) {
        const exited = once(child, 'exit').catch(() => {});
        child.kill();
        await exited;
      }
      f.cleanup();
    }
  },
);
