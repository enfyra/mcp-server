import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readEntrySource,
  readExamplesSource,
  readPlatformSource,
  readRoutingSource,
  readRuntimeZoneSource,
  readSchemaSource,
  readSourceFiles,
  readSourceTree,
} from '../test-support/source-tree.js';
import { initAuth, resetTokens } from '../dist/lib/auth.js';
import { fetchAPI } from '../dist/lib/fetch.js';
import {
  buildColumnDefinition,
  assertColumnContractBroadening,
  assertIndexesDoNotReferenceUniqueFields,
  buildPrimaryColumnForDbType,
  computeBatchCleanupOrder,
  fetchTableWithDetails,
  getSupportedColumnTypesFromMetadata,
  normalizeColumnsForLiveMetadata,
  normalizeColumnTypeForLiveMetadata,
  normalizeRelationForTablePatch,
  normalizeRelationType,
  registerTableTools,
  resolveTableIdentifierFromMetadata,
  resolveRelationTargetsFromMetadata,
  resolveTableFromMetadata,
  resolveTableFromMetadataByName,
  sanitizeExistingRelationForTablePatch,
} from '../dist/lib/table-tools.js';
import { prepareRecordBatchMutation, prepareRecordMutation, validatePortableScriptSource } from '../dist/lib/mutation-guards.js';
import { validateMainTableRoutePath } from '../dist/lib/route-guards.js';
import {
  DYNAMIC_CODE_KNOWLEDGE_ACK_KEY,
  GLOBAL_RULES_ACK_KEY,
  buildRequiredKnowledgePayload,
} from '../dist/lib/required-knowledge.js';
import { WORKFLOW_SURFACES, discoverWorkflowRoutes, listWorkflowSurfaces } from '../dist/lib/tool-routing.js';
import {
  findRoutePermission,
  mergeMethodNames,
  resolveRoleByNameOrId,
  routePermissionMatchesScope,
  summarizeRouteAccess,
  validateMethodsForRoute,
} from '../dist/lib/route-permission-tools.js';

