import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import type { Device } from './protocol.js';
import { fail, isRecord } from './protocol.js';
import type { GatewayConfig, HttpRequest, JsonObject } from './context.js';

/** Explicit safety/read exceptions. Unknown mutations require online rights. */
export function requiresCommercialAccess(req: Pick<HttpRequest,'method'|'path'|'body'|'rawBody'>, localCliOnly = false): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  if (req.method === 'DELETE' && req.path === '/personal/v1/device') return false;
  if (req.method === 'POST' && req.path.endsWith('/receipts/lookup')) return false;
  let body=req.body;
  if (body === undefined && req.rawBody && req.rawBody.length <= 65536) {
    try { body=JSON.parse(Buffer.from(req.rawBody).toString('utf8')); } catch { /* rejected below */ }
  }
  if (req.method === 'POST' && /\/(commands|control)$/.test(req.path)
      && isRecord(body) && body.intent === 'STOP') return false;
  if (localCliOnly && req.method === 'POST') {
    const id = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
    if (new RegExp(`^/personal/v1/local-tasks/${id}/(?:task-preflights|tasks|tasks/${id}/messages)$`).test(req.path)
        || new RegExp(`^/personal/v1/approvals/${id}/decision$`).test(req.path)) return false;
  }
  return true;
}

type RequestPlatform = (token: string, proof: JsonObject) => Promise<JsonObject>;

export class CommercialAccess {
  private readonly key;
  private readonly publicKey: string;
  private readonly nodeKey: string;
  private readonly tokens=new Map<string,string>();
  readonly dailyOrigin?: string;
  constructor(private readonly config: GatewayConfig, privateKey: Uint8Array,
      dailyOrigin?: string, private readonly dailyCA?: string,
      private readonly platformRequest?: RequestPlatform) {
    this.key=createPrivateKey(Buffer.from(privateKey));
    const rsa=this.key.asymmetricKeyType === 'rsa' && (this.key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 && (this.key.asymmetricKeyDetails?.modulusLength ?? 0) <= 4096;
    const ec=this.key.asymmetricKeyType === 'ec' && ['prime256v1','secp384r1'].includes(this.key.asymmetricKeyDetails?.namedCurve ?? '');
    if (!rsa && !ec) fail('COMMERCIAL_KEY_INVALID',503);
    const der=createPublicKey(this.key).export({type:'spki',format:'der'});
    this.publicKey=der.toString('base64url'); this.nodeKey=createHash('sha256').update(der).digest('hex');
    if (dailyOrigin) {
      const url=new URL(dailyOrigin);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
          || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) fail('DAILY_ORIGIN_INVALID',503);
      this.dailyOrigin=url.origin;
    }
  }
  private proof(device: Device,kind: string,extra: JsonObject={}): JsonObject {
    const iat=Math.floor(Date.now()/1000);
    const scope={sessions:device.sessions ?? [],resources:device.resources ?? [],launchScopes:device.launchScopes ?? [],actions:device.actions ?? []};
    const claims={aud:'daily-desktop-control/1',kind,iat,exp:iat+90,nonce:randomUUID(),
      personalHostId:this.config.personalHostId ?? this.config.storeId,storeId:this.config.storeId,
      deviceGrantId:device.id,installationId:device.installationId ?? device.id,
      grantRevision:String(device.revision),scopeDigest:createHash('sha256').update(JSON.stringify(scope)).digest('hex'),
      certificateSHA256:this.config.certificateSha256 ?? '',...extra};
    const payload=Buffer.from(JSON.stringify(claims));
    return {payload:payload.toString('base64url'),signature:sign('sha256',payload,this.key).toString('base64url'),publicKey:this.publicKey};
  }
  challenge(device: Device): JsonObject {
    if (!this.dailyOrigin) fail('DAILY_SERVICE_NOT_CONFIGURED',503);
    return {schemaVersion:'desktop-control-challenge/1',dailyOrigin:this.dailyOrigin,proof:this.proof(device,'CHALLENGE')};
  }
  private async check(device: Device,token: string,req?: HttpRequest): Promise<void> {
    if (!this.dailyOrigin) fail('DAILY_SERVICE_NOT_CONFIGURED',503);
    const requestId=req?.idempotencyKey ?? randomUUID();
    const digest=createHash('sha256').update(req?.method ?? 'AUTHORIZE').update('\n').update(req?.path ?? '').update('\n').update(req?.rawBody ?? JSON.stringify(req?.body ?? null)).digest('hex');
    const proof=this.proof(device,'AUTHORIZE',{requestId,bodyDigest:digest});
    const value=await (this.platformRequest ? this.platformRequest(token,proof) : this.request(token,proof));
    if (value.schemaVersion !== 'daily-desktop-authorization/1' || value.allowed !== true
        || value.nodeKeyThumbprint !== this.nodeKey || value.deviceGrantId !== device.id
        || value.requestId !== requestId || value.bodyDigest !== digest) fail('INVALID_COMMERCIAL_AUTHORIZATION',503);
  }
  async attach(device: Device,body: JsonObject): Promise<JsonObject> {
    const token=body.controlToken;
    if (typeof token !== 'string' || token.length < 16 || token.length > 256) fail('INVALID_REQUEST',400);
    await this.check(device,token); this.tokens.set(device.id,token);
    return {schemaVersion:'desktop-control-attached/1',deviceGrantId:device.id};
  }
  async authorize(device: Device,req: HttpRequest): Promise<void> {
    const token=this.tokens.get(device.id);
    if (!token) fail('CONTROL_AUTHORIZATION_REQUIRED',403);
    await this.check(device,token,req);
  }
  private request(token: string,proof: JsonObject): Promise<JsonObject> {
    const url=new URL('/api/daily/v1/desktop-control-grants/introspect',this.dailyOrigin!);
    const body=Buffer.from(JSON.stringify({proof}));
    return new Promise((resolve,reject)=>{
      const transport=url.protocol === 'https:' ? https:http;
      const request=transport.request(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':body.length},...(this.dailyCA ? {ca:this.dailyCA}:{}),timeout:5000},response=>{
        let size=0;const chunks:Buffer[]=[];
        response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536){response.destroy();reject(new Error('COMMERCIAL_RESPONSE_TOO_LARGE'));}else chunks.push(chunk);});
        response.on('error',reject);
        response.on('end',()=>{
          try { const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if(!isRecord(value)) throw new Error('INVALID_COMMERCIAL_RESPONSE');
            if(response.statusCode !== 200) { const code=typeof value.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code) ? value.code:'ENTITLEMENT_CHECK_REQUIRED';fail(code,response.statusCode === 403 ? 403:503); }
            resolve(value);
          } catch(error){reject(error);}
        });
      });
      request.on('timeout',()=>request.destroy(new Error('COMMERCIAL_TIMEOUT')));request.on('error',reject);request.end(body);
    });
  }
}
