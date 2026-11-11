import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  CSP_HEADER,
  buildWebPreferences,
  privilegedSchemes
} from '../../electron/main/security/windowSecurity';
import { isAllowedExternalUrl, isHttpsExternalUrl, isLoopbackHttpUrl, navigationDecision } from '../../electron/main/security/navigation';
import { resolveAppFilePath } from '../../electron/main/security/appProtocol';
import { redactHeaders, redactSecrets } from '../../electron/main/security/redaction';
import {
  validateBootstrapPayload,
  validateOpenExternalPayload,
  IPC_CHANNELS
} from '../../electron/main/ipc/channels';
import { chooseDirectoryDefinition, windowControlDefinition } from '../../electron/main/ipc/registry';

describe('BrowserWindow security baseline (design 6.2)', () => {
  it('enforces sandbox, context isolation and no node integration', () => {
    const prefs = buildWebPreferences('C:/x/preload.js');
    expect(prefs).toEqual({
      preload: 'C:/x/preload.js',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    });
  });

  it('rejects an empty preload path', () => {
    expect(() => buildWebPreferences('')).toThrow();
  });

  it('CSP contains the required directives', () => {
    expect(CSP_HEADER).toContain("default-src 'self'");
    expect(CSP_HEADER).toContain("script-src 'self'");
    expect(CSP_HEADER).toContain("object-src 'none'");
    expect(CSP_HEADER).toContain("frame-src 'none'");
  });

  it('registers app:// as standard secure scheme', () => {
    const schemes = privilegedSchemes();
    expect(schemes).toHaveLength(1);
    expect(schemes[0]?.scheme).toBe('app');
    expect(schemes[0]?.privileges.standard).toBe(true);
    expect(schemes[0]?.privileges.secure).toBe(true);
  });
});

describe('navigation and external URL policy', () => {
  it('allows only app:// navigation', () => {
    expect(navigationDecision('app://codeagent/index.html', 'app://codeagent/other.html')).toBe('ALLOW');
    expect(navigationDecision('app://codeagent/index.html', 'https://evil.example/')).toBe('DENY');
    expect(navigationDecision('app://codeagent/index.html', 'file:///C:/Windows/system32/config')).toBe('DENY');
    expect(navigationDecision('https://evil.example/', 'app://codeagent/index.html')).toBe('DENY');
  });

  it('opens only https external urls without credentials', () => {
    expect(isHttpsExternalUrl('https://example.com/doc')).toBe(true);
    expect(isHttpsExternalUrl('http://example.com/')).toBe(false);
    expect(isHttpsExternalUrl('file:///C:/x')).toBe(false);
    expect(isHttpsExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsExternalUrl('https://user:pass@example.com/')).toBe(false);
    expect(isHttpsExternalUrl('not a url')).toBe(false);
  });

  it('allows http only on loopback hosts for dev-server links', () => {
    expect(isLoopbackHttpUrl('http://localhost:5173/')).toBe(true);
    expect(isLoopbackHttpUrl('http://127.0.0.1:8080/api')).toBe(true);
    expect(isLoopbackHttpUrl('http://[::1]:3000')).toBe(true);
    expect(isLoopbackHttpUrl('http://example.com/')).toBe(false);
    expect(isLoopbackHttpUrl('http://localhost.evil.com/')).toBe(false);
    expect(isLoopbackHttpUrl('http://user:pass@localhost:3000/')).toBe(false);
    expect(isLoopbackHttpUrl('http://localhost@evil.com/')).toBe(false);
    expect(isLoopbackHttpUrl('https://localhost/')).toBe(false);
    expect(isAllowedExternalUrl('https://example.com/')).toBe(true);
    expect(isAllowedExternalUrl('http://localhost:3000')).toBe(true);
    expect(isAllowedExternalUrl('http://192.168.1.5:3000')).toBe(false);
  });
});

describe('app:// path resolution', () => {
  const root = path.resolve('test-renderer-root');

  it('resolves normal paths under the root', () => {
    expect(resolveAppFilePath(root, '/index.html')).toBe(path.join(root, 'index.html'));
    expect(resolveAppFilePath(root, '/assets/app.js')).toBe(path.join(root, 'assets', 'app.js'));
  });

  it('rejects path traversal and unsafe segments', () => {
    expect(resolveAppFilePath(root, '/../secret.txt')).toBeNull();
    expect(resolveAppFilePath(root, '/a/../../secret.txt')).toBeNull();
    expect(resolveAppFilePath(root, '/..%2Fsecret.txt')).toBeNull();
    expect(resolveAppFilePath(root, '/a%00.txt')).toBeNull();
  });
});

