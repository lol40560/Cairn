import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { unzipSync } from 'fflate';
import { CairnError, hash } from '../core/common.js';
import { classifyBytes } from '../core/project/filesystem.js';
import {
  exportSnapshot,
  previewGitHub,
  publishGitHub,
  GitHubExportError,
  SnapshotExportError,
  SNAPSHOT_MANIFEST_NAME,
} from '../core/project/exports.js';
import type { GitHubPreview } from '../core/project/exports.js';
import type { ProjectFile, SnapshotManifest } from '../shared/project.js';

const bytes = (input: string | Uint8Array) =>
  typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);
const gitSha = (data: Uint8Array) =>
  createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const TOKEN = 'test-only-memory-token';
const HEAD = 'a'.repeat(40),
  TREE = 'b'.repeat(40),
  NEW_TREE = 'c'.repeat(40),
  NEW_COMMIT = 'd'.repeat(40),
  OTHER_HEAD = 'e'.repeat(40);

function snapshotFixture(entries: Record<string, string | Uint8Array | null>) {
  const blobs = new Map<string, Uint8Array>();
  const files: ProjectFile[] = Object.entries(entries).map(([relative, value]) => {
    const content = value === null ? new Uint8Array() : bytes(value),
      digest = hash(content);
    const kind = value === null ? 'directory' : classifyBytes(relative, content).kind;
    if (value !== null) blobs.set(digest, content);
    return {
      id: randomUUID(),
      path: relative,
      kind,
      generation: 1,
      revision: 7,
      hash: digest,
      size: content.length,
      stateHash: kind === 'text' ? hash(`private-state-${relative}`) : null,
      lineEnding: kind === 'text' ? 'lf' : null,
      deleted: false,
    };
  });
  const snapshot: SnapshotManifest = {
    id: randomUUID(),
    projectId: randomUUID(),
    name: 'Never export this private name',
    revision: 7,
    manifestHash: hash('untrusted original manifest hash'),
    files,
    blobs: [...blobs].map(([digest, data]) => ({ hash: digest, size: data.length })),
    metadata: {
      claims: [],
      conflicts: [],
      checkpoints: [],
      trash: [],
      ignorePatterns: [],
      retentionDays: 30,
      strictClaims: false,
    },
    createdAt: Date.UTC(2026, 9, 26),
  };
  const readBlob = async (digest: string) => {
    assert.ok(blobs.has(digest), 'Only expected immutable content blobs may be read');
    return blobs.get(digest)!;
  };
  return { snapshot, blobs, readBlob };
}

function tempFixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-exports-'));
  // Only the absolute directory just created by this test is eligible for cleanup.
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return root;
}

