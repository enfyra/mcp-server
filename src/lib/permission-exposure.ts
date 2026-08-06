import type {
  PermissionDataClassification,
  PermissionExposureAssessment,
  PermissionExposureInput,
} from './permission-exposure-types.js';

function hiddenAuthorityRisk(
  serverPublic: boolean,
  dataClassification: PermissionDataClassification,
) {
  if (serverPublic || dataClassification === 'secret') return 'critical' as const;
  if (dataClassification === 'sensitive') return 'high' as const;
  if (dataClassification === 'public') return 'medium' as const;
  return 'high' as const;
}

export function assessPermissionExposure({
  uiVisible,
  serverAllowed,
  serverPublic = false,
  dataClassification = 'unknown',
  context,
}: PermissionExposureInput): PermissionExposureAssessment {
  const state = `${uiVisible ? 'visible' : 'hidden'}_${serverAllowed ? 'allowed' : 'denied'}` as PermissionExposureAssessment['state'];

  if (serverAllowed && serverPublic && ['sensitive', 'secret'].includes(dataClassification)) {
    return {
      state,
      risk: 'critical',
      finding: 'public_sensitive_authority',
      blocked: true,
      requiresExplicitReview: true,
      message: 'The server exposes sensitive authority publicly. UI visibility cannot mitigate an anonymous API exposure.',
      context: context || null,
    };
  }

  if (serverAllowed && !uiVisible) {
    return {
      state,
      risk: hiddenAuthorityRisk(serverPublic, dataClassification),
      finding: 'hidden_server_authority',
      blocked: true,
      requiresExplicitReview: true,
      message: 'The UI hides this capability while the server still grants authority. Remove or narrow server access, or make the UI visibility intentional and explicit.',
      context: context || null,
    };
  }

  if (!serverAllowed && uiVisible) {
    return {
      state,
      risk: 'low',
      finding: 'visible_server_denied',
      blocked: false,
      requiresExplicitReview: true,
      message: 'The UI is visible but the server denies the call. This may be an intentional UX/API boundary; keep backend authority enforced and label the expected 403.',
      context: context || null,
    };
  }

  return {
    state,
    risk: 'none',
    finding: 'aligned',
    blocked: false,
    requiresExplicitReview: false,
    message: 'UI visibility and server authority are aligned for this scope.',
    context: context || null,
  };
}
