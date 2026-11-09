import type { WritableCollaborationClient } from '../../../codeagent-desktop/src/renderer/app/WritableCollaborationPanel';
import { DesktopProxyError } from '../../../codeagent-desktop/packages/protocol/src/proxy-result';

export async function request(action: string, fields: object = {}, endpoint = 'call'): Promise<unknown> {
  let tab = sessionStorage.getItem('worker-lab-tab');
  if (!tab) { tab = crypto.randomUUID(); sessionStorage.setItem('worker-lab-tab', tab); }
  const response = await fetch('/api/worker/' + endpoint, { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'X-Worker-Control': '1', 'X-Worker-Tab': tab }, body: JSON.stringify({ ...fields, ...(action ? { action } : {}) }) });
  const result: unknown = await response.json();
  if (!response.ok) {
    const problem = result as Record<string, any>;
    throw new DesktopProxyError(problem.code ?? 'REQUEST_FAILED', problem.error ?? problem.detail ?? problem.message ?? `请求失败 (${response.status})`, {
      status: response.status, operationOutcome: problem.operationOutcome, receiptId: problem.receiptId,
    });
  }
  return result;
}
export const workerClient: WritableCollaborationClient = {
  writableCollaboration: operation => request('WRITABLE', { operation }),
  collaboration: operation => request('COLLABORATION', { operation }),
  getSession: id => request('SESSION', { id }),
  getMessageContentPage: (id, messageId, query) => request('MESSAGE_CONTENT', { id, messageId, maxBytes: query.maxBytes }),
  listAgentProfiles: () => request('PROFILES'), getModelCatalog: () => request('MODELS'),
};
