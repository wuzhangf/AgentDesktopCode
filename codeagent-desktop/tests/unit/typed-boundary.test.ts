import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  DesktopApi,
  DesktopResult,
  DiffPageResponse as DesktopDiffPageResponse,
  MissionCreateRequest as DesktopMissionCreateRequest,
  MissionResponse as DesktopMissionResponse,
  ProductSettingsResponse as DesktopProductSettingsResponse,
  SpecCreateRequest as DesktopSpecCreateRequest,
  SpecResponse as DesktopSpecResponse,
  WorkspaceExecutionCreateRequest as DesktopWorkspaceExecutionCreateRequest,
  WorkspaceExecutionResponse as DesktopWorkspaceExecutionResponse,
  ExecutionPolicyResponse as DesktopExecutionPolicyResponse,
  ApprovalsListResponse as DesktopApprovalsListResponse,
  AutomationControlResponse as DesktopAutomationControlResponse
} from '../../electron/shared/api-types';
import type {
  FixTaskResponse as ProtocolFixTaskResponse,
  FileReadResponse as ProtocolFileReadResponse,
  KnowledgeItemResponse as ProtocolKnowledgeItemResponse,
  PolicyLayersResponse as ProtocolPolicyLayersResponse,
  ReviewRunResponse as ProtocolReviewRunResponse,
  MissionCreateRequest as ProtocolMissionCreateRequest,
  MissionResponse as ProtocolMissionResponse,
  SpecCreateRequest as ProtocolSpecCreateRequest,
  SpecResponse as ProtocolSpecResponse,
  WorkspaceExecutionCreateRequest as ProtocolWorkspaceExecutionCreateRequest,
  ExecutionPolicyResponse as ProtocolExecutionPolicyResponse,
  ExecutionPolicyUpdateRequest as ProtocolExecutionPolicyUpdateRequest,
  ApprovalDecisionRequest as ProtocolApprovalDecisionRequest,
  AutomationControlRequest as ProtocolAutomationControlRequest,
  AutomationControlResponse as ProtocolAutomationControlResponse
} from '../../packages/protocol/src/index';
import type { ServiceClient } from '../../packages/service-client/src/index';

describe('FC2 typed desktop boundary', () => {
  it('exposes concrete DTOs for diff, review, workspace, mission, settings and knowledge', () => {
    expectTypeOf<DesktopApi['getRunDiff']>().returns.resolves.toEqualTypeOf<DesktopResult<DesktopDiffPageResponse>>();
    expectTypeOf<DesktopApi['getRunReview']>().returns.resolves.toEqualTypeOf<DesktopResult<ProtocolReviewRunResponse>>();
    expectTypeOf<DesktopApi['createWorkspaceExecution']>().returns.resolves.toEqualTypeOf<DesktopResult<DesktopWorkspaceExecutionResponse>>();
    expectTypeOf<DesktopApi['createMission']>().returns.resolves.toEqualTypeOf<DesktopResult<DesktopMissionResponse>>();
    expectTypeOf<DesktopApi['getProductSettings']>().returns.resolves.toEqualTypeOf<DesktopResult<DesktopProductSettingsResponse>>();
    expectTypeOf<DesktopApi['listKnowledge']>().returns.resolves.toEqualTypeOf<DesktopResult<import('../../electron/shared/api-types').KnowledgeListResponse>>();
    expectTypeOf<DesktopApi['getExecutionPolicy']>().returns.resolves.toEqualTypeOf<DesktopResult<DesktopExecutionPolicyResponse>>();
    expectTypeOf<DesktopApi['listApprovals']>().returns.resolves.toEqualTypeOf<DesktopResult<DesktopApprovalsListResponse>>();
    expectTypeOf<DesktopApi['getAutomationControl']>().returns.resolves.toEqualTypeOf<DesktopResult<DesktopAutomationControlResponse>>();
    expectTypeOf<DesktopApi['controlAutomation']>().returns.resolves.toEqualTypeOf<DesktopResult<DesktopAutomationControlResponse>>();
  });

  it('uses generated request and response models in ServiceClient', () => {
    expectTypeOf<Parameters<ServiceClient['createSpec']>[1]>().toEqualTypeOf<ProtocolSpecCreateRequest>();
    expectTypeOf<Awaited<ReturnType<ServiceClient['createSpec']>>>().toEqualTypeOf<ProtocolSpecResponse>();
    expectTypeOf<Parameters<ServiceClient['createMission']>[1]>().toEqualTypeOf<ProtocolMissionCreateRequest>();
    expectTypeOf<Awaited<ReturnType<ServiceClient['createMission']>>>().toEqualTypeOf<ProtocolMissionResponse>();
    expectTypeOf<Parameters<ServiceClient['createWorkspaceExecution']>[0]>().toEqualTypeOf<ProtocolWorkspaceExecutionCreateRequest>();
    expectTypeOf<Awaited<ReturnType<ServiceClient['getRunReview']>>>().toEqualTypeOf<ProtocolReviewRunResponse>();
    expectTypeOf<Awaited<ReturnType<ServiceClient['readProjectFile']>>>().toEqualTypeOf<ProtocolFileReadResponse>();
    expectTypeOf<Awaited<ReturnType<ServiceClient['createFixTask']>>>().toEqualTypeOf<ProtocolFixTaskResponse>();
    expectTypeOf<Awaited<ReturnType<ServiceClient['suggestKnowledge']>>>().toEqualTypeOf<ProtocolKnowledgeItemResponse>();
    expectTypeOf<Awaited<ReturnType<ServiceClient['listPolicyLayers']>>>().toEqualTypeOf<ProtocolPolicyLayersResponse>();
    expectTypeOf<Parameters<ServiceClient['updateExecutionPolicy']>[1]>().toEqualTypeOf<ProtocolExecutionPolicyUpdateRequest>();
    expectTypeOf<Parameters<ServiceClient['decideApproval']>[1]>().toEqualTypeOf<ProtocolApprovalDecisionRequest>();
    expectTypeOf<Parameters<ServiceClient['controlAutomation']>[1]>().toEqualTypeOf<ProtocolAutomationControlRequest>();
    expectTypeOf<Awaited<ReturnType<ServiceClient['getExecutionPolicy']>>>().toEqualTypeOf<ProtocolExecutionPolicyResponse>();
    expectTypeOf<Awaited<ReturnType<ServiceClient['getAutomationControl']>>>().toEqualTypeOf<ProtocolAutomationControlResponse>();
    expectTypeOf<Awaited<ReturnType<ServiceClient['getOperationReceipt']>>>().toMatchTypeOf<Record<string, unknown>>();
    expectTypeOf<Awaited<ReturnType<ServiceClient['getEventSnapshot']>>>().toMatchTypeOf<Record<string, unknown>>();
  });

  it('is a runtime test target so the compile-time assertions are executed by the desktop suite', () => {
    expect(true).toBe(true);
  });
});
