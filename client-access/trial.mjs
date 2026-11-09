// Integration driver for the reference port; the host is started by the acceptance harness.
import { ClientAccess } from './client-access.mjs';
import { filePending } from './test-file-pending.mjs';
const pending = filePending(process.env.UCA_PENDING_PATH);
const client = new ClientAccess({ origin: process.env.UCA_ORIGIN, basePath: process.env.UCA_BASE_PATH ?? '/api/daily/v1/client',
  authorization: 'Bearer ' + process.env.UCA_TEST_TOKEN, connectionId: process.env.UCA_CONNECTION_ID ?? 'trial-owner', pending });
const manifest = await client.connect();
const agent = (await client.agents()).items.find(a => a.availability === 'AVAILABLE');
if (!agent) throw new Error('No available agent');
let conversation = (await client.conversations(agent.agentRef)).items[0]?.conversationRef;
if (!conversation) conversation = (await client.create(agent.agentRef, 'trial-create')).conversationRef;
const view = await client.conversation(conversation);
const receipt = await client.send(view, process.env.UCA_PROMPT, 'trial-message');
if (receipt.accepted !== true) throw new Error('Source did not confirm acceptance');
let page;
for (let i = 0; i < 180; i++) {
  page = await client.replies(conversation);
  if (page.items?.some(m => m.role === 'assistant') || page.snapshot?.text) break;
  if (i % 3 === 0) {
    const observed = await client.conversation(conversation);
    if (observed.executions?.some(e => ['waiting', 'UNKNOWN'].includes(e.sourceState)))
      throw new Error('Source waiting or unresolved; original intention retained without repost');
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const current = await client.conversation(conversation);
const check = await client.lookup('trial-message');
if (check.accepted !== true || !page.items?.some(m => m.role === 'assistant') && !page.snapshot?.text) throw new Error('No real source reply');
console.log(JSON.stringify({ protocolVersion: manifest.protocolVersion, storeId: manifest.storeId, agent,
  conversationRef: conversation, receipt, lookup: check, reply: page, executions: current.executions }));
