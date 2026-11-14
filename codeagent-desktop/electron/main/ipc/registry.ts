/**
 * IPC handler registry (desktop design §6.2/§6.3, ADR-E002).
 *
 * Hardening rules enforced here before any handler runs:
 * - the channel must be registered (no generic channel proxy);
 * - the sender frame must be the bundled app:// origin (renderer sandbox);
 * - the payload must pass the channel's schema validation;
 * - string payloads are size-bounded before validation.
 */

import type { DesktopBootstrap } from '../../shared/api-types';
import type { DesktopPreferencesUpdateRequest } from '../../shared/settings-types';
import { admitPreferencesUpdate } from '../bootstrap/preferencesStore';
import { IPC_CHANNELS } from './channels';
import { isAllowedExternalUrl } from '../security/navigation';
import type { SchedulerOverviewResponse } from '../../../packages/protocol/src/index.js';

export const APP_ORIGIN_PREFIX = 'app://';
export const MAX_IPC_PAYLOAD_CHARS = 1024 * 1024;

export function isTrustedSender(senderUrl: string | undefined): boolean {
  if (!senderUrl) return false;
  try {
    const parsed = new URL(senderUrl);
    return parsed.protocol === 'app:' && parsed.host === 'codeagent';
  } catch {
    return false;
  }
}

export type IpcValidationResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface IpcDefinition<T> {
  channel: string;
  validate(payload: unknown): IpcValidationResult<T>;
}

export const bootstrapDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.bootstrap,
  validate: (payload) => {
    if (payload === undefined || payload === null) return { ok: true, value: undefined };
    return { ok: false, reason: 'bootstrap takes no payload' };
  }
};

export type WindowControlAction = 'MINIMIZE' | 'TOGGLE_MAXIMIZE' | 'CLOSE';

export const windowControlDefinition: IpcDefinition<{ action: WindowControlAction }> = {
  channel: IPC_CHANNELS.windowControl,
  validate: (payload) => {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { ok: false, reason: 'window control payload must be an object' };
    }
    const action = (payload as Record<string, unknown>).action;
    if (action !== 'MINIMIZE' && action !== 'TOGGLE_MAXIMIZE' && action !== 'CLOSE') {
      return { ok: false, reason: 'window action is invalid' };
    }
    return { ok: true, value: { action } };
  }
};

export interface DirectoryChoiceResult {
  selected: boolean;
  path?: string;
  reason?: 'cancelled' | 'unavailable' | string;
}

export const chooseDirectoryDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.chooseDirectory,
  validate: (payload) => (payload === undefined || payload === null
    ? { ok: true, value: undefined }
    : { ok: false, reason: 'chooseDirectory takes no payload' })
};

export const serviceRestartDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.serviceRestart,
  validate: (payload) => {
    if (payload === undefined || payload === null) return { ok: true, value: undefined };
    return { ok: false, reason: 'restart takes no payload' };
  }
};

export interface ServiceStatusResult {
  state: string;
  serviceInstanceId?: string;
  ownedPid?: number;
  ownedPort?: number;
  encryptionAvailable: boolean;
  tokenPersisted: boolean;
  scheduler?: SchedulerOverviewResponse;
}

export const serviceStatusDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.serviceStatus,
  validate: (payload) => {
    if (payload === undefined || payload === null) return { ok: true, value: undefined };
    return { ok: false, reason: 'status takes no payload' };
  }
};

export interface ChooseAndRegisterResult {
  registered: boolean;
  projectId?: string;
  displayName?: string;
  /** public-safe reason when the user cancelled or the service refused */
  reason?: string;
}

export const chooseAndRegisterDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.chooseAndRegister,
  validate: (payload) => {
    if (payload === undefined || payload === null) return { ok: true, value: undefined };
    return { ok: false, reason: 'chooseAndRegister takes no payload' };
  }
};

export interface DiagnosticsResult {
  serviceState: string;
  ownedProcess: { pid: number; port: number; nonce: string } | null;
  logLocation: string;
  encryptionAvailable: boolean;
}

export const diagnosticsDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.diagnostics,
  validate: (payload) => {
    if (payload === undefined || payload === null) return { ok: true, value: undefined };
    return { ok: false, reason: 'diagnostics takes no payload' };
  }
};

export const saveConversationExportDefinition: IpcDefinition<{
  suggestedName: string;
  format: 'markdown' | 'txt' | 'json' | 'csv' | 'html' | 'pdf';
  content: string;
}> = {
  channel: IPC_CHANNELS.saveConversationExport,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const suggestedName = object.value.suggestedName;
    const format = object.value.format;
    const content = object.value.content;
    if (typeof suggestedName !== 'string' || suggestedName.length === 0 || suggestedName.length > 180) {
      return { ok: false, reason: 'suggestedName is invalid' };
    }
    if (format !== 'markdown' && format !== 'txt' && format !== 'json' && format !== 'csv' && format !== 'html' && format !== 'pdf') {
      return { ok: false, reason: 'format is invalid' };
    }
    if (typeof content !== 'string' || content.length > 120 * 1024 * 1024) {
      return { ok: false, reason: 'content exceeds size limit' };
    }
    return { ok: true, value: { suggestedName, format, content } };
  }
};

export interface OpenExternalResult {
  opened: true;
}

export const openExternalDefinition: IpcDefinition<{ url: string }> = {
  channel: IPC_CHANNELS.openExternalHttps,
  validate: (payload) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, reason: 'payload must be an object' };
    }
    const url = (payload as Record<string, unknown>).url;
    if (typeof url !== 'string' || url.length > 2048) {
      return { ok: false, reason: 'url is required and bounded' };
    }
    if (!isAllowedExternalUrl(url)) {
      return { ok: false, reason: 'only https or loopback http URLs without credentials may be opened' };
    }
    return { ok: true, value: { url } };
  }
};

// ---- data proxy definitions (renderer never fetches directly, ADR-E002) ----

function requireId(schema: string, payload: unknown, field: string): IpcValidationResult<string> {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'payload must be an object' };
  }
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > 128
      || !value.match(/^[A-Za-z0-9._-]+$/)) {
    return { ok: false, reason: `${field} is invalid` };
  }
  return { ok: true, value };
}

function requireObjectPayload(payload: unknown): IpcValidationResult<Record<string, unknown>> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'payload must be an object' };
  }
  return { ok: true, value: payload as Record<string, unknown> };
}

export const projectsListDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.projectsList,
  validate: (payload) => (payload === undefined || payload === null
    ? { ok: true, value: undefined }
    : { ok: false, reason: 'list takes no payload' })
};

export const projectSessionPreflightDefinition: IpcDefinition<{ projectId: string }> = {
  channel: IPC_CHANNELS.projectSessionPreflight,
  validate: (payload) => {
    const projectId = requireId('projectSessionPreflight', payload, 'projectId');
    if (!projectId.ok) return projectId;
    return { ok: true, value: { projectId: projectId.value } };
  }
};

// ---- build-plan surface (design 2026-09-26 §7.2) ----

const BUILD_PLAN_ACTIONS = new Set(['COMPILE', 'TEST', 'PACKAGE', 'VERIFY']);
const MAX_ARGV_ENTRIES = 32;
const MAX_ARGV_LENGTH = 512;
const MAX_ENV_ENTRIES = 32;
const MAX_ENV_VALUE_LENGTH = 1024;

interface BuildPlanOverridePayload {
  projectId: string;
  targetId: string;
  action?: string;
  runner?: string;
  argv?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

/**
 * Shape validation only — the service re-validates every element against
 * the executable allowlist and workspace containment rules before the
 * override may persist or preview.
 */
function validateBuildPlanOverride(
    schema: string, payload: unknown): IpcValidationResult<BuildPlanOverridePayload> {
  const projectId = requireId(schema, payload, 'projectId');
  if (!projectId.ok) return projectId;
  const targetId = requireId(schema, payload, 'targetId');
  if (!targetId.ok) return targetId;
  const object = payload as Record<string, unknown>;
  const out: BuildPlanOverridePayload = {
    projectId: projectId.value, targetId: targetId.value
  };
  const action = object.action;
  if (action !== undefined && action !== null) {
    if (typeof action !== 'string'
        || !BUILD_PLAN_ACTIONS.has(action.trim().toUpperCase())) {
      return { ok: false, reason: `${schema}: action is invalid` };
    }
    out.action = action.trim().toUpperCase();
  }
  const runner = object.runner;
  if (runner !== undefined && runner !== null) {
    if (typeof runner !== 'string' || runner.length === 0 || runner.length > 64
        || !/^[A-Za-z0-9._-]+$/.test(runner)) {
      return { ok: false, reason: `${schema}: runner is invalid` };
    }
    out.runner = runner;
  }
  const argv = object.argv;
  if (argv !== undefined && argv !== null) {
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV_ENTRIES
        || argv.some((entry) => typeof entry !== 'string'
            || (entry as string).length === 0
            || (entry as string).length > MAX_ARGV_LENGTH)) {
      return { ok: false, reason: `${schema}: argv must be 1..${MAX_ARGV_ENTRIES} bounded strings` };
    }
    out.argv = argv as string[];
  }
  const env = object.env;
  if (env !== undefined && env !== null) {
    if (typeof env !== 'object' || Array.isArray(env)
        || Object.keys(env as Record<string, unknown>).length > MAX_ENV_ENTRIES) {
      return { ok: false, reason: `${schema}: env must be an object of at most ${MAX_ENV_ENTRIES} entries` };
    }
    const normalized: Record<string, string> = {};
    for (const key of Object.keys(env as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return { ok: false, reason: `${schema}: env key is invalid: ${key}` };
      }
      const value = (env as Record<string, unknown>)[key];
      if (typeof value !== 'string' || value.length > MAX_ENV_VALUE_LENGTH) {
        return { ok: false, reason: `${schema}: env value for ${key} is invalid` };
      }
      normalized[key] = value;
    }
    out.env = normalized;
  }
  const disabled = object.disabled;
  if (disabled !== undefined && disabled !== null) {
    if (typeof disabled !== 'boolean') {
      return { ok: false, reason: `${schema}: disabled must be a boolean` };
    }
    out.disabled = disabled;
  }
  return { ok: true, value: out };
}

export const projectBuildPlanDefinition: IpcDefinition<{ projectId: string }> = {
  channel: IPC_CHANNELS.projectBuildPlan,
  validate: (payload) => {
    const projectId = requireId('projectBuildPlan', payload, 'projectId');
    if (!projectId.ok) return projectId;
    return { ok: true, value: { projectId: projectId.value } };
  }
};

export const projectBuildPlanOverrideDefinition: IpcDefinition<BuildPlanOverridePayload> = {
  channel: IPC_CHANNELS.projectBuildPlanOverride,
  validate: (payload) => validateBuildPlanOverride('projectBuildPlanOverride', payload)
};

export const projectBuildPlanPreviewDefinition: IpcDefinition<BuildPlanOverridePayload> = {
  channel: IPC_CHANNELS.projectBuildPlanPreview,
  validate: (payload) => validateBuildPlanOverride('projectBuildPlanPreview', payload)
};

// ---- verification-profile surface (design 2026-09-26 §7.4/§10.2) ----

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PROFILE_CONFIG_KEYS = 64;

interface VerificationProfilePutPayload {
  projectId: string;
  profileId: string;
  config: Record<string, unknown>;
  enabled?: boolean;
  expectedRevision?: number;
}

export const projectVerificationProfilesDefinition: IpcDefinition<{ projectId: string }> = {
  channel: IPC_CHANNELS.projectVerificationProfiles,
  validate: (payload) => {
    const projectId = requireId('projectVerificationProfiles', payload, 'projectId');
    if (!projectId.ok) return projectId;
    return { ok: true, value: { projectId: projectId.value } };
  }
};

export const projectVerificationProfilePutDefinition: IpcDefinition<VerificationProfilePutPayload> = {
  channel: IPC_CHANNELS.projectVerificationProfilePut,
  validate: (payload) => {
    const schema = 'projectVerificationProfilePut';
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, reason: `${schema}: payload must be an object` };
    }
    const projectId = requireId(schema, payload, 'projectId');
    if (!projectId.ok) return projectId;
    const profileId = requireId(schema, payload, 'profileId');
    if (!profileId.ok) return profileId;
    if (!PROFILE_ID_PATTERN.test(profileId.value)) {
      return { ok: false, reason: `${schema}: profileId is invalid` };
    }
    const object = payload as Record<string, unknown>;
    const config = object.config;
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      return { ok: false, reason: `${schema}: config must be an object` };
    }
    if (Object.keys(config as Record<string, unknown>).length > MAX_PROFILE_CONFIG_KEYS) {
      return { ok: false, reason: `${schema}: config exceeds ${MAX_PROFILE_CONFIG_KEYS} keys` };
    }
    const out: VerificationProfilePutPayload = {
      projectId: projectId.value,
      profileId: profileId.value,
      config: config as Record<string, unknown>
    };
    const enabled = object.enabled;
    if (enabled !== undefined && enabled !== null) {
      if (typeof enabled !== 'boolean') {
        return { ok: false, reason: `${schema}: enabled must be a boolean` };
      }
      out.enabled = enabled;
    }
    const expectedRevision = object.expectedRevision;
    if (expectedRevision !== undefined && expectedRevision !== null) {
      if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)
          || expectedRevision < 0) {
        return { ok: false, reason: `${schema}: expectedRevision must be a non-negative integer` };
      }
      out.expectedRevision = expectedRevision;
    }
    return { ok: true, value: out };
  }
};

export const sessionsListDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.sessionsList,
  validate: (payload) => (payload === undefined || payload === null
    ? { ok: true, value: undefined }
    : { ok: false, reason: 'list takes no payload' })
};

function optionalString(payload: Record<string, unknown>, field: string,
    max: number): IpcValidationResult<string | undefined> {
  const value = payload[field];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    return { ok: false, reason: `${field} is invalid` };
  }
  return { ok: true, value };
}

function optionalInt(payload: Record<string, unknown>, field: string): IpcValidationResult<number | undefined> {
  const value = payload[field];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, reason: `${field} must be an integer` };
  }
  return { ok: true, value: value };
}

function requireTwoIds(payload: unknown, first: string, second: string): IpcValidationResult<{ sessionId: string; messageId: string }> {
  const firstId = requireId(first + ',' + second, payload, first);
  if (!firstId.ok) return firstId;
  const secondId = requireId(first + ',' + second, payload, second);
  if (!secondId.ok) return secondId;
  return { ok: true, value: { sessionId: firstId.value, messageId: secondId.value } };
}

// 2026-09-05 history pagination channels (design 5.1): the renderer may
// only pass bounded query params; cursors are opaque service tokens.
export const sessionSummariesListDefinition: IpcDefinition<{
  workspaceAlias?: string; archived?: string; q?: string; limit?: number; cursor?: string;
}> = {
  channel: IPC_CHANNELS.sessionSummariesList,
  validate: (payload) => {
    if (payload === undefined || payload === null) return { ok: true, value: {} };
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const out: { workspaceAlias?: string; archived?: string; q?: string; limit?: number; cursor?: string } = {};
    const workspaceAlias = optionalString(object.value, 'workspaceAlias', 128);
    if (!workspaceAlias.ok) return workspaceAlias;
    if (workspaceAlias.value !== undefined) out.workspaceAlias = workspaceAlias.value;
    const archived = optionalString(object.value, 'archived', 16);
    if (!archived.ok) return archived;
    if (archived.value !== undefined) {
      if (['ACTIVE', 'ARCHIVED', 'ALL'].indexOf(archived.value) < 0) {
        return { ok: false, reason: 'archived is invalid' };
      }
      out.archived = archived.value;
    }
    const q = optionalString(object.value, 'q', 128);
    if (!q.ok) return q;
    if (q.value !== undefined) out.q = q.value;
    const limit = optionalInt(object.value, 'limit');
    if (!limit.ok) return limit;
    if (limit.value !== undefined) out.limit = limit.value;
    const cursor = optionalString(object.value, 'cursor', 1024);
    if (!cursor.ok) return cursor;
    if (cursor.value !== undefined) out.cursor = cursor.value;
    return { ok: true, value: out };
  }
};

