"""Live Worker E2E through the same bounded gateway used by worker.html.

Start worker-fixture.py --live-project <git-project> --port 8792 first.
All evidence is local and contains no credentials. A failed assertion is a failed run.
"""
import argparse
import http.cookiejar
import json
from pathlib import Path
import time
import urllib.request
import urllib.error
import uuid
import shutil
import os
import subprocess
import socket
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:8792')
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--resume', action='store_true')
parser.add_argument('--after-adoption', action='store_true')
parser.add_argument('--finish-handoff', action='store_true')
parser.add_argument('--completion-only', action='store_true')
parser.add_argument('--settlement-only', action='store_true')
args = parser.parse_args()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
tab = str(uuid.uuid4())
evidence = json.loads(args.out.read_text(encoding='utf-8')) if args.after_adoption or args.finish_handoff or args.completion_only or args.settlement_only else {'result': 'RUNNING', 'checks': {}}
def save():
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
def call(action=None, endpoint='call', **fields):
    payload = {**fields, **({'action': action} if action else {})}
    request = urllib.request.Request(args.url + '/api/worker/' + endpoint, json.dumps(payload).encode(),
        {'Content-Type': 'application/json', 'X-Worker-Control': '1', 'X-Worker-Tab': tab}, method='POST')
    try:
        with opener.open(request, timeout=190) as response: return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(str(error.code) + ' ' + error.read().decode()) from None
def collab(action, subject, **fields): return call('COLLABORATION', operation=dict(action=action, subjectId=subject, **fields))
def write(action, **fields): return call('WRITABLE', operation=dict(action=action, runId=rid, **fields))
def wait(get, done, label, seconds=600, allow_unknown=False):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = get()
        if done(value): return value
        if value.get('state') in ('FAILED', 'RECONCILIATION_REQUIRED', 'CANCELLED') or value.get('state') == 'UNKNOWN' and not allow_unknown:
            raise AssertionError(label + ': ' + json.dumps(value, ensure_ascii=False))
        time.sleep(1)
    raise TimeoutError(label + ': ' + json.dumps(value, ensure_ascii=False))
