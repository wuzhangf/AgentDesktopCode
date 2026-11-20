import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { installationPaths, systemctl } from './install-transaction.mjs';
import { readSlot, syncPath, writeAtomic } from './slots.mjs';

const timer = 'agent-link-update.timer';
const service = 'agent-link-update.service';
const scheduled = 'agent-link-update-scheduled.service';
const revision = '3\n';

const quoted = (value, exec = true) => {
  const path = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return '"' + (exec ? path.replaceAll('$', '$$') : path) + '"';
};

export function configureUpdater(requestedPrefix) {
  const { program, prefix, updateRoot, unitDir, xdgConfig } = installationPaths(requestedPrefix);
  const current = readSlot(program, 'current');
  if (!current) return;
  const slot = join(program, current);
  const trust = join(slot, 'bootstrap/trust.json');
  const settings = join(updateRoot, 'settings.json');
  if (!existsSync(trust) && !existsSync(settings)) return;

  const bootstrap = join(program, 'updater');
  const installed = join(bootstrap, 'configured');
  const configured = existsSync(installed);
  if (configured && readFileSync(installed, 'utf8') === revision) return;
  const timerWasActive = configured && systemctl('show', timer, '--property=ActiveState', '--value') === 'active';
  for (const directory of [updateRoot, bootstrap, join(updateRoot, 'metadata')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw new Error('Update directories must be local to the installation');
  }
  const root = join(updateRoot, 'metadata/root.json');
  if (!existsSync(settings)) {
    const pinned = JSON.parse(readFileSync(trust, 'utf8'));
    if (!existsSync(root)) writeAtomic(root, readFileSync(join(slot, 'bootstrap/root.json')));
    writeAtomic(settings, JSON.stringify({ ...pinned, cohort: randomUUID() }));
  } else if (!existsSync(root)) {
    throw new Error('The installed TUF root cache is missing');
  }
  const node = join(bootstrap, 'node');
  const updater = join(bootstrap, 'update.cjs');
  if (!existsSync(node)) {
    linkSync(join(slot, 'runtime/node'), node);
    syncPath(bootstrap);
  }
  writeAtomic(updater, readFileSync(join(slot, 'bootstrap/update.cjs')));
  const values = {
    '@XDG_CONFIG@': quoted(`XDG_CONFIG_HOME=${xdgConfig}`, false),
    '@LOCK@': quoted(join(unitDir, '.agent-link.install.lock')),
    '@NODE@': quoted(node),
    '@UPDATER@': quoted(updater),
    '@PREFIX@': quoted(prefix),
  };
  for (const name of [service, scheduled, timer]) {
    let template = readFileSync(join(slot, 'systemd', name === scheduled ? service : name), 'utf8');
    if (name === scheduled) template = template.replace(/^ExecStart=.+$/m, '$& --scheduled');
    writeAtomic(join(unitDir, name), template.replace(/@[A-Z_]+@/g, token => values[token]), 0o644);
  }
  systemctl('daemon-reload');
  for (const name of [service, scheduled]) {
    if (!systemctl('show', name, '--property=FragmentPath', '--value')) systemctl('link', join(unitDir, name));
  }
  // An absolute timer path works when the installed XDG config differs
  // from the environment that originally started the user manager.
  if (!configured) systemctl('enable', '--now', join(unitDir, timer));
  else if (timerWasActive) systemctl('restart', timer);
  writeAtomic(installed, revision);
  console.log('Agent Link update scheduler configured');
}
