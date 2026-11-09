import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { Devices, INVITE_TTL, RECOVERY_TTL } from '../src/devices.js';
import { GatewayStore } from '../src/store.js';
import { createOwnerListener } from '../src/http.js';
import type { GatewayContext } from '../src/context.js';

it('real owner HTTP GET restores only the original live envelope and never recreates cleaned invitations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-invite-recovery-'));
  const store = new GatewayStore(root); let clock = Date.now();
  const devices = new Devices(store, randomBytes(32), undefined, 'store', 'https://mac.example', () => clock);
  const ctx = { auth:devices, config:{storeId:'store',acsStoreId:'store',bootId:'boot',origin:'https://mac.example',certificatePem:'synthetic-cert'},inbox:{requestRefresh(){},scanAll(){},list(){return {items:[]};},detail(){throw new Error("not used");}} } as GatewayContext;
  const server = createOwnerListener({ctx,ownerToken:'synthetic-owner',ownerClientToken:'synthetic-client',bind:'127.0.0.1',port:0});
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = {Authorization:'Bearer synthetic-owner','X-CodeAgent-Client-Token':'synthetic-client'};
  try {
    const original = devices.invitationResources('original-key',[],[{backendStoreId:'backend',projectId:'office',engineId:'macos'}],['OBSERVE','LAUNCH'],'a'.repeat(64));
    const before = JSON.stringify(store.get('invite','original-key'));
    expect((await fetch(origin+'/api/v2/personal-access/pairing-invitations/original-key')).status).toBe(401);
    expect((await fetch(origin+'/api/v2/personal-access/pairing-invitations/original-key',{headers:{...headers,'X-CodeAgent-Client-Token':'wrong'}})).status).toBe(401);
    for(let i=0;i<2;i++) {
      const response=await fetch(origin+'/api/v2/personal-access/pairing-invitations/original-key',{headers});
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({...original,certificatePem:'synthetic-cert'});
      expect(JSON.stringify(store.get('invite','original-key'))).toBe(before);
    }
    clock += INVITE_TTL+1;
    expect((await fetch(origin+'/api/v2/personal-access/pairing-invitations/original-key',{headers})).status).toBe(410);
    expect(JSON.stringify(store.get('invite','original-key'))).toBe(before);
    clock += RECOVERY_TTL+1; devices.requests(); // Existing production cleanup, unchanged.
    expect(store.get('invite','original-key')).toBeUndefined();
    expect((await fetch(origin+'/api/v2/personal-access/pairing-invitations/original-key',{headers})).status).toBe(404);
    expect(store.get('invite','original-key')).toBeUndefined();
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(root,{recursive:true,force:true}); }
});
