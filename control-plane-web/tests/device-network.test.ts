import {it,expect} from 'vitest';
import {deviceNetworkFacts,type DeviceCapabilities} from '../src/personal/device-access';
const base={origin:'https://phone.example',enabled:true,storeId:'s',certificateSha256:'public',certificateNotBefore:10,certificateNotAfter:30,sessions:[]} satisfies DeviceCapabilities;
it('reports actual SAN, validity and loopback facts without implying phone reachability',()=>{
  expect(deviceNetworkFacts({...base,certificateNames:[[2,'phone.example']],bindAddress:'0.0.0.0'},20)).toMatchObject({nameMatches:true,certificateTimeValid:true,loopbackBind:false,loopbackOrigin:false});
  expect(deviceNetworkFacts({...base,certificateNames:[[2,'other.example']],bindAddress:'127.0.0.1'},40)).toMatchObject({nameMatches:false,certificateTimeValid:false,loopbackBind:true});
  expect(deviceNetworkFacts({...base,origin:'https://localhost',certificateNames:[[2,'localhost']]},20)).toMatchObject({loopbackOrigin:true,nameMatches:true});
  expect(deviceNetworkFacts(base,20).nameMatches).toBeNull();
  expect(deviceNetworkFacts({...base,origin:'https://127.0.0.1',certificateNames:[[2,'127.0.0.1']]},20).nameMatches).toBe(false);
});
it('limits wildcard DNS matching to one label and treats IP SAN separately',()=>{
  expect(deviceNetworkFacts({...base,certificateNames:[[2,'*.example']]},20).nameMatches).toBe(true);
  expect(deviceNetworkFacts({...base,origin:'https://deep.phone.example',certificateNames:[[2,'*.example']]},20).nameMatches).toBe(false);
  expect(deviceNetworkFacts({...base,origin:'https://[::1]',certificateNames:[[7,'0:0:0:0:0:0:0:1']]},20).nameMatches).toBe(true);
});
