const { spawnSync } = require('node:child_process');
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
const commands = [
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.node.json', '--noEmit'],
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.web.json'],
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.node.json'],
  ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'],
  ['--test', '--test-concurrency=1', 'dist/tests/*.test.js'],
];
if (process.argv.includes('--desktop'))
  commands.push(['tests/release.e2e.cjs'], ['tests/startup-close.e2e.cjs']);
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
