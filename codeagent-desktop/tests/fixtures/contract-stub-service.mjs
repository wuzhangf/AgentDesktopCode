/**
 * Contract stub service for the desktop client tests (EW1). Implements the
 * canonical v2 wire shapes from business-codeagent-v2.yaml, plus fixtures
 * for version skew, stale expectedStateVersion and unknown enum values.
 * Env: CODEAGENT_SERVICE_PORT, CODEAGENT_SERVICE_TOKEN,
 *      CODEAGENT_STUB_MIN_DESKTOP (optional protocol skew fixture).
 */
import http from 'node:http';

const port = Number(process.env.CODEAGENT_SERVICE_PORT);
const token = process.env.CODEAGENT_SERVICE_TOKEN ?? '';
const minDesktop = process.env.CODEAGENT_STUB_MIN_DESKTOP ?? '2.0';

const seenIdempotencyKeys = new Set();

function authorized(req) {
  return req.headers.authorization === `Bearer ${token}`;
}

function problem(res, status, code, message, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify({ code, status, message, ...extra }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const path = url.pathname;
  if (!authorized(req)) {
    problem(res, 401, 'UNAUTHORIZED', 'Bearer token is required');
    return;
  }
  if (path === '/api/v2/capabilities') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      serviceInstanceId: 'svc-contract-stub',
      protocolVersion: '2.1',
      minDesktopProtocol: minDesktop,
      features: {
        sessionV2: true, durableEvents: true, visibleOutputStream: false,
        reviewScopes: [], worktreeExecution: false, mission: true,
        mcpHost: false, servicePty: false
      },
      limits: { maxDiffBytes: 2097152, maxEventPage: 500, maxVisibleDeltaChars: 8192 },
      operations: [
        'project.register', 'session.create.inspect', 'session.create.modify',
        'session.create.plan', 'session.message.send.text', 'session.message.send.image',
        'run.stream.output', 'run.interrupt', 'run.diff.read', 'run.review.read',
        'finding.fixTask.create', 'file.read', 'file.reveal', 'evidence.read',
        'spec.manage', 'mission.manage', 'settings.manage', 'knowledge.manage',
        'mcp.resource.read', 'skill.manage', 'hook.health.read'
      ].map((id) => ({ id, availability: 'AVAILABLE', contractVersion: '2.1' }))
    }));
    return;
  }
  if (path === '/api/v2/scheduler/overview' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      schemaVersion: 'business-scheduler-overview/1', bootId: 'boot-1',
      schedulerMode: 'DEGRADED', recoveryBarrier: 'OPEN', configFingerprint: 'config-1',
      activeRuns: 1, maxActiveRuns: 2, queuedRuns: 3,
      resourcePools: [{ type: 'RUN_EXECUTION_SLOT', used: 1, limit: 2 }]
    }));
    return;
  }
  if (path === '/api/v2/projects' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{
      projectId: 'sample', displayName: 'sample', workspaceAlias: 'sample',
      vcsKind: 'GIT', branchDisplay: 'main', headShortRevision: 'abc1234',
      dirtySummary: 'CLEAN', authorityStatus: 'AVAILABLE', capabilities: [],
      runningCount: 0, attentionCount: 0
    }]));
    return;
  }
  if (path === '/api/v2/projects/sample/files/README.md' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      projectId: 'sample', fileRef: 'README.md', revisionRef: 'fixture-revision',
      mediaType: 'text/plain', encoding: 'UTF-8', contentText: '# fixture\n',
      contentBytes: 10, sha256: 'fixture-sha256', truncated: false, stale: false
    }));
    return;
  }
  if (path === '/api/v2/projects/sample/session-preflight' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      projectId: 'sample', workspaceAlias: 'sample', workspaceId: 'workspace-1',
      headRevision: 'abc1234', workspaceFingerprint: 'workspace-fp-1',
      revision: 'preflight-revision-1', policyFingerprint: 'policy-fp-1',
      authorityStatus: 'AVAILABLE', allowedIntents: ['ASK', 'CODE', 'PLAN'],
      suggestedWriteScope: ['services/visits/src'], writeScopeCeiling: ['services/visits/src'],
      modelAlias: 'fixture-model', modelAvailability: 'AVAILABLE'
    }));
    return;
  }
  if (path === '/api/v2/projects/registrations' && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!key || key.length > 128) {
      problem(res, 400, 'INVALID_REQUEST', 'Idempotency-Key is required and limited to 128 characters');
      return;
    }
    seenIdempotencyKeys.add(key);
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      projectId: 'fixture-1a2b3c4d', workspaceAlias: 'fixture-1a2b3c4d',
      displayName: 'fixture', canonicalRoot: 'C:/codeagent/fixture', alreadyRegistered: false
    }));
    return;
  }
  if (path === '/api/v2/policies/PROJECT' && req.method === 'PUT') {
    const key = req.headers['idempotency-key'];
    if (!key) {
      problem(res, 400, 'INVALID_REQUEST', 'Idempotency-Key is required and limited to 128 characters');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.maximumAutonomy !== 'LOW' || parsed.expectedRevision !== 3) {
        problem(res, 400, 'INVALID_REQUEST', 'policy update body was not received');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        layers: [{ layer: 'PROJECT', maximumAutonomy: parsed.maximumAutonomy, revision: 4 }],
        effectiveMaximumAutonomy: 'LOW'
      }));
    });
    return;
  }
  if (path === '/api/v2/settings' && req.method === 'PUT') {
    const key = req.headers['idempotency-key'];
    if (!key) {
      problem(res, 400, 'INVALID_REQUEST', 'Idempotency-Key is required and limited to 128 characters');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.localOnly !== false || parsed.expectedRevision !== 5) {
        problem(res, 400, 'INVALID_REQUEST', 'settings update body was not received');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        revision: 6, traceExportEnabled: false, localOnly: false,
        eventJournalRetentionDays: 30, telemetryMinimal: false
      }));
    });
    return;
  }
  // GUI budget approval is a two-step, approval-id-bound protocol. The
  // desktop client must first read the pending request and then submit the
  // service-owned decision shape to the exact approval resource.
  if (path === '/api/v1/gui/runs/run-budget/budget-approval' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      runId: 'run-budget', approvalId: 'approval-1', status: 'PENDING',
      requestFingerprint: 'budget-fingerprint-1', createdAt: 1000, expiresAt: 3000,
      request: {
        requestedTopUp: {
          maxSteps: 4, maxModelHttpRequests: 2, maxRecoveryRequests: 1,
          additionalRunMillis: 5000, maxCostMicros: 900
        },
        maximumAllowedTopUp: {
          maxSteps: 8, maxModelHttpRequests: 4, maxRecoveryRequests: 2,
          additionalRunMillis: 10000, maxCostMicros: 1800
        }
      }
    }));
    return;
  }
  if (path === '/api/v1/gui/runs/run-budget/budget-approval/approval-1' && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!key) {
      problem(res, 400, 'INVALID_REQUEST', 'Idempotency-Key is required and limited to 128 characters');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.requestFingerprint !== 'budget-fingerprint-1'
          || parsed.idempotencyKey !== key
          || !parsed.approvedTopUp
          || parsed.approvedTopUp.maxSteps !== 4) {
        problem(res, 400, 'INVALID_REQUEST', 'budget approval decision shape is invalid');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        runId: 'run-budget', approvalId: 'approval-1', status: parsed.decision === 'DENY' ? 'DENIED' : 'APPROVED',
        requestFingerprint: parsed.requestFingerprint, decision: parsed.decision,
        approverId: parsed.approverId, comment: parsed.comment, approvedTopUp: parsed.approvedTopUp
      }));
    });
    return;
  }
  if (path === '/api/v1/gui/runs/run-command/command-approval' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      approvalId: 'command-approval-1', fingerprint: 'command-fingerprint-1',
      executable: 'git', arguments: ['status'], workingDirectory: 'workspace',
      timeoutMillis: 30000, environmentVariableNames: [], stdinPresent: false,
      expiresAtMillis: 3000
    }));
    return;
  }
  if (path === '/api/v1/gui/runs/run-command/command-approval/command-approval-1' && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!key) {
      problem(res, 400, 'INVALID_REQUEST', 'Idempotency-Key is required and limited to 128 characters');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.fingerprint !== 'command-fingerprint-1' || parsed.decision !== 'APPROVE') {
        problem(res, 400, 'INVALID_REQUEST', 'command approval decision shape is invalid');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ACCEPTED' }));
    });
    return;
  }
  if (path === '/api/v1/runs/run-terminal/terminal-approvals/pending' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      approvalId: 'terminal-approval-1', fingerprint: 'terminal-fingerprint-1',
      businessSessionId: 'session-terminal', runId: 'run-terminal',
      workspaceExecutionId: 'execution-1', workspaceLineageId: 'lineage-1',
      agentReadAllowed: true, agentInputAllowed: true, executable: 'node.exe',
      arguments: ['server.js'], workingDirectory: '.', columns: 120, rows: 40,
      lifetimeScope: 'RUN', inputPolicy: 'LINE', terminalMode: 'LINE_STREAM',
      profile: 'DIRECT_PROCESS', networkIntent: 'INHERIT', maxLifetimeMillis: 1800000,
      createdAtMillis: 1000, expiresAtMillis: 3000
    }));
    return;
  }
  if (path === '/api/v1/runs/run-terminal/terminal-approvals/terminal-approval-1' && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!key) {
      problem(res, 400, 'INVALID_REQUEST', 'Idempotency-Key is required and limited to 128 characters');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.fingerprint !== 'terminal-fingerprint-1' || parsed.decision !== 'APPROVE_SESSION') {
        problem(res, 400, 'INVALID_REQUEST', 'terminal approval decision shape is invalid');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ACCEPTED' }));
    });
    return;
  }
  if (path === '/api/v2/runs/run-1' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      runId: 'run-1', taskId: 'task-1', state: 'COMPLETED', sourceStatus: 'SUCCEEDED',
      stateVersion: 12, changedFileCount: 2, sessionId: null, workspaceAlias: 'sample'
    }));
    return;
  }
  if (path === '/api/v2/runs/run-unknown' && req.method === 'GET') {
    problem(res, 404, 'INVALID_REQUEST', 'Run not found');
    return;
  }
  if (path === '/api/v2/runs/run-drift' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      runId: 'run-drift', taskId: 'task-drift', state: 'SOMETHING_NEW',
      sourceStatus: 'SOMETHING_NEW', stateVersion: 3, changedFileCount: 0
    }));
    return;
  }
  if (path === '/api/v2/runs/run-1/interrupt' && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!key) {
      problem(res, 400, 'INVALID_REQUEST', 'Idempotency-Key is required and limited to 128 characters');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.expectedStateVersion === 999) {
        problem(res, 409, 'STATE_VERSION_CONFLICT', 'Run state changed before the interrupt was applied',
          { expectedStateVersion: 999, actualStateVersion: 12 });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        runId: 'run-1', taskId: 'task-1', state: 'NEEDS_ATTENTION',
        sourceStatus: 'INTERRUPTED', stateVersion: 13, changedFileCount: 0
      }));
    });
    return;
  }
  if (path === '/api/v2/runs/run-1/evidence') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      runId: 'run-1', generatedAt: '2026-08-28T00:00:00Z', complete: false,
      items: [
        { evidenceId: 'run:run-1:SOURCE', layer: 'SOURCE', status: 'PRESENT', summary: {} },
        { evidenceId: 'run:run-1:DETERMINISTIC_TEST', layer: 'DETERMINISTIC_TEST', status: 'NOT_RUN', summary: { reason: 'none' } }
      ]
    }));
    return;
  }
  if (path === '/api/v2/model-catalog') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [] }));
    return;
  }
  // read-only external sources (EW10.2): provenance + untrusted marker
  if (path === '/api/v2/sources/fetch' && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!key) {
      problem(res, 400, 'INVALID_REQUEST', 'Idempotency-Key is required and limited to 128 characters');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seenIdempotencyKeys.add(key);
      const parsed = JSON.parse(body || '{}');
      if (parsed.sourceType === 'FORBIDDEN') {
        problem(res, 415, 'SOURCE_TYPE_FORBIDDEN', 'Source type is not supported by the read-only adapter');
        return;
      }
      if (parsed.uri === 'http://127.0.0.1/x') {
        problem(res, 403, 'SOURCE_URI_FORBIDDEN', 'Source host is not publicly routable');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        sourceType: parsed.sourceType ?? 'WEB',
        sourceUri: parsed.uri ?? 'https://docs.example.com/guide',
        finalUri: parsed.uri ?? 'https://docs.example.com/guide',
        fetchedAt: '2026-08-29T00:00:00Z',
        contentType: 'text/markdown',
        contentBytes: 7,
        contentText: '# guide',
        truncated: false,
        untrustedContent: true,
        redirectCount: 0,
        statusCode: 200
      }));
    });
    return;
  }
  // read-only MCP sources (EW10.3): allowlisted servers, untrusted content
  if (path === '/api/v2/mcp/servers' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ serverId: 'docs', status: 'READY', reason: null, resourceCount: null }]));
    return;
  }
  if (path === '/api/v2/mcp/servers/docs/resources' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([
      { uri: 'file:///docs/a.md', name: 'a', mimeType: 'text/markdown', description: 'doc a' },
      { uri: 'file:///docs/b.txt', name: 'b', mimeType: null, description: null }
    ]));
    return;
  }
  if (path === '/api/v2/mcp/servers/docs/resources/read' && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!key) {
      problem(res, 400, 'INVALID_REQUEST', 'Idempotency-Key is required and limited to 128 characters');
      return;
    }
    seenIdempotencyKeys.add(key);
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.uri === 'file:///missing.md') {
        problem(res, 502, 'MCP_REQUEST_FAILED', 'MCP remote error code=-32002');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        serverId: 'docs',
        uri: parsed.uri ?? 'file:///docs/a.md',
        mimeType: 'text/markdown',
        contentBytes: 7,
        contentText: '# guide',
        truncated: false,
        untrustedContent: true,
        fetchedAt: '2026-08-29T00:00:00Z'
      }));
    });
    return;
  }
  // skill catalog (EW10.5)
  if (path === '/api/v2/skills' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{
      skillId: 'skill-1a2b3c4d5e6f7a8b9c0d', name: 'error-codes', version: '1.0.0',
      source: 'user', scope: 'PROJECT', projectAlias: 'sample',
      instructions: 'Map error codes first.', permissions: ['CONTEXT_INJECTION'],
      status: 'ACTIVE', revision: 1,
      createdAt: '2026-08-29T00:00:00Z', updatedAt: '2026-08-29T00:00:00Z'
    }]));
    return;
  }
  if (path === '/api/v2/skills' && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!key) {
      problem(res, 400, 'INVALID_REQUEST', 'Idempotency-Key is required and limited to 128 characters');
      return;
    }
    seenIdempotencyKeys.add(key);
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      skillId: 'skill-1a2b3c4d5e6f7a8b9c0d', status: 'ACTIVE', revision: 1,
      createdAt: '2026-08-29T00:00:00Z', updatedAt: '2026-08-29T00:00:00Z'
    }));
    return;
  }
  if (path === '/api/v2/skills/skill-1a2b3c4d5e6f7a8b9c0d/status' && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!key) {
      problem(res, 400, 'INVALID_REQUEST', 'Idempotency-Key is required and limited to 128 characters');
      return;
    }
    seenIdempotencyKeys.add(key);
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.expectedRevision !== 1) {
        problem(res, 409, 'SKILL_REVISION_CONFLICT', 'Skill revision does not match the expected revision',
          { currentRevision: 1 });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        skillId: 'skill-1a2b3c4d5e6f7a8b9c0d', status: parsed.status ?? 'DISABLED',
        revision: 2, createdAt: '2026-08-29T00:00:00Z', updatedAt: '2026-08-29T01:00:00Z'
      }));
    });
    return;
  }
  // typed hooks (EW10.6)
  if (path === '/api/v2/hooks' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{
      name: 'notify', event: 'RUN_TERMINAL', enabled: true, timeoutMillis: 5000,
      failurePolicy: 'LOG_ONLY', lastStatus: 'OK', lastFinishedAt: '2026-08-29T01:00:00Z'
    }]));
    return;
  }
  if (path === '/api/v2/hooks/executions' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [{
      hookName: 'notify', event: 'RUN_TERMINAL', eventId: 'evt-1', status: 'OK',
      durationMillis: 12, finishedAt: '2026-08-29T01:00:00Z'
    }], truncated: false }));
    return;
  }
  problem(res, 404, 'INVALID_REQUEST', 'Endpoint not found');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`ready ${seenIdempotencyKeys.size}\n`);
});
