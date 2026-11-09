/**
 * Main-process personal-access session (`client-access/1`, UCA-001 C4).
 *
 * Trusted connection setup lives here, not in the renderer: the binding
 * (origin, base path, optional pinned CA) is non-secret configuration, the
 * bearer token is write-only through `CONFIGURE` and stored encrypted via the
 * OS secret store when available. Pending intentions are durable on disk so a
 * restart resumes the original lookup instead of re-posting the message.
 *
 * This session is deliberately independent of the local Service connection:
 * a personal access server is a different endpoint with its own authorization,
 * and losing the Service must not silently repoint the user's conversations.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  AccessError,
  ClientAccess,
  type AgentList,
  type ConversationPage,
  type ConversationView,
  type Manifest,
  type Receipt,
  type ReplyContent,
  type ReplyPage
} from '../../../packages/client-access/src/index';
import {
  validBasePath,
  validPersonalAccessOrigin,
  type PersonalAccessOperation
} from '../../../packages/client-access/src/operations';
import type { SecretStore } from '../bootstrap/secureConfig';
import type { PersonalAccessStatus } from '../../../packages/client-access/src/status';
import { FilePendingStore } from './pendingStore';
import { createCaPinnedFetch } from './httpsFetch';

export interface PersonalAccessConfig {
  origin: string;
  basePath: string;
  caPemPath?: string;
}

export type { PersonalAccessStatus };

export interface PersonalAccessSessionOptions {
  /** profile user-data directory; personal-access state lives below it */
  directory: string;
  /** stable device/principal identity from the profile manifest */
  connectionId: string;
  secretStore: SecretStore;
  /** test seam; defaults to the platform fetch */
  fetchImpl?: typeof globalThis.fetch;
}

const CONFIG_FILE = 'personal-access.json';
const TOKEN_FILE = 'personal-access-token.enc';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;

export class PersonalAccessSession {
  private readonly directory: string;
  private readonly connectionId: string;
  private readonly secretStore: SecretStore;
  private readonly fetchImpl: typeof globalThis.fetch;
  private instance: ClientAccess | undefined;
  private connected = false;
  private memoryToken: string | undefined;
  private tokenPersisted = false;
  private config: PersonalAccessConfig | undefined;

  constructor(options: PersonalAccessSessionOptions) {
    this.directory = options.directory;
    this.connectionId = options.connectionId;
    this.secretStore = options.secretStore;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.config = this.loadConfig();
    const token = this.loadToken();
    this.memoryToken = token ?? undefined;
    this.tokenPersisted = token !== null && fs.existsSync(this.tokenPath());
  }

  /** Executes one admitted bounded operation. */
  async execute(operation: PersonalAccessOperation): Promise<unknown> {
    switch (operation.action) {
      case 'STATUS':
        return this.status();
      case 'CONFIGURE':
        return this.configure(operation);
      case 'CONNECT':
        return this.connect();
      case 'DISCONNECT':
        this.disconnect();
        return this.status();
      case 'AGENTS':
        return this.requireClient().agents();
      case 'CONVERSATIONS':
        return this.requireClient().conversations(operation.agentRef);
      case 'CONVERSATION':
        return this.requireClient().conversation(operation.conversationRef);
      case 'REPLIES':
        return this.requireClient().replies(operation.conversationRef, {
          cursor: operation.cursor, ifRevision: operation.ifRevision
        });
      case 'CONTENT':
        return this.requireClient().content(operation.conversationRef, operation.replyRef, operation.cursor);
      case 'SEND':
        return this.send(operation.conversationRef, operation.text, operation.requestId);
      case 'ACTION':
        return this.action(operation.conversationRef, operation.actionId, operation.input, operation.requestId);
      case 'LOOKUP':
        return this.requireClient().lookup(operation.requestId);
      default:
        throw new AccessError('INVALID_REQUEST');
    }
  }

  status(): PersonalAccessStatus {
    const manifest = this.connected ? this.instance?.manifest : undefined;
    return {
      configured: this.config !== undefined,
      connected: this.connected && manifest !== undefined,
      ...(this.config ? { origin: this.config.origin, basePath: this.config.basePath } : {}),
      caPinned: this.config?.caPemPath !== undefined,
      encryptionAvailable: this.secretStore.isEncryptionAvailable(),
      tokenPersisted: this.tokenPersisted,
      hasToken: this.memoryToken !== undefined,
      ...(manifest ? {
        manifest: {
          protocolVersion: manifest.protocolVersion,
          storeId: manifest.storeId,
          authorizationRevision: typeof manifest.authorizationRevision === 'string'
            ? manifest.authorizationRevision : null,
          features: {
            conversationCreate: manifest.features?.conversationCreate === true,
            replyContent: manifest.features?.replyContent === true
          }
        }
      } : {})
    };
  }

