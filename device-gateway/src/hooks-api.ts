/**
 * src/hooks-api.ts — loopback surface for local agent hook processes.
 *
 * Hook commands are spawned by the agent CLIs themselves (Claude Code
 * PreToolUse, Codex, ...). They are short-lived local processes, not paired
 * devices, so they cannot and must not present a device token. They bind to a
 * dedicated loopback listener gated by the hooks token — a local credential
 * persisted next to store.key, never an owner token (which could revoke
 * devices) and never a device token (which is a remote grant).
 *
 *   GET  /hooks/v1/enabled                     → {enabled} — any active device?
 *   POST /hooks/v1/approvals                   → create/get the ask
 *   GET  /hooks/v1/approvals/{id}              → poll the decision
 *   POST /hooks/v1/approvals/{id}/cancel       → stop waiting (card closes)
 *
 * Everything else → NOT_FOUND. Without ctx.approvals the surface reports
 * APPROVALS_NOT_CONFIGURED so the hook exits silently and the agent shows its
 * own dialog — the fail-open rule applies to the whole surface.
 */
import { constantEqual, fail, GatewayError } from './protocol';
import type { GatewayContext, HttpRequest, HttpResponse } from './context';

const json = (body: unknown, status = 200): HttpResponse => ({ status, body: body as HttpResponse['body'] });

export const handleHooksRoute = async (
  ctx: GatewayContext, req: HttpRequest, hooksToken: string,
): Promise<HttpResponse> => {
  try {
    if (!constantEqual(req.accessToken, hooksToken)) fail('ACCESS_UNAUTHORIZED', 401);
    const approvals = ctx.approvals;
    if (approvals === undefined) fail('APPROVALS_NOT_CONFIGURED', 503);
    const path = req.path;
    const method = req.method;

    if (path === '/hooks/v1/enabled' && method === 'GET') {
      return json({ schemaVersion: 'agent-hooks/1', enabled: await approvals.enabled() });
    }
    if (path === '/hooks/v1/approvals' && method === 'GET') {
      return json(approvals.pending());
    }
    if (path === '/hooks/v1/approvals' && method === 'POST') {
      const body = JSON.parse(new TextDecoder().decode(req.rawBody)) as unknown;
      return json(approvals.submit(body), 201);
    }
    const match = /^\/hooks\/v1\/approvals\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})(\/cancel)?$/.exec(path);
    if (match !== null) {
      if (match[2] === '/cancel' && method === 'POST') return json(approvals.cancel(match[1]));
      if (match[2] === undefined && method === 'GET') return json(approvals.poll(match[1]));
    }
    fail('NOT_FOUND', 404);
  } catch (error) {
    if (error instanceof GatewayError) {
      return json({ code: error.code, detail: error.code }, error.httpStatus);
    }
    if (error instanceof SyntaxError) {
      return json({ code: 'INVALID_REQUEST', detail: 'INVALID_REQUEST' }, 400);
    }
    throw error;
  }
};