export const sessionSummaryGetDefinition: IpcDefinition<{ sessionId: string; refreshEnvironment?: boolean }> = {
  channel: IPC_CHANNELS.sessionSummaryGet,
  validate: (payload) => {
    const id = requireId('sessionSummaryGet', payload, 'sessionId');
    if (!id.ok) return id;
    const out: { sessionId: string; refreshEnvironment?: boolean } = { sessionId: id.value };
    const refresh = (payload as Record<string, unknown>).refreshEnvironment;
    if (refresh !== undefined && refresh !== null) {
      if (typeof refresh !== 'boolean') {
        return { ok: false, reason: 'refreshEnvironment must be a boolean' };
      }
      out.refreshEnvironment = refresh;
    }
    return { ok: true, value: out };
  }
};

export const sessionMetadataGetDefinition: IpcDefinition<{ sessionId: string }> = {
  channel: IPC_CHANNELS.sessionMetadataGet,
  validate: sessionSummaryGetDefinition.validate
};

export const sessionMessagesPageDefinition: IpcDefinition<{
  sessionId: string; limit?: number; cursor?: string; aroundMessageId?: string;
}> = {
  channel: IPC_CHANNELS.sessionMessagesPage,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const id = requireId('sessionMessagesPage', payload, 'sessionId');
    if (!id.ok) return id;
    const out: { sessionId: string; limit?: number; cursor?: string; aroundMessageId?: string } = {
      sessionId: id.value
    };
    const limit = optionalInt(object.value, 'limit');
    if (!limit.ok) return limit;
    if (limit.value !== undefined) out.limit = limit.value;
    const cursor = optionalString(object.value, 'cursor', 1024);
    if (!cursor.ok) return cursor;
    const around = optionalString(object.value, 'aroundMessageId', 128);
    if (!around.ok) return around;
    if (cursor.value !== undefined && around.value !== undefined) {
      return { ok: false, reason: 'cursor and aroundMessageId are mutually exclusive' };
    }
    if (cursor.value !== undefined) out.cursor = cursor.value;
    if (around.value !== undefined) out.aroundMessageId = around.value;
    return { ok: true, value: out };
  }
};

export const sessionMessageContentDefinition: IpcDefinition<{
  sessionId: string; messageId: string; cursor?: string; maxBytes?: number;
}> = {
  channel: IPC_CHANNELS.sessionMessageContent,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const ids = requireTwoIds(payload, 'sessionId', 'messageId');
    if (!ids.ok) return ids;
    const out: { sessionId: string; messageId: string; cursor?: string; maxBytes?: number } = {
      sessionId: ids.value.sessionId, messageId: ids.value.messageId
    };
    const cursor = optionalString(object.value, 'cursor', 1024);
    if (!cursor.ok) return cursor;
    if (cursor.value !== undefined) out.cursor = cursor.value;
    const maxBytes = optionalInt(object.value, 'maxBytes');
    if (!maxBytes.ok) return maxBytes;
    if (maxBytes.value !== undefined) out.maxBytes = maxBytes.value;
    return { ok: true, value: out };
  }
};

export const sessionsGetDefinition: IpcDefinition<{ sessionId: string }> = {
  channel: IPC_CHANNELS.sessionsGet,
  validate: (payload) => {
    const id = requireId('sessionsGet', payload, 'sessionId');
    if (!id.ok) return id;
    return { ok: true, value: { sessionId: id.value } };
  }
};

export const sessionsCreateDefinition: IpcDefinition<{ body: Record<string, unknown>; idempotencyKey?: string }> = {
  channel: IPC_CHANNELS.sessionsCreate,
  validate: (payload) => {
    // 兼容两种包络：裸 body（旧渲染器/测试），或 { body, idempotencyKey }（长输入冻结意图）。
    const record = (payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      && typeof (payload as Record<string, unknown>).body === 'object'
      && (payload as Record<string, unknown>).body !== null)
      ? (payload as Record<string, unknown>).body as Record<string, unknown>
      : payload;
    const result = requireObjectPayload(record);
    if (!result.ok) return result;
    // An omitted workspace is the supported ordinary-chat contract. Editing
    // sessions remain gated by the service once their intent is evaluated.
    if (result.value.workspaceAlias !== undefined && result.value.workspaceAlias !== null
        && (typeof result.value.workspaceAlias !== 'string' || result.value.workspaceAlias.length > 128)) {
      return { ok: false, reason: 'workspaceAlias is invalid' };
    }
    const envelope = payload as Record<string, unknown>;
    const key = envelope.body !== undefined ? envelope.idempotencyKey : undefined;
    if (key !== undefined && (typeof key !== 'string' || key.length === 0 || key.length > 128)) {
      return { ok: false, reason: 'idempotencyKey is invalid' };
    }
    return {
      ok: true,
      value: {
        body: result.value,
        ...(typeof key === 'string' ? { idempotencyKey: key } : {})
      }
    };
  }
};

export const sessionsPatchDefinition: IpcDefinition<{ sessionId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.sessionsPatch,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const id = requireId('sessionsPatch', payload, 'sessionId');
    if (!id.ok) return id;
    const body = (payload as Record<string, unknown>).body;
    if (typeof body !== 'object' || body === null) {
      return { ok: false, reason: 'body is required' };
    }
    return { ok: true, value: { sessionId: id.value, body: body as Record<string, unknown> } };
  }
};

export const sessionMessageReceiptDefinition: IpcDefinition<{ sessionId: string; idempotencyKey: string }> = {
  channel: IPC_CHANNELS.sessionMessageReceipt,
  validate: (payload) => {
    const session = requireId('sessionMessageReceipt', payload, 'sessionId');
    if (!session.ok) return session;
    const key = requireId('sessionMessageReceipt', payload, 'idempotencyKey');
    if (!key.ok) return key;
    return { ok: true, value: { sessionId: session.value, idempotencyKey: key.value } };
  }
};

export const sessionsMessageDefinition: IpcDefinition<{ sessionId: string; body: Record<string, unknown>; idempotencyKey?: string }> = {
  channel: IPC_CHANNELS.sessionsMessage,
  validate: (payload) => {
    const base = sessionsPatchDefinition.validate(payload);
    if (!base.ok) return base;
    const envelope = payload as Record<string, unknown>;
    const key = envelope.idempotencyKey;
    if (key !== undefined && (typeof key !== 'string' || key.length === 0 || key.length > 128)) {
      return { ok: false, reason: 'idempotencyKey is invalid' };
    }
    return {
      ok: true,
      value: {
        sessionId: base.value.sessionId,
        body: base.value.body,
        ...(typeof key === 'string' ? { idempotencyKey: key } : {})
      }
    };
  }
};

/** 长输入设计 §6.3：附件内容读取的窄 IPC（sessionId/messageId/attachmentId 三者归属由服务校验）。 */
export const sessionsAttachmentContentDefinition: IpcDefinition<{
  sessionId: string;
  messageId: string;
  attachmentId: string;
}> = {
  channel: IPC_CHANNELS.sessionsAttachmentContent,
  validate: (payload) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, reason: 'payload must be an object' };
    }
    const record = payload as Record<string, unknown>;
    const sessionId = record.sessionId;
    const messageId = record.messageId;
    const attachmentId = record.attachmentId;
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128
        || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      return { ok: false, reason: 'sessionId is invalid' };
    }
    if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 128
        || !/^[A-Za-z0-9._-]+$/.test(messageId)) {
      return { ok: false, reason: 'messageId is invalid' };
    }
    if (typeof attachmentId !== 'string' || attachmentId.length === 0 || attachmentId.length > 128
        || !/^[A-Za-z0-9._:-]+$/.test(attachmentId)) {
      return { ok: false, reason: 'attachmentId is invalid' };
    }
    return { ok: true, value: { sessionId, messageId, attachmentId } };
  }
};

/** WU-12: image bytes are a separate, read-only, ownership-checked IPC. */
export const sessionsAttachmentBytesDefinition: IpcDefinition<{
  sessionId: string;
  messageId: string;
  attachmentId: string;
}> = {
  channel: IPC_CHANNELS.sessionsAttachmentBytes,
  validate: sessionsAttachmentContentDefinition.validate
};

export const sessionsForkDefinition: IpcDefinition<{ sessionId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.sessionsFork,
  validate: sessionsPatchDefinition.validate
};

export const sessionsArchiveDefinition: IpcDefinition<{ sessionId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.sessionsArchive,
  validate: sessionsPatchDefinition.validate
};

export const runsListDefinition: IpcDefinition<{ workspaceAlias?: string; sessionId?: string }> = {
  channel: IPC_CHANNELS.runsList,
  validate: (payload) => {
    if (payload === undefined || payload === null) return { ok: true, value: {} };
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const out: { workspaceAlias?: string; sessionId?: string } = {};
    for (const field of ['workspaceAlias', 'sessionId'] as const) {
      const value = object.value[field];
      if (value !== undefined) {
        if (typeof value !== 'string' || value.length > 128) return { ok: false, reason: `${field} must be a bounded string` };
        out[field] = value;
      }
    }
    return { ok: true, value: out };
  }
};

export const attentionListDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.attentionList,
  validate: (payload) => (payload === undefined || payload === null
    ? { ok: true, value: undefined }
    : { ok: false, reason: 'list takes no payload' })
};

// ---- stateful terminal session definitions ----

export const terminalSessionsListDefinition: IpcDefinition<{ businessSessionId: string }> = {
  channel: IPC_CHANNELS.terminalSessionsList,
  validate: (payload) => {
    const id = requireId('terminalSessionsList', payload, 'businessSessionId');
    if (!id.ok) return id;
    return { ok: true, value: { businessSessionId: id.value } };
  }
};

function terminalIdAndBody(payload: unknown): IpcValidationResult<{
  terminalSessionId: string;
  body: Record<string, unknown>;
}> {
  const object = requireObjectPayload(payload);
  if (!object.ok) return object;
  const id = requireId('terminal', payload, 'terminalSessionId');
  if (!id.ok) return id;
  const body = object.value.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'body must be an object' };
  }
  return { ok: true, value: { terminalSessionId: id.value, body: body as Record<string, unknown> } };
}

export const terminalSessionCreateDefinition: IpcDefinition<{
  businessSessionId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.terminalSessionCreate,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const businessSessionId = requireId('terminalSessionCreate', payload, 'businessSessionId');
    if (!businessSessionId.ok) return businessSessionId;
    const body = object.value.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, reason: 'body must be an object' };
    }
    const bodyObject = body as Record<string, unknown>;
    if (typeof bodyObject.workspaceExecutionId !== 'string' || bodyObject.workspaceExecutionId.length === 0
        || bodyObject.workspaceExecutionId.length > 128) {
      return { ok: false, reason: 'workspaceExecutionId is required and bounded' };
    }
    if (typeof bodyObject.executable !== 'string' || bodyObject.executable.length === 0
        || bodyObject.executable.length > 256) {
      return { ok: false, reason: 'executable is required and bounded' };
    }
    return { ok: true, value: { businessSessionId: businessSessionId.value, body: bodyObject } };
  }
};

export const terminalSessionGetDefinition: IpcDefinition<{ terminalSessionId: string }> = {
  channel: IPC_CHANNELS.terminalSessionGet,
  validate: (payload) => {
    const id = requireId('terminalSessionGet', payload, 'terminalSessionId');
    if (!id.ok) return id;
    return { ok: true, value: { terminalSessionId: id.value } };
  }
};

export const terminalOutputGetDefinition: IpcDefinition<{
  terminalSessionId: string;
  cursor?: string;
  maxBytes?: number;
  waitMillis?: number;
  mode?: 'RAW_VT' | 'PLAIN_TEXT';
}> = {
  channel: IPC_CHANNELS.terminalOutputGet,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const id = requireId('terminalOutputGet', payload, 'terminalSessionId');
    if (!id.ok) return id;
    const cursor = object.value.cursor;
    if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || cursor.length > 512)) {
      return { ok: false, reason: 'cursor must be a bounded string' };
    }
    const maxBytes = object.value.maxBytes;
    if (maxBytes !== undefined && maxBytes !== null
        && (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144)) {
      return { ok: false, reason: 'maxBytes is outside the allowed range' };
    }
    const waitMillis = object.value.waitMillis;
    if (waitMillis !== undefined && waitMillis !== null
        && (typeof waitMillis !== 'number' || !Number.isInteger(waitMillis) || waitMillis < 0 || waitMillis > 30000)) {
      return { ok: false, reason: 'waitMillis is outside the allowed range' };
    }
    const mode = object.value.mode;
    if (mode !== undefined && mode !== null && mode !== 'RAW_VT' && mode !== 'PLAIN_TEXT') {
      return { ok: false, reason: 'mode is invalid' };
    }
    return {
      ok: true,
      value: {
        terminalSessionId: id.value,
        ...(typeof cursor === 'string' ? { cursor } : {}),
        ...(typeof maxBytes === 'number' ? { maxBytes } : {}),
        ...(typeof waitMillis === 'number' ? { waitMillis } : {}),
        ...(mode === 'RAW_VT' || mode === 'PLAIN_TEXT' ? { mode } : {})
      }
    };
  }
};

export const terminalInputWriteDefinition: IpcDefinition<{
  terminalSessionId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.terminalInputWrite,
  validate: terminalIdAndBody
};

export const terminalSessionResizeDefinition: IpcDefinition<{
  terminalSessionId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.terminalSessionResize,
  validate: terminalIdAndBody
};

export const terminalSessionSignalDefinition: IpcDefinition<{
  terminalSessionId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.terminalSessionSignal,
  validate: terminalIdAndBody
};

export const terminalSessionCloseDefinition: IpcDefinition<{
  terminalSessionId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.terminalSessionClose,
  validate: terminalIdAndBody
};

export const terminalControlAcquireDefinition: IpcDefinition<{
  terminalSessionId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.terminalControlAcquire,
  validate: terminalIdAndBody
};

export const terminalControlRenewDefinition: IpcDefinition<{
  terminalSessionId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.terminalControlRenew,
  validate: terminalIdAndBody
};

export const terminalControlReleaseDefinition: IpcDefinition<{
  terminalSessionId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.terminalControlRelease,
  validate: terminalIdAndBody
};

// ---- governance definitions (EW5) ----

function idAndBody(payload: unknown): IpcValidationResult<{ id: string; body: Record<string, unknown> }> {
  const object = requireObjectPayload(payload);
  if (!object.ok) return object;
  const id = requireId('governance', payload, 'id');
  if (!id.ok) return id;
  const body = (payload as Record<string, unknown>).body;
  if (typeof body !== 'object' || body === null) {
    return { ok: false, reason: 'body is required' };
  }
  return { ok: true, value: { id: id.value, body: body as Record<string, unknown> } };
}

export const specsCreateDefinition: IpcDefinition<{ sessionId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.specsCreate,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const sessionId = requireId('specsCreate', payload, 'sessionId');
    if (!sessionId.ok) return sessionId;
    const body = object.value.body;
    if (typeof body !== 'object' || body === null) {
      return { ok: false, reason: 'body is required' };
    }
    return { ok: true, value: { sessionId: sessionId.value, body: body as Record<string, unknown> } };
  }
};

export const specsGetDefinition: IpcDefinition<{ specId: string }> = {
  channel: IPC_CHANNELS.specsGet,
  validate: (payload) => {
    const id = requireId('specsGet', payload, 'specId');
    if (!id.ok) return id;
    return { ok: true, value: { specId: id.value } };
  }
};

export const specsReviseDefinition: IpcDefinition<{ id: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.specsRevise,
  validate: idAndBody
};

export const specsConvertDefinition: IpcDefinition<{ id: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.specsConvert,
  validate: idAndBody
};

export const specsDecideDefinition: IpcDefinition<{ specId: string; approvalId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.specsDecide,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const specId = requireId('specsDecide', payload, 'specId');
    if (!specId.ok) return specId;
    const approvalId = (payload as Record<string, unknown>).approvalId;
    if (typeof approvalId !== 'string' || !approvalId.match(/^[A-Za-z0-9._-]{1,128}$/)) {
      return { ok: false, reason: 'approvalId is invalid' };
    }
    const body = (payload as Record<string, unknown>).body;
    if (typeof body !== 'object' || body === null) {
      return { ok: false, reason: 'body is required' };
    }
    return { ok: true, value: { specId: specId.value, approvalId, body: body as Record<string, unknown> } };
  }
};

