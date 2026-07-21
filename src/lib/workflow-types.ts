export type WorkflowSurface =
  | 'api-endpoint'
  | 'extension'
  | 'schema'
  | 'record-data'
  | 'dynamic-script'
  | 'route-access'
  | 'guards-permissions-rules'
  | 'flow'
  | 'websocket'
  | 'graphql'
  | 'storage-file'
  | 'oauth'
  | 'identity-access'
  | 'platform-config'
  | 'package'
  | 'cache'
  | 'logs-debug'
  | 'auth-context';

export type WorkflowDetail = 'summary' | 'plan' | 'full';

export type AvoidToolRule = {
  tool: string;
  when: string;
  useInstead: string;
  reason: string;
};

export type WorkflowPathStep = {
  order: number;
  tool: string;
  purpose: string;
  when?: string;
  stopWhen?: string;
};

export type ToolWorkflow = {
  key: WorkflowSurface;
  title: string;
  useWhen: string[];
  keywords: string[];
  firstTools: string[];
  inspectTools: string[];
  knowledgeTools: string[];
  writeTools: string[];
  verifyTools: string[];
  avoidTools: AvoidToolRule[];
  requiredAck: string[];
  exampleCategories: string[];
  nextStepTemplate: string[];
  recommendedScope: string;
};

export type WorkflowRouteOptions = {
  intent?: string;
  surface?: string;
  risk?: string;
  detail?: string;
  limit?: number;
};

export type WorkflowProfile = 'all' | 'extension' | 'schema' | 'runtime' | 'operations';
