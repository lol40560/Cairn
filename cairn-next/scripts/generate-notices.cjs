/* Local installed-package inventory only. No network access or package installation. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const application = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'THIRD_PARTY_NOTICES.md');
const packages = new Map();
const visited = new Set();
const omissions = new Set();
const issues = new Set();
const texts = new Map();
const escapeCell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');

function locate(name, from) {
  let current = from;
  while (true) {
    const candidate = path.join(current, 'node_modules', ...name.split('/'), 'package.json');
    if (fs.existsSync(candidate)) return fs.realpathSync(path.dirname(candidate));
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function licenseExpression(metadata) {
  if (typeof metadata.license === 'string') return metadata.license;
  if (metadata.license?.type) return metadata.license.type;
  if (Array.isArray(metadata.licenses))
    return metadata.licenses.map((license) => license.type || String(license)).join(' OR ');
  return 'NOT DECLARED';
}

function recordLicense(directory, metadata, scope) {
  const identity = `${metadata.name}@${metadata.version}`;
  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(?:licen[cs]e(?:[._-].*)?|copying(?:[._-].*)?|(?:third[-_ ]?party[-_ ]?)?notices?(?:[._-].*)?|copyright(?:[._-].*)?)$/i.test(
          entry.name,
        ),
    )
    .map((entry) => entry.name)
    .sort();
  const references = [];
  for (const filename of files) {
    const file = path.join(directory, filename);
    if (fs.statSync(file).size > 1024 * 1024) {
      issues.add(`${identity}: ${filename} exceeds the 1 MiB text embedding limit.`);
      continue;
    }
    const content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd();
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    if (!texts.has(digest)) texts.set(digest, { content, uses: [] });
    texts.get(digest).uses.push(`${identity} — ${filename}`);
    references.push(digest);
  }
  const license = licenseExpression(metadata);
  if (!references.length)
    issues.add(
      `${identity}: no top-level license/notice text found; inspect package source before distribution.`,
    );
  if (['NOT DECLARED', 'UNLICENSED', 'NONE'].includes(license.toUpperCase()))
    issues.add(`${identity}: license metadata is ${license}.`);
  const existing = packages.get(identity);
  if (!existing)
    packages.set(identity, {
      name: metadata.name,
      version: metadata.version,
      license,
      scope,
      references,
    });
  else if (scope === 'direct') existing.scope = scope;
}

function visit(name, from, scope, optional = false) {
  const directory = locate(name, from);
  if (!directory) {
    const message = `${name}: ${optional ? 'optional dependency or peer' : 'required dependency'} not installed.`;
    if (optional) omissions.add(message);
    else issues.add(message);
    return;
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  recordLicense(directory, metadata, scope);
  if (visited.has(directory)) return;
  visited.add(directory);
  const edges = {
    ...metadata.dependencies,
    ...metadata.peerDependencies,
    ...metadata.optionalDependencies,
  };
  for (const child of Object.keys(edges).sort()) {
    const optionalChild =
      Object.hasOwn(metadata.optionalDependencies || {}, child) ||
      metadata.peerDependenciesMeta?.[child]?.optional === true;
    visit(child, directory, 'transitive', optionalChild);
  }
}

for (const name of Object.keys(application.dependencies || {}).sort()) visit(name, root, 'direct');
const electronDirectory = locate('electron', root);
let electronVersion = 'not installed';
const runtimeFiles = [];
if (electronDirectory) {
  const electron = JSON.parse(
    fs.readFileSync(path.join(electronDirectory, 'package.json'), 'utf8'),
  );
  electronVersion = electron.version;
  recordLicense(electronDirectory, electron, 'runtime');
  // Chromium's full aggregate notices belong beside Electron, not inside an app.asar.
  for (const filename of ['LICENSE', 'LICENSES.chromium.html']) {
    const file = path.join(electronDirectory, 'dist', filename);
    if (!fs.existsSync(file)) {
      issues.add(`Electron runtime: ${filename} is missing from the installed distribution.`);
      continue;
    }
    const content = fs.readFileSync(file);
    runtimeFiles.push({
      filename,
      bytes: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    });
  }
} else issues.add('Electron runtime package is not installed.');

const sortedPackages = [...packages.values()].sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'),
);
const sortedTexts = [...texts.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'));
const textNumbers = new Map(sortedTexts.map(([digest], index) => [digest, index + 1]));
const lines = [
  '# Third-party notices — Cairn Next',
  '',
  'Generated from the installed package metadata and license files by `node scripts/generate-notices.cjs`. No downloads or registry lookups are performed. Versions below describe this checkout, not a claim that the software has been publicly released.',
  '',
  `This inventory covers ${sortedPackages.length} distinct installed package versions in the production dependency graph, including resolved dependencies and peers and the Electron ${electronVersion} runtime. Development-only tools are not traversed. Runtime peers that are present are included; optional packages absent from this installation are listed separately.`,
  '',
  'Cairn Next itself is marked `UNLICENSED` in package.json. Third-party licenses grant rights for their respective components; this file does not grant a license to Cairn Next or the user’s project files.',
  '',
  '## Distribution requirements',
  '',
  '- Include this file with the application, including the full texts below.',
  '- Keep Electron’s `LICENSE` and `LICENSES.chromium.html` with the packaged runtime. The latter contains the runtime’s bundled Chromium and other third-party notices; the npm package table is not a substitute for it.',
  '- Regenerate and review this inventory after dependency changes and on the machine that creates each platform artifact. The runtime-file hashes below identify the inspected installed distribution, which may differ by platform.',
  '- Metadata license expressions are reproduced as provided by packages. For DOMPurify’s dual license, retain both supplied texts; the application may use the Apache-2.0 option. This inventory does not rewrite or relicense dependencies.',
  '',
  '## Installed package inventory',
  '',
  '| Package | Version | Metadata license | Scope | Included texts |',
  '| --- | --- | --- | --- | --- |',
  ...sortedPackages.map(
    (entry) =>
      `| ${escapeCell(entry.name)} | ${escapeCell(entry.version)} | ${escapeCell(entry.license)} | ${entry.scope} | ${[...new Set(entry.references)].map((digest) => `[${textNumbers.get(digest)}](#license-text-${textNumbers.get(digest)})`).join(', ') || 'See review items'} |`,
  ),
  '',
  '## Electron runtime notice files',
  '',
  '| File in installed Electron distribution | Bytes | SHA-256 |',
  '| --- | ---: | --- |',
  ...runtimeFiles.map((entry) => `| ${entry.filename} | ${entry.bytes} | \`${entry.sha256}\` |`),
  '',
  'Source location before packaging: `node_modules/electron/dist/`. On macOS the installed runtime layout can differ; preserve the corresponding notices shipped with that Electron distribution.',
  '',
  '## Review items',
  '',
  ...(issues.size
    ? [...issues].sort().map((issue) => `- ${issue}`)
    : [
        'No missing top-level license texts or undeclared license expressions were detected in the traversed installed graph. This check does not replace a legal or complete packaged-artifact review.',
      ]),
  '',
  '## Optional packages absent from this installation',
  '',
  ...(omissions.size
    ? [...omissions].sort().map((omission) => `- ${omission}`)
    : ['None encountered.']),
  '',
  '## Included license and notice texts',
  '',
];
for (const [digest, entry] of sortedTexts) {
  const number = textNumbers.get(digest);
  const fence = '`'.repeat(
    Math.max(3, ...[...entry.content.matchAll(/`+/g)].map((match) => match[0].length + 1)),
  );
  lines.push(
    `### License text ${number}`,
    '',
    ...[...new Set(entry.uses)].sort().map((use) => `- ${use}`),
    '',
    `Text SHA-256: \`${digest}\``,
    '',
    fence + 'text',
    entry.content,
    fence,
    '',
  );
}
const result = lines.join('\n');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== result) {
    console.error(
      'THIRD_PARTY_NOTICES.md differs from the installed dependency inventory. Regenerate it.',
    );
    process.exitCode = 1;
  }
} else fs.writeFileSync(output, result, 'utf8');
console.log(
  JSON.stringify(
    {
      packages: sortedPackages.length,
      embeddedTexts: sortedTexts.length,
      runtimeNoticeFiles: runtimeFiles.length,
      reviewItems: [...issues].sort(),
      absentOptional: [...omissions].sort(),
    },
    null,
    2,
  ),
);