type RequestRecord = { method: string; route: string; body: any };
async function githubMock(
  t: { after(fn: () => Promise<void>): void },
  initial: Record<string, string | Uint8Array>,
) {
  const remote = new Map(
    Object.entries(initial).map(([relative, value]) => [
      relative,
      { bytes: bytes(value), mode: '100644' },
    ]),
  );
  const state = {
    head: HEAD,
    remote,
    requests: [] as RequestRecord[],
    refs: new Map<string, string>(),
    uploads: new Map<string, Buffer>(),
    failures: [] as { method: string; route: string; status: number }[],
    collisionOnce: false,
    baseReads: 0,
    changeOnBaseRead: 0,
    truncated: false,
    redirect: '',
  };
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const route = (request.url ?? '').replace('/repos/alice/demo', '');
    const method = request.method ?? 'GET',
      body = raw ? JSON.parse(raw) : undefined;
    state.requests.push({ method, route, body });
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      send(401, { message: 'wrong token' });
      return;
    }
    const failure = state.failures.find(
      (failure) => failure.method === method && failure.route === route,
    );
    if (failure) {
      send(failure.status, { message: `server reflection ${TOKEN}`, secret: TOKEN });
      return;
    }
    if (state.redirect) {
      response.writeHead(302, { Location: state.redirect });
      response.end();
      return;
    }
    if (method === 'GET' && route.startsWith('/git/ref/heads/')) {
      const branch = decodeURIComponent(route.slice('/git/ref/heads/'.length));
      if (branch === 'main') {
        state.baseReads++;
        if (state.changeOnBaseRead && state.baseReads >= state.changeOnBaseRead)
          state.head = OTHER_HEAD;
      }
      const sha = branch === 'main' ? state.head : state.refs.get(branch);
      send(
        sha ? 200 : 404,
        sha
          ? { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } }
          : { message: 'missing' },
      );
      return;
    }
    if (method === 'GET' && route === `/git/commits/${HEAD}`) {
      send(200, { sha: HEAD, tree: { sha: TREE } });
      return;
    }
    if (method === 'GET' && route === `/git/trees/${TREE}?recursive=1`) {
      const directories = new Set<string>();
      for (const relative of remote.keys()) {
        const parts = relative.split('/');
        for (let index = 1; index < parts.length; index++)
          directories.add(parts.slice(0, index).join('/'));
      }
      send(200, {
        sha: TREE,
        truncated: state.truncated,
        tree: [
          ...[...directories].map((relative) => ({
            path: relative,
            type: 'tree',
            mode: '040000',
            sha: TREE,
          })),
          ...[...remote].map(([relative, file]) => ({
            path: relative,
            type: 'blob',
            mode: file.mode,
            sha: gitSha(file.bytes),
            size: file.bytes.length,
          })),
        ],
      });
      return;
    }
    if (method === 'GET' && route.startsWith('/git/blobs/')) {
      const sha = route.slice('/git/blobs/'.length),
        file = [...remote.values()].find((file) => gitSha(file.bytes) === sha);
      send(
        file ? 200 : 404,
        file
          ? {
              sha,
              size: file.bytes.length,
              encoding: 'base64',
              content: file.bytes.toString('base64'),
            }
          : {},
      );
      return;
    }
    if (method === 'POST' && route === '/git/blobs') {
      assert.equal(body.encoding, 'base64');
      const data = Buffer.from(body.content, 'base64'),
        sha = gitSha(data);
      state.uploads.set(sha, data);
      send(201, { sha });
      return;
    }
    if (method === 'POST' && route === '/git/trees') {
      send(201, { sha: NEW_TREE });
      return;
    }
    if (method === 'POST' && route === '/git/commits') {
      send(201, { sha: NEW_COMMIT });
      return;
    }
    if (method === 'POST' && route === '/git/refs') {
      const branch = body.ref.slice('refs/heads/'.length);
      if (state.collisionOnce) {
        state.collisionOnce = false;
        state.refs.set(branch, OTHER_HEAD);
        send(422, { message: 'Reference already exists' });
        return;
      }
      if (state.refs.has(branch)) {
        send(422, {});
        return;
      }
      state.refs.set(branch, body.sha);
      send(201, { ref: body.ref, object: { type: 'commit', sha: body.sha } });
      return;
    }
    if (method === 'POST' && route === '/pulls') {
      send(201, { html_url: 'https://github.com/alice/demo/pull/42' });
      return;
    }
    send(500, { message: `Unexpected ${method} ${route}` });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address() as { port: number };
  return { state, apiBase: `http://127.0.0.1:${address.port}`, allowTestApi: true as const };
}

const previewInput = (
  fixture: ReturnType<typeof snapshotFixture>,
  mock: Awaited<ReturnType<typeof githubMock>>,
) => ({
  snapshot: fixture.snapshot,
  readBlob: fixture.readBlob,
  owner: 'alice',
  repo: 'demo',
  baseBranch: 'main',
  token: TOKEN,
  apiBase: mock.apiBase,
  allowTestApi: mock.allowTestApi,
});
const publishInput = (
  preview: GitHubPreview,
  fixture: ReturnType<typeof snapshotFixture>,
  mock: Awaited<ReturnType<typeof githubMock>>,
  selectedPaths: string[],
) => ({
  preview,
  readBlob: fixture.readBlob,
  token: TOKEN,
  title: 'Reviewed snapshot',
  body: 'Publish selected files.',
  selectedPaths,
  apiBase: mock.apiBase,
  allowTestApi: mock.allowTestApi,
});
const isCode = (code: string) => (error: unknown) =>
  error instanceof CairnError && error.code === code;

