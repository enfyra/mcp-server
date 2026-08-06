export type PermissionRiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type PermissionDataClassification = 'unknown' | 'public' | 'internal' | 'sensitive' | 'secret';

export type PermissionExposureFinding =
  | 'aligned'
  | 'visible_server_denied'
  | 'hidden_server_authority'
  | 'public_sensitive_authority';

export interface PermissionExposureInput {
  uiVisible: boolean;
  serverAllowed: boolean;
  serverPublic?: boolean;
  dataClassification?: PermissionDataClassification;
  context?: string;
}

export interface PermissionExposureAssessment {
  state: 'visible_allowed' | 'visible_denied' | 'hidden_allowed' | 'hidden_denied';
  risk: PermissionRiskLevel;
  finding: PermissionExposureFinding;
  blocked: boolean;
  requiresExplicitReview: boolean;
  message: string;
  context: string | null;
}