export const commandApprovalDefinition: IpcDefinition<{ id: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.commandApproval,
  validate: idAndBody
};

export const sandboxApprovalDefinition: IpcDefinition<{ id: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.sandboxApproval,
  validate: idAndBody
};

export const sandboxApprovalPendingDefinition: IpcDefinition<{ id: string }> = {
  channel: IPC_CHANNELS.sandboxApprovalPending,
  validate: (payload) => {
    const id = requireId('sandboxApprovalPending', payload, 'id');
    if (!id.ok) return id;
    return { ok: true, value: { id: id.value } };
  }
};

export const terminalApprovalDefinition: IpcDefinition<{ id: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.terminalApproval,
  validate: idAndBody
};

export const terminalApprovalPendingDefinition: IpcDefinition<{ id: string }> = {
  channel: IPC_CHANNELS.terminalApprovalPending,
  validate: (payload) => {
    const id = requireId('terminalApprovalPending', payload, 'id');
    if (!id.ok) return id;
    return { ok: true, value: { id: id.value } };
  }
};

export const budgetApprovalDefinition: IpcDefinition<{ id: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.budgetApproval,
  validate: idAndBody
};

export const writeApprovalDefinition: IpcDefinition<{ id: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.writeApproval,
  validate: idAndBody
};

export const writeApprovalPendingDefinition: IpcDefinition<{ id: string }> = {
  channel: IPC_CHANNELS.writeApprovalPending,
  validate: (payload) => {
    const id = requireId('writeApprovalPending', payload, 'id');
    if (!id.ok) return id;
    return { ok: true, value: { id: id.value } };
  }
};

// ---- unified permission / approval v2 definitions ----

export const executionPolicyGetDefinition: IpcDefinition<{ sessionId: string; projectId?: string }> = {
  channel: IPC_CHANNELS.executionPolicyGet,
  validate: (payload) => {
    const id = requireId('executionPolicyGet', payload, 'sessionId');
    if (!id.ok) return id;
    const projectId = (payload as Record<string, unknown>).projectId;
    if (projectId !== undefined && projectId !== null) {
      if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 128 || !projectId.match(/^[A-Za-z0-9._-]+$/)) {
        return { ok: false, reason: 'projectId is invalid' };
      }
    }
    return { ok: true, value: { sessionId: id.value, projectId: projectId as string | undefined } };
  }
};

function idempotencyBody(payload: unknown, schema: string): IpcValidationResult<{
  id: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
  projectId?: string;
}> {
  const object = requireObjectPayload(payload);
  if (!object.ok) return object;
  const id = requireId(schema, payload, 'id');
  if (!id.ok) return id;
  const body = object.value.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'body is required' };
  }
  const idempotencyKey = object.value.idempotencyKey;
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 128)) {
    return { ok: false, reason: 'idempotencyKey is invalid' };
  }
  const projectId = object.value.projectId;
  if (projectId !== undefined && projectId !== null
      && (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 128 || !projectId.match(/^[A-Za-z0-9._-]+$/))) {
    return { ok: false, reason: 'projectId is invalid' };
  }
  return { ok: true, value: { id: id.value, body: body as Record<string, unknown>, idempotencyKey: idempotencyKey as string | undefined, projectId: projectId as string | undefined } };
}

export const executionPolicyUpdateDefinition: IpcDefinition<{ id: string; body: Record<string, unknown>; idempotencyKey?: string; projectId?: string }> = {
  channel: IPC_CHANNELS.executionPolicyUpdate,
  validate: (payload) => idempotencyBody(payload, 'executionPolicyUpdate')
};

export const executionPolicyDefaultsGetDefinition: IpcDefinition<{ projectId: string }> = {
  channel: IPC_CHANNELS.executionPolicyDefaultsGet,
  validate: (payload) => {
    const id = requireId('executionPolicyDefaultsGet', payload, 'projectId');
    return id.ok ? { ok: true, value: { projectId: id.value } } : id;
  }
};

export const executionPolicyDefaultsUpdateDefinition: IpcDefinition<{ id: string; body: Record<string, unknown>; idempotencyKey?: string }> = {
  channel: IPC_CHANNELS.executionPolicyDefaultsUpdate,
  validate: (payload) => idempotencyBody(payload, 'executionPolicyDefaultsUpdate')
};

// User-scope defaults (design 2026-09-30 §5.1): the caller's own durable
// default for new sessions — the payload carries no identity; the trusted
// service principal owns the row.
export const executionPolicyMyDefaultsGetDefinition: IpcDefinition<Record<string, never>> = {
  channel: IPC_CHANNELS.executionPolicyMyDefaultsGet,
  validate: () => ({ ok: true, value: {} })
};

export const executionPolicyMyDefaultsUpdateDefinition: IpcDefinition<{ body: Record<string, unknown>; idempotencyKey?: string }> = {
  channel: IPC_CHANNELS.executionPolicyMyDefaultsUpdate,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const body = object.value.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, reason: 'body is required' };
    }
    const idempotencyKey = object.value.idempotencyKey;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 128)) {
      return { ok: false, reason: 'idempotencyKey is invalid' };
    }
    return { ok: true, value: { body: body as Record<string, unknown>, idempotencyKey: idempotencyKey as string | undefined } };
  }
};

export const automationControlGetDefinition: IpcDefinition<{ sessionId: string }> = {
  channel: IPC_CHANNELS.automationControlGet,
  validate: (payload) => {
    const id = requireId('automationControlGet', payload, 'sessionId');
    return id.ok ? { ok: true, value: { sessionId: id.value } } : id;
  }
};

export const automationControlUpdateDefinition: IpcDefinition<{
  id: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
}> = {
  channel: IPC_CHANNELS.automationControlUpdate,
  validate: (payload) => {
    const result = idempotencyBody(payload, 'automationControlUpdate');
    if (!result.ok) return result;
    const expectedVersion = result.value.body.expectedVersion;
    const control = result.value.body.control;
    if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      return { ok: false, reason: 'expectedVersion must be a positive safe integer' };
    }
    if (control !== 'PAUSE_AUTOMATION' && control !== 'RESUME_AUTOMATION') {
      return { ok: false, reason: 'control must be PAUSE_AUTOMATION or RESUME_AUTOMATION' };
    }
    return result;
  }
};

export const approvalsListDefinition: IpcDefinition<{ sessionId: string; cursor?: string; limit?: number }> = {
  channel: IPC_CHANNELS.approvalsList,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const id = requireId('approvalsList', payload, 'sessionId');
    if (!id.ok) return id;
    const cursor = object.value.cursor;
    const limit = object.value.limit;
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 256)) return { ok: false, reason: 'cursor is invalid' };
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200)) return { ok: false, reason: 'limit is invalid' };
    return { ok: true, value: { sessionId: id.value, cursor: cursor as string | undefined, limit: limit as number | undefined } };
  }
};

export const approvalGetDefinition: IpcDefinition<{ approvalId: string }> = {
  channel: IPC_CHANNELS.approvalGet,
  validate: (payload) => {
    const id = requireId('approvalGet', payload, 'approvalId');
    return id.ok ? { ok: true, value: { approvalId: id.value } } : id;
  }
};

export const approvalDecideDefinition: IpcDefinition<{ id: string; body: Record<string, unknown>; idempotencyKey?: string }> = {
  channel: IPC_CHANNELS.approvalDecide,
  validate: (payload) => idempotencyBody(payload, 'approvalDecide')
};

export const approvalAdvanceDefinition: IpcDefinition<{ id: string; body: Record<string, unknown>; idempotencyKey?: string }> = {
  channel: IPC_CHANNELS.approvalAdvance,
  validate: (payload) => idempotencyBody(payload, 'approvalAdvance')
};

export const approvalControlDefinition: IpcDefinition<{ id: string; body: Record<string, unknown>; idempotencyKey?: string }> = {
  channel: IPC_CHANNELS.approvalControl,
  validate: (payload) => idempotencyBody(payload, 'approvalControl')
};

export const runCancelDefinition: IpcDefinition<{ runId: string }> = {
  channel: IPC_CHANNELS.runCancel,
  validate: (payload) => {
    const id = requireId('runCancel', payload, 'runId');
    if (!id.ok) return id;
    return { ok: true, value: { runId: id.value } };
  }
};

export const runInterruptDefinition: IpcDefinition<{ runId: string; expectedStateVersion: number | null }> = {
  channel: IPC_CHANNELS.runInterrupt,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const runId = requireId('runInterrupt', payload, 'runId');
    if (!runId.ok) return runId;
    const expected = (payload as Record<string, unknown>).expectedStateVersion;
    if (expected !== null && expected !== undefined && typeof expected !== 'number') {
      return { ok: false, reason: 'expectedStateVersion must be a number or null' };
    }
    return { ok: true, value: { runId: runId.value, expectedStateVersion: typeof expected === 'number' ? expected : null } };
  }
};

export const runControlDefinition: IpcDefinition<{ runId: string; body: {
  intent: 'PAUSE' | 'RESUME' | 'STOP' | 'RECOVER';
  expectedStateVersion: number | null;
  reasonCode?: string | null;
} }> = {
  channel: IPC_CHANNELS.runControl,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const runId = requireId('runControl', payload, 'runId');
    if (!runId.ok) return runId;
    const rawBody = (payload as Record<string, unknown>).body;
    if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
      return { ok: false, reason: 'runControl body must be an object' };
    }
    const body = rawBody as Record<string, unknown>;
    const intent = body.intent;
    if (intent !== 'PAUSE' && intent !== 'RESUME' && intent !== 'STOP' && intent !== 'RECOVER') {
      return { ok: false, reason: 'runControl intent is invalid' };
    }
    const expected = body.expectedStateVersion;
    if (expected !== null && expected !== undefined && typeof expected !== 'number') {
      return { ok: false, reason: 'expectedStateVersion must be a number or null' };
    }
    const reasonCode = body.reasonCode;
    if (reasonCode !== null && reasonCode !== undefined && typeof reasonCode !== 'string') {
      return { ok: false, reason: 'reasonCode must be a string or null' };
    }
    return {
      ok: true,
      value: {
        runId: runId.value,
        body: {
          intent,
          expectedStateVersion: typeof expected === 'number' ? expected : null,
          reasonCode: typeof reasonCode === 'string' ? reasonCode : null
        }
      }
    };
  }
};

// WU-05 (design §6.5): POST /api/v2/runs/{id}/continue — creates the linked
// continuation run once workspace attention is cleared.
export const runContinueDefinition: IpcDefinition<{ runId: string; expectedStateVersion: number | null; message: string | null }> = {
  channel: IPC_CHANNELS.runContinue,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const runId = requireId('runContinue', payload, 'runId');
    if (!runId.ok) return runId;
    const raw = payload as Record<string, unknown>;
    const expected = raw.expectedStateVersion;
    if (expected !== null && expected !== undefined && typeof expected !== 'number') {
      return { ok: false, reason: 'expectedStateVersion must be a number or null' };
    }
    const message = raw.message;
    if (message !== null && message !== undefined && typeof message !== 'string') {
      return { ok: false, reason: 'message must be a string or null' };
    }
    return {
      ok: true,
      value: {
        runId: runId.value,
        expectedStateVersion: typeof expected === 'number' ? expected : null,
        message: typeof message === 'string' ? message : null
      }
    };
  }
};

// ---- diff / review / evidence definitions (EW6) ----

export const runDiffDefinition: IpcDefinition<{ runId: string; page: number; pageSize: number }> = {
  channel: IPC_CHANNELS.runDiff,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const runId = requireId('runDiff', payload, 'runId');
    if (!runId.ok) return runId;
    const page = (payload as Record<string, unknown>).page;
    const pageSize = (payload as Record<string, unknown>).pageSize;
    const out: { runId: string; page: number; pageSize: number } = {
      runId: runId.value,
      page: typeof page === 'number' && page >= 0 ? Math.floor(page) : 0,
      pageSize: typeof pageSize === 'number' && pageSize >= 1 ? Math.min(100, Math.floor(pageSize)) : 20
    };
    return { ok: true, value: out };
  }
};

export const runReviewDefinition: IpcDefinition<{ runId: string }> = {
  channel: IPC_CHANNELS.runReview,
  validate: (payload) => {
    const runId = requireId('runReview', payload, 'runId');
    if (!runId.ok) return runId;
    return { ok: true, value: { runId: runId.value } };
  }
};

export const runEvidenceDefinition: IpcDefinition<{ runId: string }> = {
  channel: IPC_CHANNELS.runEvidence,
  validate: (payload) => {
    const runId = requireId('runEvidence', payload, 'runId');
    if (!runId.ok) return runId;
    return { ok: true, value: { runId: runId.value } };
  }
};

// Run activity snapshot (design 2026-09-02 §11.1): read-only, bounded.
export const runActivitiesDefinition: IpcDefinition<{ runId: string; afterCursor: number; limit: number }> = {
  channel: IPC_CHANNELS.runActivities,
  validate: (payload) => {
    const runId = requireId('runActivities', payload, 'runId');
    if (!runId.ok) return runId;
    const afterCursor = (payload as Record<string, unknown>).afterCursor;
    const limit = (payload as Record<string, unknown>).limit;
    const out: { runId: string; afterCursor: number; limit: number } = {
      runId: runId.value,
      afterCursor: typeof afterCursor === 'number' && afterCursor >= 0 ? Math.floor(afterCursor) : 0,
      limit: typeof limit === 'number' && limit >= 1 ? Math.min(20000, Math.floor(limit)) : 0
    };
    return { ok: true, value: out };
  }
};

// Run display-reasoning snapshot (design 2026-09-18): read-only, bounded.
export const runReasoningDefinition: IpcDefinition<{ runId: string }> = {
  channel: IPC_CHANNELS.runReasoning,
  validate: (payload) => {
    const runId = requireId('runReasoning', payload, 'runId');
    if (!runId.ok) return runId;
    return { ok: true, value: { runId: runId.value } };
  }
};

// Run visible-output snapshot (design 2026-09-19 §5.5-B): read-only, bounded.
export const runOutputDefinition: IpcDefinition<{ runId: string }> = {
  channel: IPC_CHANNELS.runOutput,
  validate: (payload) => {
    const runId = requireId('runOutput', payload, 'runId');
    if (!runId.ok) return runId;
    return { ok: true, value: { runId: runId.value } };
  }
};

// Session execution-evidence reads (design 2026-09-26 §10.2): read-only,
// session-scoped and service-bounded. The artifact path is a
// record-relative reference the capability recorded — traversal segments
// are rejected here and again server-side.
export const sessionExecutionsDefinition: IpcDefinition<{
  sessionId: string;
  runId?: string;
  limit: number;
}> = {
  channel: IPC_CHANNELS.sessionExecutions,
  validate: (payload) => {
    const sessionId = requireId('sessionExecutions', payload, 'sessionId');
    if (!sessionId.ok) return sessionId;
    const runId = (payload as Record<string, unknown>).runId;
    const limit = (payload as Record<string, unknown>).limit;
    if (runId !== undefined && runId !== null
        && (typeof runId !== 'string' || runId.length === 0 || runId.length > 128)) {
      return { ok: false, reason: 'runId is invalid' };
    }
    return { ok: true, value: {
      sessionId: sessionId.value,
      runId: typeof runId === 'string' && runId.length > 0 ? runId : undefined,
      limit: typeof limit === 'number' && limit >= 1 ? Math.min(500, Math.floor(limit)) : 0
    } };
  }
};

export const sessionExecutionDefinition: IpcDefinition<{
  sessionId: string;
  executionId: string;
}> = {
  channel: IPC_CHANNELS.sessionExecution,
  validate: (payload) => {
    const sessionId = requireId('sessionExecution', payload, 'sessionId');
    if (!sessionId.ok) return sessionId;
    const executionId = requireId('sessionExecution', payload, 'executionId');
    if (!executionId.ok) return executionId;
    return { ok: true, value: { sessionId: sessionId.value, executionId: executionId.value } };
  }
};

