export type AuthHeaderCredentialType = 'pat' | 'jwt';

export type AuthHeaderScheme = 'raw' | 'bearer';

export type AuthHeaderRecord = {
  id: string | number;
  headerKey: string;
  credentialType: AuthHeaderCredentialType;
  scheme: AuthHeaderScheme;
  priority: number;
  isEnabled: boolean;
  isSystem: boolean;
  description?: string | null;
};

export type EnsureAuthHeaderInput = {
  headerKey: string;
  credentialType?: AuthHeaderCredentialType;
  scheme?: AuthHeaderScheme;
  priority?: number;
  isEnabled?: boolean;
  description?: string | null;
  globalRulesAckKey?: string;
};

export type ReorderAuthHeadersInput = {
  updates: Array<{ id: string | number; priority: number }>;
  globalRulesAckKey?: string;
};