  configure(operation: Extract<PersonalAccessOperation, { action: 'CONFIGURE' }>): PersonalAccessStatus {
    if (!validPersonalAccessOrigin(operation.origin)) throw new AccessError('UNTRUSTED_ORIGIN');
    const basePath = operation.basePath ?? '';
    if (!validBasePath(basePath)) throw new AccessError('INVALID_CONNECTION_BINDING');
    let caPemPath: string | undefined;
    if (operation.caPemPath !== undefined) {
      const resolved = path.resolve(operation.caPemPath);
      let pem: string;
      try {
        pem = fs.readFileSync(resolved, 'utf8');
      } catch {
        throw new AccessError('CA_UNREADABLE');
      }
      if (!pem.includes('BEGIN CERTIFICATE')) throw new AccessError('CA_UNREADABLE');
      caPemPath = resolved;
    }
    // A plain-http loopback binding cannot use a pinned CA; keep the file name
    // only when it can actually be applied so STATUS never overstates trust.
    if (caPemPath && !operation.origin.startsWith('https:')) caPemPath = undefined;

    this.resetInstance();
    this.config = {
      origin: operation.origin,
      basePath: basePath.replace(/\/$/, ''),
      ...(caPemPath ? { caPemPath } : {})
    };
    this.saveConfig(this.config);
    if (operation.token !== undefined) this.storeToken(operation.token);
    return this.status();
  }

  async connect(): Promise<PersonalAccessStatus> {
    const client = this.requireClient();
    try {
      await client.connect();
    } catch (error) {
      this.connected = false;
      throw error;
    }
    this.connected = true;
    return this.status();
  }

  disconnect(): void {
    this.instance?.disconnect();
    this.resetInstance();
  }

  private async send(conversationRef: string, text: string, requestId: string): Promise<Receipt> {
    const client = this.requireClient();
    // Binding resolution stays in main: the renderer never forges a message
    // binding, and the port still validates the descriptor's availability.
    const view = await client.conversation(conversationRef);
    return await client.send(view, text, requestId);
  }

  private async action(
    conversationRef: string,
    actionId: string,
    input: Record<string, unknown>,
    requestId: string
  ): Promise<Receipt> {
    const client = this.requireClient();
    const view = await client.conversation(conversationRef);
    const descriptor = view.actions?.find((candidate) => candidate.actionId === actionId);
    if (!descriptor) throw new AccessError('CAPABILITY_UNAVAILABLE');
    return await client.action(view, descriptor, input, requestId);
  }

  private requireClient(): ClientAccess {
    if (!this.config) throw new AccessError('NOT_CONFIGURED');
    if (!this.instance) {
      this.instance = new ClientAccess({
        origin: this.config.origin,
        basePath: this.config.basePath,
        authorization: this.memoryToken ? `Bearer ${this.memoryToken}` : undefined,
        connectionId: this.connectionId,
        pending: new FilePendingStore(path.join(this.directory, 'pending')),
        fetch: this.buildFetch(this.config)
      });
    }
    return this.instance;
  }

  private buildFetch(config: PersonalAccessConfig): typeof globalThis.fetch {
    if (config.caPemPath && config.origin.startsWith('https:')) {
      try {
        return createCaPinnedFetch(fs.readFileSync(config.caPemPath, 'utf8'));
      } catch {
        // Fail closed: an unreadable CA must not degrade to system trust.
        throw new AccessError('CA_UNREADABLE');
      }
    }
    return this.fetchImpl;
  }

  private resetInstance(): void {
    this.instance?.disconnect();
    this.instance = undefined;
    this.connected = false;
  }

  private storeToken(token: string): void {
    this.memoryToken = token;
    if (!this.secretStore.isEncryptionAvailable()) {
      this.tokenPersisted = false;
      return;
    }
    const encrypted = this.secretStore.encrypt(token);
    if (encrypted === null) {
      this.tokenPersisted = false;
      return;
    }
    fs.mkdirSync(this.directory, { recursive: true });
    atomicWrite(this.tokenPath(), encrypted);
    this.tokenPersisted = true;
  }

  private loadToken(): string | null {
    try {
      if (!fs.existsSync(this.tokenPath())) return null;
      const encrypted = fs.readFileSync(this.tokenPath());
      if (encrypted.length > MAX_TOKEN_BYTES) return null;
      return this.secretStore.decrypt(encrypted);
    } catch {
      return null;
    }
  }

  private configPath(): string { return path.join(this.directory, CONFIG_FILE); }
  private tokenPath(): string { return path.join(this.directory, TOKEN_FILE); }

  private loadConfig(): PersonalAccessConfig | undefined {
    try {
      if (!fs.existsSync(this.configPath())) return undefined;
      if (fs.statSync(this.configPath()).size > MAX_CONFIG_BYTES) return undefined;
      const parsed = JSON.parse(fs.readFileSync(this.configPath(), 'utf8')) as Record<string, unknown>;
      if (!validPersonalAccessOrigin(parsed.origin)) return undefined;
      const basePath = typeof parsed.basePath === 'string' && validBasePath(parsed.basePath) ? parsed.basePath : '';
      const caPemPath = typeof parsed.caPemPath === 'string' && parsed.caPemPath.length <= 1024
        ? parsed.caPemPath : undefined;
      return { origin: parsed.origin, basePath, ...(caPemPath ? { caPemPath } : {}) };
    } catch {
      return undefined;
    }
  }

  private saveConfig(config: PersonalAccessConfig): void {
    const serialized = JSON.stringify(config, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES) throw new Error('personal-access config too large');
    fs.mkdirSync(this.directory, { recursive: true });
    atomicWrite(this.configPath(), serialized);
  }
}

function atomicWrite(target: string, content: string | Buffer): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle: number | undefined;
  try {
    handle = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(handle, content);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temp, target);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

export type { AgentList, ConversationPage, ConversationView, Manifest, Receipt, ReplyContent, ReplyPage };
