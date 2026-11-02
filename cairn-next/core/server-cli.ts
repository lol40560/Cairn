import { parseArgs } from 'node:util';
import * as path from 'node:path';
import { CairnServer } from './server.js';
import { publicError, writeDurable } from './common.js';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    file: { type: 'string' },
    name: { type: 'string' },
    'invite-file': { type: 'string' },
    address: { type: 'string' },
    help: { type: 'boolean' },
  },
  strict: true,
});
if (values.help || !values.root) {
  console.log(
    'Cairn Next server\nnode dist/core/server-cli.js --root <dedicated folder> [--port 47123] [--host 0.0.0.0] [--file collaboration.txt] [--name Cairn]\nOptional: --invite-file <new private .json file> [--address wss://LAN-IP:port/cairn]\nCtrl+C stops the server. No router or firewall settings are changed.',
  );
  process.exitCode = values.help ? 0 : 2;
} else {
  try {
    const server = await CairnServer.start({
      root: values.root,
      port: values.port ? Number(values.port) : undefined,
      host: values.host,
      fileName: values.file,
      name: values.name,
    });
    if (values['invite-file']) {
      try {
        const invite = server.invite('editor', values.address);
        writeDurable(path.resolve(values['invite-file']), JSON.stringify(invite, null, 2));
      } catch (error) {
        await server.stop();
        throw error;
      }
    }
    console.log(JSON.stringify({ type: 'ready', status: server.status() }));
    server.on('error', (error) =>
      console.error(JSON.stringify({ type: 'error', code: error.code, message: error.message })),
    );
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void server.stop().then(() => {
        console.log(JSON.stringify({ type: 'stopped' }));
        process.exitCode = 0;
      });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    console.error(JSON.stringify({ type: 'error', ...publicError(error) }));
    process.exitCode = 1;
  }
}
