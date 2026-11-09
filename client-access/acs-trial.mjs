// UCA-001 ACS real-model driver: chat session + native worker task via client-access/1.
// TLS is pinned to the PEM exported by the acceptance harness (rejectUnauthorized stays on).
import https from 'node:https';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { ClientAccess, applyReplies } from './client-access.mjs';
import { filePending } from './test-file-pending.mjs';

const ca = readFileSync(process.env.UCA_CA_PEM, 'utf8');
const pinned = (url, init = {}) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = https.request({
    hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
    method: init.method ?? 'GET', headers: init.headers ?? {}, ca,
    rejectUnauthorized: true,
  }, res => resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: res.headers })));
  req.on('error', reject);
  if (init.body) req.write(init.body);
  req.end();
});

const client = new ClientAccess({
  origin: process.env.UCA_ORIGIN, basePath: process.env.UCA_BASE_PATH ?? '/personal/v1/client',
  authorization: 'Bearer ' + process.env.UCA_TEST_TOKEN,
  connectionId: process.env.UCA_CONNECTION_ID ?? 'uca-acs', fetch: pinned,
  pending: filePending(process.env.UCA_PENDING_PATH),
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Each trial run gets a fresh nonce so durable request ids never collide with
// payloads from an earlier run against the same source store.
const run = process.env.UCA_RUN ?? Date.now().toString(36);
const out = { verdict: 'FAIL', mode: process.env.UCA_MODE ?? 'chat', step: 'init' };
try {
  const manifest = await client.connect(); out.step = 'connected';
  out.protocolVersion = manifest.protocolVersion; out.storeId = manifest.storeId;
  const agents = (await client.agents()).items;
  out.agents = agents.map(a => ({ kind: a.sourceKind, engine: a.engineId, availability: a.availability, reason: a.reasonCode }));

  if (out.mode === 'chat') {
    const agent = agents.find(a => a.sourceKind === 'ACS_SESSION' && a.availability === 'AVAILABLE');
    if (!agent) throw new Error('ACS_SESSION agent unavailable');
    const dir = await client.conversations(agent.agentRef); out.step = 'directory';
    const ref = dir.items[0]?.conversationRef;
    if (!ref) throw new Error('no conversation granted');
    out.conversationRef = ref;
    const view = await client.conversation(ref); out.step = 'view';
    const receipt = await client.send(view, process.env.UCA_PROMPT ?? 'Reply: UCA-ACS-OK', `acs-msg-${run}`);
    out.receipt = receipt; out.step = 'sent';
    if (receipt.accepted !== true) throw new Error('message not accepted: ' + JSON.stringify(receipt));
    let page;
    for (let i = 0; i < 240; i++) {
      page = applyReplies(page, await client.replies(ref));
      if (page.items?.some(m => m.role === 'assistant' && m.text?.trim())) break;
      await sleep(1500);
    }
    out.reply = page;
    out.lookup = await client.lookup(`acs-msg-${run}`); out.step = 'lookup';
    if (!page?.items?.some(m => m.role === 'assistant' && m.text?.trim())) throw new Error('no assistant reply');
    out.verdict = 'PASS';
  } else {
    const agent = agents.find(a => a.sourceKind === 'WORKER_NATIVE' && a.engineId === (process.env.UCA_ENGINE ?? 'pi'));
    if (!agent || agent.availability !== 'AVAILABLE') throw new Error('native agent unavailable: ' + JSON.stringify(out.agents));
    const dir = await client.conversations(agent.agentRef);
    const ref = dir.items[0]?.conversationRef;
    if (!ref) throw new Error('native conversation absent after launch');
    out.conversationRef = ref;
    let view, page, state = '';
    for (let i = 0; i < 240; i++) {
      view = await client.conversation(ref);
      state = view.sourceState ?? '';
      page = applyReplies(page, await client.replies(ref));
      const text = page.snapshot?.text ?? '';
      if (/UCA-PI-OK/.test(text)) break;
      if (['SUCCEEDED', 'STOPPED'].includes(state) && text.trim()) break;
      if (['FAILED', 'UNKNOWN', 'CANCELLED'].includes(state)) throw new Error('native task ended ' + state);
      await sleep(1500);
    }
    out.nativeState = state; out.reply = page;
    const text = page?.snapshot?.text ?? '';
    if (!text.trim()) throw new Error('native task produced no public reply');
    if (view.message?.availability === 'AVAILABLE') {
      const follow = await client.send(view, 'Reply with exactly: UCA-PI-FOLLOWUP-OK', `acs-followup-${run}`);
      out.followUpReceipt = follow;
      if (follow.accepted === true) {
        for (let i = 0; i < 240; i++) {
          page = applyReplies(page, await client.replies(ref));
          if (/UCA-PI-FOLLOWUP-OK/.test(page.snapshot?.text ?? '')) break;
          await sleep(1500);
        }
        out.followUpText = (page.snapshot?.text ?? '').slice(-400);
      }
    }
    out.verdict = 'PASS';
  }
} catch (e) { out.error = String(e.message ?? e).slice(0, 600); }
console.log(JSON.stringify(out));
