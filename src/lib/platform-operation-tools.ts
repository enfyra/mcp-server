export {
  applyExtensionCodePatches,
  assertFixedFlowStepConfigIsStatic,
  buildExtensionAccountPanelSnippet,
  buildExtensionApiUsageSnippet,
  buildExtensionConfirmSnippet,
  buildExtensionDrawerSnippet,
  buildExtensionEmptyStateSnippet,
  buildExtensionFormEditorSnippet,
  buildExtensionMenuNotificationSnippet,
  buildExtensionModalSnippet,
  buildExtensionNotifySnippet,
  buildExtensionPageShellSnippet,
  buildExtensionPatchDiffArtifact,
  buildExtensionPermissionGateSnippet,
  buildExtensionResourceGridSnippet,
  buildExtensionResourceListSnippet,
  buildExtensionTabsSnippet,
  buildExtensionUiSnippet,
  buildExtensionUploadModalSnippet,
  buildExtensionWidgetSnippet,
  buildExtensionRuntimeVerification,
  reviewExtensionRuntimeContract,
  reviewExtensionThemeContract,
  reviewExtensionUiContract,
  summarizeWorkflowOperation,
  validateExtensionCode,
  validateExtensionCodeLocally,
  verifyExtensionRuntime,
} from './platform-operation-logic.js';
import { registerPlatformExtensionTools } from './platform-extension-tools.js';
import { registerPlatformFlowTools } from './platform-flow-tools.js';
import { registerPlatformPolicyTools } from './platform-policy-tools.js';
import { registerPlatformResourceTools } from './platform-resource-tools.js';
import { registerPlatformRouteTools } from './platform-route-tools.js';
import { registerPlatformWebsocketTools } from './platform-websocket-tools.js';

export function registerPlatformOperationTools(server, ENFYRA_API_URL) {
  registerPlatformExtensionTools(server, ENFYRA_API_URL);
  registerPlatformRouteTools(server, ENFYRA_API_URL);
  registerPlatformPolicyTools(server, ENFYRA_API_URL);
  registerPlatformWebsocketTools(server, ENFYRA_API_URL);
  registerPlatformFlowTools(server, ENFYRA_API_URL);
  registerPlatformResourceTools(server, ENFYRA_API_URL);
}
