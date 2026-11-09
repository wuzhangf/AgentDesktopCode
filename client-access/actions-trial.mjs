import { ClientAccess } from './client-access.mjs';
import { filePending } from './test-file-pending.mjs';
const options = { origin: process.env.UCA_ORIGIN, basePath: '/api/daily/v1/client',
  authorization: 'Bearer ' + process.env.UCA_TEST_TOKEN, connectionId: 'trial-owner',
  pending: filePending(process.env.UCA_PENDING_PATH) };
const first = new ClientAccess(options); await first.connect();
const agent = (await first.agents()).items[0];
const conversation = (await first.conversations(agent.agentRef)).items[0].conversationRef;
const view = await first.conversation(conversation);
const stop = view.actions.find(a => a.actionId === 'execution.stop' && a.availability === 'AVAILABLE');
if (!stop) throw new Error('No selected source execution can be stopped');
const receipt = await first.action(view, stop, {}, 'trial-stop');
// A new consumer instance restores the persisted locator; it only queries the original command.
first.disconnect(); const restored = new ClientAccess(options); await restored.connect();
const lookup = await restored.lookup('trial-stop');
const current = await restored.conversation(conversation);
if (!lookup.accepted || !current.executions.some(e => e.sourceState === 'cancelled')) throw new Error('Original stop did not settle');
console.log(JSON.stringify({ receipt, lookup, executions: current.executions }));
