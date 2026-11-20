import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { install } from './install-transaction.mjs';
import { configureUpdater } from './configure-update.mjs';

const source = dirname(fileURLToPath(import.meta.url));

async function main() {
  const { values: args } = parseArgs({
    options: Object.fromEntries(['prefix', 'project', 'bind', 'port'].map(name => [name, { type: 'string' }])),
  });
  await install({ source, args });
  try {
    configureUpdater(args.prefix);
  } catch (error) {
    throw new Error(`Updater configuration failed after program installation: ${error.message}`, { cause: error });
  }
}

main().catch(error => {
  console.error(`agent-link install: ${error.message}`);
  process.exitCode = 1;
});
