import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { personalTaskMetrics, unknownTaskMetrics } from '../server/repositories/personalTask.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE obs_run(scope_id,run_id,business_run_id,session_id,task_id);
    CREATE TABLE obs_task(scope_id,task_id,external_task_id);
    CREATE TABLE obs_model_call(scope_id,run_id,call_id);
    CREATE TABLE obs_model_attempt(scope_id,attempt_id,call_id,visibility,dispatch_state,provider_id,requested_model,resolved_model,response_model);
    CREATE TABLE obs_model_usage(scope_id,attempt_id,input_tokens,output_tokens,reasoning_tokens,total_tokens,total_source,input_coverage,reasoning_relation,measurement_source);
    CREATE TABLE obs_command(scope_id,command_id,run_id);
    CREATE TABLE obs_cost_observation(scope_id,attempt_id,command_id,authority_key,revision,source,amount_decimal,currency);
    INSERT INTO obs_run VALUES('local','obs-run','business-run','session-one','task-one');
    INSERT INTO obs_model_call VALUES('local','obs-run','call-one');
    INSERT INTO obs_model_attempt VALUES('local','attempt-one','call-one','TRANSPORT_ATTEMPT','RESPONSE_RECEIVED','provider','configured','routed','response');
    INSERT INTO obs_model_attempt VALUES('local','attempt-two','call-one','TRANSPORT_ATTEMPT','ATTEMPTED','provider','configured','routed',NULL);
    INSERT INTO obs_model_attempt VALUES('local','intent-one','call-one','INTENT','UNKNOWN','provider','configured',NULL,NULL);
    INSERT INTO obs_model_usage VALUES('local','attempt-one',100,30,10,130,'PROVIDER','COMPLETE','INCLUDED_IN_OUTPUT','PROVIDER_REPORTED');`);
  return db;
}
const params={scopeId:'local',runId:'business-run',sessionId:'session-one',taskId:'task-one'};
describe('personal exact-run metrics',()=>{
  it('includes missing usage in denominator and never adds reasoning twice',()=>{
    const db=fixture();try{
      const result=personalTaskMetrics({db,source:{}},params);
      expect(result.metrics.find(m=>m.metricId==='model.logical_calls').value).toBe(1);
      expect(result.metrics.find(m=>m.metricId==='model.transports').value).toBe(2);
      expect(result.metrics.find(m=>m.metricId==='model.dispatch_unconfirmed').value).toBe(1);
      expect(result.metrics.find(m=>m.metricId==='model.usage.total.reported')).toMatchObject({value:130,sampleCount:2,knownCount:1,unknownCount:1,coverageRatio:.5,completeness:'PARTIAL',measurement:'REPORTED'});
      expect(result.models[0]).toMatchObject({requestedModel:'configured',resolvedModel:'routed',responseModel:'response'});
      expect(result.metrics.find(m=>m.metricId==='model.cost').value).toBeNull();
    }finally{db.close();}
  });
  it('keeps estimates separate from reported tokens',()=>{
    const db=fixture();try{
      db.exec("INSERT INTO obs_model_usage VALUES('local','attempt-two',500,50,NULL,550,'DERIVED','COMPLETE','UNKNOWN','ESTIMATED')");
      const result=personalTaskMetrics({db,source:{}},params);
      expect(result.metrics.find(m=>m.metricId==='model.usage.total.reported').value).toBe(130);
      expect(result.metrics.find(m=>m.metricId==='model.usage.total.estimated')).toMatchObject({value:550,measurement:'ESTIMATED'});
    }finally{db.close();}
  });
  it('deduplicates cost revisions, keeps sources and currencies separate, and retains unknown latest values',()=>{
    const db=fixture();try{
      db.exec(`INSERT INTO obs_cost_observation VALUES('local','attempt-one',NULL,'provider-one',1,'PROVIDER_REPORTED','1.1','USD');
        INSERT INTO obs_cost_observation VALUES('local','attempt-one',NULL,'provider-one',2,'PROVIDER_REPORTED','0.2','USD');
        INSERT INTO obs_cost_observation VALUES('local','attempt-one',NULL,'estimate-one',1,'LOCAL_ESTIMATE','0.3','USD');
        INSERT INTO obs_cost_observation VALUES('local','attempt-one',NULL,'router-one',1,'ROUTER_REPORTED','0.4','CNY');
        INSERT INTO obs_cost_observation VALUES('local','attempt-two',NULL,'unknown-one',1,'PROVIDER_REPORTED','1','EUR');
        INSERT INTO obs_cost_observation VALUES('local','attempt-two',NULL,'unknown-one',2,'PROVIDER_REPORTED',NULL,'EUR');`);
      const result=personalTaskMetrics({db,source:{}},params);
      const costs=result.metrics.filter(m=>m.unit==='money');
      expect(costs).toHaveLength(4);
      expect(costs.find(m=>m.currency==='USD'&&m.measurement==='REPORTED').value).toBe('0.2');
      expect(costs.find(m=>m.currency==='USD'&&m.measurement==='ESTIMATED').value).toBe('0.3');
      expect(costs.find(m=>m.currency==='EUR').value).toBeNull();
    }finally{db.close();}
  });
  it('requires exact run/session/task identity, never selects another matching run or a time window',()=>{
    const db=fixture();try{
      expect(personalTaskMetrics({db,source:{}},{...params,sessionId:'other'}).reasonCodes).toContain('RUN_NOT_COLLECTED');
      db.exec("INSERT INTO obs_run VALUES('local','other-run','business-run','session-one','task-one')");
      expect(personalTaskMetrics({db,source:{}},params).reasonCodes).toContain('AMBIGUOUS_RUN_BINDING');
      expect(unknownTaskMetrics('OFF').metrics.every(m=>m.value===null)).toBe(true);
    }finally{db.close();}
  });
});