test('snapshot ZIP preserves original binary bytes, CRLF, Unicode paths, directories and a safe immutable manifest', async (t) => {
  const root = tempFixture(t),
    binary = new Uint8Array([0, 255, 254, 128, 13, 10, 1]);
  const fixture = snapshotFixture({
    src: null,
    'src/한글.txt': 'first\r\nsecond\r\n',
    'assets/data.bin': binary,
    empty: null,
  });
  const before = structuredClone(fixture.snapshot),
    result = await exportSnapshot({ ...fixture, outputPath: path.join(root, 'snapshot.zip') });
  const archive = unzipSync(fs.readFileSync(result.path));
  assert.equal(result.files, 2);
  assert.equal(result.bytes, fs.statSync(result.path).size);
  assert.deepEqual(
    Object.keys(archive).sort(),
    [SNAPSHOT_MANIFEST_NAME, 'assets/data.bin', 'empty/', 'src/', 'src/한글.txt'].sort(),
  );
  assert.deepEqual(archive['assets/data.bin'], binary);
  assert.equal(Buffer.from(archive['src/한글.txt']).toString(), 'first\r\nsecond\r\n');
  const manifest = JSON.parse(Buffer.from(archive[SNAPSHOT_MANIFEST_NAME]).toString());
  assert.equal(manifest.revision, 7);
  assert.equal(manifest.contentHash, hash(JSON.stringify(manifest.files)));
  assert.deepEqual(
    Object.keys(manifest).sort(),
    ['format', 'version', 'revision', 'createdAt', 'contentHash', 'files'].sort(),
  );
  assert.ok(!JSON.stringify(manifest).includes('private-state'));
  assert.ok(!JSON.stringify(manifest).includes('stateHash'));
  assert.deepEqual(fixture.snapshot, before);
});

test('snapshot and GitHub ignore defaults cannot be negated or bypassed by a malicious manifest', async (t) => {
  const root = tempFixture(t),
    marker = 'NEVER_SHARE_THIS';
  const forbidden = [
    '.env',
    '.env.production',
    '.env-local',
    '.npmrc',
    'key.pem',
    'credentials.json',
    '.git',
    '.git/config',
    '.cairn-next/project.sqlite',
    '.cairn-snapshot-manifest.json',
    '.ssh/id_ed25519',
    'node_modules/pkg/a.js',
    'dist/bundle.js',
    'build',
    'cache.tmp',
  ];
  const fixture = snapshotFixture({
    'safe.txt': 'safe',
    '.gitignore': '!**/*\nlocal.log\n',
    'local.log': marker,
    rules: null,
    'rules/.gitignore': '*.private\n',
    'rules/data.private': marker,
    ...Object.fromEntries(forbidden.map((name) => [name, marker])),
  });
  fixture.snapshot.metadata.ignorePatterns = ['!**/*'];
  const reads = new Set<string>();
  const readBlob = async (digest: string) => {
    reads.add(digest);
    return fixture.readBlob(digest);
  };
  const result = await exportSnapshot({
    snapshot: fixture.snapshot,
    readBlob,
    outputPath: path.join(root, 'safe.zip'),
  });
  const archive = unzipSync(fs.readFileSync(result.path));
  assert.ok(
    !Object.keys(archive).some(
      (name) => forbidden.includes(name) && name !== SNAPSHOT_MANIFEST_NAME,
    ),
  );
  assert.ok(!reads.has(hash(marker)));
  assert.ok(!fs.readFileSync(result.path).includes(Buffer.from(marker)));
  const mock = await githubMock(t, {
    '.env': marker,
    '.git/config': marker,
    'remote.txt': 'keep',
    'rules/data.private': marker,
  });
  const preview = await previewGitHub({ ...previewInput(fixture, mock), readBlob });
  assert.ok(
    !preview.files.some(
      (file) =>
        forbidden.includes(file.path) ||
        file.path.endsWith('.private') ||
        file.path === 'local.log',
    ),
  );
  assert.ok(
    !mock.state.requests.some((request) => request.route === `/git/blobs/${gitSha(bytes(marker))}`),
  );
  assert.ok(preview.files.every((file) => file.selected === false));
  assert.ok(!JSON.stringify(preview).includes(TOKEN));
});

