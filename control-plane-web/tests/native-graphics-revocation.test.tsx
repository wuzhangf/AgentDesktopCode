// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {NativeGraphicsSection} from '../src/personal/components/NativeGraphicsSection';
import type {PersonalTaskDetail} from '../../codeagent-desktop/packages/protocol/src/personal-task';

afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();});
it.each(['observe-revoked','source-offline'] as const)('hides retained AX cache and open review on %s',reason=>{
 const profile={id:'registered',bundleID:'fixture.app',windowTitle:'Fixture',allowedActions:['setValue'],allowedElementIdentifiers:['field']};
 const detail:PersonalTaskDetail={taskId:'task-one',accepted:true,createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z',observedAt:'2026-10-25T00:00:00Z',core:'MACOS',executionBinding:{kind:'WORKER_LOCAL',connectionId:'source',storeId:'store',localTaskId:'native-one',engineId:'macos',engineVersion:'1'},native:{taskId:'native-one',engineId:'macos',engineVersion:'1',state:'WAITING_INPUT',generation:'g',nativeSessionId:'session',segmentId:'segment',ownerEpoch:'1',graphicsObservationRevision:'revision',graphicsObservationValid:true,graphicsProfile:profile,graphicsAccess:{protocolVersion:'mac-graphics/1',observe:true,capture:false,act:true}}};
 const cached={items:[{schemaVersion:'mac-graphics-observation/1',taskId:'native-one',generation:'g',nativeSessionId:'session',segmentId:'segment',ownerEpoch:'1',revision:'revision',observedAt:'2026-10-25T00:00:00Z',target:{bundleID:'fixture.app',windowID:1},elements:[{identifier:'field',role:'AXTextField',value:'PRIVATE_AX_VALUE',canSetValue:true,canPress:false}]}]};
 const qc=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});qc.setQueryData(['native-graphics','task-one'],cached);
 const fetch=vi.fn(()=>{throw Error('No source read should occur from fresh cache or disabled permission');});vi.stubGlobal('fetch',fetch);
 const view=(d:PersonalTaskDetail)=><QueryClientProvider client={qc}><NativeGraphicsSection taskId="task-one" detail={d} readonly={false}/></QueryClientProvider>;
 const shown=render(view(detail));expect(screen.getByText(/PRIVATE_AX_VALUE/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'设置 field 值…'}));expect(screen.getByRole('dialog',{name:'核对图形操作'})).toBeTruthy();expect(screen.getByDisplayValue('PRIVATE_AX_VALUE')).toBeTruthy();
 const denied:PersonalTaskDetail={...detail,...(reason==='source-offline'?{sourceError:'SOURCE_UNAVAILABLE'}:{}),native:{...detail.native!,graphicsAccess:{protocolVersion:'mac-graphics/1',observe:reason!=='observe-revoked',capture:false,act:false}}};
 shown.rerender(view(denied));expect(qc.getQueryData(['native-graphics','task-one'])).toEqual(cached);expect(screen.queryByText(/PRIVATE_AX_VALUE/)).toBeNull();expect(screen.queryByDisplayValue('PRIVATE_AX_VALUE')).toBeNull();expect(screen.queryByRole('dialog')).toBeNull();expect(fetch).not.toHaveBeenCalled();
});
