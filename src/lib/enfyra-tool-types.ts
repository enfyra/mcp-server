export type AnyRecord = Record<string, any>;

export type MethodPatchBody = {
  buttonColor?: string;
  textColor?: string;
  name?: string;
};

export type RouteCreateBody = {
  path: string;
  isEnabled: boolean;
  description: string;
  availableMethods: any;
  mainTable?: { id: any };
  publicMethods?: any;
};

export type RouteHandlerBody = {
  route: { id: string | number };
  method: { id: any };
  sourceCode: string;
  scriptLanguage: 'javascript' | 'typescript';
  timeout?: number;
};