describe('log redaction (design 6.5)', () => {
  it('redacts authorization-like headers', () => {
    const out = redactHeaders({
      authorization: 'Bearer abc123',
      'content-type': 'application/json',
      'x-api-key': 'zzz'
    });
    expect(out['authorization']).toBe('[REDACTED]');
    expect(out['x-api-key']).toBe('[REDACTED]');
    expect(out['content-type']).toBe('application/json');
  });

  it('scrubs secret values from free text', () => {
    expect(redactSecrets('token=supersecretvalue123 failed', ['supersecretvalue123'])).toBe(
      'token=*** failed'
    );
    // short secrets are ignored to avoid mangling text
    expect(redactSecrets('abc', ['abc'])).toBe('abc');
  });
});

describe('IPC payload validation (design 6.3)', () => {
  it('bootstrap accepts empty object payloads only', () => {
    expect(validateBootstrapPayload(undefined)).toBe(true);
    expect(validateBootstrapPayload({})).toBe(true);
    expect(validateBootstrapPayload([1])).toBe(false);
    expect(validateBootstrapPayload('x')).toBe(false);
  });

  it('openExternal accepts https or loopback http payloads only', () => {
    expect(validateOpenExternalPayload({ url: 'https://example.com' })).toBe(true);
    expect(validateOpenExternalPayload({ url: 'http://localhost:5173' })).toBe(true);
    expect(validateOpenExternalPayload({ url: 'http://example.com' })).toBe(false);
    expect(validateOpenExternalPayload({ url: 'file:///C:/x' })).toBe(false);
    expect(validateOpenExternalPayload({ x: 1 })).toBe(false);
  });

  it('uses fixed channel names, no generic proxy', () => {
    expect(Object.values(IPC_CHANNELS).sort()).toEqual([
      'app/about/get',
      'app/agent-profiles/list',
      'app/approvals/budget',
      'app/approvals/command',
      'app/approvals/ping',
      'app/approvals/sandbox',
      'app/approvals/sandbox/pending',
      'app/approvals/terminal',
      'app/approvals/terminal/pending',
      'app/approvals/v2/advance',
      'app/approvals/v2/control',
      'app/approvals/v2/decide',
      'app/approvals/v2/get',
      'app/approvals/v2/list',
      'app/approvals/write',
      'app/approvals/write/pending',
      'app/attention/list',
      'app/automation-controls/get',
      'app/automation-controls/update',
      'app/bootstrap',
      'app/collaboration',
      'app/deliveries/apply',
      'app/deliveries/changes',
      'app/deliveries/create',
      'app/deliveries/decide',
      'app/deliveries/get',
      'app/deliveries/list',
      'app/deliveries/prepare',
      'app/deliveries/rebase',
      'app/deliveries/reconcile',
      'app/diagnostics',
      'app/diagnostics/copy',
      'app/diagnostics/reveal',
      'app/dialog/chooseDirectory',
      'app/environment/feature-preflight',
      'app/environment/feature-update',
      'app/environment/features',
      'app/events/durable',
      'app/events/native',
      'app/events/status',
      'app/execution-policy/defaults/get',
      'app/execution-policy/defaults/update',
      'app/execution-policy/get',
      'app/execution-policy/my-defaults/get',
      'app/execution-policy/my-defaults/update',
      'app/execution-policy/update',
      'app/executions/extension-invocation-action',
      'app/executions/extension-invocations',
      'app/executions/extension-test',
      'app/executions/extensions',
      'app/export/save',
      'app/findings/fix-task',
      'app/hooks/executions',
      'app/hooks/list',
      'app/hub/capabilities',
      'app/hub/connection-action',
      'app/hub/connection-create',
      'app/hub/connection-get',
      'app/hub/connection-update',
      'app/hub/connections',
      'app/hub/register-server',
      'app/hub/resources',
      'app/hub/session-acquire',
      'app/hub/session-control',
      'app/hub/sessions',
      'app/knowledge/confirm',
      'app/knowledge/list',
      'app/knowledge/suggest',
      'app/mcp/auth-action',
      'app/mcp/catalog-refresh',
      'app/mcp/connection-action',
      'app/mcp/operation',
      'app/mcp/prompt-resolve',
      'app/mcp/prompts',
      'app/mcp/resource-templates',
      'app/mcp/resource/read',
      'app/mcp/resources',
      'app/mcp/server-create',
      'app/mcp/server-get',
      'app/mcp/server-status',
      'app/mcp/server-update',
      'app/mcp/servers',
      'app/mcp/servers-governed',
      'app/mcp/tools',
      'app/missions/cancel',
      'app/missions/create',
      'app/missions/decide',
      'app/missions/get',
      'app/missions/list',
      'app/missions/pause',
      'app/missions/resume',
      'app/missions/start',
      'app/model-providers/delete',
      'app/model-providers/list',
      'app/model-providers/model-delete',
      'app/model-providers/model-upsert',
      'app/model-providers/remote-models',
      'app/model-providers/upsert',
      'app/models/catalog',
      'app/openExternalHttps',
      'app/personal',
      'app/personal-access',
      'app/policies/layers',
      'app/policies/update',
      'app/preferences/get',
      'app/preferences/update',
      'app/projects/build-plan',
      'app/projects/build-plan-override',
      'app/projects/build-plan-preview',
      'app/projects/chooseAndRegister',
      'app/projects/list',
      'app/projects/read-file',
      'app/projects/reveal-file',
      'app/projects/session-preflight',
      'app/projects/verification-profile-put',
      'app/projects/verification-profiles',
      'app/runs/activities',
      'app/runs/cancel',
      'app/runs/continue',
      'app/runs/control',
      'app/runs/diff',
      'app/runs/evidence',
      'app/runs/interrupt',
      'app/runs/list',
      'app/runs/output',
      'app/runs/reasoning',
      'app/runs/review',
      'app/service/restart',
      'app/service/status',
      'app/sessions/archive',
      'app/sessions/attachment-bytes',
      'app/sessions/attachment-content',
      'app/sessions/create',
      'app/sessions/executions/artifact',
      'app/sessions/executions/get',
      'app/sessions/executions/list',
      'app/sessions/fork',
      'app/sessions/get',
      'app/sessions/list',
      'app/sessions/message',
      'app/sessions/message-content',
      'app/sessions/messages-page',
      'app/sessions/metadata',
      'app/sessions/patch',
      'app/sessions/summaries',
      'app/sessions/summary',
      'app/settings/get',
      'app/settings/update',
      'app/skills/governed',
      'app/skills/import',
      'app/skills/import-pick',
      'app/skills/import-preview',
      'app/skills/list',
      'app/skills/manifest',
      'app/skills/register',
      'app/skills/status',
      'app/skills/version-select',
      'app/skills/versions',
      'app/sources/fetch',
      'app/specs/convert',
      'app/specs/create',
      'app/specs/decide',
      'app/specs/get',
      'app/specs/revise',
      'app/terminal-sessions/close',
      'app/terminal-sessions/control/acquire',
      'app/terminal-sessions/control/release',
      'app/terminal-sessions/control/renew',
      'app/terminal-sessions/create',
      'app/terminal-sessions/get',
      'app/terminal-sessions/input',
      'app/terminal-sessions/list',
      'app/terminal-sessions/output',
      'app/terminal-sessions/resize',
      'app/terminal-sessions/signal',
      'app/web-search-providers/delete',
      'app/web-search-providers/list',
      'app/web-search-providers/upsert',
      'app/window/control',
      'app/window/state',
      'app/workspace-conflicts/auto-merge',
      'app/workspace-conflicts/dismiss',
      'app/workspace-conflicts/get',
      'app/workspace-conflicts/list',
      'app/workspace-conflicts/list-filtered',
      'app/workspace-conflicts/proposals/poll',
      'app/workspace-conflicts/proposals/submit',
      'app/workspace-conflicts/resolve',
      'app/workspace-conflicts/resolve-batch',
      'app/workspace-contents/get',
      'app/workspace-contents/put',
      'app/workspace-executions/create',
      'app/workspace-executions/handoff',
      'app/workspace-executions/list',
      'app/workspace-executions/reclaim',
      'app/workspace-lanes/bind',
      'app/workspace-lanes/create',
      'app/workspace-lanes/get',
      'app/workspace-lanes/release',
      'app/workspace-lanes/reopen',
      'app/writable-collaboration'
    ]);
  });

  it('validates native window actions and directory picker payloads', () => {
    expect(windowControlDefinition.validate({ action: 'MINIMIZE' }).ok).toBe(true);
    expect(windowControlDefinition.validate({ action: 'CLOSE' }).ok).toBe(true);
    expect(windowControlDefinition.validate({ action: 'EXECUTE' }).ok).toBe(false);
    expect(chooseDirectoryDefinition.validate(undefined).ok).toBe(true);
    expect(chooseDirectoryDefinition.validate({ path: 'C:/secret' }).ok).toBe(false);
  });
});
