export type AnyRecord = Record<string, any>;

export type MethodMap = Record<string, string | number>;

export type MethodIdNameMap = Record<string, string>;

export type RouteMethodBody = {
  availableMethods: Array<{ id: string | number }>;
  publicMethods: Array<{ id: string | number }>;
  isEnabled?: boolean;
};

export type FlowStepBody = {
  key: any;
  type: any;
  stepOrder: any;
  config: any;
  timeout: any;
  isEnabled: any;
  flow: { id: any };
  sourceCode?: any;
  scriptLanguage?: any;
};

export type HandlerBody = {
  sourceCode: any;
  scriptLanguage: any;
  timeout?: any;
};

export type RouteHandlerBody = HandlerBody & {
  route: { id: any };
  method: { id: any };
};

export type WorkflowNextStep = {
  tool: string;
  input: AnyRecord;
  reason?: string;
  stepId?: string;
  requiresKnowledgeAck?: string;
  requiredAckParams?: string[];
};