export const sessionExecutionArtifactDefinition: IpcDefinition<{
  sessionId: string;
  executionId: string;
  path: string;
  offset: number;
  maxBytes: number;
}> = {
  channel: IPC_CHANNELS.sessionExecutionArtifact,
  validate: (payload) => {
    const sessionId = requireId('sessionExecutionArtifact', payload, 'sessionId');
    if (!sessionId.ok) return sessionId;
    const executionId = requireId('sessionExecutionArtifact', payload, 'executionId');
    if (!executionId.ok) return executionId;
    const path = (payload as Record<string, unknown>).path;
    if (typeof path !== 'string' || path.length === 0 || path.length > 512
        || path.includes('..') || path.startsWith('/') || path.startsWith('\\')
        || path.includes(':') || path.includes('?') || path.includes('#')) {
      return { ok: false, reason: 'path is invalid' };
    }
    const offset = (payload as Record<string, unknown>).offset;
    const maxBytes = (payload as Record<string, unknown>).maxBytes;
    return { ok: true, value: {
      sessionId: sessionId.value,
      executionId: executionId.value,
      path,
      offset: typeof offset === 'number' && offset >= 0 ? Math.floor(offset) : 0,
      maxBytes: typeof maxBytes === 'number' && maxBytes >= 1
          ? Math.min(1048576, Math.floor(maxBytes)) : 0
    } };
  }
};

export const workspaceConflictsListDefinition: IpcDefinition<{ runId: string }> = {
  channel: IPC_CHANNELS.workspaceConflictsList,
  validate: (payload) => {
    const runId = requireId('workspaceConflictsList', payload, 'runId');
    if (!runId.ok) return runId;
    return { ok: true, value: { runId: runId.value } };
  }
};

export const workspaceConflictGetDefinition: IpcDefinition<{ conflictId: string }> = {
  channel: IPC_CHANNELS.workspaceConflictGet,
  validate: (payload) => {
    const conflictId = requireId('workspaceConflictGet', payload, 'conflictId');
    if (!conflictId.ok) return conflictId;
    if (!/^wc-[A-Za-z0-9_-]{12,64}$/.test(conflictId.value)) {
      return { ok: false, reason: 'conflictId is invalid' };
    }
    return { ok: true, value: { conflictId: conflictId.value } };
  }
};

export const workspaceConflictResolveDefinition: IpcDefinition<{
  conflictId: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
}> = {
  channel: IPC_CHANNELS.workspaceConflictResolve,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const conflictId = requireId('workspaceConflictResolve', payload, 'conflictId');
    if (!conflictId.ok) return conflictId;
    if (!/^wc-[A-Za-z0-9_-]{12,64}$/.test(conflictId.value)) {
      return { ok: false, reason: 'conflictId is invalid' };
    }
    const body = object.value.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, reason: 'body is required' };
    }
    const idempotencyKey = object.value.idempotencyKey;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string'
        || idempotencyKey.length === 0 || idempotencyKey.length > 128)) {
      return { ok: false, reason: 'idempotencyKey is invalid' };
    }
    return { ok: true, value: {
      conflictId: conflictId.value,
      body: body as Record<string, unknown>,
      idempotencyKey: idempotencyKey as string | undefined
    } };
  }
};

export const workspaceConflictAutoMergeDefinition: IpcDefinition<{
  conflictId: string; idempotencyKey?: string;
}> = {
  channel: IPC_CHANNELS.workspaceConflictAutoMerge,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const conflictId = requireId('workspaceConflictAutoMerge', payload, 'conflictId');
    if (!conflictId.ok) return conflictId;
    if (!/^wc-[A-Za-z0-9_-]{12,64}$/.test(conflictId.value)) {
      return { ok: false, reason: 'conflictId is invalid' };
    }
    const idempotencyKey = object.value.idempotencyKey;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string'
        || idempotencyKey.length === 0 || idempotencyKey.length > 128)) {
      return { ok: false, reason: 'idempotencyKey is invalid' };
    }
    return { ok: true, value: {
      conflictId: conflictId.value,
      idempotencyKey: idempotencyKey as string | undefined
    } };
  }
};

export const workspaceConflictDismissDefinition: IpcDefinition<{
  conflictId: string; idempotencyKey?: string;
}> = {
  channel: IPC_CHANNELS.workspaceConflictDismiss,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const conflictId = requireId('workspaceConflictDismiss', payload, 'conflictId');
    if (!conflictId.ok) return conflictId;
    if (!/^wc-[A-Za-z0-9_-]{12,64}$/.test(conflictId.value)) {
      return { ok: false, reason: 'conflictId is invalid' };
    }
    const idempotencyKey = object.value.idempotencyKey;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string'
        || idempotencyKey.length === 0 || idempotencyKey.length > 128)) {
      return { ok: false, reason: 'idempotencyKey is invalid' };
    }
    return { ok: true, value: {
      conflictId: conflictId.value,
      idempotencyKey: idempotencyKey as string | undefined
    } };
  }
};

export const workspaceConflictProposalSubmitDefinition: IpcDefinition<{
  conflictId: string; idempotencyKey?: string;
}> = {
  channel: IPC_CHANNELS.workspaceConflictProposalSubmit,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const conflictId = requireId('workspaceConflictProposalSubmit', payload, 'conflictId');
    if (!conflictId.ok) return conflictId;
    if (!/^wc-[A-Za-z0-9_-]{12,64}$/.test(conflictId.value)) {
      return { ok: false, reason: 'conflictId is invalid' };
    }
    const idempotencyKey = object.value.idempotencyKey;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string'
        || idempotencyKey.length === 0 || idempotencyKey.length > 128)) {
      return { ok: false, reason: 'idempotencyKey is invalid' };
    }
    return { ok: true, value: {
      conflictId: conflictId.value,
      idempotencyKey: idempotencyKey as string | undefined
    } };
  }
};

export const workspaceConflictProposalPollDefinition: IpcDefinition<{
  proposalId: string;
}> = {
  channel: IPC_CHANNELS.workspaceConflictProposalPoll,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const proposalId = object.value.proposalId;
    if (typeof proposalId !== 'string'
        || !/^proposal-[A-Za-z0-9-]{8,128}$/.test(proposalId)) {
      return { ok: false, reason: 'proposalId is invalid' };
    }
    return { ok: true, value: { proposalId } };
  }
};

export const workspaceConflictsResolveBatchDefinition: IpcDefinition<{
  body: Record<string, unknown>; idempotencyKey?: string;
}> = {
  channel: IPC_CHANNELS.workspaceConflictsResolveBatch,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const body = object.value.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, reason: 'body is required' };
    }
    const items = (body as Record<string, unknown>).items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 200) {
      return { ok: false, reason: 'body.items must contain 1..200 entries' };
    }
    const idempotencyKey = object.value.idempotencyKey;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string'
        || idempotencyKey.length === 0 || idempotencyKey.length > 128)) {
      return { ok: false, reason: 'idempotencyKey is invalid' };
    }
    return { ok: true, value: {
      body: body as Record<string, unknown>,
      idempotencyKey: idempotencyKey as string | undefined
    } };
  }
};

export const workspaceConflictsFilteredDefinition: IpcDefinition<{
  projectId?: string; origin?: string; runId?: string;
  state?: string; cursor?: string; limit?: number;
}> = {
  channel: IPC_CHANNELS.workspaceConflictsFiltered,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const value: Record<string, unknown> = {};
    for (const key of ['projectId', 'origin', 'runId', 'state', 'cursor']) {
      const raw = object.value[key];
      if (raw !== undefined && raw !== null) {
        if (typeof raw !== 'string' || raw.length > 256) {
          return { ok: false, reason: `${key} must be a bounded string` };
        }
        value[key] = raw;
      }
    }
    const limit = object.value.limit;
    if (limit !== undefined && (typeof limit !== 'number'
        || !Number.isFinite(limit) || limit < 1 || limit > 200)) {
      return { ok: false, reason: 'limit must be 1..200' };
    }
    if (limit !== undefined) value.limit = Math.floor(limit);
    return { ok: true, value: value as {
      projectId?: string; origin?: string; runId?: string;
      state?: string; cursor?: string; limit?: number;
    } };
  }
};

export const workspaceContentGetDefinition: IpcDefinition<{
  ref: string; offset?: number; limit?: number;
}> = {
  channel: IPC_CHANNELS.workspaceContentGet,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const ref = object.value.ref;
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > 256) {
      return { ok: false, reason: 'ref is required and bounded' };
    }
    const offset = object.value.offset;
    if (offset !== undefined && (typeof offset !== 'number'
        || !Number.isFinite(offset) || offset < 0)) {
      return { ok: false, reason: 'offset must be a non-negative number' };
    }
    const limit = object.value.limit;
    if (limit !== undefined && (typeof limit !== 'number'
        || !Number.isFinite(limit) || limit < 0 || limit > 2 * 1024 * 1024)) {
      return { ok: false, reason: 'limit must be 0..2MiB' };
    }
    return { ok: true, value: {
      ref,
      offset: typeof offset === 'number' ? Math.floor(offset) : undefined,
      limit: typeof limit === 'number' ? Math.floor(limit) : undefined
    } };
  }
};

export const workspaceContentPutDefinition: IpcDefinition<{
  contentBase64: string; idempotencyKey?: string;
}> = {
  channel: IPC_CHANNELS.workspaceContentPut,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const contentBase64 = object.value.contentBase64;
    if (typeof contentBase64 !== 'string' || contentBase64.length > 4 * 1024 * 1024) {
      return { ok: false, reason: 'contentBase64 is required and bounded' };
    }
    const idempotencyKey = object.value.idempotencyKey;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string'
        || idempotencyKey.length === 0 || idempotencyKey.length > 128)) {
      return { ok: false, reason: 'idempotencyKey is invalid' };
    }
    return { ok: true, value: {
      contentBase64,
      idempotencyKey: idempotencyKey as string | undefined
    } };
  }
};

export const readProjectFileDefinition: IpcDefinition<{ projectId: string; fileRef: string; revision?: string }> = {
  channel: IPC_CHANNELS.readProjectFile,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const projectId = requireId('readProjectFile', payload, 'projectId');
    if (!projectId.ok) return projectId;
    const fileRef = object.value.fileRef;
    if (typeof fileRef !== 'string' || fileRef.length === 0 || fileRef.length > 1024 || fileRef.includes('\0')) {
      return { ok: false, reason: 'fileRef is required and bounded' };
    }
    const revision = object.value.revision;
    if (revision !== undefined && revision !== null
        && (typeof revision !== 'string' || revision.length === 0 || revision.length > 256)) {
      return { ok: false, reason: 'revision must be a bounded string when present' };
    }
    return { ok: true, value: { projectId: projectId.value, fileRef, ...(typeof revision === 'string' ? { revision } : {}) } };
  }
};

export const createFixTaskDefinition: IpcDefinition<{ id: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.createFixTask,
  validate: idAndBody
};

export const revealProjectFileDefinition: IpcDefinition<{ projectId: string; fileRef: string }> = {
  channel: IPC_CHANNELS.revealProjectFile,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const projectId = requireId('revealProjectFile', payload, 'projectId');
    if (!projectId.ok) return projectId;
    const fileRef = (payload as Record<string, unknown>).fileRef;
    if (typeof fileRef !== 'string' || fileRef.length === 0 || fileRef.length > 512) {
      return { ok: false, reason: 'fileRef is required and bounded' };
    }
    return { ok: true, value: { projectId: projectId.value, fileRef } };
  }
};

// ---- service-owned workspace execution definitions (EW7) ----

export const workspaceExecutionsListDefinition: IpcDefinition<{ projectId: string }> = {
  channel: IPC_CHANNELS.workspaceExecutionsList,
  validate: (payload) => {
    const projectId = requireId('workspaceExecutionsList', payload, 'projectId');
    if (!projectId.ok) return projectId;
    return { ok: true, value: { projectId: projectId.value } };
  }
};

export const workspaceExecutionCreateDefinition: IpcDefinition<{
  workspaceAlias: string;
  kind: string;
  ownerType: string;
  ownerId: string;
  startPolicy?: string;
}> = {
  channel: IPC_CHANNELS.workspaceExecutionCreate,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const workspaceAlias = requireId('workspaceExecutionCreate', payload, 'workspaceAlias');
    if (!workspaceAlias.ok) return workspaceAlias;
    const ownerId = requireId('workspaceExecutionCreate', payload, 'ownerId');
    if (!ownerId.ok) return ownerId;
    const kind = (payload as Record<string, unknown>).kind;
    const ownerType = (payload as Record<string, unknown>).ownerType;
    if (kind !== 'WORKTREE' && kind !== 'CHECKOUT') {
      return { ok: false, reason: 'kind must be WORKTREE or CHECKOUT' };
    }
    if (ownerType !== 'RUN' && ownerType !== 'MISSION_WORK_ITEM' && ownerType !== 'SESSION') {
      return { ok: false, reason: 'ownerType is invalid' };
    }
    const startPolicy = (payload as Record<string, unknown>).startPolicy;
    const startPolicies = new Set(['CLEAN_HEAD', 'USER_WIP_SNAPSHOT', 'APPROVED_DELIVERY',
      'FORK_SNAPSHOT', 'CURRENT_WORKTREE', 'REQUIRE_KNOWN_LINEAGE', 'REQUIRE_CLEAN', 'READ_ONLY_CURRENT']);
    if (startPolicy !== undefined && startPolicy !== null
        && (typeof startPolicy !== 'string' || !startPolicies.has(startPolicy))) {
      return { ok: false, reason: 'startPolicy is invalid' };
    }
    return {
      ok: true,
      value: {
        workspaceAlias: workspaceAlias.value, kind, ownerType, ownerId: ownerId.value,
        ...(typeof startPolicy === 'string' ? { startPolicy } : {})
      }
    };
  }
};

export const workspaceExecutionHandoffDefinition: IpcDefinition<{
  workspaceExecutionId: string;
  expectedStateVersion: number | null;
}> = {
  channel: IPC_CHANNELS.workspaceExecutionHandoff,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const id = requireId('workspaceExecutionHandoff', payload, 'workspaceExecutionId');
    if (!id.ok) return id;
    const expected = (payload as Record<string, unknown>).expectedStateVersion;
    if (expected !== null && expected !== undefined && typeof expected !== 'number') {
      return { ok: false, reason: 'expectedStateVersion must be a number or null' };
    }
    return {
      ok: true,
      value: {
        workspaceExecutionId: id.value,
        expectedStateVersion: typeof expected === 'number' ? expected : null
      }
    };
  }
};

export const workspaceExecutionReclaimDefinition: IpcDefinition<{
  workspaceExecutionId: string;
  expectedStateVersion: number | null;
}> = {
  channel: IPC_CHANNELS.workspaceExecutionReclaim,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const id = requireId('workspaceExecutionReclaim', payload, 'workspaceExecutionId');
    if (!id.ok) return id;
    const expected = (payload as Record<string, unknown>).expectedStateVersion;
    if (expected !== null && expected !== undefined && typeof expected !== 'number') {
      return { ok: false, reason: 'expectedStateVersion must be a number or null' };
    }
    return {
      ok: true,
      value: {
        workspaceExecutionId: id.value,
        expectedStateVersion: typeof expected === 'number' ? expected : null
      }
    };
  }
};

// ---- session-owned workspace lanes and serialized delivery ----

function boundedIdField(schema: string, object: Record<string, unknown>, field: string): IpcValidationResult<string> {
  const value = object[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    return { ok: false, reason: `${schema}.${field} is invalid` };
  }
  return { ok: true, value };
}

function boundedOptionalString(schema: string, object: Record<string, unknown>, field: string, max = 512): IpcValidationResult<string | undefined> {
  const value = object[field];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    return { ok: false, reason: `${schema}.${field} is invalid` };
  }
  return { ok: true, value };
}

function laneIdAndBody(payload: unknown, schema: string): IpcValidationResult<{ workspaceLaneId: string; body: Record<string, unknown> }> {
  const object = requireObjectPayload(payload);
  if (!object.ok) return object;
  const id = boundedIdField(schema, object.value, 'workspaceLaneId');
  if (!id.ok) return id;
  const body = object.value.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: `${schema}.body must be an object` };
  }
  return { ok: true, value: { workspaceLaneId: id.value, body: body as Record<string, unknown> } };
}