test('snapshot path validation rejects traversal, backslashes, NFC aliases, reserved names and case collisions', async (t) => {
  const root = tempFixture(t);
  for (const relative of [
    '../outside',
    '/absolute',
    'C:/absolute',
    'a\\b',
    'a//b',
    'con.txt',
    'name. ',
    'cafe\u0301.txt',
    'bad\ud800.txt',
  ]) {
    const fixture = snapshotFixture({ [relative]: 'data' });
    await assert.rejects(
      exportSnapshot({ ...fixture, outputPath: path.join(root, `${randomUUID()}.zip`) }),
      isCode('UNSAFE_PATH'),
    );
  }
  const collisions: Record<string, string>[] = [
    { 'A.txt': 'one', 'a.txt': 'two' },
    { 'Folder/a.txt': 'one', 'folder/b.txt': 'two' },
    { a: 'one', 'a/b.txt': 'two' },
  ];
  for (const entries of collisions) {
    const fixture = snapshotFixture(entries);
    await assert.rejects(
      exportSnapshot({ ...fixture, outputPath: path.join(root, `${randomUUID()}.zip`) }),
      isCode('PATH_COLLISION'),
    );
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('snapshot descriptors are frozen before blob reads and hash failures never publish a corrupt ZIP', async (t) => {
  const root = tempFixture(t),
    fixture = snapshotFixture({ 'note.txt': 'original' }),
    target = path.join(root, 'copy.zip');
  let calls = 0;
  const readBlob = async (digest: string) => {
    calls++;
    fixture.snapshot.revision = 999;
    fixture.snapshot.files[0].path = '.env';
    fixture.snapshot.files[0].hash = hash('changed');
    return fixture.readBlob(digest);
  };
  await exportSnapshot({ snapshot: fixture.snapshot, readBlob, outputPath: target });
  const archive = unzipSync(fs.readFileSync(target));
  assert.equal(Buffer.from(archive['note.txt']).toString(), 'original');
  assert.equal(JSON.parse(Buffer.from(archive[SNAPSHOT_MANIFEST_NAME]).toString()).revision, 7);
  assert.equal(calls, 1);
  const bad = snapshotFixture({ 'bad.txt': 'expected' }),
    badTarget = path.join(root, 'bad.zip');
  await assert.rejects(
    exportSnapshot({ ...bad, readBlob: async () => bytes('modified'), outputPath: badTarget }),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotExportError);
      assert.equal(error.code, 'BLOB_HASH_MISMATCH');
      assert.ok(error.recoveryPath && fs.existsSync(error.recoveryPath));
      return true;
    },
  );
  assert.equal(fs.existsSync(badTarget), false);
});

test('snapshot uses atomic no-replace publication and preserves a racing destination plus recovery ZIP', async (t) => {
  const root = tempFixture(t),
    fixture = snapshotFixture({ 'note.txt': 'snapshot' }),
    target = path.join(root, 'race.zip');
  const readBlob = async (digest: string) => {
    fs.writeFileSync(target, 'external writer', { flag: 'wx' });
    return fixture.readBlob(digest);
  };
  await assert.rejects(
    exportSnapshot({ ...fixture, readBlob, outputPath: target }),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotExportError);
      assert.equal(error.code, 'EXPORT_EXISTS');
      assert.ok(error.recoveryPath);
      assert.equal(
        Buffer.from(unzipSync(fs.readFileSync(error.recoveryPath))['note.txt']).toString(),
        'snapshot',
      );
      return true;
    },
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'external writer');
  await assert.rejects(exportSnapshot({ ...fixture, outputPath: target }), isCode('EXPORT_EXISTS'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'external writer');
});

