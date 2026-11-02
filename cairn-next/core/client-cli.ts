import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as Y from 'yjs';
import { CairnClient } from './client.js';
import { CairnError, publicError, unb64 } from './common.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
function statusOnly(state: ReturnType<CairnClient['snapshot']>) {
  const { text: _text, state: _binaryState, directory: _directory, ...status } = state;
  return status;
}
const root = arg('--root');
const inviteFile = arg('--invite-file');
if (process.argv.includes('--help') || !root || !inviteFile) {
  process.stderr.write(
    'Usage: node dist/core/client-cli.js --root <empty-work-folder> --invite-file <private-invite.json> --name <display-name> [--offline]\n',
  );
  process.exitCode = process.argv.includes('--help') ? 0 : 2;
} else {
  let client: CairnClient | undefined;
  try {
    // Constructor validates the complete invite but permits opening a known offline cache
    // with expired credentials; connect() will require fresh authentication.
    client = new CairnClient({
      directory: root,
      invite: JSON.parse(fs.readFileSync(inviteFile, 'utf8')),
      name: arg('--name') ?? 'Participant',
    });
    const current = client;
    current.on('state', (state) => output({ event: 'state', state: statusOnly(state) }));
    current.on('awareness', (update) => output({ event: 'awareness', update }));
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      current.close();
      lines.close();
    };
    process.once('SIGINT', () => {
      stop();
      process.exitCode = 0;
    });
    process.once('SIGTERM', () => {
      stop();
      process.exitCode = 0;
    });
    lines.on('line', (line) => {
      void (async () => {
        let message: {
          id?: unknown;
          cmd?: unknown;
          index?: unknown;
          text?: unknown;
          length?: unknown;
          update?: unknown;
          message?: unknown;
        } = {};
        try {
          if (line.length > 8 * 1024 * 1024)
            throw new CairnError('SIZE_LIMIT', '명령이 너무 큽니다.');
          message = JSON.parse(line);
          let result: unknown;
          switch (message.cmd) {
            case 'state':
              result = current.snapshot();
              break;
            case 'connect':
              await current.connect();
              result = current.snapshot();
              break;
            case 'disconnect':
              current.disconnect();
              result = current.snapshot();
              break;
            case 'retry-projection':
              current.retryProjection();
              result = current.snapshot();
              break;
            case 'raw':
              current.sendRaw(message.message);
              result = { sent: true };
              break;
            case 'update':
              if (typeof message.update !== 'string') throw new Error('update');
              result = current.applyLocalUpdate(unb64(message.update));
              break;
            case 'insert':
            case 'delete': {
              const doc = current.doc;
              try {
                const text = doc.getText('content');
                const index = message.index;
                if (
                  typeof index !== 'number' ||
                  !Number.isInteger(index) ||
                  index < 0 ||
                  index > text.length
                )
                  throw new CairnError('INVALID_RANGE', '잘못된 텍스트 위치입니다.');
                let update: Uint8Array | undefined;
                doc.on('update', (value) => {
                  update = value;
                });
                if (message.cmd === 'insert') {
                  if (typeof message.text !== 'string')
                    throw new CairnError('INVALID_TEXT', '문자열을 입력하세요.');
                  text.insert(index, message.text);
                } else {
                  const length = message.length;
                  if (
                    typeof length !== 'number' ||
                    !Number.isInteger(length) ||
                    length < 0 ||
                    index + length > text.length
                  )
                    throw new CairnError('INVALID_RANGE', '잘못된 삭제 범위입니다.');
                  text.delete(index, length);
                }
                result = update ? current.applyLocalUpdate(update) : current.snapshot();
              } finally {
                doc.destroy();
              }
              break;
            }
            case 'exit':
              result = { closed: true };
              output({ id: message.id, result });
              stop();
              return;
            default:
              throw new CairnError('UNKNOWN_COMMAND', '알 수 없는 명령입니다.');
          }
          output({ id: message.id, result });
        } catch (error) {
          output({ id: message.id, error: publicError(error) });
        }
      })();
    });
    output({ event: 'ready', state: statusOnly(current.snapshot()) });
    if (!process.argv.includes('--offline'))
      void current
        .connect()
        .catch((error) => output({ event: 'connection-error', error: publicError(error) }));
  } catch (error) {
    client?.close();
    output({ event: 'fatal', error: publicError(error) });
    process.exitCode = 1;
  }
}