function deliveryIdAndBody(payload: unknown, schema: string): IpcValidationResult<{ deliveryId: string; body: Record<string, unknown> }> {
  const object = requireObjectPayload(payload);
  if (!object.ok) return object;
  const id = boundedIdField(schema, object.value, 'deliveryId');
  if (!id.ok) return id;
  const body = object.value.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: `${schema}.body must be an object` };
  }
  return { ok: true, value: { deliveryId: id.value, body: body as Record<string, unknown> } };
}

export const workspaceLaneCreateDefinition: IpcDefinition<Record<string, unknown>> = {
  channel: IPC_CHANNELS.workspaceLaneCreate,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const sessionId = boundedIdField('workspaceLaneCreate', object.value, 'sessionId');
    if (!sessionId.ok) return sessionId;
    const projectId = boundedIdField('workspaceLaneCreate', object.value, 'projectId');
    if (!projectId.ok) return projectId;
    const baselineRevision = boundedOptionalString('workspaceLaneCreate', object.value, 'baselineRevision', 256);
    if (!baselineRevision.ok) return baselineRevision;
    return { ok: true, value: { sessionId: sessionId.value, projectId: projectId.value, ...(baselineRevision.value ? { baselineRevision: baselineRevision.value } : {}) } };
  }
};

export const workspaceLaneGetDefinition: IpcDefinition<{ workspaceLaneId: string }> = {
  channel: IPC_CHANNELS.workspaceLaneGet,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const id = boundedIdField('workspaceLaneGet', object.value, 'workspaceLaneId');
    return id.ok ? { ok: true, value: { workspaceLaneId: id.value } } : id;
  }
};

export const workspaceLaneBindDefinition: IpcDefinition<{ workspaceLaneId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.workspaceLaneBind,
  validate: (payload) => laneIdAndBody(payload, 'workspaceLaneBind')
};

export const workspaceLaneReopenDefinition: IpcDefinition<{ workspaceLaneId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.workspaceLaneReopen,
  validate: (payload) => laneIdAndBody(payload, 'workspaceLaneReopen')
};

export const workspaceLaneReleaseDefinition: IpcDefinition<{ workspaceLaneId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.workspaceLaneRelease,
  validate: (payload) => laneIdAndBody(payload, 'workspaceLaneRelease')
};

export const deliveryCreateDefinition: IpcDefinition<Record<string, unknown>> = {
  channel: IPC_CHANNELS.deliveryCreate,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const projectId = boundedIdField('deliveryCreate', object.value, 'projectId');
    if (!projectId.ok) return projectId;
    const lane = boundedIdField('deliveryCreate', object.value, 'workspaceLaneId');
    if (!lane.ok) return lane;
    return { ok: true, value: object.value };
  }
};

export const deliveryGetDefinition: IpcDefinition<{ deliveryId: string }> = {
  channel: IPC_CHANNELS.deliveryGet,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const id = boundedIdField('deliveryGet', object.value, 'deliveryId');
    return id.ok ? { ok: true, value: { deliveryId: id.value } } : id;
  }
};

export const deliveryChangesDefinition: IpcDefinition<{ deliveryId: string }> = {
  channel: IPC_CHANNELS.deliveryChanges,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const id = boundedIdField('deliveryChanges', object.value, 'deliveryId');
    return id.ok ? { ok: true, value: { deliveryId: id.value } } : id;
  }
};

export const deliveryPrepareDefinition: IpcDefinition<{ deliveryId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.deliveryPrepare,
  validate: (payload) => deliveryIdAndBody(payload, 'deliveryPrepare')
};

export const deliveryDecideDefinition: IpcDefinition<{ deliveryId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.deliveryDecide,
  validate: (payload) => deliveryIdAndBody(payload, 'deliveryDecide')
};

export const deliveryApplyDefinition: IpcDefinition<{ deliveryId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.deliveryApply,
  validate: (payload) => deliveryIdAndBody(payload, 'deliveryApply')
};

export const deliveryReconcileDefinition: IpcDefinition<{ deliveryId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.deliveryReconcile,
  validate: (payload) => deliveryIdAndBody(payload, 'deliveryReconcile')
};

export const deliveryRebaseDefinition: IpcDefinition<{ deliveryId: string; body: Record<string, unknown> }> = {
  channel: IPC_CHANNELS.deliveryRebase,
  validate: (payload) => deliveryIdAndBody(payload, 'deliveryRebase')
};

export const deliveryListDefinition: IpcDefinition<{ projectId: string; cursor?: string; limit?: number }> = {
  channel: IPC_CHANNELS.deliveryList,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const projectId = boundedIdField('deliveryList', object.value, 'projectId');
    if (!projectId.ok) return projectId;
    const cursor = boundedOptionalString('deliveryList', object.value, 'cursor', 1024);
    if (!cursor.ok) return cursor;
    const limit = object.value.limit;
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) {
      return { ok: false, reason: 'deliveryList.limit is outside the allowed range' };
    }
    return { ok: true, value: { projectId: projectId.value, ...(cursor.value ? { cursor: cursor.value } : {}), ...(typeof limit === 'number' ? { limit } : {}) } };
  }
};

// ---- mission control definitions (EW8) ----

export const missionsListDefinition: IpcDefinition<{ sessionId: string | null }> = {
  channel: IPC_CHANNELS.missionsList,
  validate: (payload) => {
    const sessionId = (payload as Record<string, unknown> | null)?.sessionId;
    if (sessionId !== null && sessionId !== undefined && typeof sessionId !== 'string') {
      return { ok: false, reason: 'sessionId must be a string or null' };
    }
    return { ok: true, value: { sessionId: typeof sessionId === 'string' ? sessionId : null } };
  }
};

export const missionsGetDefinition: IpcDefinition<{ missionId: string }> = {
  channel: IPC_CHANNELS.missionsGet,
  validate: (payload) => {
    const missionId = requireId('missionsGet', payload, 'missionId');
    if (!missionId.ok) return missionId;
    return { ok: true, value: { missionId: missionId.value } };
  }
};

export const missionsCreateDefinition: IpcDefinition<{
  sessionId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.missionsCreate,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const sessionId = requireId('missionsCreate', payload, 'sessionId');
    if (!sessionId.ok) return sessionId;
    const body = (payload as Record<string, unknown>).body;
    if (typeof body !== 'object' || body === null) {
      return { ok: false, reason: 'body must be an object' };
    }
    return { ok: true, value: { sessionId: sessionId.value, body: body as Record<string, unknown> } };
  }
};

export const missionsDecideDefinition: IpcDefinition<{
  missionId: string;
  approvalId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.missionsDecide,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const missionId = requireId('missionsDecide', payload, 'missionId');
    if (!missionId.ok) return missionId;
    const approvalId = requireId('missionsDecide', payload, 'approvalId');
    if (!approvalId.ok) return approvalId;
    const body = (payload as Record<string, unknown>).body;
    if (typeof body !== 'object' || body === null) {
      return { ok: false, reason: 'body must be an object' };
    }
    return { ok: true, value: { missionId: missionId.value, approvalId: approvalId.value, body: body as Record<string, unknown> } };
  }
};

export const missionCommandDefinitionFactory = (channel: string): IpcDefinition<{
  missionId: string;
  expectedMissionVersion: number;
}> => ({
  channel,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const missionId = requireId('missionCommand', payload, 'missionId');
    if (!missionId.ok) return missionId;
    const expected = (payload as Record<string, unknown>).expectedMissionVersion;
    if (typeof expected !== 'number' || expected < 0) {
      return { ok: false, reason: 'expectedMissionVersion must be a non-negative number' };
    }
    return { ok: true, value: { missionId: missionId.value, expectedMissionVersion: Math.floor(expected) } };
  }
});

export const missionsStartDefinition = missionCommandDefinitionFactory(IPC_CHANNELS.missionsStart);
export const missionsPauseDefinition = missionCommandDefinitionFactory(IPC_CHANNELS.missionsPause);
export const missionsResumeDefinition = missionCommandDefinitionFactory(IPC_CHANNELS.missionsResume);
export const missionsCancelDefinition = missionCommandDefinitionFactory(IPC_CHANNELS.missionsCancel);

// ---- product governance definitions (EW9) ----

const noPayloadValidation: IpcDefinition<Record<string, never>> = {
  channel: '' as never,
  validate: () => ({ ok: true, value: {} })
};

export const policyLayersListDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.policyLayersList
};

export const policyLayerUpdateDefinition: IpcDefinition<{
  layer: string;
  maximumAutonomy: string;
  expectedRevision: number | null;
}> = {
  channel: IPC_CHANNELS.policyLayerUpdate,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const layer = requireId('policyLayerUpdate', payload, 'layer');
    if (!layer.ok) return layer;
    if (layer.value !== 'PROJECT' && layer.value !== 'USER') {
      return { ok: false, reason: 'layer must be PROJECT or USER' };
    }
    const maximumAutonomy = (payload as Record<string, unknown>).maximumAutonomy;
    if (typeof maximumAutonomy !== 'string'
        || !['OFF', 'LOW', 'MEDIUM', 'HIGH'].includes(maximumAutonomy)) {
      return { ok: false, reason: 'maximumAutonomy is invalid' };
    }
    const expected = (payload as Record<string, unknown>).expectedRevision;
    if (expected !== null && expected !== undefined && typeof expected !== 'number') {
      return { ok: false, reason: 'expectedRevision must be a number or null' };
    }
    return {
      ok: true,
      value: {
        layer: layer.value,
        maximumAutonomy,
        expectedRevision: typeof expected === 'number' ? expected : null
      }
    };
  }
};

export const settingsGetDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.settingsGet
};

export const settingsUpdateDefinition: IpcDefinition<{
  traceExportEnabled: boolean | null;
  localOnly: boolean | null;
  eventJournalRetentionDays: number | null;
  expectedRevision: number | null;
}> = {
  channel: IPC_CHANNELS.settingsUpdate,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const record = payload as Record<string, unknown>;
    const out: {
      traceExportEnabled: boolean | null;
      localOnly: boolean | null;
      eventJournalRetentionDays: number | null;
      expectedRevision: number | null;
    } = { traceExportEnabled: null, localOnly: null, eventJournalRetentionDays: null, expectedRevision: null };
    if (typeof record.traceExportEnabled === 'boolean') out.traceExportEnabled = record.traceExportEnabled;
    if (typeof record.localOnly === 'boolean') out.localOnly = record.localOnly;
    if (typeof record.eventJournalRetentionDays === 'number') {
      out.eventJournalRetentionDays = Math.floor(record.eventJournalRetentionDays);
    }
    if (typeof record.expectedRevision === 'number') out.expectedRevision = Math.floor(record.expectedRevision);
    return { ok: true, value: out };
  }
};

export const knowledgeListDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.knowledgeList
};

export const knowledgeSuggestDefinition: IpcDefinition<{ content: string; sourceRef: string | null }> = {
  channel: IPC_CHANNELS.knowledgeSuggest,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const content = (payload as Record<string, unknown>).content;
    if (typeof content !== 'string' || content.trim().length === 0 || content.length > 2000) {
      return { ok: false, reason: 'content is required and bounded' };
    }
    const sourceRef = (payload as Record<string, unknown>).sourceRef;
    if (sourceRef !== undefined && sourceRef !== null
        && (typeof sourceRef !== 'string' || sourceRef.length > 512)) {
      return { ok: false, reason: 'sourceRef must be a bounded string when present' };
    }
    return {
      ok: true,
      value: {
        content,
        sourceRef: typeof sourceRef === 'string' ? sourceRef : null
      }
    };
  }
};

export const knowledgeConfirmDefinition: IpcDefinition<{ knowledgeId: string }> = {
  channel: IPC_CHANNELS.knowledgeConfirm,
  validate: (payload) => {
    const knowledgeId = requireId('knowledgeConfirm', payload, 'knowledgeId');
    if (!knowledgeId.ok) return knowledgeId;
    return { ok: true, value: { knowledgeId: knowledgeId.value } };
  }
};

// ---- settings center (SET-2/SET-3) ----

export const preferencesGetDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.preferencesGet
};

export const preferencesUpdateDefinition: IpcDefinition<DesktopPreferencesUpdateRequest> = {
  channel: IPC_CHANNELS.preferencesUpdate,
  validate: (payload) => admitPreferencesUpdate(payload)
};

export const modelsCatalogDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.modelsCatalog
};

export const agentProfilesListDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.agentProfilesList
};

export const diagnosticsRevealDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.diagnosticsReveal,
  validate: (payload) => {
    if (payload === undefined || payload === null) return { ok: true, value: undefined };
    return { ok: false, reason: 'reveal takes no payload' };
  }
};

export const diagnosticsCopyDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.diagnosticsCopy,
  validate: (payload) => {
    if (payload === undefined || payload === null) return { ok: true, value: undefined };
    return { ok: false, reason: 'copy takes no payload' };
  }
};

export const aboutGetDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.aboutGet,
  validate: (payload) => {
    if (payload === undefined || payload === null) return { ok: true, value: undefined };
    return { ok: false, reason: 'about takes no payload' };
  }
};

export const approvalPingDefinition: IpcDefinition<undefined> = {
  channel: IPC_CHANNELS.approvalPing,
  validate: (payload) => {
    if (payload === undefined || payload === null) return { ok: true, value: undefined };
    return { ok: false, reason: 'approval ping takes no payload' };
  }
};

// ---- read-only external sources (EW10.2) ----

export const sourcesFetchDefinition: IpcDefinition<{
  sourceType: 'WEB' | 'ISSUE' | 'DOCS';
  uri: string;
  maxBytes: number | null;
}> = {
  channel: IPC_CHANNELS.sourcesFetch,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const sourceType = (payload as Record<string, unknown>).sourceType;
    if (sourceType !== 'WEB' && sourceType !== 'ISSUE' && sourceType !== 'DOCS') {
      return { ok: false, reason: 'sourceType must be WEB, ISSUE or DOCS' };
    }
    const uri = (payload as Record<string, unknown>).uri;
    if (typeof uri !== 'string' || uri.trim().length === 0 || uri.length > 2048) {
      return { ok: false, reason: 'uri is required and bounded to 2048 characters' };
    }
    const maxBytes = (payload as Record<string, unknown>).maxBytes;
    if (maxBytes !== null && maxBytes !== undefined
        && (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes <= 0)) {
      return { ok: false, reason: 'maxBytes must be a positive integer or null' };
    }
    return {
      ok: true,
      value: {
        sourceType,
        uri,
        maxBytes: typeof maxBytes === 'number' ? maxBytes : null
      }
    };
  }
};

export const mcpServersListDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.mcpServersList
};

export const mcpResourcesListDefinition: IpcDefinition<{ serverId: string }> = {
  channel: IPC_CHANNELS.mcpResourcesList,
  validate: (payload) => {
    const serverId = requireId('mcpResourcesList', payload, 'serverId');
    if (!serverId.ok) return serverId;
    if (!/^[a-z0-9_-]{1,64}$/.test(serverId.value)) {
      return { ok: false, reason: 'serverId must match ^[a-z0-9_-]{1,64}$' };
    }
    return { ok: true, value: { serverId: serverId.value } };
  }
};

export const mcpResourceReadDefinition: IpcDefinition<{ serverId: string; uri: string }> = {
  channel: IPC_CHANNELS.mcpResourceRead,
  validate: (payload) => {
    const serverId = requireId('mcpResourceRead', payload, 'serverId');
    if (!serverId.ok) return serverId;
    if (!/^[a-z0-9_-]{1,64}$/.test(serverId.value)) {
      return { ok: false, reason: 'serverId must match ^[a-z0-9_-]{1,64}$' };
    }
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const uri = (payload as Record<string, unknown>).uri;
    if (typeof uri !== 'string' || uri.trim().length === 0 || uri.length > 2048) {
      return { ok: false, reason: 'uri is required and bounded to 2048 characters' };
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(uri)) {
      return { ok: false, reason: 'uri must not contain control characters' };
    }
    return { ok: true, value: { serverId: serverId.value, uri } };
  }
};

// ---- skill catalog (EW10.5) / typed hooks (EW10.6) ----

export const skillsListDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.skillsList
};

