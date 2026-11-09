import {describe,it,expect} from 'vitest';
import QRCode from 'qrcode';
import {invitationQrFits} from '../src/personal/components/InvitationQr';
describe('complete invitation QR',()=>{
  it('encodes complete UTF8 envelope and preserves byte capacity fallback',()=>{
    const text=JSON.stringify({schemaVersion:'personal-pairing-invite/1',certificatePem:'公开测试证书'.repeat(80),inviteSecret:'nonfunctional-public-fixture'});
    expect(invitationQrFits(text)).toBe(true);
    const symbol=QRCode.create([{data:new TextEncoder().encode(text),mode:'byte'}],{errorCorrectionLevel:'L'});
    expect(symbol.modules.size).toBeGreaterThan(21);
    expect(invitationQrFits('汉'.repeat(1000))).toBe(false);
    expect(invitationQrFits('a'.repeat(2953))).toBe(true);
    expect(invitationQrFits('a'.repeat(2954))).toBe(false);
  });
});