test('GitHub preview is read-only; explicit publication preserves bytes and remote unselected files', async (t) => {
  const binary = new Uint8Array([0, 1, 255, 128, 13, 10]),
    fixture = snapshotFixture({ 'src/note.txt': 'new\r\n', 'image.bin': binary, empty: null });
  const mock = await githubMock(t, {
    'src/note.txt': 'old\r\n',
    'remove.txt': 'remove',
    'keep.txt': 'unrelated',
  });
  mock.state.remote.get('src/note.txt')!.mode = '100755';
  const preview = await previewGitHub(previewInput(fixture, mock));
  assert.ok(mock.state.requests.every((request) => request.method === 'GET'));
  assert.equal(preview.baseHead, HEAD);
  assert.equal(preview.baseTree, TREE);
  assert.ok(preview.files.every((file) => !file.selected));
  assert.match(preview.files.find((file) => file.path === 'src/note.txt')!.diff!, /-old\r?\n\+new/);
  assert.equal(preview.files.find((file) => file.path === 'image.bin')!.kind, 'binary');
  await assert.rejects(
    publishGitHub(publishInput(preview, fixture, mock, [])),
    isCode('GITHUB_SELECTION_EMPTY'),
  );
  assert.ok(mock.state.requests.every((request) => request.method === 'GET'));
  const result = await publishGitHub(
    publishInput(preview, fixture, mock, ['src/note.txt', 'image.bin', 'remove.txt']),
  );
  assert.equal(result.url, 'https://github.com/alice/demo/pull/42');
  assert.match(result.branch, /^cairn-export-r7-/);
  assert.deepEqual(mock.state.uploads.get(gitSha(binary)), Buffer.from(binary));
  const tree = mock.state.requests.find(
    (request) => request.method === 'POST' && request.route === '/git/trees',
  )!.body;
  assert.equal(tree.base_tree, TREE);
  assert.deepEqual(
    tree.tree.map((entry: any) => entry.path).sort(),
    ['src/note.txt', 'image.bin', 'remove.txt'].sort(),
  );
  assert.equal(tree.tree.find((entry: any) => entry.path === 'remove.txt').sha, null);
  assert.equal(tree.tree.find((entry: any) => entry.path === 'src/note.txt').mode, '100755');
  const commit = mock.state.requests.find(
    (request) => request.method === 'POST' && request.route === '/git/commits',
  )!.body;
  assert.deepEqual(commit.parents, [HEAD]);
  assert.equal(commit.tree, NEW_TREE);
  assert.equal(mock.state.refs.get(result.branch), NEW_COMMIT);
  assert.ok(
    !mock.state.requests.some((request) => ['DELETE', 'PATCH', 'PUT'].includes(request.method)),
  );
});

test('GitHub preview omits unchanged files and rejects incomplete remote trees', async (t) => {
  const fixture = snapshotFixture({ 'same.txt': 'unchanged' }),
    mock = await githubMock(t, { 'same.txt': 'unchanged' });
  const preview = await previewGitHub(previewInput(fixture, mock));
  assert.deepEqual(preview.files, []);
  assert.ok(!mock.state.requests.some((request) => request.route.startsWith('/git/blobs/')));
  mock.state.truncated = true;
  await assert.rejects(
    previewGitHub(previewInput(fixture, mock)),
    isCode('GITHUB_TREE_INCOMPLETE'),
  );
});

test('GitHub rejects changed base before upload and a base change during preview', async (t) => {
  const fixture = snapshotFixture({ 'note.txt': 'new' }),
    mock = await githubMock(t, {});
  const preview = await previewGitHub(previewInput(fixture, mock));
  mock.state.head = OTHER_HEAD;
  await assert.rejects(
    publishGitHub(publishInput(preview, fixture, mock, ['note.txt'])),
    isCode('GITHUB_BASE_CHANGED'),
  );
  assert.ok(mock.state.requests.every((request) => request.method === 'GET'));
  mock.state.head = HEAD;
  mock.state.changeOnBaseRead = mock.state.baseReads + 2;
  await assert.rejects(previewGitHub(previewInput(fixture, mock)), isCode('GITHUB_BASE_CHANGED'));
});

test('GitHub verifies every selected digest before any upload and rejects altered preview metadata', async (t) => {
  const fixture = snapshotFixture({ 'a.txt': 'first', 'b.txt': 'second' }),
    mock = await githubMock(t, {});
  const preview = await previewGitHub(previewInput(fixture, mock));
  await assert.rejects(
    publishGitHub({
      ...publishInput(preview, fixture, mock, ['a.txt', 'b.txt']),
      readBlob: async (digest: string) =>
        digest === hash('second') ? bytes('wrong!') : fixture.readBlob(digest),
    }),
    isCode('BLOB_HASH_MISMATCH'),
  );
  assert.ok(mock.state.requests.every((request) => request.method === 'GET'));
  const altered = structuredClone(preview);
  altered.files[0].path = 'different.txt';
  await assert.rejects(
    publishGitHub(publishInput(altered, fixture, mock, ['different.txt'])),
    isCode('GITHUB_PREVIEW_CHANGED'),
  );
  await assert.rejects(
    publishGitHub(publishInput(preview, fixture, mock, ['missing.txt'])),
    isCode('GITHUB_SELECTION_INVALID'),
  );
});

