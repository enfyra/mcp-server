import type { UnknownRecord } from './types.js';

export type RestProjectionAccess = 'authenticated' | 'anonymous' | 'compare';
export type ProjectionPathPresence = 'present' | 'missing' | 'indeterminate' | 'no_rows' | 'not_evaluated';

export interface RestProjectionHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: unknown;
}

export interface InspectRestProjectionInput {
  tableName: string;
  fields: string[];
  routePath?: string;
  filter?: UnknownRecord;
  sort?: string;
  deep?: UnknownRecord;
  limit?: number;
  access?: RestProjectionAccess;
}

export interface RestProjectionDependencies {
  loadTable?: (tableName: string) => Promise<UnknownRecord>;
  request?: (url: string, authenticated: boolean) => Promise<RestProjectionHttpResponse>;
}