export const skillsRegisterDefinition: IpcDefinition<{
  name: string;
  version: string;
  source: string;
  scope: string;
  projectAlias: string | null;
  instructions: string;
}> = {
  channel: IPC_CHANNELS.skillsRegister,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const record = payload as Record<string, unknown>;
    for (const field of ['name', 'version', 'source', 'instructions'] as const) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        return { ok: false, reason: `${field} is required` };
      }
    }
    if (typeof record.name === 'string' && record.name.length > 100) {
      return { ok: false, reason: 'name is bounded to 100 characters' };
    }
    if (typeof record.version === 'string' && record.version.length > 64) {
      return { ok: false, reason: 'version is bounded to 64 characters' };
    }
    if (typeof record.source === 'string' && record.source.length > 256) {
      return { ok: false, reason: 'source is bounded to 256 characters' };
    }
    if (typeof record.instructions === 'string' && record.instructions.length > 8000) {
      return { ok: false, reason: 'instructions are bounded to 8000 characters' };
    }
    if (record.scope !== 'PROJECT' && record.scope !== 'USER') {
      return { ok: false, reason: 'scope must be PROJECT or USER' };
    }
    return {
      ok: true,
      value: {
        name: record.name as string,
        version: record.version as string,
        source: record.source as string,
        scope: record.scope,
        projectAlias: typeof record.projectAlias === 'string' && record.projectAlias.trim().length > 0
          ? record.projectAlias
          : null,
        instructions: record.instructions as string
      }
    };
  }
};

export const skillStatusDefinition: IpcDefinition<{
  skillId: string;
  status: 'ACTIVE' | 'DISABLED' | 'REVOKED';
  expectedRevision: number;
}> = {
  channel: IPC_CHANNELS.skillStatus,
  validate: (payload) => {
    const skillId = requireId('skillStatus', payload, 'skillId');
    if (!skillId.ok) return skillId;
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const record = payload as Record<string, unknown>;
    if (record.status !== 'ACTIVE' && record.status !== 'DISABLED' && record.status !== 'REVOKED') {
      return { ok: false, reason: 'status must be ACTIVE, DISABLED or REVOKED' };
    }
    if (typeof record.expectedRevision !== 'number' || !Number.isInteger(record.expectedRevision)
        || record.expectedRevision < 1) {
      return { ok: false, reason: 'expectedRevision must be a positive integer' };
    }
    return {
      ok: true,
      value: {
        skillId: skillId.value,
        status: record.status,
        expectedRevision: record.expectedRevision
      }
    };
  }
};

export const hooksListDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.hooksList
};

export const hooksExecutionsDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.hooksExecutions
};

// ---- governed extension surface (capability uplift WU07) ----
// Configuration and evidence only: the renderer never carries credential
// material, never supplies filesystem paths for imports, and never
// executes MCP calls or skill code — the Java host owns all of that.

export const mcpServersGovernedDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.mcpServersGoverned
};

/** Narrow allowlist on server config — slot names only, never values. */
export const mcpServerCreateDefinition: IpcDefinition<{
  displayName: string;
  scope: 'USER' | 'PROJECT';
  projectId: string | null;
  enabled: boolean;
  protocolPolicy: 'PIN' | 'AUTO';
  protocolProfile: string | null;
  transport: Record<string, unknown>;
  credentialRef: string | null;
  oauthClientId: string | null;
  templateRef: string | null;
  templateVersion: string | null;
  policyRef: string | null;
}> = {
  channel: IPC_CHANNELS.mcpServerCreate,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const record = payload as Record<string, unknown>;
    if (typeof record.displayName !== 'string' || record.displayName.trim().length === 0
        || record.displayName.length > 128) {
      return { ok: false, reason: 'displayName is required and bounded to 128 characters' };
    }
    if (record.scope !== 'USER' && record.scope !== 'PROJECT') {
      return { ok: false, reason: 'scope must be USER or PROJECT' };
    }
    if (record.scope === 'PROJECT'
        && (typeof record.projectId !== 'string' || record.projectId.trim().length === 0)) {
      return { ok: false, reason: 'projectId is required for PROJECT scope' };
    }
    if (record.protocolPolicy !== 'PIN' && record.protocolPolicy !== 'AUTO'
        && record.protocolPolicy !== undefined) {
      return { ok: false, reason: 'protocolPolicy must be PIN or AUTO' };
    }
    if (record.protocolProfile !== undefined && record.protocolProfile !== null
        && !['LEGACY_2024_11_05', 'LEGACY_2025_11_25', 'MODERN_2026_07_28'].includes(record.protocolProfile as string)) {
      return { ok: false, reason: 'unknown protocolProfile' };
    }
    if (typeof record.transport !== 'object' || record.transport === null) {
      return { ok: false, reason: 'transport config is required' };
    }
    // Hard stop on credential-like keys anywhere in the transport body —
    // the contract carries slot names, never material.
    const transportText = JSON.stringify(record.transport).toLowerCase();
    if (/"(secret|password|apikey|api_key|token|authorization)"\s*:/.test(transportText)) {
      return { ok: false, reason: 'transport must carry slot names, never credential material' };
    }
    return {
      ok: true,
      value: {
        displayName: record.displayName,
        scope: record.scope,
        projectId: typeof record.projectId === 'string' && record.projectId.trim().length > 0
          ? record.projectId : null,
        enabled: record.enabled !== false,
        protocolPolicy: (record.protocolPolicy as 'PIN' | 'AUTO' | undefined) ?? 'PIN',
        protocolProfile: typeof record.protocolProfile === 'string' ? record.protocolProfile : null,
        transport: record.transport as Record<string, unknown>,
        credentialRef: typeof record.credentialRef === 'string' && record.credentialRef.trim().length > 0
          ? record.credentialRef.slice(0, 128) : null,
        // WU08/WU09: the OAuth client id is registration data (public by
        // OAuth semantics), never a credential — bounded like other refs.
        oauthClientId: typeof record.oauthClientId === 'string' && record.oauthClientId.trim().length > 0
          ? record.oauthClientId.slice(0, 256) : null,
        templateRef: typeof record.templateRef === 'string' && record.templateRef.trim().length > 0
          ? record.templateRef.slice(0, 128) : null,
        templateVersion: typeof record.templateVersion === 'string' && record.templateVersion.trim().length > 0
          ? record.templateVersion.slice(0, 64) : null,
        policyRef: typeof record.policyRef === 'string' && record.policyRef.trim().length > 0
          ? record.policyRef.slice(0, 128) : null
      }
    };
  }
};

export const mcpServerStatusDefinition: IpcDefinition<{
  serverId: string;
  enabled: boolean;
  expectedRevision: number;
}> = {
  channel: IPC_CHANNELS.mcpServerStatus,
  validate: (payload) => {
    const serverId = requireId('mcpServerStatus', payload, 'serverId');
    if (!serverId.ok) return serverId;
    const record = payload as Record<string, unknown>;
    if (typeof record.enabled !== 'boolean') {
      return { ok: false, reason: 'enabled is required' };
    }
    if (typeof record.expectedRevision !== 'number' || !Number.isInteger(record.expectedRevision)
        || record.expectedRevision < 1) {
      return { ok: false, reason: 'expectedRevision must be a positive integer' };
    }
    return { ok: true, value: { serverId: serverId.value, enabled: record.enabled, expectedRevision: record.expectedRevision } };
  }
};

const MCP_CONNECTION_ACTIONS = ['CONNECT', 'TEST', 'DISCONNECT', 'RESTART', 'DIAGNOSE'] as const;
export type McpConnectionActionKind = (typeof MCP_CONNECTION_ACTIONS)[number];

export const mcpConnectionActionDefinition: IpcDefinition<{
  serverId: string;
  action: McpConnectionActionKind;
}> = {
  channel: IPC_CHANNELS.mcpConnectionAction,
  validate: (payload) => {
    const serverId = requireId('mcpConnectionAction', payload, 'serverId');
    if (!serverId.ok) return serverId;
    const record = payload as Record<string, unknown>;
    if (!(MCP_CONNECTION_ACTIONS as readonly string[]).includes(record.action as string)) {
      return { ok: false, reason: 'action must be CONNECT, TEST, DISCONNECT, RESTART or DIAGNOSE' };
    }
    return { ok: true, value: { serverId: serverId.value, action: record.action as McpConnectionActionKind } };
  }
};

export const mcpOperationGetDefinition: IpcDefinition<{ operationId: string }> = {
  channel: IPC_CHANNELS.mcpOperationGet,
  validate: (payload) => {
    const operationId = requireId('mcpOperationGet', payload, 'operationId');
    if (!operationId.ok) return operationId;
    return { ok: true, value: { operationId: operationId.value } };
  }
};

export const mcpToolsListDefinition: IpcDefinition<{ serverId: string; cursor: string | null; limit: number | null }> = {
  channel: IPC_CHANNELS.mcpToolsList,
  validate: (payload) => {
    const serverId = requireId('mcpToolsList', payload, 'serverId');
    if (!serverId.ok) return serverId;
    const record = payload as Record<string, unknown>;
    const cursor = typeof record.cursor === 'string' && record.cursor.trim().length > 0
      ? record.cursor.trim().slice(0, 256) : null;
    const limit = typeof record.limit === 'number' && Number.isInteger(record.limit)
        && record.limit >= 1 && record.limit <= 200
      ? record.limit : null;
    return { ok: true, value: { serverId: serverId.value, cursor, limit } };
  }
};

export const mcpCatalogRefreshDefinition: IpcDefinition<{ serverId: string }> = {
  channel: IPC_CHANNELS.mcpCatalogRefresh,
  validate: (payload) => {
    const serverId = requireId('mcpCatalogRefresh', payload, 'serverId');
    if (!serverId.ok) return serverId;
    return { ok: true, value: { serverId: serverId.value } };
  }
};

/**
 * Import-pick carries at most a displayName hint — the path itself comes
 * from the main-process directory dialog, never from the renderer.
 */
export const skillsGovernedDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.skillsGoverned
};

export const skillImportPickDefinition: IpcDefinition<{ displayName: string | null }> = {
  channel: IPC_CHANNELS.skillImportPick,
  validate: (payload) => {
    if (payload === undefined || payload === null) {
      return { ok: true, value: { displayName: null } };
    }
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const record = payload as Record<string, unknown>;
    if (record.rootHint !== undefined || record.path !== undefined || record.root !== undefined) {
      return { ok: false, reason: 'renderer-supplied paths are never accepted; use the picker' };
    }
    const displayName = typeof record.displayName === 'string' && record.displayName.trim().length > 0
      ? record.displayName.slice(0, 256) : null;
    return { ok: true, value: { displayName } };
  }
};

export const skillImportPreviewDefinition: IpcDefinition<{ sourceHandle: string }> = {
  channel: IPC_CHANNELS.skillImportPreview,
  validate: (payload) => {
    const record = payload as Record<string, unknown>;
    const handle = record?.sourceHandle;
    if (typeof handle !== 'string' || !/^src-[A-Za-z0-9_-]{1,64}$/.test(handle)) {
      return { ok: false, reason: 'sourceHandle must be an opaque src-* handle' };
    }
    return { ok: true, value: { sourceHandle: handle } };
  }
};

export const skillImportDefinition: IpcDefinition<{
  previewId: string;
  expectedSourceDigest: string;
  scope: 'USER' | 'PROJECT';
  projectAlias: string | null;
  name: string | null;
}> = {
  channel: IPC_CHANNELS.skillImport,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const record = payload as Record<string, unknown>;
    if (typeof record.previewId !== 'string' || !/^prev-[A-Za-z0-9_-]{1,64}$/.test(record.previewId)) {
      return { ok: false, reason: 'previewId must be an opaque prev-* handle' };
    }
    if (typeof record.expectedSourceDigest !== 'string'
        || !/^sha256:[0-9a-f]{64}$/.test(record.expectedSourceDigest)) {
      return { ok: false, reason: 'expectedSourceDigest must be a sha256: hex digest' };
    }
    if (record.scope !== 'USER' && record.scope !== 'PROJECT') {
      return { ok: false, reason: 'scope must be USER or PROJECT' };
    }
    return {
      ok: true,
      value: {
        previewId: record.previewId,
        expectedSourceDigest: record.expectedSourceDigest,
        scope: record.scope,
        projectAlias: typeof record.projectAlias === 'string' && record.projectAlias.trim().length > 0
          ? record.projectAlias.slice(0, 128) : null,
        name: typeof record.name === 'string' && record.name.trim().length > 0
          ? record.name.slice(0, 100) : null
      }
    };
  }
};

export const skillVersionsListDefinition: IpcDefinition<{ skillId: string }> = {
  channel: IPC_CHANNELS.skillVersionsList,
  validate: (payload) => {
    const skillId = requireId('skillVersionsList', payload, 'skillId');
    if (!skillId.ok) return skillId;
    return { ok: true, value: { skillId: skillId.value } };
  }
};

export const skillVersionSelectDefinition: IpcDefinition<{
  skillId: string;
  versionDigest: string;
  expectedRevision: number;
}> = {
  channel: IPC_CHANNELS.skillVersionSelect,
  validate: (payload) => {
    const skillId = requireId('skillVersionSelect', payload, 'skillId');
    if (!skillId.ok) return skillId;
    const record = payload as Record<string, unknown>;
    if (typeof record.versionDigest !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(record.versionDigest)) {
      return { ok: false, reason: 'versionDigest is invalid' };
    }
    if (typeof record.expectedRevision !== 'number' || !Number.isInteger(record.expectedRevision)
        || record.expectedRevision < 1) {
      return { ok: false, reason: 'expectedRevision must be a positive integer' };
    }
    return { ok: true, value: { skillId: skillId.value, versionDigest: record.versionDigest, expectedRevision: record.expectedRevision } };
  }
};

export const executionExtensionsDefinition: IpcDefinition<{ executionId: string }> = {
  channel: IPC_CHANNELS.executionExtensions,
  validate: (payload) => {
    const executionId = requireId('executionExtensions', payload, 'executionId');
    if (!executionId.ok) return executionId;
    return { ok: true, value: { executionId: executionId.value } };
  }
};

export const extensionInvocationsDefinition: IpcDefinition<{
  executionId: string; cursor: string | null; limit: number | null;
}> = {
  channel: IPC_CHANNELS.extensionInvocations,
  validate: (payload) => {
    const executionId = requireId('extensionInvocations', payload, 'executionId');
    if (!executionId.ok) return executionId;
    const record = payload as Record<string, unknown>;
    const cursor = typeof record.cursor === 'string' && record.cursor.trim().length > 0
      ? record.cursor.trim().slice(0, 256) : null;
    const limit = typeof record.limit === 'number' && Number.isInteger(record.limit)
        && record.limit >= 1 && record.limit <= 200
      ? record.limit : null;
    return { ok: true, value: { executionId: executionId.value, cursor, limit } };
  }
};

// ---- WU08 governed surface additions ----

export const mcpServerGetDefinition: IpcDefinition<{ serverId: string }> = {
  channel: IPC_CHANNELS.mcpServerGet,
  validate: (payload) => {
    const serverId = requireId('mcpServerGet', payload, 'serverId');
    if (!serverId.ok) return serverId;
    return { ok: true, value: { serverId: serverId.value } };
  }
};

