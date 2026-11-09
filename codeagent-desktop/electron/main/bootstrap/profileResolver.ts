import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type DesktopProfileSource = 'argument' | 'environment' | 'packaged-default' | 'development-default';

export interface DesktopProfileResolverInput {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  appRoot: string;
  isPackaged: boolean;
  /** The build-manifest channel. It is intentionally not inferred from appRoot. */
  packagedChannel?: string;
  /** Explicit root for tests, CI, or a task-local desktop profile installation. */
  desktopProfilesRoot?: string;
  repositoryGitDir?: string;
  serviceStateDir?: string;
  /** Accepted for callers that also resolve a connection; never enters the profile key. */
  endpoint?: string;
}

export interface DesktopLaunchProfile {
  profileId: string;
  channel: string;
  source: DesktopProfileSource;
  /** The canonical desktopProfilesRoot, before channel/profile components. */
  root: string;
  profileDir: string;
  userDataDir: string;
  sessionDataDir: string;
  logsDir: string;
  crashDumpsDir: string;
  diagnosticsDir: string;
}

export class ProfileResolutionError extends Error {
  readonly code: 'PROFILE_ARGUMENT_CONFLICT' | 'INVALID_PROFILE_ID' | 'INVALID_PROFILE_ROOT';

  constructor(code: ProfileResolutionError['code'], message: string) {
    super(message);
    this.name = 'ProfileResolutionError';
    this.code = code;
  }
}

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

function fail(code: ProfileResolutionError['code'], message: string): never {
  throw new ProfileResolutionError(code, message);
}

export function validateProfileId(profileId: string): string {
  if (!PROFILE_ID_PATTERN.test(profileId) || WINDOWS_DEVICE_NAME.test(profileId)) {
    fail('INVALID_PROFILE_ID', 'profileId must be a unique lowercase safe identifier');
  }
  return profileId;
}

function readArgument(argv: readonly string[]): string | undefined {
  let found: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--desktop-profile') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('INVALID_PROFILE_ID', 'missing --desktop-profile value');
      if (found !== undefined && found !== value) {
        fail('PROFILE_ARGUMENT_CONFLICT', 'multiple --desktop-profile values differ');
      }
      found = value;
      continue;
    }
    if (argument.startsWith('--desktop-profile=')) {
      const value = argument.slice('--desktop-profile='.length);
      if (!value) fail('INVALID_PROFILE_ID', 'missing --desktop-profile value');
      if (found !== undefined && found !== value) {
        fail('PROFILE_ARGUMENT_CONFLICT', 'multiple --desktop-profile values differ');
      }
      found = value;
    }
  }
  return found;
}

function canonicalPath(candidate: string): string {
  const absolute = path.resolve(candidate);
  let existing = absolute;
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) fail('INVALID_PROFILE_ROOT', `profile root does not resolve: ${candidate}`);
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  let resolvedExisting: string;
  try {
    resolvedExisting = fs.realpathSync.native(existing);
  } catch (error) {
    fail('INVALID_PROFILE_ROOT', `profile root cannot be canonicalized: ${candidate}`);
  }
  return missing.reduce((current, segment) => path.join(current, segment), resolvedExisting);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function validateRoot(root: string, repositoryGitDir?: string, serviceStateDir?: string): string {
  if (!path.isAbsolute(root)) fail('INVALID_PROFILE_ROOT', 'desktop profile root must be absolute');
  const canonicalRoot = canonicalPath(root);
  // The default profile root is created during bootstrap.  Requiring it to
  // exist here makes a first launch fail before main.ts gets a chance to
  // create the profile-owned directories.  Validate the nearest existing
  // ancestor instead; canonicalPath has already resolved that ancestor, so a
  // later physical-path check can close the create/check race.
  let existingAncestor = path.resolve(root);
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      fail('INVALID_PROFILE_ROOT', `profile root does not resolve: ${root}`);
    }
    existingAncestor = parent;
  }
  try {
    if (!fs.statSync(existingAncestor).isDirectory()) {
      fail('INVALID_PROFILE_ROOT', 'desktop profile root must be a directory');
    }
  } catch (error) {
    if (error instanceof ProfileResolutionError) throw error;
    fail('INVALID_PROFILE_ROOT', `desktop profile root is not accessible: ${root}`);
  }
  for (const protectedPath of [repositoryGitDir, serviceStateDir]) {
    if (protectedPath && pathsOverlap(canonicalRoot, canonicalPath(protectedPath))) {
      fail('INVALID_PROFILE_ROOT', 'desktop profile root is a protected repository or service directory');
    }
  }
  return canonicalRoot;
}