test('mcp server exposes update_script_source for raw source updates', () => {
  const entry = readEntrySource();
  assert.match(entry, /server\.tool\(\s*['"]update_script_source['"]/);
  assert.match(entry, /JSON\.stringify\(\{ sourceCode, scriptLanguage \}\)/);
  assert.match(entry, /updated_script_source/);
});

test('mcp server exposes script source inspection and patch tools', () => {
  const entry = readEntrySource();
  assert.match(entry, /server\.tool\(\s*['"]get_script_source['"]/);
  assert.match(entry, /server\.tool\(\s*['"]patch_script_source['"]/);
  assert.match(entry, /expectedSourceSha256/);
  assert.match(entry, /patch_script_source_preview/);
});

test('mcp server exposes metadata usage tracing for production script edits', () => {
  const entry = readEntrySource();
  assert.match(entry, /server\.tool\(\s*['"]trace_metadata_usage['"]/);
  assert.match(entry, /scriptReadErrors/);
  assert.match(entry, /get_script_source/);
  assert.match(entry, /route\.path/);
  assert.match(entry, /flow\.name/);
  assert.match(entry, /gateway\.path/);
});

test('code-writing tools require session or explicit required-knowledge acknowledgement without blocking discovery or validation', () => {
  const entry = readEntrySource();
  const platformTools = readPlatformSource();
  const requiredKnowledge = readSourceFiles('lib/required-knowledge.ts');
  const instructions = readSourceFiles('lib/mcp-instructions.ts');

  assert.match(entry, /server\.tool\(\s*['"]get_enfyra_required_knowledge['"]/);
  assert.match(entry, /server\.tool\(\s*['"]discover_enfyra_workflows['"]/);
  assert.match(entry, /discoverWorkflowRoutes/);
  assert.match(entry, /detail: z\.enum\(\['summary', 'plan', 'full'\]/);
  assert.match(entry, /avoidTools negative-routing boundaries/);
  assert.match(requiredKnowledge, /GLOBAL_RULES_ACK_KEY/);
  assert.match(requiredKnowledge, /globalRulesAckKey/);
  assert.match(requiredKnowledge, /Call get_enfyra_required_knowledge/);
  assert.match(requiredKnowledge, /DYNAMIC_CODE_KNOWLEDGE_ACK_KEY/);
  assert.match(requiredKnowledge, /EXTENSION_KNOWLEDGE_ACK_KEY/);
  assert.match(requiredKnowledge, /secure-vs-trusted-repositories/);
  assert.match(requiredKnowledge, /theme-contract-first/);
  assert.match(instructions, /get_enfyra_required_knowledge/);
  assert.match(instructions, /discover_enfyra_workflows/);
  assert.match(instructions, /known non-destructive task/);
  assert.match(instructions, /Session acknowledgement removes repeated keys/);

  assert.match(entry, /server\.tool\(\s*['"]create_records['"]/);
  assert.match(entry, /server\.tool\(\s*['"]update_records['"]/);
  assert.match(entry, /server\.tool\(\s*['"]delete_records['"]/);
  assert.match(entry, /create_records[\s\S]*prepareGenericBatchMutation/);
  assert.match(entry, /create_records[\s\S]*sequential/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_record['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]update_record['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]delete_record['"]/);
  assert.match(entry, /create_records[\s\S]*knowledgeAckKey/);
  assert.match(entry, /update_records[\s\S]*extensionKnowledgeAckKey/);
  assert.match(entry, /delete_records[\s\S]*globalRulesAckKey/);
  assert.match(entry, /SCRIPT_BACKED_TABLE_SET\.has\(tableName\)/);
  assert.match(entry, /patch_script_source[\s\S]*apply[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(entry, /update_script_source[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(entry, /create_handler[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(entry, /create_pre_hook[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(entry, /create_post_hook[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);

  assert.match(platformTools, /set_table_graphql[\s\S]*globalRulesAckKey/);
  assert.match(platformTools, /api_endpoint_workflow[\s\S]*knowledgeAckKey/);
  assert.match(platformTools, /api_endpoint_workflow[\s\S]*globalRulesAckKey/);
  assert.match(platformTools, /apply \|\| opts\.applyAll[\s\S]*assertGlobalRulesAck/);
  assert.match(platformTools, /applyAll[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(platformTools, /create_api_endpoint[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(platformTools, /ensure_websocket_gateway[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAckIf/);
  assert.match(platformTools, /ensure_websocket_event[\s\S]*assertGlobalRulesAck[\s\S]*assertDynamicCodeKnowledgeAck/);
  assert.match(platformTools, /ensure_script_flow_step[\s\S]*knowledgeAckKey/);
  assert.match(platformTools, /ensure_condition_flow_step[\s\S]*knowledgeAckKey/);
  assert.match(platformTools, /ensure_page_extension[\s\S]*globalRulesAckKey[\s\S]*extensionKnowledgeAckKey/);
  assert.match(platformTools, /ensure_global_extension[\s\S]*globalRulesAckKey[\s\S]*extensionKnowledgeAckKey/);
  assert.match(platformTools, /ensure_widget_extension[\s\S]*globalRulesAckKey[\s\S]*extensionKnowledgeAckKey/);

  assert.match(platformTools, /validate_dynamic_script[\s\S]*sourceCode: z\.string/);
  assert.doesNotMatch(platformTools, /validate_dynamic_script[\s\S]{0,500}knowledgeAckKey/);
  assert.match(platformTools, /validate_extension_code[\s\S]*code: z\.preprocess\(normalizeEscapedVueSource, z\.string\(\)\)/);
  assert.doesNotMatch(platformTools, /validate_extension_code[\s\S]{0,500}extensionKnowledgeAckKey/);
});

test('mcp server exposes route platform operation tools', () => {
  const entry = readEntrySource();
  const tableTools = readSchemaSource();
  const platformTools = readPlatformSource();
  const instructions = readSourceFiles('lib/mcp-instructions.ts');
  const routing = readRoutingSource();
  const examples = readExamplesSource();
  const extensionThemeContractBlock = platformTools.slice(
    platformTools.indexOf('function getExtensionThemeContract()'),
    platformTools.indexOf('function getThemeClassReference()'),
  );

  assert.match(entry, /registerPlatformOperationTools\(server, ENFYRA_API_URL\)/);
  assert.doesNotMatch(tableTools, /server\.tool\(\s*['"]add_column['"]/);
  assert.doesNotMatch(tableTools, /server\.tool\(\s*['"]remove_column['"]/);
  assert.doesNotMatch(tableTools, /server\.tool\(\s*['"]add_relation['"]/);
  assert.doesNotMatch(tableTools, /server\.tool\(\s*['"]remove_relation['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]ensure_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]add_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]replace_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]remove_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]enable_route['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]disable_route['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]delete_route['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]set_route_public_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]public_route_methods['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]set_public_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]private_route_methods['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]api_endpoint_workflow['"]/);
  assert.match(platformTools, /nextSteps/);
  assert.match(platformTools, /applyAll/);
  assert.match(platformTools, /delete_route\(\{ routeId:/);
  assert.doesNotMatch(platformTools, /delete_record\(\{ tableName: "enfyra_route_handler"/);
  assert.match(platformTools, /server\.tool\(\s*['"]create_api_endpoint['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]validate_dynamic_script['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]validate_extension_code['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_ui['"]/);
  assert.match(platformTools, /Lazy gateway for Enfyra admin extension UI builders/);
  assert.match(platformTools, /extensionKnowledgeAckKey/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_drawer['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_modal['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_page_shell['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_permission_gate['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_empty_state['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_resource_list['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_resource_grid['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_form_editor['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_widget['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_menu_notification['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_account_panel_item['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_tabs['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]build_extension_upload_modal['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]review_extension_ui_contract['"]/);
  assert.match(entry, /server\.tool\(\s*['"]get_permission_profile['"]/);
  assert.match(entry, /MCP_PERMISSION_REQUIREMENTS/);
  assert.match(entry, /\/admin\/script\/validate/);
  assert.match(entry, /\/admin\/test\/run/);
  assert.match(entry, /\/admin\/flow\/trigger\/:id/);
  assert.match(entry, /\/admin\/menu\/reorder/);
  assert.match(entry, /tools: \['reorder_menus'\]/);
  assert.match(platformTools, /server\.tool\(\s*['"]set_table_graphql['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_column_rule['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_field_permission['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_route_rate_limit['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_guard['"]/);
  assert.match(platformTools, /ensure_column_rule[\s\S]*globalRulesAckKey[\s\S]*assertGlobalRulesAck/);
  assert.match(platformTools, /ensure_field_permission[\s\S]*globalRulesAckKey[\s\S]*assertGlobalRulesAck/);
  assert.match(platformTools, /ensure_route_rate_limit[\s\S]*globalRulesAckKey[\s\S]*assertGlobalRulesAck/);
  assert.match(platformTools, /ensure_guard[\s\S]*globalRulesAckKey[\s\S]*assertGlobalRulesAck/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_column_rule['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_field_permission['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_route_permission['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_guard['"]/);
	  assert.match(platformTools, /server\.tool\(\s*['"]ensure_websocket_gateway['"]/);
	  assert.match(platformTools, /server\.tool\(\s*['"]ensure_websocket_event['"]/);
	  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]ensure_flow['"]/);
	  assert.match(platformTools, /server\.tool\(\s*['"]flow_workflow['"]/);
	  assert.match(platformTools, /server\.tool\(\s*['"]ensure_manual_flow['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_scheduled_flow['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]choose_flow_step_tool['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]ensure_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_script_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_condition_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_query_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_create_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_update_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_delete_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_http_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_sleep_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_trigger_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_log_flow_step['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_menu['"]/);
  assert.match(platformTools, /normalizeMenuPermissionArg/);
  assert.match(platformTools, /new menus default to null/);
  assert.match(platformTools, /Empty objects are normalized to null/);
  assert.match(platformTools, /server\.tool\(\s*['"]reorder_menus['"]/);
  assert.match(platformTools, /\/admin\/menu\/reorder/);
  assert.match(platformTools, /Duplicate menu id in reorder payload/);
  assert.match(platformTools, /emits enfyra_menu cache invalidation/);
  assert.match(platformTools, /server\.tool\(\s*['"]extension_workflow['"]/);
  assert.match(platformTools, /runExtensionWorkflow/);
  assert.match(platformTools, /extension_workflow_planned/);
  assert.match(platformTools, /extension_workflow_advanced/);
  assert.match(platformTools, /assertExtensionKnowledgeAck/);
  assert.match(platformTools, /get_extension_theme_contract before generating or reviewing extension UI/);
  assert.match(platformTools, /kind=api_usage/);
  assert.match(platformTools, /For high-contract UI\/runtime code, call build_extension_ui/);
  assert.match(platformTools, /Generate a contract-safe CommonDrawer Vue snippet/);
  assert.match(platformTools, /Generate a contract-safe CommonModal\/UModal Vue snippet/);
  assert.match(platformTools, /Generate page-header and shell-header-action script setup code/);
  assert.match(platformTools, /Generate a PermissionGate wrapper snippet/);
  assert.match(platformTools, /Generate an EmptyState snippet/);
  assert.match(platformTools, /Generate a CommonResourceListFrame\/CommonResourceListItem snippet/);
  assert.match(platformTools, /Generate a constrained responsive CommonResourceListFrame card grid/);
  assert.match(platformTools, /Generate a FormEditor\/FormEditorLazy snippet/);
  assert.match(platformTools, /Generate a Widget snippet/);
  assert.match(platformTools, /Generate useMenuNotificationRegistry registration code/);
  assert.match(platformTools, /Generate useAccountPanelRegistry registration code/);
  assert.match(platformTools, /Generate a UTabs snippet/);
  assert.match(platformTools, /Generate a CommonUploadModal snippet/);
  assert.match(platformTools, /extension_api_usage_built/);
  assert.match(platformTools, /extension_notify_usage_built/);
  assert.match(platformTools, /extension_runtime_contract_reviewed/);
  assert.match(platformTools, /Invalid extension runtime contract/);
  assert.match(platformTools, /api_usage/);
  assert.match(platformTools, /runtime_review/);
  assert.match(platformTools, /theme_classes/);
  assert.match(platformTools, /theme_review/);
  assert.match(platformTools, /extension_theme_contract_reviewed/);
  assert.match(platformTools, /Invalid extension theme contract/);
  assert.match(platformTools, /Review an Enfyra extension Vue snippet/);
  assert.match(platformTools, /kind=review/);
  assert.match(platformTools, /field controls without class="w-full"/);
  assert.match(platformTools, /Extension validation rejects UInput, UTextarea/);
  assert.match(routing, /build_extension_ui/);
  assert.match(routing, /FormEditor, Widget, shell registries, tabs, upload modal, api usage, notify, runtime review, theme classes, theme review, or full review/);
  assert.match(routing, /kind: drawer, modal, page shell/);
  assert.match(platformTools, /Use build_extension_ui kind=drawer for generated drawer\/editing snippets/);
  assert.match(platformTools, /Use build_extension_ui kind=modal for generated modal\/confirmation snippets/);
  assert.match(platformTools, /Unrestricted menu permission is null/);
  assert.match(platformTools, /patches=\[\{search,replace\}/);
  assert.match(platformTools, /searchMode="whitespace"/);
  assert.match(platformTools, /replaceAll=true/);
  assert.match(platformTools, /Atomic multi-patch list/);
  assert.match(platformTools, /shellComponentContracts/);
  assert.match(platformTools, /Use build_extension_ui kind=permission_gate for generated permission wrapper snippets/);
  assert.match(platformTools, /PermissionGate renders the permitted slot directly/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_page_extension['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_global_extension['"]/);
  assert.match(platformTools, /server\.tool\(\s*['"]ensure_widget_extension['"]/);
  assert.doesNotMatch(platformTools, /server\.tool\(\s*['"]ensure_menu_extension_page['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_menu['"]/);
  assert.doesNotMatch(entry, /server\.tool\(\s*['"]create_extension['"]/);
  assert.match(platformTools, /sourceCode/);
  assert.match(platformTools, /stepOrder/);
  assert.match(platformTools, /triggerType/);
  assert.doesNotMatch(platformTools, /connectionHandlerScript/);
  assert.doesNotMatch(platformTools, /handlerScript/);
  assert.doesNotMatch(platformTools, /\/admin\/reload\/flows/);
  assert.doesNotMatch(platformTools, /\/admin\/reload\/websockets/);
  assert.match(platformTools, /validateScriptSourceIfPresent/);
  assert.match(platformTools, /get_extension_theme_contract/);
  assert.match(platformTools, /Never fix one extension by injecting global CSS/);
  assert.match(platformTools, /theme guards/);
  assert.match(extensionThemeContractBlock, /Do not choose theme classes from memory/);
  assert.match(extensionThemeContractBlock, /themeIntents/);
  assert.match(extensionThemeContractBlock, /neutral_surface/);
  assert.match(extensionThemeContractBlock, /primary_identity/);
  assert.match(extensionThemeContractBlock, /theme_review/);
  assert.doesNotMatch(extensionThemeContractBlock, /decisionCases/);
  assert.doesNotMatch(extensionThemeContractBlock, /patternExamples/);
  assert.doesNotMatch(extensionThemeContractBlock, /compactExample/);
  assert.doesNotMatch(extensionThemeContractBlock, /classReference/);
  assert.doesNotMatch(extensionThemeContractBlock, /eapp-primary-surface/);
  assert.doesNotMatch(extensionThemeContractBlock, /bg-primary\/10/);
  assert.match(platformTools, /Use build_extension_ui kind=modal for generated modal\/confirmation snippets/);
  assert.match(platformTools, /md:grid-cols-2 xl:grid-cols-3/);
  assert.match(examples, /eapp-surface-card p-4/);
  assert.match(examples, /eapp-primary-surface/);
  assert.match(examples, /eapp-primary-soft/);
  assert.match(examples, /eapp-primary-solid/);
  assert.match(examples, /gradient: 'none'/);
  assert.match(examples, /color: 'neutral'/);
  assert.match(examples, /Call get_extension_theme_contract before writing or reviewing page\/widget\/global extension UI/);
  assert.match(examples, /authority for theme, color, layout, modal, drawer, and shell registry details/);
  assert.doesNotMatch(examples, /gradient: 'cyan'/);
  assert.doesNotMatch(examples, /<p class=\\["']text-sm text-muted/);
  assert.doesNotMatch(examples, /grid gap-4 md:grid-cols-3/);
  assert.doesNotMatch(examples, /bg-\[var\(--eapp-surface-muted\)\]/);
  assert.doesNotMatch(examples, /hover:eapp-surface-muted/);
  assert.match(instructions, /most specific operation tool/);
  assert.match(instructions, /lazily/);
  assert.match(instructions, /discover_enfyra_workflows/);
  assert.match(routing, /ensure_websocket_event/);
  assert.match(routing, /extension_workflow/);
  assert.match(routing, /reorder_menus/);
  assert.match(routing, /PATCH enfyra_menu for order or parent changes/);
  assert.match(routing, /api_endpoint_workflow/);
  assert.match(routing, /create_api_endpoint/);
  assert.match(routing, /public_route_methods/);
  assert.match(routing, /add_route_methods/);
  assert.match(routing, /enable_route/);
  assert.match(routing, /ensure_page_extension/);
});

test('test_flow_step uses unified admin test runner', () => {
  const entry = readEntrySource();
  assert.match(entry, /'test_flow_step'/);
  assert.match(entry, /'\/admin\/test\/run'/);
  assert.match(entry, /kind:\s*'flow_step'/);
  assert.doesNotMatch(entry, /fetchAPI\(ENFYRA_API_URL,\s*'\/admin\/flow\/test-step'/);
});

test('GraphQL uses generated resolvers instead of script-backed source records', () => {
  const entry = readEntrySource();
  const runtimeZones = readRuntimeZoneSource();
  const mutationGuards = readSourceFiles('lib/mutation-guards.ts');

  const scriptTableBlock = entry.slice(
    entry.indexOf('const SCRIPT_BACKED_TABLES'),
    entry.indexOf('const SCRIPT_SOURCE_FIELDS'),
  );
  assert.doesNotMatch(scriptTableBlock, /enfyra_graphql/);
  assert.doesNotMatch(mutationGuards.slice(0, mutationGuards.indexOf('export function parseRecordData')), /enfyra_graphql/);
  assert.match(runtimeZones, /enfyra_graphql[^\n]+metadata/);
  assert.doesNotMatch(runtimeZones, /enfyra_graphql[^\n]+sourceCode/);
  assert.match(entry, /server\.tool\(\s*['"]test_graphql['"]/);
});

test('OAuth provider provisioning source is treated as a script-backed identity surface', () => {
  const entry = readEntrySource();
  const guards = readSourceFiles('lib/mutation-guards.ts');
  const zones = readRuntimeZoneSource();

  assert.match(entry, /SCRIPT_BACKED_TABLES[\s\S]*'enfyra_oauth_config'/);
  assert.match(guards, /SCRIPT_TABLES[\s\S]*'enfyra_oauth_config'/);
  assert.match(entry, /oauthUserProvisioning/);
  assert.match(zones, /enfyra_oauth_config[^\n]*sourceCode[^\n]*appCallbackUrl/);
  assert.match(zones, /enfyra_user/);
  assert.match(zones, /enfyra_oauth_account/);
});

test('run_admin_test exposes the backend generic script test kind', () => {
  const entry = readEntrySource();
  assert.match(entry, /kind: z\.enum\(\['script', 'flow_step', 'websocket_event', 'websocket_connection'\]/);
});

test('mcp log search matches dashed and dotted app log filenames', () => {
  const entry = readEntrySource();
  assert.match(entry, /\^app\[\.-\]/);
  assert.match(entry, /\^error\[\.-\]/);
});

test('server instructions stay compact and route details to tools', () => {
  const instructions = readSourceFiles('lib/mcp-instructions.ts');
  const routing = readRoutingSource();

  assert.ok(Buffer.byteLength(instructions, 'utf8') < 4000);
  assert.match(instructions, /path is ambiguous/);
  assert.match(instructions, /get_enfyra_api_context/);
  assert.match(instructions, /Inspect only the exact artifact/);
  assert.match(instructions, /Load other context lazily/);
  assert.match(instructions, /Session acknowledgement/);
  assert.match(routing, /progressive disclosure/);
  assert.match(routing, /query_table on destination domain lists/);
	  assert.match(routing, /notification summary\/realtime shell signal plus destination-page fetch on click/);
	  assert.match(routing, /api_endpoint_workflow/);
	  assert.match(routing, /flow_workflow/);
  assert.doesNotMatch(instructions, /#### Injected Vue API functions/);
  assert.doesNotMatch(instructions, /Tables confirmed to have REST routes/);
});

test('discovery tools report target instance and avoid unbounded broad searches', () => {
  const entry = readEntrySource();

  assert.match(entry, /function targetInstance\(\)/);
  assert.match(entry, /source: 'ENFYRA_API_URL environment variable used by this MCP server process'/);
  assert.match(entry, /targetInstance: targetInstance\(\)/);
  assert.match(entry, /Use this as the cheap first target sanity check/);
  assert.match(entry, /Do not use this only to confirm the API base/);
  assert.match(entry, /installColumnarToolFormatter\(server\)/);
  assert.match(entry, /routeSamples: sample\(routes, 25\)/);
  assert.match(entry, /tableSamples: sample\(tableNames, 40\)/);
  assert.match(entry, /adminRoutes: sample\(adminRoutes/);
  assert.match(entry, /publicRoutes: sample\(publicRoutes/);
  assert.match(entry, /relationFkColumnNames/);
  assert.match(entry, /hiddenRelationColumnCount/);
  assert.match(entry, /discoveryFetch\(`\/metadata\/\$\{encodeURIComponent\(tableName\)\}`\)/);
  assert.doesNotMatch(entry, /\n\s+tableNames,\n\s+routes,\n/);
  assert.match(entry, /DISCOVERY_FETCH_TIMEOUT_MS = 12000/);
  assert.match(entry, /partialErrors: collectPartialErrors/);
  assert.match(entry, /async function collectFeatureSearchState\(\)/);
  assert.match(entry, /const state = await collectFeatureSearchState\(\)/);
  assert.doesNotMatch(entry, /const state = await collectRestDefinitionState\(\);\n\s+const q = rawQuery\.toLowerCase\(\)/);
  assert.match(entry, /Run broad discovery tools sequentially; do not call multiple broad discovery tools in parallel/);
  assert.match(entry, /limit: z\.number\(\)\.int\(\)\.positive\(\)\.max\(25\)\.optional\(\)\.default\(8\)/);
  assert.match(entry, /inspect_feature query must be at least 2 characters/);
  assert.match(entry, /For a specific match, call inspect_table, inspect_route, trace_metadata_usage, or get_script_source/);
});

test('query_table supports deep meta and aggregate query options', () => {
  const entry = readEntrySource();
  assert.match(entry, /meta: z\.string\(\)\.optional\(\)/);
  assert.match(entry, /deep: jsonObjectParam\(z, 'Deep relation fetch object'\)\.optional\(\)/);
  assert.match(entry, /aggregate: jsonObjectParam\(z, 'Aggregate object'\)\.optional\(\)/);
  assert.match(entry, /call discover_query_capabilities before using aggregate objects instead of guessing _sum\/_count operators/);
  assert.match(entry, /queryParams\.set\('deep', deepParam\)/);
  assert.match(entry, /queryParams\.set\('aggregate', aggregateParam\)/);
  assert.match(entry, /function applyDeepFieldSelections/);
  assert.match(entry, /autoAddedDeepFields/);
  assert.match(entry, /query_table auto-adds missing top-level deep relation names to fields/);
});

test('generic read tools reject enfyra_extension sourceCode confusion', () => {
  const entry = readEntrySource();
  const requiredKnowledge = readSourceFiles('lib/required-knowledge.ts');
  const runtimeZoneTools = readSourceTree();

  assert.match(entry, /function assertExtensionReadFields/);
  assert.match(entry, /enfyra_extension stores editable Vue SFC extension source in `code`, not `sourceCode`/);
  assert.match(entry, /assertExtensionReadFields\(tableName, fields\)/);
  assert.match(requiredKnowledge, /Read code, not sourceCode, for editable enfyra_extension Vue SFC records/);
  assert.match(requiredKnowledge, /Editable extension source is enfyra_extension\.code/);
  assert.match(runtimeZoneTools, /editable source artifact is enfyra_extension\.code/);
  assert.match(runtimeZoneTools, /do not query sourceCode on enfyra_extension/);
});

test('dynamic script guidance documents repository deep projection contract', () => {
  const entry = readEntrySource();
  const instructions = readSourceFiles('lib/mcp-instructions.ts');
  const requiredKnowledge = readSourceFiles('lib/required-knowledge.ts');
  const examples = readExamplesSource();
  const routing = readRoutingSource();
  const platformTools = readPlatformSource();

  assert.match(entry, /For repository find\(\{ deep \}\) in scripts, include relation property names in top-level fields/);
  assert.match(requiredKnowledge, /Inside dynamic server scripts, repository find\(\{ deep \}\) requires the relation property to also be present in top-level fields/);
  assert.match(examples, /Workflow handler with relation read and side effects/);
  assert.match(examples, /fields: \["id", "title", "status", "requester"\]/);
  assert.match(examples, /Find one record by id in a handler/);
  assert.match(examples, /do not keep retrying @REPOS\.<table>\.find id filter shapes/);
  assert.match(examples, /top-level fields controls which parent properties appear/);
  assert.match(routing, /fields\+deep projection contract for script repository reads/);
  assert.match(entry, /#secure\.table_name or @REPOS\.secure\.table_name/);
  assert.match(platformTools, /#secure\.table_name or @REPOS\.secure\.table_name/);
  assert.match(requiredKnowledge, /Reserve #table_name\/@REPOS\.table_name for trusted internal work/);
});

test('dynamic endpoint guidance distinguishes canonical policy from custom endpoint policy', () => {
  const entry = readEntrySource();
  const requiredKnowledge = readSourceFiles('lib/required-knowledge.ts');
  const routing = readRoutingSource();
  const platformTools = readPlatformSource();

  assert.match(requiredKnowledge, /Custom routes have no main table/);
  assert.match(requiredKnowledge, /canonical route pre-hook/);
  assert.match(requiredKnowledge, /data: @BODY/);
  assert.match(requiredKnowledge, /column-rule\/Zod/);
  assert.match(routing, /third-party-only owner\/tenant\/business policy/);
  assert.match(routing, /canonical route pre-hook/);
  assert.doesNotMatch(platformTools, /sourceCode: z\.string\(\)\.describe\('[^']*@REPOS\.main/);
  assert.match(platformTools, /assertCustomEndpointRoute\(route\)/);
  assert.match(entry, /#secure\.orders/);
  assert.doesNotMatch(entry, /explicit repos such as `\$ctx\.\$repos\.orders`/);
});

test('guidance rejects sql-like filter operators', () => {
  const requiredKnowledge = readSourceFiles('lib/required-knowledge.ts');
  assert.match(requiredKnowledge, /do not use _like/);
});

test('schema design context warns about column relation namespace clashes', () => {
  const tableTools = readSchemaSource();
  const requiredKnowledge = readSourceFiles('lib/required-knowledge.ts');
  assert.match(tableTools, /Column names and relation propertyName values share one table namespace/);
  assert.match(tableTools, /Relation propertyName must be unique among both relation names and scalar column names/);
  assert.match(tableTools, /parent detail\/read must deep-load a child collection/);
  assert.match(requiredKnowledge, /deep-read a parent with child collections/);
});

test('dynamic script guidance rejects physical relation filter names', () => {
  const entry = readEntrySource();
  const instructions = readSourceFiles('lib/mcp-instructions.ts');
  const requiredKnowledge = readSourceFiles('lib/required-knowledge.ts');
  assert.match(entry, /not \{ incidentId: \{ _eq: incident\.id \} \}/);
  assert.match(instructions, /get_enfyra_required_knowledge/);
  assert.match(requiredKnowledge, /not \{ incidentId: \{ _eq: id \} \}/);
});

test('list query tools require explicit limit or all intent except bounded locator search', () => {
  const entry = readEntrySource();
  const examples = readExamplesSource();
  const schemaSkill = readFileSync(new URL('../.codex/skills/enfyra-mcp-schema-data/SKILL.md', import.meta.url), 'utf8');

  assert.match(entry, /query_table requires either limit or all=true/);
  assert.match(entry, /get_all_routes requires either limit or all=true/);
  assert.match(entry, /If search is provided without limit, the tool returns a bounded lookup window of 10 matches/);
  assert.match(entry, /query_table accepts either all=true or limit, not both/);
  assert.match(entry, /get_all_routes accepts either all=true or limit, not both/);
  assert.match(entry, /all: z\.boolean\(\)\.optional\(\)\.default\(false\)\.describe\('Return all matching rows by sending REST limit=0/);
  assert.match(examples, /pass all: true instead of choosing an arbitrary page size such as 30 or 50/);
  assert.match(schemaSkill, /Locator searches on `get_all_routes` and `get_all_tables` may omit `limit`/);
});

test('delete_tables accepts tableName or tableId and schema rules mention full-batch preflight', () => {
  const tableTools = readSchemaSource();
  const requiredKnowledge = readSourceFiles('lib/required-knowledge.ts');

  assert.match(tableTools, /Native JSON array of delete items: \[\{ tableId \}\] or \[\{ tableName \}\]/);
  assert.match(tableTools, /items\[\$\{index\}\] requires tableId or tableName/);
  assert.match(requiredKnowledge, /create_tables preflights all items before posting tables/);
});

test('websocket script context documents roomSize helper', () => {
  const entry = readEntrySource();

  assert.match(entry, /roomSize\(room\) counts sockets in that room across registered gateways/);
  assert.match(entry, /@SOCKET reply\/join\/leave\/disconnect\/emit helpers\/roomSize/);
});

test('script context discovery documents runtime macro and helper surface', () => {
  const entry = readEntrySource();

  for (const macro of [
    '@BODY',
    '@QUERY',
    '@PARAMS',
    '@USER',
    '@REQ',
    '@RES',
    '@REPOS',
    '@CACHE',
    '@HELPERS',
    '@FETCH',
    '@STORAGE',
    '@UPLOADED_FILE',
    '@SOCKET',
    '@TRIGGER',
    '@DATA',
    '@ERROR',
    '@STATUS',
    '@ENV',
    '@PKGS',
    '@LOGS',
    '@SHARE',
    '@API',
    '@THROW',
    '@THROW400',
    '@THROW503',
  ]) {
    assert.match(entry, new RegExp(`'${macro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  assert.match(entry, /@FETCH maps to \$ctx\.\$helpers\.\$fetch/);
  assert.match(entry, /\$ctx\.\$helpers includes \$bcrypt\.hash\/compare, autoSlug\(text\), \$fetch, \$sleep\(ms\)/);
  assert.match(entry, /@REQ websocket request metadata/);
  assert.match(entry, /@RES when response streaming is available/);
  assert.match(entry, /runtimeTypes section is the authoritative script-visible ESV contract/);
  assert.match(entry, /runtimeTypes: buildDynamicScriptContextTypeContract\(\)/);
});

test('dynamic throw contract is consistently documented and ack-versioned', () => {
  const entry = readEntrySource();
  const requiredKnowledge = readSourceFiles('lib/required-knowledge.ts');
  const examples = readExamplesSource();
  const payload = buildRequiredKnowledgePayload();
  const payloadText = JSON.stringify(payload);

  assert.match(GLOBAL_RULES_ACK_KEY, /20260717M$/);
  assert.match(DYNAMIC_CODE_KNOWLEDGE_ACK_KEY, /DYNAMIC-REPOSITORY-CONTRACT/);
  assert.equal(payload.version, '2026-07-20.dynamic-script-runtime-types');

  for (const text of [entry, requiredKnowledge, examples, payloadText]) {
    assert.match(text, /numeric helpers? (are|is) raw HTTP message|use numeric @THROW helpers for raw HTTP messages/i);
    assert.match(text, /details.*object\/array|object or array/i);
    assert.match(text, /notFound\(resource, id\?\)|notFound\(\.\.\.\)|notFound\(resource, identifier\)/);
    assert.match(text, /duplicate\(resource, field, value\)|duplicate\(\.\.\.\)/);
  }

  assert.match(entry, /do not use @THROW404\("Project", id\) as a semantic shortcut/);
  assert.ok(payloadText.includes('do not use @THROW404(\\"Project\\", id) as a semantic shortcut'));
});

test('SSR app examples include Nuxt Next and Angular connection patterns', () => {
  const examples = readExamplesSource();

  assert.match(examples, /Nuxt routeRules for REST and Socket\.IO/);
  assert.match(examples, /Next rewrites for REST and Socket\.IO/);
  assert.match(examples, /Next client provider for authenticated realtime/);
  assert.match(examples, /Create the Socket\.IO client once in a top-level client provider/);
  assert.match(examples, /Proxy \/socket\.io through Next rewrites to the Enfyra app bridge \/ws\/socket\.io/);
  assert.match(examples, /Angular dev proxy for REST and Socket\.IO/);
  assert.match(examples, /"pathRewrite": \{/);
  assert.match(examples, /provideHttpClient\(withInterceptors\(\[enfyraCredentialsInterceptor\]\)\)/);
  assert.match(examples, /req\.clone\(\{ withCredentials: true \}\)/);
  assert.match(examples, /Angular HttpClient auth service and route guard/);
  assert.match(examples, /Angular singleton Socket\.IO realtime service/);
  assert.match(examples, /Do not create a new socket per routed component/);
});

test('OAuth setup examples guide provider console callback configuration', () => {
  const examples = readExamplesSource();

  assert.match(examples, /['"]oauth-setup['"]/);
  assert.match(examples, /setup_oauth_provider/);
  assert.match(examples, /Authorized redirect URIs/);
  assert.match(examples, /enfyra_oauth_config/);
  assert.match(examples, /never ask the user for a callback URI/i);
  assert.match(examples, /connect the third app before asking for provider credentials/i);
  assert.match(examples, /never read or reuse stored credential values/i);
  assert.match(examples, /do not present callbackUri.*before setup_oauth_provider returns/i);
  assert.match(examples, /wait for confirmation/i);
  assert.match(examples, /setupComplete=false/i);
  assert.match(examples, /Enfyra app bridge owns refresh and Bearer forwarding/);
  assert.match(examples, /fetchOptions:\s*\{\s*redirect:\s*["']manual["']/);
});

test('route creation tools report real route reload status instead of a hardcoded success flag', () => {
  const entry = readEntrySource();
  assert.match(entry, /async function reloadRoutesResult\(\)/);
  assert.match(entry, /routeReload/);
  assert.doesNotMatch(entry, /routesReloaded:\s*true/);
});

test('column rule examples use the current value contract', () => {
  const examples = readExamplesSource();
  assert.match(examples, /value: JSON\.stringify\(\{ v: "email" \}\)/);
  assert.doesNotMatch(examples, /ruleConfig: JSON\.stringify/);
});

test('query examples distinguish relation fields from deep relation query options', () => {
  const examples = readExamplesSource();
  assert.match(examples, /Use fields with dotted relation paths when you only need scalar fields from related records/);
  assert.match(examples, /Use deep when relation loading needs query options such as filter, sort, limit, page, or nested deep/);
  assert.match(examples, /Do not use deep just to filter by a relation id/);
});

test('query guidance documents fields exclusion mode', () => {
  const examples = readExamplesSource();
  const schemaSkill = readFileSync(new URL('../.codex/skills/enfyra-mcp-schema-data/SKILL.md', import.meta.url), 'utf8');
  assert.match(examples, /fields=-compiledCode/);
  assert.match(examples, /fields=id,-compiledCode returns all readable fields except compiledCode/);
  assert.match(examples, /Dotted exclusions and deep relation fields use the same exclude-mode rule/);
  assert.match(schemaSkill, /`fields=-compiledCode` excludes that field/);
  assert.match(schemaSkill, /`fields=-owner\.avatar`/);
});

test('operator guidance avoids speculative warnings and physical FK generated code', () => {
  const examples = readExamplesSource();
  const dynamicSkill = readFileSync(new URL('../.codex/skills/enfyra-mcp-dynamic-code/SKILL.md', import.meta.url), 'utf8');
  const schemaSkill = readFileSync(new URL('../.codex/skills/enfyra-mcp-schema-data/SKILL.md', import.meta.url), 'utf8');
  assert.match(examples, /conversationId is accepted only as the room\/business identifier; persistence uses relation properties conversation and sender/);
  assert.match(examples, /Do not ask the client for senderId\. The sender relation is derived from @USER\.id/);
  assert.match(dynamicSkill, /`compiledCode` is generated from source and may differ textually/);
  assert.match(schemaSkill, /relation property names, not `relationId` fields/);
});

test('schema examples guide live types and relation mutation without stale update_table relation payloads', () => {
  const examples = readExamplesSource();
  const requiredKnowledge = readSourceFiles('lib/required-knowledge.ts');

  assert.match(examples, /Bulk schema creation with one-item-or-many arrays/);
  assert.match(examples, /amount.*type: "float"/s);
  assert.match(examples, /lookup: "<app_lookup_id>"/);
  assert.doesNotMatch(examples, /learning_/);
  assert.match(requiredKnowledge, /call get_schema_design_context first/);
  assert.match(examples, /create_tables creates tables\/columns first, then creates requested relations after all batch tables exist/);
  assert.doesNotMatch(examples, /update_tables\(\{[\s\S]*relations: JSON\.stringify/);
});

test('RLS guidance preserves caller projection and pagination', () => {
  const examples = readExamplesSource();
  const requiredKnowledge = readSourceFiles('lib/required-knowledge.ts');
  const entry = readEntrySource();
  assert.match(requiredKnowledge, /merge security filters into @QUERY\.filter/);
  assert.match(examples, /keep projection and pagination client-owned/);
  assert.match(entry, /preserve client-controlled query shape/);
  assert.match(entry, /pass through client fields\/deep\/sort\/page\/limit\/meta\/aggregate\/debugMode/);
});