/** PATCH is partial — every listed field optional except expectedRevision. */
export const mcpServerUpdateDefinition: IpcDefinition<{
  serverId: string;
  expectedRevision: number;
  displayName: string | null;
  enabled: boolean | null;
  protocolPolicy: 'PIN' | 'AUTO' | null;
  protocolProfile: string | null;
  transport: Record<string, unknown> | null;
  credentialRef: string | null;
  oauthClientId: string | null;
  policyRef: string | null;
}> = {
  channel: IPC_CHANNELS.mcpServerUpdate,
  validate: (payload) => {
    const serverId = requireId('mcpServerUpdate', payload, 'serverId');
    if (!serverId.ok) return serverId;
    const record = payload as Record<string, unknown>;
    if (typeof record.expectedRevision !== 'number' || !Number.isInteger(record.expectedRevision)
        || record.expectedRevision < 1) {
      return { ok: false, reason: 'expectedRevision must be a positive integer' };
    }
    if (record.protocolPolicy !== undefined && record.protocolPolicy !== null
        && record.protocolPolicy !== 'PIN' && record.protocolPolicy !== 'AUTO') {
      return { ok: false, reason: 'protocolPolicy must be PIN or AUTO' };
    }
    if (record.protocolProfile !== undefined && record.protocolProfile !== null
        && !['LEGACY_2024_11_05', 'LEGACY_2025_11_25', 'MODERN_2026_07_28'].includes(record.protocolProfile as string)) {
      return { ok: false, reason: 'unknown protocolProfile' };
    }
    if (record.transport !== undefined && record.transport !== null) {
      if (typeof record.transport !== 'object') {
        return { ok: false, reason: 'transport must be an object when present' };
      }
      // Same hard stop as create: slot names only, never credential material.
      const transportText = JSON.stringify(record.transport).toLowerCase();
      if (/"(secret|password|apikey|api_key|token|authorization)"\s*:/.test(transportText)) {
        return { ok: false, reason: 'transport must carry slot names, never credential material' };
      }
    }
    return {
      ok: true,
      value: {
        serverId: serverId.value,
        expectedRevision: record.expectedRevision,
        displayName: typeof record.displayName === 'string' && record.displayName.trim().length > 0
          ? record.displayName.slice(0, 128) : null,
        enabled: typeof record.enabled === 'boolean' ? record.enabled : null,
        protocolPolicy: (record.protocolPolicy as 'PIN' | 'AUTO' | null | undefined) ?? null,
        protocolProfile: typeof record.protocolProfile === 'string' ? record.protocolProfile : null,
        transport: (record.transport as Record<string, unknown> | null) ?? null,
        credentialRef: typeof record.credentialRef === 'string' && record.credentialRef.trim().length > 0
          ? record.credentialRef.slice(0, 128) : null,
        oauthClientId: typeof record.oauthClientId === 'string' && record.oauthClientId.trim().length > 0
          ? record.oauthClientId.slice(0, 256) : null,
        policyRef: typeof record.policyRef === 'string' && record.policyRef.trim().length > 0
          ? record.policyRef.slice(0, 128) : null
      }
    };
  }
};

const MCP_AUTH_ACTIONS = ['START', 'CANCEL', 'REVOKE'] as const;
export type McpAuthActionKind = (typeof MCP_AUTH_ACTIONS)[number];

export const mcpAuthActionDefinition: IpcDefinition<{
  serverId: string;
  action: McpAuthActionKind;
}> = {
  channel: IPC_CHANNELS.mcpAuthAction,
  validate: (payload) => {
    const serverId = requireId('mcpAuthAction', payload, 'serverId');
    if (!serverId.ok) return serverId;
    const record = payload as Record<string, unknown>;
    if (!(MCP_AUTH_ACTIONS as readonly string[]).includes(record.action as string)) {
      return { ok: false, reason: 'auth action must be START, CANCEL or REVOKE' };
    }
    return { ok: true, value: { serverId: serverId.value, action: record.action as McpAuthActionKind } };
  }
};

export const mcpPromptsListDefinition: IpcDefinition<{ serverId: string }> = {
  channel: IPC_CHANNELS.mcpPromptsList,
  validate: (payload) => {
    const serverId = requireId('mcpPromptsList', payload, 'serverId');
    if (!serverId.ok) return serverId;
    return { ok: true, value: { serverId: serverId.value } };
  }
};

export const mcpPromptResolveDefinition: IpcDefinition<{
  serverId: string;
  name: string;
  arguments_: { [key: string]: string } | null;
}> = {
  channel: IPC_CHANNELS.mcpPromptResolve,
  validate: (payload) => {
    const serverId = requireId('mcpPromptResolve', payload, 'serverId');
    if (!serverId.ok) return serverId;
    const record = payload as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 256) {
      return { ok: false, reason: 'prompt name is required and bounded to 256 characters' };
    }
    const args = record.arguments;
    if (args !== undefined && args !== null) {
      if (typeof args !== 'object' || Array.isArray(args)) {
        return { ok: false, reason: 'prompt arguments must be a string map' };
      }
      for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        if (typeof value !== 'string' || key.length > 128 || value.length > 8192) {
          return { ok: false, reason: 'prompt arguments must be bounded string values' };
        }
      }
    }
    return {
      ok: true,
      value: {
        serverId: serverId.value,
        name: name.trim(),
        arguments_: (args as { [key: string]: string } | null) ?? null
      }
    };
  }
};

export const mcpResourceTemplatesDefinition: IpcDefinition<{ serverId: string }> = {
  channel: IPC_CHANNELS.mcpResourceTemplates,
  validate: (payload) => {
    const serverId = requireId('mcpResourceTemplates', payload, 'serverId');
    if (!serverId.ok) return serverId;
    return { ok: true, value: { serverId: serverId.value } };
  }
};

// ---- WU01 (uplift design §5): Hub associations ----

export const hubConnectionsListDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.hubConnectionsList
};

const requireHubId = (payload: unknown) => requireId('hub', payload, 'hubConnectionId');

/** Registration: fixed base URL + credential slot name, never material. */
export const hubConnectionCreateDefinition: IpcDefinition<{
  displayName: string;
  baseUrl: string;
  credentialRef: string | null;
  scope: 'USER' | 'PROJECT';
  projectId: string | null;
  enabled: boolean;
  allowInsecureLoopback: boolean;
}> = {
  channel: IPC_CHANNELS.hubConnectionCreate,
  validate: (payload) => {
    const object = requireObjectPayload(payload);
    if (!object.ok) return object;
    const record = payload as Record<string, unknown>;
    if (typeof record.displayName !== 'string' || record.displayName.trim().length === 0
        || record.displayName.length > 120) {
      return { ok: false, reason: 'displayName is required and bounded to 120 characters' };
    }
    if (typeof record.baseUrl !== 'string' || record.baseUrl.trim().length === 0
        || record.baseUrl.length > 512) {
      return { ok: false, reason: 'baseUrl is required and bounded to 512 characters' };
    }
    if (record.scope !== undefined && record.scope !== 'USER' && record.scope !== 'PROJECT') {
      return { ok: false, reason: 'scope must be USER or PROJECT' };
    }
    return {
      ok: true,
      value: {
        displayName: record.displayName.trim(),
        baseUrl: record.baseUrl.trim(),
        credentialRef: typeof record.credentialRef === 'string' && record.credentialRef.trim().length > 0
          ? record.credentialRef.trim().slice(0, 128) : null,
        scope: (record.scope as 'USER' | 'PROJECT' | undefined) ?? 'USER',
        projectId: typeof record.projectId === 'string' && record.projectId.trim().length > 0
          ? record.projectId.trim() : null,
        enabled: record.enabled !== false,
        allowInsecureLoopback: record.allowInsecureLoopback === true
      }
    };
  }
};

export const hubConnectionGetDefinition: IpcDefinition<{ hubConnectionId: string }> = {
  channel: IPC_CHANNELS.hubConnectionGet,
  validate: (payload) => {
    const id = requireHubId(payload);
    if (!id.ok) return id;
    return { ok: true, value: { hubConnectionId: id.value } };
  }
};

export const hubConnectionUpdateDefinition: IpcDefinition<{
  hubConnectionId: string;
  displayName: string | null;
  credentialRef: string | null;
  allowInsecureLoopback: boolean | null;
  enabled: boolean | null;
  expectedRevision: number;
}> = {
  channel: IPC_CHANNELS.hubConnectionUpdate,
  validate: (payload) => {
    const id = requireHubId(payload);
    if (!id.ok) return id;
    const record = payload as Record<string, unknown>;
    if (typeof record.expectedRevision !== 'number' || !Number.isInteger(record.expectedRevision)
        || record.expectedRevision < 1) {
      return { ok: false, reason: 'expectedRevision must be a positive integer' };
    }
    if (record.displayName !== undefined && record.displayName !== null
        && (typeof record.displayName !== 'string' || record.displayName.trim().length === 0
            || record.displayName.length > 120)) {
      return { ok: false, reason: 'displayName must be a non-empty string up to 120 characters' };
    }
    return {
      ok: true,
      value: {
        hubConnectionId: id.value,
        displayName: typeof record.displayName === 'string' ? record.displayName.trim() : null,
        credentialRef: typeof record.credentialRef === 'string' && record.credentialRef.trim().length > 0
          ? record.credentialRef.trim().slice(0, 128) : null,
        allowInsecureLoopback: typeof record.allowInsecureLoopback === 'boolean'
          ? record.allowInsecureLoopback : null,
        enabled: typeof record.enabled === 'boolean' ? record.enabled : null,
        expectedRevision: record.expectedRevision
      }
    };
  }
};

const HUB_CONNECTION_ACTIONS = ['CONNECT', 'TEST', 'DISCONNECT', 'DIAGNOSE'] as const;
export type HubConnectionActionKind = (typeof HUB_CONNECTION_ACTIONS)[number];

export const hubConnectionActionDefinition: IpcDefinition<{
  hubConnectionId: string;
  action: HubConnectionActionKind;
}> = {
  channel: IPC_CHANNELS.hubConnectionAction,
  validate: (payload) => {
    const id = requireHubId(payload);
    if (!id.ok) return id;
    const record = payload as Record<string, unknown>;
    if (!(HUB_CONNECTION_ACTIONS as readonly string[]).includes(record.action as string)) {
      return { ok: false, reason: 'action must be CONNECT, TEST, DISCONNECT or DIAGNOSE' };
    }
    return { ok: true, value: { hubConnectionId: id.value, action: record.action as HubConnectionActionKind } };
  }
};

export const hubRegisterServerDefinition: IpcDefinition<{ hubConnectionId: string }> = {
  channel: IPC_CHANNELS.hubRegisterServer,
  validate: (payload) => {
    const id = requireHubId(payload);
    if (!id.ok) return id;
    return { ok: true, value: { hubConnectionId: id.value } };
  }
};

export const hubCapabilitiesDefinition: IpcDefinition<{ hubConnectionId: string }> = {
  channel: IPC_CHANNELS.hubCapabilities,
  validate: (payload) => {
    const id = requireHubId(payload);
    if (!id.ok) return id;
    return { ok: true, value: { hubConnectionId: id.value } };
  }
};

// ---- W3 resource sessions (hub /api/v2/resources*) ----

export const hubResourcesDefinition: IpcDefinition<{ hubConnectionId: string }> = {
  channel: IPC_CHANNELS.hubResources,
  validate: (payload) => {
    const id = requireHubId(payload);
    if (!id.ok) return id;
    return { ok: true, value: { hubConnectionId: id.value } };
  }
};

export const hubSessionsListDefinition: IpcDefinition<{ hubConnectionId: string }> = {
  channel: IPC_CHANNELS.hubSessionsList,
  validate: (payload) => {
    const id = requireHubId(payload);
    if (!id.ok) return id;
    return { ok: true, value: { hubConnectionId: id.value } };
  }
};

const HUB_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const HUB_SESSION_MODES = ['managed', 'attached'] as const;
const HUB_SESSION_ACTIONS = ['pause', 'resume', 'handover', 'estop', 'release', 'renew'] as const;
export type HubSessionControlActionKind = (typeof HUB_SESSION_ACTIONS)[number];

export const hubSessionAcquireDefinition: IpcDefinition<{
  hubConnectionId: string;
  resourceKey: string;
  mode: string;
  controller: string;
  ttlSeconds: number | null;
}> = {
  channel: IPC_CHANNELS.hubSessionAcquire,
  validate: (payload) => {
    const id = requireHubId(payload);
    if (!id.ok) return id;
    const record = payload as Record<string, unknown>;
    const resourceKey = typeof record.resourceKey === 'string' ? record.resourceKey.trim() : '';
    if (resourceKey.length === 0 || resourceKey.length > 256 || !/^[\w:./-]+$/.test(resourceKey)) {
      return { ok: false, reason: 'resourceKey is required (1-256 of [word : . / -])' };
    }
    const mode = typeof record.mode === 'string' ? record.mode : 'managed';
    if (!(HUB_SESSION_MODES as readonly string[]).includes(mode)) {
      return { ok: false, reason: 'mode must be managed or attached' };
    }
    const controller = typeof record.controller === 'string' && record.controller.trim().length > 0
      ? record.controller.trim().slice(0, 120) : 'desktop';
    const ttl = typeof record.ttlSeconds === 'number' && Number.isFinite(record.ttlSeconds)
      ? Math.max(1, Math.min(3600, Math.floor(record.ttlSeconds))) : null;
    return { ok: true, value: { hubConnectionId: id.value, resourceKey, mode, controller, ttlSeconds: ttl } };
  }
};

export const hubSessionControlDefinition: IpcDefinition<{
  hubConnectionId: string;
  sessionId: string;
  action: HubSessionControlActionKind;
  controller: string | null;
  expectedEpoch: number | null;
}> = {
  channel: IPC_CHANNELS.hubSessionControl,
  validate: (payload) => {
    const id = requireHubId(payload);
    if (!id.ok) return id;
    const record = payload as Record<string, unknown>;
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
    if (!HUB_SESSION_ID.test(sessionId)) {
      return { ok: false, reason: 'sessionId is invalid' };
    }
    if (!(HUB_SESSION_ACTIONS as readonly string[]).includes(record.action as string)) {
      return { ok: false, reason: 'action must be pause|resume|handover|estop|release|renew' };
    }
    const controller = typeof record.controller === 'string' && record.controller.trim().length > 0
      ? record.controller.trim().slice(0, 120) : null;
    const expectedEpoch = typeof record.expectedEpoch === 'number' && Number.isFinite(record.expectedEpoch)
      ? Math.floor(record.expectedEpoch) : null;
    return { ok: true, value: { hubConnectionId: id.value, sessionId,
      action: record.action as HubSessionControlActionKind, controller, expectedEpoch } };
  }
};

const EXTENSION_INVOCATION_ACTIONS = ['CANCEL', 'RESUME_INPUT', 'RECONCILE'] as const;
export type ExtensionInvocationActionKind = (typeof EXTENSION_INVOCATION_ACTIONS)[number];

export const extensionInvocationActionDefinition: IpcDefinition<{
  executionId: string;
  invocationId: string;
  action: ExtensionInvocationActionKind;
  input: { [key: string]: unknown } | null;
}> = {
  channel: IPC_CHANNELS.extensionInvocationAction,
  validate: (payload) => {
    const executionId = requireId('extensionInvocationAction', payload, 'executionId');
    if (!executionId.ok) return executionId;
    const record = payload as Record<string, unknown>;
    const invocationId = record.invocationId;
    if (typeof invocationId !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/.test(invocationId)) {
      return { ok: false, reason: 'invocationId is invalid' };
    }
    if (!(EXTENSION_INVOCATION_ACTIONS as readonly string[]).includes(record.action as string)) {
      return { ok: false, reason: 'action must be CANCEL, RESUME_INPUT or RECONCILE' };
    }
    // RESUME_INPUT answers are plain JSON objects, bounded — they travel to
    // the remote server verbatim inside the same governed invocation.
    const input = record.input;
    if (input !== undefined && input !== null) {
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, reason: 'input must be an object when present' };
      }
      if (JSON.stringify(input).length > 64 * 1024) {
        return { ok: false, reason: 'input exceeds 64 KiB' };
      }
    }
    return {
      ok: true,
      value: {
        executionId: executionId.value,
        invocationId,
        action: record.action as ExtensionInvocationActionKind,
        input: (input as { [key: string]: unknown } | null) ?? null
      }
    };
  }
};

/** Exactly one server entry with exactly one toolId — service-side enforces. */
export const extensionTestExecutionDefinition: IpcDefinition<{
  sessionId: string | null;
  serverId: string;
  toolId: string;
  arguments_: { [key: string]: unknown } | null;
}> = {
  channel: IPC_CHANNELS.extensionTestExecution,
  validate: (payload) => {
    const serverId = requireId('extensionTestExecution', payload, 'serverId');
    if (!serverId.ok) return serverId;
    const record = payload as Record<string, unknown>;
    const toolId = record.toolId;
    if (typeof toolId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(toolId)) {
      return { ok: false, reason: 'toolId is invalid' };
    }
    const args = record.arguments;
    if (args !== undefined && args !== null) {
      if (typeof args !== 'object' || Array.isArray(args)) {
        return { ok: false, reason: 'arguments must be an object when present' };
      }
      if (JSON.stringify(args).length > 64 * 1024) {
        return { ok: false, reason: 'arguments exceed 64 KiB' };
      }
    }
    return {
      ok: true,
      value: {
        sessionId: typeof record.sessionId === 'string' && record.sessionId.trim().length > 0
          ? record.sessionId.trim().slice(0, 128) : null,
        serverId: serverId.value,
        toolId,
        arguments_: (args as { [key: string]: unknown } | null) ?? null
      }
    };
  }
};