test('GitHub base races after content verification and after new-branch creation stop before the next write', async (t) => {
  const fixture = snapshotFixture({ 'note.txt': 'new' }),
    mock = await githubMock(t, {});
  const preview = await previewGitHub(previewInput(fixture, mock));
  await assert.rejects(
    publishGitHub({
      ...publishInput(preview, fixture, mock, ['note.txt']),
      readBlob: async (digest: string) => {
        mock.state.head = OTHER_HEAD;
        return fixture.readBlob(digest);
      },
    }),
    isCode('GITHUB_BASE_CHANGED'),
  );
  assert.ok(mock.state.requests.every((request) => request.method === 'GET'));
  mock.state.head = HEAD;
  // Pre-read, pre-upload and post-commit pass. The base moves just after branch creation.
  mock.state.changeOnBaseRead = mock.state.baseReads + 4;
  await assert.rejects(
    publishGitHub(publishInput(preview, fixture, mock, ['note.txt'])),
    (error: unknown) => {
      assert.ok(error instanceof GitHubExportError);
      assert.equal(error.code, 'GITHUB_BASE_CHANGED');
      assert.ok(error.branch);
      assert.equal(mock.state.refs.get(error.branch), NEW_COMMIT);
      return true;
    },
  );
  assert.ok(
    !mock.state.requests.some((request) => request.method === 'POST' && request.route === '/pulls'),
  );
});

