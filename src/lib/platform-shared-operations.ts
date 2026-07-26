export type { AnyRecord, FlowStepBody, HandlerBody, MethodIdNameMap, MethodMap, RouteHandlerBody, RouteMethodBody, WorkflowNextStep } from './platform-operation-types.js';

export function jsonText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