export const skillManifestDefinition: IpcDefinition<{ skillId: string; versionDigest: string }> = {
  channel: IPC_CHANNELS.skillManifest,
  validate: (payload) => {
    const skillId = requireId('skillManifest', payload, 'skillId');
    if (!skillId.ok) return skillId;
    const record = payload as Record<string, unknown>;
    const versionDigest = record.versionDigest;
    if (typeof versionDigest !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(versionDigest)) {
      return { ok: false, reason: 'versionDigest is invalid' };
    }
    return { ok: true, value: { skillId: skillId.value, versionDigest } };
  }
};

// ---- environment feature surface (settings design) ----

const ENVIRONMENT_FEATURE_IDS = new Set(['SANDBOX', 'WEBSEARCH', 'TERMINAL', 'MCP', 'SKILLS', 'MODEL', 'BUILD_VERIFICATION', 'EXECUTION_EVIDENCE', 'EXECUTION_INSPECT']);
const MANAGED_MODEL_ID = /^[A-Za-z0-9._:\/-]{1,128}$/;

function requireFeatureId(schema: string, payload: unknown): IpcValidationResult<string> {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'payload must be an object' };
  }
  const value = (payload as Record<string, unknown>).featureId;
  if (typeof value !== 'string'
      || !ENVIRONMENT_FEATURE_IDS.has(value.trim().toUpperCase())) {
    return { ok: false, reason: `${schema}: featureId is invalid` };
  }
  return { ok: true, value: value.trim().toUpperCase() };
}

/** Model ids allow ':' (tagged slugs) but never '/' — they occupy a path segment. */
function requireModelId(schema: string, payload: unknown, field: string): IpcValidationResult<string> {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'payload must be an object' };
  }
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !MANAGED_MODEL_ID.test(value)) {
    return { ok: false, reason: `${schema}: ${field} is invalid` };
  }
  return { ok: true, value };
}

function optionalExpectedRevision(object: Record<string, unknown>): IpcValidationResult<number | undefined> {
  const value = object.expectedRevision;
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { ok: false, reason: 'expectedRevision must be a non-negative integer' };
  }
  return { ok: true, value };
}

/** Bounded string array — the unsetFields explicit-clear contract. */
function boundedStringArray(value: unknown, field: string): IpcValidationResult<undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!Array.isArray(value) || value.length > 64
      || value.some((entry) => typeof entry !== 'string' || entry.length > 128)) {
    return { ok: false, reason: `${field} must be a bounded string array` };
  }
  return { ok: true, value: undefined };
}

/**
 * Default-model replacement ref for deletes (settings design S05):
 * providerId:modelKey or a bare model key.
 */
function optionalReplaceDefault(object: Record<string, unknown>): IpcValidationResult<string | undefined> {
  const value = object.replaceDefault;
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.length > 256
      || !/^[A-Za-z0-9._:\/-]+$/.test(value)) {
    return { ok: false, reason: 'replaceDefault must name a catalog model' };
  }
  return { ok: true, value: value.trim() };
}

export const environmentFeaturesDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.environmentFeatures
};

export const environmentFeatureUpdateDefinition: IpcDefinition<{
  featureId: string;
  enabled: boolean | null;
  entries?: Record<string, string | null>;
  expectedRevision?: number;
}> = {
  channel: IPC_CHANNELS.environmentFeatureUpdate,
  validate: (payload) => {
    const featureId = requireFeatureId('environmentFeatureUpdate', payload);
    if (!featureId.ok) return featureId;
    const object = (payload as Record<string, unknown>);
    const enabled = object.enabled;
    if (enabled !== undefined && enabled !== null && typeof enabled !== 'boolean') {
      return { ok: false, reason: 'enabled must be a boolean when present' };
    }
    const revision = optionalExpectedRevision(object);
    if (!revision.ok) return revision;
    const entries = object.entries;
    // Absent entries must stay absent: the service treats "field missing"
    // as keep-stored-values, and fabricating {} here would wipe them.
    let normalized: Record<string, string | null> | undefined;
    if (entries !== undefined && entries !== null) {
      normalized = {};
      if (typeof entries !== 'object' || Array.isArray(entries)) {
        return { ok: false, reason: 'entries must be an object' };
      }
      const keys = Object.keys(entries as Record<string, unknown>);
      if (keys.length > 32) return { ok: false, reason: 'too many entries' };
      for (const key of keys) {
        if (key.length > 128 || !/^[A-Za-z0-9._-]+$/.test(key)) {
          return { ok: false, reason: 'entry key is invalid' };
        }
        const raw = (entries as Record<string, unknown>)[key];
        if (raw !== null && typeof raw !== 'string') {
          return { ok: false, reason: 'entry values must be strings or null' };
        }
        if (typeof raw === 'string' && raw.length > 1024) {
          return { ok: false, reason: 'entry value is too long' };
        }
        normalized[key] = raw as string | null;
      }
    }
    return {
      ok: true,
      value: {
        featureId: featureId.value,
        enabled: typeof enabled === 'boolean' ? enabled : null,
        entries: normalized,
        expectedRevision: revision.value
      }
    };
  }
};

export const environmentFeaturePreflightDefinition: IpcDefinition<{ featureId: string }> = {
  channel: IPC_CHANNELS.environmentFeaturePreflight,
  validate: (payload) => {
    const featureId = requireFeatureId('environmentFeaturePreflight', payload);
    if (!featureId.ok) return featureId;
    return { ok: true, value: { featureId: featureId.value } };
  }
};

export const modelProvidersDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.modelProviders
};

export const modelProviderRemoteModelsDefinition: IpcDefinition<{
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.modelProviderRemoteModels,
  validate: (payload) => {
    const object = (payload as Record<string, unknown>);
    const body = object.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, reason: 'body must be an object' };
    }
    return { ok: true, value: { body: body as Record<string, unknown> } };
  }
};

export const modelProviderUpsertDefinition: IpcDefinition<{
  providerId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.modelProviderUpsert,
  validate: (payload) => {
    const providerId = requireId('modelProviderUpsert', payload, 'providerId');
    if (!providerId.ok) return providerId;
    const object = (payload as Record<string, unknown>);
    const body = object.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, reason: 'body must be an object' };
    }
    const record = body as Record<string, unknown>;
    // The service validates semantics; main enforces shape + bounded strings.
    // apiKey is write-only secret material — bounded here, never logged.
    for (const key of ['dialect', 'baseUrl', 'credentialKind', 'credentialEnvName', 'displayName', 'apiKey', 'apiVersion', 'betaHeaders']) {
      const value = record[key];
      if (value !== undefined && value !== null
          && (typeof value !== 'string' || value.length > 1024)) {
        return { ok: false, reason: `${key} must be a bounded string` };
      }
    }
    const unsetCheck = boundedStringArray(record.unsetFields, 'unsetFields');
    if (!unsetCheck.ok) return unsetCheck;
    if (record.enabled !== undefined && record.enabled !== null
        && typeof record.enabled !== 'boolean') {
      return { ok: false, reason: 'enabled must be a boolean when present' };
    }
    if (record.expectedRevision !== undefined && record.expectedRevision !== null
        && (typeof record.expectedRevision !== 'number'
            || !Number.isInteger(record.expectedRevision))) {
      return { ok: false, reason: 'expectedRevision must be an integer' };
    }
    return { ok: true, value: { providerId: providerId.value, body: record } };
  }
};

export const modelProviderDeleteDefinition: IpcDefinition<{
  providerId: string;
  expectedRevision?: number;
  replaceDefault?: string;
}> = {
  channel: IPC_CHANNELS.modelProviderDelete,
  validate: (payload) => {
    const providerId = requireId('modelProviderDelete', payload, 'providerId');
    if (!providerId.ok) return providerId;
    const revision = optionalExpectedRevision(payload as Record<string, unknown>);
    if (!revision.ok) return revision;
    const replaceDefault = optionalReplaceDefault(payload as Record<string, unknown>);
    if (!replaceDefault.ok) return replaceDefault;
    return { ok: true, value: {
      providerId: providerId.value, expectedRevision: revision.value,
      replaceDefault: replaceDefault.value } };
  }
};

export const modelProviderModelUpsertDefinition: IpcDefinition<{
  providerId: string;
  modelId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.modelProviderModelUpsert,
  validate: (payload) => {
    const providerId = requireId('modelProviderModelUpsert', payload, 'providerId');
    if (!providerId.ok) return providerId;
    const modelId = requireModelId('modelProviderModelUpsert', payload, 'modelId');
    if (!modelId.ok) return modelId;
    const body = (payload as Record<string, unknown>).body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, reason: 'body must be an object' };
    }
    const record = body as Record<string, unknown>;
    for (const key of ['displayName', 'remoteModelId', 'thinkingMode',
        'costTier', 'latencyTier', 'qualityTier',
        'imageInputProfile', 'cacheTtls']) {
      const value = record[key];
      if (value !== undefined && value !== null
          && (typeof value !== 'string' || value.length > 256)) {
        return { ok: false, reason: `${key} must be a bounded string` };
      }
    }
    for (const key of ['capabilities', 'reasoningEfforts']) {
      const value = record[key];
      if (value !== undefined && value !== null) {
        if (!Array.isArray(value) || value.length > 64
            || value.some((entry) => typeof entry !== 'string' || entry.length > 128)) {
          return { ok: false, reason: `${key} must be a bounded string array` };
        }
      }
    }
    const unsetCheck = boundedStringArray(record.unsetFields, 'unsetFields');
    if (!unsetCheck.ok) return unsetCheck;
    if (record.reasoningWire !== undefined && record.reasoningWire !== null
        && (typeof record.reasoningWire !== 'object' || Array.isArray(record.reasoningWire))) {
      return { ok: false, reason: 'reasoningWire must be an object' };
    }
    for (const key of ['contextWindowTokens', 'maxOutputTokens', 'expectedRevision']) {
      const value = record[key];
      if (value !== undefined && value !== null
          && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
        return { ok: false, reason: `${key} must be a non-negative integer` };
      }
    }
    if (record.enabled !== undefined && record.enabled !== null
        && typeof record.enabled !== 'boolean') {
      return { ok: false, reason: 'enabled must be a boolean when present' };
    }
    return {
      ok: true,
      value: { providerId: providerId.value, modelId: modelId.value, body: record }
    };
  }
};

export const modelProviderModelDeleteDefinition: IpcDefinition<{
  providerId: string;
  modelId: string;
  expectedRevision?: number;
  replaceDefault?: string;
}> = {
  channel: IPC_CHANNELS.modelProviderModelDelete,
  validate: (payload) => {
    const providerId = requireId('modelProviderModelDelete', payload, 'providerId');
    if (!providerId.ok) return providerId;
    const modelId = requireModelId('modelProviderModelDelete', payload, 'modelId');
    if (!modelId.ok) return modelId;
    const revision = optionalExpectedRevision(payload as Record<string, unknown>);
    if (!revision.ok) return revision;
    const replaceDefault = optionalReplaceDefault(payload as Record<string, unknown>);
    if (!replaceDefault.ok) return replaceDefault;
    return {
      ok: true,
      value: {
        providerId: providerId.value, modelId: modelId.value,
        expectedRevision: revision.value, replaceDefault: replaceDefault.value }
    };
  }
};

export const webSearchProvidersDefinition: IpcDefinition<Record<string, never>> = {
  ...noPayloadValidation,
  channel: IPC_CHANNELS.webSearchProviders
};

export const webSearchProviderUpsertDefinition: IpcDefinition<{
  providerId: string;
  body: Record<string, unknown>;
}> = {
  channel: IPC_CHANNELS.webSearchProviderUpsert,
  validate: (payload) => {
    const providerId = requireId('webSearchProviderUpsert', payload, 'providerId');
    if (!providerId.ok) return providerId;
    const body = (payload as Record<string, unknown>).body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, reason: 'body must be an object' };
    }
    const record = body as Record<string, unknown>;
    // The service validates semantics; main enforces shape + bounded
    // strings. apiKey is write-only secret material — bounded here,
    // never logged.
    for (const key of ['providerKind', 'displayName', 'credentialKind',
        'credentialEnvName', 'apiKey']) {
      const value = record[key];
      if (value !== undefined && value !== null
          && (typeof value !== 'string' || value.length > 1024)) {
        return { ok: false, reason: `${key} must be a bounded string` };
      }
    }
    const unsetCheck = boundedStringArray(record.unsetFields, 'unsetFields');
    if (!unsetCheck.ok) return unsetCheck;
    if (record.entries !== undefined && record.entries !== null) {
      if (typeof record.entries !== 'object' || Array.isArray(record.entries)) {
        return { ok: false, reason: 'entries must be an object' };
      }
      const entries = record.entries as Record<string, unknown>;
      if (Object.keys(entries).length > 64) {
        return { ok: false, reason: 'too many entries' };
      }
      for (const key of Object.keys(entries)) {
        if (key.length > 128) {
          return { ok: false, reason: 'entry key is too long' };
        }
        const raw = entries[key];
        if (raw !== null && typeof raw !== 'string') {
          return { ok: false, reason: 'entry values must be strings or null' };
        }
        if (typeof raw === 'string' && raw.length > 1024) {
          return { ok: false, reason: 'entry value is too long' };
        }
      }
    }
    if (record.enabled !== undefined && record.enabled !== null
        && typeof record.enabled !== 'boolean') {
      return { ok: false, reason: 'enabled must be a boolean when present' };
    }
    if (record.expectedRevision !== undefined && record.expectedRevision !== null
        && (typeof record.expectedRevision !== 'number'
            || !Number.isInteger(record.expectedRevision))) {
      return { ok: false, reason: 'expectedRevision must be an integer' };
    }
    return { ok: true, value: { providerId: providerId.value, body: record } };
  }
};

export const webSearchProviderDeleteDefinition: IpcDefinition<{
  providerId: string;
  expectedRevision?: number;
}> = {
  channel: IPC_CHANNELS.webSearchProviderDelete,
  validate: (payload) => {
    const providerId = requireId('webSearchProviderDelete', payload, 'providerId');
    if (!providerId.ok) return providerId;
    const revision = optionalExpectedRevision(payload as Record<string, unknown>);
    if (!revision.ok) return revision;
    return { ok: true, value: {
      providerId: providerId.value, expectedRevision: revision.value } };
  }
};

type AnyDefinition = IpcDefinition<unknown>;

export class IpcRegistry {
  private readonly definitions = new Map<string, AnyDefinition>();

  register<T>(definition: IpcDefinition<T>): void {
    if (this.definitions.has(definition.channel)) {
      throw new Error(`channel already registered: ${definition.channel}`);
    }
    this.definitions.set(definition.channel, definition as AnyDefinition);
  }

  has(channel: string): boolean {
    return this.definitions.has(channel);
  }

  channels(): string[] {
    return Array.from(this.definitions.keys());
  }

  /**
   * Full admission check: sender origin, channel allowlist, payload bounds
   * and schema. Returns the validated payload or a public-safe rejection.
   * The value is intentionally widened to any here: each definition owns
   * its typed validate(); handlers destructure the admitted value directly.
   */
  admit(channel: string, senderUrl: string | undefined, payload: unknown): IpcValidationResult<any> {
    if (!isTrustedSender(senderUrl)) {
      return { ok: false, reason: 'untrusted sender' };
    }
    const definition = this.definitions.get(channel);
    if (!definition) {
      return { ok: false, reason: 'unknown channel' };
    }
    if (typeof payload === 'string' && payload.length > MAX_IPC_PAYLOAD_CHARS) {
      return { ok: false, reason: 'payload exceeds size limit' };
    }
    return definition.validate(payload);
  }
}

/** Shared result type used by handlers that answer with a bootstrap view. */
export type BootstrapLikeResult = DesktopBootstrap;