function canonicalProfilePath(root: string, channel: string, profileId: string): string {
  const lexicalPath = path.join(root, channel, profileId);
  const canonical = canonicalPath(lexicalPath);
  if (!samePath(lexicalPath, canonical)) {
    fail('INVALID_PROFILE_ROOT', 'profile path resolves through a symlink or junction');
  }
  return lexicalPath;
}

/** Re-checks physical directories after creation, closing the check/create race. */
function verifyPhysicalDirectory(directory: string): void {
    let canonical: string;
    try {
      if (!fs.statSync(directory).isDirectory()) {
        fail('INVALID_PROFILE_ROOT', `profile path is not a directory: ${directory}`);
      }
      canonical = fs.realpathSync.native(directory);
    } catch (error) {
      if (error instanceof ProfileResolutionError) throw error;
      fail('INVALID_PROFILE_ROOT', `profile path cannot be canonicalized: ${directory}`);
    }
    if (!samePath(directory, canonical)) {
      fail('INVALID_PROFILE_ROOT', 'profile path resolves through a symlink or junction');
    }
  }

/** Checks the profile directory before any profile-owned child is created. */
export function verifyLaunchProfileDirectory(profile: DesktopLaunchProfile): void {
  verifyPhysicalDirectory(profile.profileDir);
}

/** Re-checks physical directories after creation, closing the check/create race. */
export function verifyLaunchProfilePaths(profile: DesktopLaunchProfile): void {
  for (const directory of [profile.profileDir, profile.userDataDir, profile.sessionDataDir,
    profile.logsDir, profile.crashDumpsDir, profile.diagnosticsDir]) {
    verifyPhysicalDirectory(directory);
  }
}

function defaultRoot(env: NodeJS.ProcessEnv): string {
  return env.CODEAGENT_DESKTOP_PROFILE_ROOT ?? path.join(os.homedir(), '.codeagent', 'desktop-profiles');
}

function developmentProfileId(appRoot: string): string {
  const canonicalAppRoot = canonicalPath(appRoot);
  return `dev-${crypto.createHash('sha256').update(canonicalAppRoot).digest('hex').slice(0, 16)}`;
}

export function resolveLaunchProfile(input: DesktopProfileResolverInput): DesktopLaunchProfile {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const argumentProfile = readArgument(argv);
  const environmentProfile = env.CODEAGENT_DESKTOP_PROFILE;
  if (argumentProfile !== undefined && environmentProfile !== undefined && argumentProfile !== environmentProfile) {
    fail('PROFILE_ARGUMENT_CONFLICT', 'explicit profile and CODEAGENT_DESKTOP_PROFILE differ');
  }

  const profileId = argumentProfile ?? environmentProfile ?? (
    input.isPackaged ? (input.packagedChannel ?? 'default') : developmentProfileId(input.appRoot)
  );
  validateProfileId(profileId);
  const source: DesktopProfileSource = argumentProfile !== undefined
    ? 'argument'
    : environmentProfile !== undefined ? 'environment' : input.isPackaged ? 'packaged-default' : 'development-default';
  const root = validateRoot(input.desktopProfilesRoot ?? defaultRoot(env), input.repositoryGitDir, input.serviceStateDir);
  const channel = validateProfileId(input.isPackaged ? (input.packagedChannel ?? 'default') : 'dev');
  const profileDir = canonicalProfilePath(root, channel, profileId);
  return {
    profileId,
    channel,
    source,
    root,
    profileDir,
    userDataDir: path.join(profileDir, 'user-data'),
    sessionDataDir: path.join(profileDir, 'session-data'),
    logsDir: path.join(profileDir, 'logs'),
    crashDumpsDir: path.join(profileDir, 'crash-dumps'),
    diagnosticsDir: path.join(profileDir, 'diagnostics')
  };
}
