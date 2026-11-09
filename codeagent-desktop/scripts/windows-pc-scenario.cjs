// One manually selected case. Default is the local fixture, never a stage chain.
const path=require('path'),{spawn}=require('child_process');
if(process.env.PC_TEST_EXECUTE!=='1')throw Error('TESTS_DISABLED_EXPLICIT_EXECUTION_REQUIRED');
const [scenario='control',...flags]=process.argv.slice(2);
if(!['control','faults','transport-fault'].includes(scenario)||flags.some(f=>!['--fixture','--live'].includes(f))||new Set(flags).size!==flags.length||flags.length>1)throw Error('SELECT_ONE_SCENARIO_AND_ONE_MODEL_KIND');
const live=flags.includes('--live');
if(live&&scenario==='transport-fault')throw Error('TRANSPORT_FAULT_REQUIRES_LOCAL_FIXTURE');
const env={...process.env,PC_E2E_MODE:scenario,PC_MODEL_FIXTURE:live?'0':'1'};
for(const key of ['PC_BINDING_DELAY_MS','PC_SAVE_DELAY_MS','PC_FORCE_CAPTURE_FALLBACK','PC_FORCE_CLOSE_TIMEOUT','PC_STALE_STOP'])env[key]='0';
env.PC_MODEL_FAULT=scenario==='transport-fault'?'stream-disconnect':'none';
// Output placement is owned by the bounded driver, not inherited old launch files.
delete env.PC_E2E_OUTPUT;
const child=spawn(process.execPath,[path.join(__dirname,'windows-codex-control-e2e.cjs')],{env,windowsHide:true,stdio:'inherit'});
child.once('error',e=>{console.error(e.message);process.exitCode=1;});
child.once('exit',(code,signal)=>{process.exitCode=signal?1:code??1;});
