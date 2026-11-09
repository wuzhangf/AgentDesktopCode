import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProfileResolutionError,
  resolveLaunchProfile,
  validateProfileId
} from '../../electron/main/bootstrap/profileResolver';

const ownedRoots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-profile-'));
  ownedRoots.push(root);
  return root;
}
afterEach(() => {
  for (const root of ownedRoots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});

describe('resolveLaunchProfile', () => {
  it('uses explicit profile before environment and keeps endpoint out of the result', () => {
    const root = tempRoot();
    const first = resolveLaunchProfile({
      argv: ['--desktop-profile', 'desktop-a'],
      env: { CODEAGENT_DESKTOP_PROFILE: 'desktop-a' },
      appRoot: root,
      isPackaged: true,
      packagedChannel: 'stable',
      desktopProfilesRoot: root,
      endpoint: 'http://127.0.0.1:8765'
    });
    const second = resolveLaunchProfile({
      argv: ['--desktop-profile=desktop-a'],
      env: {},
      appRoot: root,
      isPackaged: true,
      packagedChannel: 'stable',
      desktopProfilesRoot: root,
      endpoint: 'http://127.0.0.1:9876'
    });
    expect(first).toEqual(second);
    expect(first.source).toBe('argument');
    const physicalRoot = fs.realpathSync.native(root);
    expect(first.root).toBe(physicalRoot);
    expect(first.profileDir).toBe(path.join(physicalRoot, 'stable', 'desktop-a'));
  });

  it('rejects conflicting explicit and environment profiles', () => {
    expect(() => resolveLaunchProfile({
      argv: ['--desktop-profile', 'desktop-a'],
      env: { CODEAGENT_DESKTOP_PROFILE: 'desktop-b' },
      appRoot: tempRoot(),
      isPackaged: true,
      desktopProfilesRoot: tempRoot()
    })).toThrowError(expect.objectContaining({ code: 'PROFILE_ARGUMENT_CONFLICT' }));
    expect(() => resolveLaunchProfile({
      argv: ['--desktop-profile', 'desktop-a', '--desktop-profile=desktop-b'],
      env: {},
      appRoot: tempRoot(),
      isPackaged: true,
      desktopProfilesRoot: tempRoot()
    })).toThrowError(expect.objectContaining({ code: 'PROFILE_ARGUMENT_CONFLICT' }));
  });

  it('derives unpackaged profile from canonical appRoot', () => {
    const appRoot = tempRoot();
    const expected = `dev-${crypto.createHash('sha256').update(fs.realpathSync.native(appRoot)).digest('hex').slice(0, 16)}`;
    const profile = resolveLaunchProfile({ appRoot, isPackaged: false, desktopProfilesRoot: tempRoot() });
    expect(profile.profileId).toBe(expected);
    expect(profile.source).toBe('development-default');
  });

  it('allows the profile root to be created on first launch', () => {
    const parent = tempRoot();
    const root = path.join(parent, 'new-profile-root');
    const profile = resolveLaunchProfile({
      appRoot: parent,
      isPackaged: true,
      packagedChannel: 'stable',
      desktopProfilesRoot: root
    });
    const physicalRoot = path.join(fs.realpathSync.native(parent), 'new-profile-root');
    expect(profile.root).toBe(physicalRoot);
    expect(profile.profileDir).toBe(path.join(physicalRoot, 'stable', 'stable'));
  });

  it('resolves root aliases but still rejects profile symlink escapes and protected aliases', () => {
    const base = tempRoot();
    const root = path.join(base, 'profiles');
    const alias = path.join(base, 'alias');
    const target = path.join(base, 'outside-profile');
    fs.mkdirSync(root);
    fs.mkdirSync(target);
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const profile = resolveLaunchProfile({appRoot: base, isPackaged: true,
      packagedChannel: 'stable', desktopProfilesRoot: alias});
    expect(profile.root).toBe(fs.realpathSync.native(root));
    fs.mkdirSync(path.join(root, 'stable'));
    fs.symlinkSync(target, path.join(root, 'stable', 'stable'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveLaunchProfile({appRoot: base, isPackaged: true,
      packagedChannel: 'stable', desktopProfilesRoot: alias})).toThrowError(
        expect.objectContaining({code: 'INVALID_PROFILE_ROOT'}));
    expect(() => resolveLaunchProfile({appRoot: base, isPackaged: true,
      desktopProfilesRoot: alias, serviceStateDir: root})).toThrowError(
        expect.objectContaining({code: 'INVALID_PROFILE_ROOT'}));
  });

  it('enforces safe lowercase ids and protected absolute roots', () => {
    for (const value of ['A', '../x', 'a/b', 'a.', 'a ', 'con', 'profile:one']) {
      expect(() => validateProfileId(value)).toThrowError(ProfileResolutionError);
    }
    const root = tempRoot();
    expect(() => resolveLaunchProfile({
      appRoot: root,
      isPackaged: true,
      desktopProfilesRoot: path.join(root, '.git'),
      repositoryGitDir: path.join(root, '.git')
    })).toThrowError(expect.objectContaining({ code: 'INVALID_PROFILE_ROOT' }));
    expect(() => resolveLaunchProfile({
      appRoot: root,
      isPackaged: true,
      desktopProfilesRoot: 'relative-profile-root'
    })).toThrowError(expect.objectContaining({ code: 'INVALID_PROFILE_ROOT' }));
    const fileRoot = path.join(root, 'not-a-directory');
    fs.writeFileSync(fileRoot, 'x');
    expect(() => resolveLaunchProfile({
      appRoot: root,
      isPackaged: true,
      desktopProfilesRoot: fileRoot
    })).toThrowError(expect.objectContaining({ code: 'INVALID_PROFILE_ROOT' }));
  });
});
