/**
 * app:// static file resolution with path traversal guard (design 6.2).
 * The renderer may only load files bundled under the renderer root.
 */

import path from 'node:path';

export function resolveAppFilePath(rootDir: string, requestPath: string): string | null {
  if (!rootDir || !requestPath) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (decoded.includes('\\')) return null;
  const relative = decoded.replace(/^\/+/, '').split('/').filter((segment) => segment.length > 0);
  for (const segment of relative) {
    if (segment === '..' || segment === '.') return null;
  }
  const joined = path.join(rootDir, ...relative);
  const normalizedRoot = path.resolve(rootDir);
  const normalizedJoined = path.resolve(joined);
  if (normalizedJoined !== normalizedRoot && !normalizedJoined.startsWith(normalizedRoot + path.sep)) {
    return null;
  }
  return normalizedJoined;
}
