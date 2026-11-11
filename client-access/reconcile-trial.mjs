// Integration driver: observe an externally reconciled run settle through client-access/1.
// The host is started by the acceptance harness; this driver dispatches no new intention.
import { ClientAccess } from './client-access.mjs';
import { filePending } from './test-file-pending.mjs';
const pending = filePending(process.env.UCA_PENDING_PATH);
const client = new ClientAccess({ origin: process.env.UCA_ORIGIN, basePath: process.env.UCA_BASE_PATH ?? '/api/daily/v1/client',
  authorization: 'Bearer ' + process.env.UCA_TEST_TOKEN, connectionId: process.env.UCA_CONNECTION_ID ?? 'trial-owner', pending });
const manifest = await client.connect();
const agent = (await client.agents()).items.find(a => a.availability === 'AVAILABLE');
if (!agent) throw new Error('No available agent');
const conversation = (await client.conversations(agent.agentRef)).items[0]?.conversationRef;
if (!conversation) throw new Error('No retained conversation');
let page;
for (let i = 0; i < 180; i++) {
  page = await client.replies(conversation);
  if (page.items?.some(m => m.role === 'assistant') || page.snapshot?.text) break;
  const observed = await client.conversation(conversation);
  if (observed.executions?.length && observed.executions.every(e => ['succeeded', 'failed', 'cancelled'].includes(e.sourceState))) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const current = await client.conversation(conversation);
if (!page?.items?.some(m => m.role === 'assistant') && !page?.snapshot?.text)
  throw new Error('Reconciled execution produced no visible reply');
console.log(JSON.stringify({ protocolVersion: manifest.protocolVersion, storeId: manifest.storeId, agent,
  conversationRef: conversation, reply: page, executions: current.executions }));
