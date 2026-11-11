import {validPersonalEnvelope, type PersonalOperation} from '../../../packages/protocol/src/personal';

/** Bounded personal gateway call. All traffic stays in Electron main through
 * the fixed operation whitelist and the production preload — the renderer
 * never sees an origin, credential or arbitrary request. */
export async function personalCall<T>(operation: PersonalOperation): Promise<T> {
  const value = await window.codeAgentDesktop.personalOperation?.(operation);
  if (!validPersonalEnvelope(value)) throw new Error(value && 'error' in value ? String(value.error) : '个人管理网关响应无效');
  return value.data as T;
}

export function readStored<T>(key: string): T | undefined {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : undefined;
  } catch {
    return undefined;
  }
}

export function writeStored(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function removeStored(key: string): void {
  localStorage.removeItem(key);
}