test('GitHub wrong token and permission failures do not expose token or reflected response bodies', async (t) => {
  const fixture = snapshotFixture({ 'note.txt': 'text' }),
    mock = await githubMock(t, {});
  await assert.rejects(
    previewGitHub({ ...previewInput(fixture, mock), token: 'incorrect-token' }),
    isCode('GITHUB_AUTH'),
  );
  mock.state.failures.push({ method: 'GET', route: '/git/ref/heads/main', status: 403 });
  await assert.rejects(previewGitHub(previewInput(fixture, mock)), (error: unknown) => {
    assert.ok(error instanceof GitHubExportError);
    assert.equal(error.code, 'GITHUB_PERMISSION');
    assert.ok(!JSON.stringify(error).includes(TOKEN));
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  assert.ok(mock.state.requests.every((request) => request.method === 'GET'));
});

test('GitHub endpoint restriction requires an explicit trusted loopback test flag and blocks redirects', async (t) => {
  const fixture = snapshotFixture({ 'note.txt': 'text' }),
    mock = await githubMock(t, {});
  for (const apiBase of [
    mock.apiBase,
    'http://api.github.com',
    'https://api.github.com.evil.test',
    'https://user:password@api.github.com',
    'https://api.github.com/path',
    'https://api.github.com/?secret=1',
  ]) {
    await assert.rejects(
      previewGitHub({ ...previewInput(fixture, mock), apiBase, allowTestApi: false }),
      isCode('GITHUB_API_INVALID'),
    );
  }
  assert.equal(mock.state.requests.length, 0);
  let redirected = 0;
  const other = http.createServer((_request, response) => {
    redirected++;
    response.end('{}');
  });
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(async () => {
    other.closeAllConnections();
    await new Promise<void>((resolve) => other.close(() => resolve()));
  });
  mock.state.redirect = `http://127.0.0.1:${(other.address() as { port: number }).port}/stolen`;
  await assert.rejects(previewGitHub(previewInput(fixture, mock)), isCode('GITHUB_NETWORK'));
  assert.equal(redirected, 0);
});

test('GitHub API failure before ref creation leaves base untouched; PR failure preserves recoverable branch', async (t) => {
  const fixture = snapshotFixture({ 'note.txt': 'new' }),
    mock = await githubMock(t, {});
  const preview = await previewGitHub(previewInput(fixture, mock));
  mock.state.failures.push({ method: 'POST', route: '/git/trees', status: 500 });
  await assert.rejects(
    publishGitHub(publishInput(preview, fixture, mock, ['note.txt'])),
    (error: unknown) => {
      assert.ok(error instanceof GitHubExportError);
      assert.equal(error.stage, 'create-tree');
      assert.equal(error.branch, undefined);
      return true;
    },
  );
  assert.equal(mock.state.refs.size, 0);
  assert.equal(mock.state.head, HEAD);
  mock.state.failures.length = 0;
  mock.state.failures.push({ method: 'POST', route: '/pulls', status: 403 });
  await assert.rejects(
    publishGitHub(publishInput(preview, fixture, mock, ['note.txt'])),
    (error: unknown) => {
      assert.ok(error instanceof GitHubExportError);
      assert.equal(error.stage, 'create-pr');
      assert.ok(error.branch);
      assert.equal(error.commit, NEW_COMMIT);
      assert.equal(mock.state.refs.get(error.branch), NEW_COMMIT);
      return true;
    },
  );
  assert.equal(mock.state.head, HEAD);
  assert.ok(
    !mock.state.requests.some(
      (request) => request.method === 'DELETE' || request.method === 'PATCH',
    ),
  );
});

test('GitHub collision retry creates a fresh branch without changing the colliding reference', async (t) => {
  const fixture = snapshotFixture({ 'note.txt': 'new' }),
    mock = await githubMock(t, {});
  const preview = await previewGitHub(previewInput(fixture, mock));
  mock.state.collisionOnce = true;
  const result = await publishGitHub(publishInput(preview, fixture, mock, ['note.txt']));
  assert.equal(mock.state.refs.size, 2);
  assert.equal(mock.state.refs.get(result.branch), NEW_COMMIT);
  assert.equal([...mock.state.refs.values()].filter((sha) => sha === OTHER_HEAD).length, 1);
});

test('GitHub rejects symlink replacement and portable case conflicts while leaving unrelated content available', async (t) => {
  const fixture = snapshotFixture({ 'link.txt': 'new', 'FILE.txt': 'new', 'safe.txt': 'yes' });
  const mock = await githubMock(t, { 'link.txt': 'some-target', 'file.txt': 'existing' });
  mock.state.remote.get('link.txt')!.mode = '120000';
  const preview = await previewGitHub(previewInput(fixture, mock));
  assert.ok(!preview.files.some((file) => file.path === 'link.txt' || file.path === 'FILE.txt'));
  assert.ok(preview.excluded.some((file) => file.path === 'link.txt'));
  assert.ok(preview.excluded.some((file) => file.path === 'FILE.txt'));
  assert.ok(preview.files.some((file) => file.path === 'safe.txt'));
});

test('export module runs in an independent process with real ZIP and loopback GitHub transport', async (t) => {
  const root = tempFixture(t),
    fixture = snapshotFixture({
      'hello.txt': 'child\r\n',
      'binary.bin': new Uint8Array([255, 0, 128]),
    });
  const mock = await githubMock(t, {}),
    output = path.join(root, 'child.zip');
  const payload = {
    snapshot: fixture.snapshot,
    blobs: Object.fromEntries(
      [...fixture.blobs].map(([digest, data]) => [digest, Buffer.from(data).toString('base64')]),
    ),
    output,
    apiBase: mock.apiBase,
  };
  const code = `
    import { exportSnapshot, previewGitHub, publishGitHub } from ${JSON.stringify(new URL('../core/project/exports.js', import.meta.url).href)};
    let text = ''; for await (const chunk of process.stdin) text += chunk;
    const data = JSON.parse(text), readBlob = async (hash) => Buffer.from(data.blobs[hash], 'base64');
    const zip = await exportSnapshot({ snapshot: data.snapshot, readBlob, outputPath: data.output });
    const options = { snapshot: data.snapshot, readBlob, token: 'test-only-memory-token', apiBase: data.apiBase, allowTestApi: true };
    const preview = await previewGitHub({ ...options, owner: 'alice', repo: 'demo', baseBranch: 'main' });
    const result = await publishGitHub({ ...options, preview, title: 'Child process', body: '', selectedPaths: ['hello.txt', 'binary.bin'] });
    process.stdout.write(JSON.stringify({ zip, result }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify(payload));
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.result.url, 'https://github.com/alice/demo/pull/42');
  const archive = unzipSync(fs.readFileSync(output));
  assert.deepEqual(archive['binary.bin'], new Uint8Array([255, 0, 128]));
  assert.equal(Buffer.from(archive['hello.txt']).toString(), 'child\r\n');
});
