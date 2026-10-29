const { spawnSync } = require('node:child_process');
const code = `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,chrome:process.versions.chrome,platform:process.platform,arch:process.arch,sqlite:d.prepare('select sqlite_version() as version').get().version}));d.close();`;
const result = spawnSync(require('electron'), ['-e', code], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