def budget(calls, edits=0): return dict(logicalCalls=str(calls), httpRequests=str(calls), editAttempts=str(edits))
try:
    call(endpoint='connect')
    if args.settlement_only:
        rid, sid = evidence['identity']['runId'], evidence['identity']['sessionId']
    else:
        if args.completion_only:
            rid, sid = evidence['identity']['runId'], evidence['identity']['sessionId']
        else:
            if args.finish_handoff:
                rid, sid = evidence['identity']['runId'], evidence['identity']['sessionId']
                evidence['result'] = 'RUNNING'
            else:
                if args.after_adoption:
                    rid, sid = evidence['identity']['runId'], evidence['identity']['sessionId']
                    workspace = Path(evidence['statusBeforeAdoption']['workspace'])
                    snap = evidence['snapshot']
                    evidence['result'] = 'RUNNING'
                else:
                    status = call('FIXTURE_STATUS')
                    identity = {key: status[key] for key in ('runId', 'sessionId')} if status.get('runId') else call('FIXTURE_START')
                    if 'attemptId' not in identity:
                        identity['attemptId'] = status['workerTask']['attemptId']
                    evidence['identity'] = identity
                    rid, sid = identity['runId'], identity['sessionId']
                    evidence['foundation'] = collab('FOUNDATION', sid)
                    assert evidence['foundation']['executionBinding']['attemptId'] == identity['attemptId']
                    evidence['checks']['exactWorkerBinding'] = True
                    wait(lambda: call('FIXTURE_STATUS'), lambda x: x.get('parentCalls', 0) >= 1, 'Product initialization', 180)
                    group_id = 'live-feature'
                    if not args.resume:
                        paths = ['src/main/java/com/example/crud/employee/EmployeeController.java',
                                 'src/main/java/com/example/crud/employee/EmployeeRepository.java',
                                 'src/test/java/com/example/crud/EmployeeCountApiTest.java']
                        objective = ('CHILD_WRITE_X: Implement GET /api/employees/count returning JSON {count: number}. '
                            'Omitted or blank department counts all; a nonblank department is trimmed and matches exactly, case sensitive; '
                            'unknown departments return zero. Add a JPA repository countByDepartment method and controller mapping. '
                            'Create EmployeeCountApiTest with @SpringBootTest and @AutoConfigureMockMvc and @Transactional, '
                            'using repository.deleteAll() and two Engineering and one HR employees with distinct valid emails. '
                            'Test total=3, Engineering=2, HR=1, unknown=0, lowercase engineering=0, whitespace trimmed and blank=3. '
                            'Read existing files and preserve CRUD behavior. Use workspace_read/write/edit; do not run processes. '
                            'All edits must be within the three authorized paths. Finish after writing source and test.')
                        graph = dict(schemaVersion='collaboration-graph/1', samePathMode='REJECT', requestedParallelism=1,
                            units=[dict(unitId='employee-count', kind='WRITE_CANDIDATE', objective=objective, required=True,
                                allowNoChanges=False, readScope=['src', 'pom.xml'], writeScope=paths, dependsOn=[])])
                        created = write('CREATE', key=group_id, body=dict(requestId=group_id, expectedExecutionEpoch='1', graph=graph))
                        grant = write('AUTHORIZE', groupId=group_id, key='live-grant', body=dict(requestId='live-grant',
                            expectedGraphRevision=created['revision'], graphFingerprint=created['graphFingerprint'],
                            adoptionMode='USER_CONFIRM', retryLimit=0, repairLimit=0, integrationReserve=budget(1, 1),
                            repairReserve=budget(0), units=[dict(unitId='employee-count', total=budget(20, 8), perAttempt=budget(20, 8))]))
                        group = write('GROUP', groupId=group_id)
                        write('START', groupId=group_id, key='live-start', body=dict(startId='live-start',
                            expectedGraphRevision=group['revision'], grantFingerprint=grant['grantFingerprint'], expectedExecutionEpoch='1'))
                        call('FIXTURE_RELEASE')
                    else:
                        run = call('RUN', id=rid)
                        if run.get('sourceStatus') == 'PAUSED_FOR_HUMAN':
                            call('COMMAND', runId=rid, key='live-resume-freeze', intent='RESUME', version=run['stateVersion'])
                        wait(lambda: call('RUN', id=rid), lambda x: x.get('sourceStatus') == 'RUNNING', 'Resume parent')
                        group = write('GROUP', groupId=group_id)
                        if group.get('state') == 'SUSPENDED':
                            write('START', groupId=group_id, key='live-restart-after-pause', body=dict(startId='live-restart-after-pause', expectedGraphRevision=group['revision'], grantFingerprint=group['grantFingerprint'], expectedExecutionEpoch='1'))
                    print('Worker bound; isolated real-model candidate running', flush=True); save()
                    ready = wait(lambda: write('GROUP', groupId=group_id), lambda x: x.get('state') == 'READY', 'Real-model candidate', 900)
                    evidence['groupBeforeAdoption'] = ready; save()
                    run = call('RUN', id=rid)
                    if run.get('sourceStatus') != 'PAUSED_FOR_HUMAN':
                        call('COMMAND', runId=rid, key='live-pause-after-child', intent='PAUSE', version=run['stateVersion'])
                        call('FIXTURE_RELEASE')
                        evidence['pause'] = wait(lambda: call('COMMAND_RECEIPT', id=rid, entityId='live-pause-after-child'), lambda x: x.get('phase') == 'APPLIED', 'PAUSE receipt')
                    evidence['checks']['pauseApplied'] = True
                    snap = collab('FREEZE_SNAPSHOT', sid, key='live-snapshot-adoption', body={})
                    evidence['snapshot'] = snap
                    evidence['snapshotItems'] = call('SNAPSHOT_ITEMS', id=sid, entityId=snap['snapshotId'])

                    status = call('FIXTURE_STATUS'); evidence['statusBeforeAdoption'] = status
                    workspace = Path(status['workspace'])
                    assert '"/count"' not in (workspace / paths[0]).read_text(encoding='utf-8')
                    evidence['checks']['candidateDidNotModifyParent'] = True
                    chosen = [dict(unitId=c['unitId'], candidateId=c['candidateId'], candidateFingerprint=c['candidateFingerprint']) for c in ready['candidates']]
                    assert len(chosen) == 1
                    selected = write('SELECT', groupId=group_id, key='live-select', body=dict(selectionId='live-select', expectedGraphRevision=ready['revision'], units=chosen))
                    preview = write('PREVIEW', groupId=group_id, entityId='live-select', key='live-preview',
                        body=dict(previewId='live-preview', selectionFingerprint=selected['selectionFingerprint'], mode='STRICT'))
                    assert preview['state'] == 'READY', preview
                    evidence['preview'] = preview
                    run = call('RUN', id=rid)
                    evidence['modelCallsBeforeAdoption'] = call('FIXTURE_STATUS')['forwardedCalls']
                    write('ADOPT', groupId=group_id, key='live-adopt', body=dict(adoptionId='live-adopt',
                        expectedRunStateVersion=str(run['stateVersion']), expectedExecutionEpoch='1', selectionId='live-select',
                        selectionFingerprint=selected['selectionFingerprint'], previewId='live-preview',
                        previewFingerprint=preview['previewFingerprint'], mode='STRICT'))
                    adopted = wait(lambda: write('ADOPTION', groupId=group_id, entityId='live-adopt'), lambda x: x.get('state') == 'ADOPTED', 'Real Maven integration verification', 600)
                    evidence['adoption'] = adopted
                    assert adopted['contentApplied'] and adopted['verificationPassed'] and adopted['contextCommitted'], adopted
                    assert evidence['modelCallsBeforeAdoption'] == call('FIXTURE_STATUS')['forwardedCalls']
                    evidence['checks']['adoptWhilePausedWithoutModelCalls'] = True
                    evidence['checks']['realIntegrationVerificationPassed'] = True
                    print('Real model candidate adopted; production verification and context commit passed', flush=True); save()
                # Independent acceptance copies the actual adopted bytes, not the model's claims.
                acceptance = args.out.parent.resolve() / 'acceptance'
                acceptance.mkdir(exist_ok=True)
                shutil.copy2(workspace / 'pom.xml', acceptance / 'pom.xml')
                shutil.copytree(workspace / 'src', acceptance / 'src', dirs_exist_ok=True)
                heldout = acceptance / 'src/test/java/com/example/crud/WorkerHeldOutCountTest.java'
                heldout.write_text('''package com.example.crud;
            import com.example.crud.employee.EmployeeRepository;
            import org.junit.jupiter.api.Test;
            import org.springframework.beans.factory.annotation.Autowired;
            import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
            import org.springframework.boot.test.context.SpringBootTest;
            import org.springframework.test.web.servlet.MockMvc;
            import org.springframework.transaction.annotation.Transactional;
            import org.springframework.http.MediaType;
            import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
            import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
            @SpringBootTest @AutoConfigureMockMvc @Transactional
            class WorkerHeldOutCountTest {
             @Autowired MockMvc api; @Autowired EmployeeRepository repository;
             @Test void operatorHeldOutAcceptance() throws Exception {
              repository.deleteAll();
              api.perform(get("/api/employees/count")).andExpect(status().isOk()).andExpect(jsonPath("$.count").value(0));
              for(int i=0;i<3;i++) api.perform(post("/api/employees").contentType(MediaType.APPLICATION_JSON)
                .content("{\\"name\\":\\"E2E"+i+"\\",\\"email\\":\\"e2e"+i+"@example.com\\",\\"department\\":\\""+(i<2?"Engineering":"HR")+"\\",\\"role\\":\\"Tester\\"}"))
                .andExpect(status().isCreated());
              api.perform(get("/api/employees/count")).andExpect(status().isOk()).andExpect(jsonPath("$.count").value(3));
              String[] filters={"Engineering","HR","Unknown","engineering","  Engineering  ","   "};
              int[] expected={2,1,0,0,2,3};
              for(int i=0;i<filters.length;i++) api.perform(get("/api/employees/count").param("department",filters[i]))
                .andExpect(status().isOk()).andExpect(jsonPath("$.count").value(expected[i]));
              api.perform(get("/api/employees")).andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(3));
             }
            }''', encoding='utf-8')
                maven = shutil.which('mvn')
                with (acceptance / 'maven.log').open('w', encoding='utf-8') as log:
                    checked = subprocess.run([maven, '-B', '-ntp', '-o', 'package'], cwd=acceptance, stdout=log, stderr=subprocess.STDOUT, timeout=240)
                assert checked.returncode == 0, 'Independent Maven acceptance failed; inspect acceptance/maven.log'
                reports = [ET.parse(file).getroot() for file in (acceptance / 'target/surefire-reports').glob('TEST-*.xml')]
                evidence['externalTests'] = dict(tests=sum(int(x.attrib['tests']) for x in reports),
                    failures=sum(int(x.attrib['failures']) + int(x.attrib['errors']) for x in reports))
                assert evidence['externalTests']['failures'] == 0 and evidence['externalTests']['tests'] >= 4
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0)); app_port = sock.getsockname()[1]
                jars = [file for file in (acceptance / 'target').glob('*.jar') if not file.name.endswith('.original')]
                with (acceptance / 'application.log').open('w', encoding='utf-8') as log:
                    java = str(Path(os.environ['JAVA_HOME']) / 'bin/java.exe') if os.environ.get('JAVA_HOME') else shutil.which('java')
                    app = subprocess.Popen([java, '-jar', str(jars[0]), '--server.address=127.0.0.1', '--server.port=' + str(app_port)], cwd=acceptance, stdout=log, stderr=subprocess.STDOUT)
                    try:
                        end = time.monotonic() + 60
                        while True:
                            try:
                                with urllib.request.urlopen(f'http://127.0.0.1:{app_port}/api/employees/count', timeout=2) as response:
                                    count = json.load(response)
                                break
                            except Exception:
                                if time.monotonic() > end or app.poll() is not None: raise
                                time.sleep(1)
                        assert isinstance(count['count'], int)
                        with urllib.request.urlopen(f'http://127.0.0.1:{app_port}/api/employees/count?department=E2E_DOES_NOT_EXIST', timeout=5) as response:
                            assert json.load(response) == {'count': 0}
                        evidence['checks']['packagedSpringBootHttpPassed'] = True
                    finally:
                        app.terminate()
                        try: app.wait(timeout=10)
                        except subprocess.TimeoutExpired: app.kill(); app.wait()
                # Real auxiliary Q&A on frozen material stays independent of the paused parent.
                pack = collab('CREATE_PACKAGE', sid, key='live-package', body=dict(requestId='live-package', snapshotId=snap['snapshotId']))
                aux = collab('CREATE_AUX', sid, key='live-aux', body=dict(requestId='live-aux', basePackageId=pack['packageId']))
                collab('TURN', aux['sessionId'], key='live-question', body=dict(turnId='live-question', expectedSessionVersion='1', packageId=pack['packageId'],
                    question='Based only on the frozen context, identify the employee count requirement and three useful edge cases. Be concise; do not claim test results not present in the evidence.'))
                evidence['auxiliary'] = wait(lambda: collab('TURN_RESULT', aux['sessionId'], entityId='live-question'), lambda x: x.get('state') == 'SUCCEEDED', 'Real auxiliary answer', 180)
                assert evidence['auxiliary'].get('answer')
                run = call('RUN', id=rid)
                assert run.get('sourceStatus') == 'PAUSED_FOR_HUMAN'
                before_calls = call('FIXTURE_STATUS')['parentCalls']
                call('COMMAND', runId=rid, key='live-resume-adopted', intent='RESUME', version=run['stateVersion'])
                evidence['resume'] = wait(lambda: call('COMMAND_RECEIPT', id=rid, entityId='live-resume-adopted'), lambda x: x.get('phase') == 'APPLIED', 'Real resume receipt', 120)
                wait(lambda: call('FIXTURE_STATUS'), lambda x: x['parentCalls'] > before_calls, 'Resumed Product reached model', 120)
                evidence['checks']['resumeSameWorkerRun'] = True
            if not args.finish_handoff:
                profiles = call('PROFILES')['profiles']
                reviewer = next(profile for profile in profiles if profile['id'] == 'reviewer')
                transition = dict(transitionId='live-handoff', target=dict(agentProfileId='reviewer', agentProfileRevision=reviewer['revision']))
                preflight = collab('PREFLIGHT', rid, body=transition)
                transition.update(preflightDigest=preflight['preflightDigest'], expectedExecutionEpoch='1',
                    expectedRunStateVersion=preflight['runStateVersion'], expectedModelSettingsRevision=preflight['modelSettingsRevision'])
                collab('HANDOFF', rid, key='live-handoff', body=transition)
            # Ensure the accepted handoff has actually requested pause before the model gate opens.
            wait(lambda: collab('HANDOFF_RESULT', rid, entityId='live-handoff'), lambda x: x.get('state') in ('QUIESCING', 'PREPARED', 'ACTIVATING', 'ACTIVE', 'UNKNOWN'), 'Handoff quiescence request', 60)
            call('FIXTURE_RELEASE')
            evidence['handoff'] = wait(lambda: collab('HANDOFF_RESULT', rid, entityId='live-handoff'), lambda x: x.get('state') == 'ACTIVE', 'Reviewer activation', 180, allow_unknown=True)
            evidence['segments'] = collab('SEGMENTS', rid)
            evidence['checks']['handoffActiveSameRun'] = True
            evidence['result'] = 'ACTIVE_PENDING_COMPLETION'; save()
            print('Independent Maven/HTTP, real auxiliary, resume and reviewer handoff passed', flush=True)
        advice = ('Operator acceptance of the actual adopted bytes has passed: Maven package ran '
            + str(evidence['externalTests']['tests']) + ' tests with zero failures; the packaged Spring Boot app served the count endpoint and returned zero for an unknown department. '
            'The collaboration receipt live-adopt is ADOPTED with contentApplied, verificationPassed and contextCommitted all true. '
            'verification:live-adopt:VERIFY is an opaque collaboration proof reference, not a native verification_inspect recordId. '
            'Do not retry that lookup or run more tools. The required candidate is adopted and verified. Finish with a concise final report of the implemented endpoint and the actual evidence.')
        evidence['completionAdvice'] = collab('BOUNDARY', rid, key='live-completion-advice', body=dict(
            schemaVersion='run-boundary-request/1', requestId='live-completion-advice', kind='CONTEXT_ADVICE',
            expectedExecutionEpoch=evidence['handoff']['targetEpoch'], text=advice, sourceRefs=[]))
        save()
        call('FIXTURE_FINISH')
        evidence['run'] = wait(lambda: call('RUN', id=rid), lambda x: x.get('state') in ('COMPLETED', 'SUCCEEDED'), 'Real reviewer completed original goal', 240)
    evidence['finalStatus'] = wait(lambda: call('FIXTURE_STATUS'), lambda x: x.get('workerFinish', {}).get('finishState') in ('DELIVERY_ACCEPTED', 'AUDIT_CONFIRMED'), 'Worker delivery settlement', 180)
    assert evidence['finalStatus']['runId'] == rid
    assert evidence['finalStatus']['workerFinish']['artifacts']
    assert all(state == 'VERIFIED' for state in evidence['finalStatus']['workerFinish']['artifacts'].values())
    evidence['completionAdvice'] = collab('BOUNDARY_RESULT', rid, entityId='live-completion-advice')
    assert evidence['completionAdvice']['state'] == 'CONSUMED'
    evidence['checks']['explicitBoundaryAdviceConsumed'] = True
    evidence['checks']['workerDeliverySettled'] = True
    evidence.pop('error', None)
    evidence['result'] = 'PASS'
    print('REAL_MODEL_REAL_PROJECT_E2E_PASS', flush=True); save()
except BaseException as error:
    evidence['result'] = 'FAIL'
    evidence['error'] = str(error)
    save()
    raise
