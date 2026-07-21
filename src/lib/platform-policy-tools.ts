import { z } from 'zod';
import { createHash } from 'node:crypto';
import { fetchAPI } from './fetch.js';
import { fetchTableCatalog, fetchTableMetadata, fetchTableMetadataByRef, resolveTableCatalogEntry } from './metadata-client.js';
import {
  assertCustomEndpointRoute,
  assertDynamicEndpointContract,
  extractExplicitRepositoryTableNames,
  reviewDynamicEndpointContract,
} from './dynamic-endpoint-contract.js';
import { validatePortableScriptSource, validateScriptSourceIfPresent } from './mutation-guards.js';
import { writeSourceArtifact } from './source-artifacts.js';
import {
  normalizeEscapedVueSource,
  normalizeStrictBoolean,
} from './tool-input-normalization.js';
import {
  analyzeExtensionSfc,
  extensionElementAttributeValue,
  extensionElementHasAttribute,
} from './extension-sfc-analyzer.js';
import {
  assertDynamicCodeKnowledgeAck,
  assertDynamicCodeKnowledgeAckIf,
  assertExtensionKnowledgeAck,
  assertGlobalRulesAck,
  dynamicCodeKnowledgeAckParam,
  extensionKnowledgeAckParam,
  globalRulesAckParam,
} from './required-knowledge.js';
import {
  assertOneScope,
  createOrPatch,
  fetchRecords,
  findRecord,
  getId,
  getMethodContext,
  jsonText,
  parseJsonArrayArg,
  parseJsonObjectArg,
  reloadBestEffort,
  resolveColumn,
  resolveMethodRefs,
  resolveRelation,
  resolveRole,
  resolveRoute,
  uniqueMethodNames,
} from './platform-operation-logic.js';

export function registerPlatformPolicyTools(server, ENFYRA_API_URL) {
  server.tool(
      'ensure_column_rule',
      'Business operation: create or update a column validation rule. It resolves table/column ids and avoids duplicate rules for the same column+ruleType.',
      {
        tableName: z.string().describe('Table name, alias, or id.'),
        columnName: z.string().describe('Column name or id.'),
        ruleType: z.enum(['min', 'max', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'custom']).describe('Validation rule type.'),
        value: z.string().optional().describe('Rule config JSON object, usually {"v": ...}.'),
        message: z.string().optional().describe('Custom validation error message.'),
        description: z.string().optional().describe('Admin note.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable the rule.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ tableName, columnName, ruleType, value, message, description, isEnabled, globalRulesAckKey }) => {
        assertGlobalRulesAck(globalRulesAckKey);
        const table = await fetchTableMetadataByRef(ENFYRA_API_URL, tableName);
        const column = resolveColumn(table, columnName);
        const existing = await findRecord(ENFYRA_API_URL, 'enfyra_column_rule', {
          column: { id: { _eq: getId(column) } },
          ruleType: { _eq: ruleType },
        }, 'id,_id,column.id,ruleType');
        const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_column_rule', existing, {
          column: { id: getId(column) },
          ruleType,
          value: parseJsonObjectArg('value', value, null),
          message,
          description,
          isEnabled,
        });
        return jsonText({
          action: 'column_rule_ensured',
          table: { id: getId(table), name: table.name },
          column: { id: getId(column), name: column.name },
          ruleType,
          operation,
        });
      },
    );

  server.tool(
      'ensure_field_permission',
      'Business operation: create or update one field permission. It resolves table field ids, enforces exactly one column/relation target, and enforces a role/user scope.',
      {
        tableName: z.string().describe('Table name, alias, or id.'),
        columnName: z.string().optional().describe('Column name/id to protect. Use exactly one of columnName or relationName.'),
        relationName: z.string().optional().describe('Relation propertyName/id to protect. Use exactly one of columnName or relationName.'),
        action: z.enum(['read', 'create', 'update']).optional().default('read').describe('Field action.'),
        effect: z.enum(['allow', 'deny']).optional().default('allow').describe('Permission effect.'),
        roleId: z.union([z.string(), z.number()]).optional().describe('Role id scope.'),
        roleName: z.string().optional().describe('Role name scope.'),
        allowedUserIds: z.array(z.union([z.string(), z.number()])).optional().describe('Direct user id scope.'),
        condition: z.string().optional().describe('Condition JSON object using field permission DSL.'),
        description: z.string().optional().describe('Admin note.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable the permission.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ tableName, columnName, relationName, action, effect, roleId, roleName, allowedUserIds, condition, description, isEnabled, globalRulesAckKey }) => {
        assertGlobalRulesAck(globalRulesAckKey);
        if (!!columnName === !!relationName) throw new Error('Provide exactly one of columnName or relationName.');
        assertOneScope({ roleId, roleName, allowedUserIds });
        const [table, role] = await Promise.all([
          fetchTableMetadataByRef(ENFYRA_API_URL, tableName),
          resolveRole(ENFYRA_API_URL, { roleId, roleName }),
        ]);
        const field = columnName ? resolveColumn(table, columnName) : resolveRelation(table, relationName);
        const filter = {
          action: { _eq: action },
          effect: { _eq: effect },
          ...(columnName ? { column: { id: { _eq: getId(field) } } } : { relation: { id: { _eq: getId(field) } } }),
          ...(role ? { role: { id: { _eq: role.id } } } : {}),
        };
        const existing = role
          ? await findRecord(ENFYRA_API_URL, 'enfyra_field_permission', filter, 'id,_id,column.id,relation.id,role.id,action,effect')
          : null;
        const body = {
          action,
          effect,
          isEnabled,
          description,
          condition: parseJsonObjectArg('condition', condition, null),
          ...(columnName ? { column: { id: getId(field) } } : { relation: { id: getId(field) } }),
          ...(role ? { role: { id: role.id } } : {}),
          ...(allowedUserIds?.length ? { allowedUsers: allowedUserIds.map((id) => ({ id })) } : {}),
        };
        const operation = await createOrPatch(ENFYRA_API_URL, 'enfyra_field_permission', existing, body);
        const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/metadata');
        return jsonText({
          action: 'field_permission_ensured',
          table: { id: getId(table), name: table.name },
          field: { id: getId(field), name: columnName ? field.name : field.propertyName, kind: columnName ? 'column' : 'relation' },
          scope: { role, allowedUserIds: allowedUserIds || [] },
          operation,
          reload,
        });
      },
    );

  server.tool(
      'ensure_route_rate_limit',
      'Business operation: create or update a route rate-limit guard through the Enfyra guard engine. Prefer this over pre-hooks or raw guard JSON for request throttling.',
      {
        name: z.string().optional().describe('Optional guard name. Defaults to a stable name based on path, methods, and scope.'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Optional route id.'),
        path: z.string().optional().describe('Route path to protect, e.g. /newsletter_signup.'),
        methods: z.array(z.string()).default(['POST']).describe('HTTP method names to protect.'),
        scope: z.enum(['ip', 'user', 'route']).default('ip').describe('Rate-limit key scope. Use ip for public/pre-auth routes, user for authenticated users, route for a shared route-wide limit.'),
        maxRequests: z.number().int().positive().describe('Allowed request count per window.'),
        perSeconds: z.number().int().positive().describe('Window length in seconds.'),
        position: z.enum(['pre_auth', 'post_auth']).optional().describe('Optional override. Defaults to pre_auth for ip/route and post_auth for user.'),
        priority: z.number().optional().default(0).describe('Lower runs earlier.'),
        isEnabled: z.boolean().optional().default(true).describe('Enable the guard. Defaults true.'),
        description: z.string().optional().describe('Admin note.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ name, routeId, path, methods, scope, maxRequests, perSeconds, position, priority, isEnabled, description, globalRulesAckKey }) => {
        assertGlobalRulesAck(globalRulesAckKey);
        if (path && routeId) throw new Error('Provide path or routeId, not both.');
        const resolvedPosition = position || (scope === 'user' ? 'post_auth' : 'pre_auth');
        if (scope === 'user' && resolvedPosition === 'pre_auth') {
          throw new Error('User-scoped rate limits require post_auth because user identity is unavailable before auth.');
        }
        const { route } = await resolveRoute(ENFYRA_API_URL, { path, routeId });
        const { methodMap } = await getMethodContext(ENFYRA_API_URL);
        const methodNames = uniqueMethodNames(methods?.length ? methods : ['POST']);
        const ruleType = scope === 'user' ? 'rate_limit_by_user' : scope === 'route' ? 'rate_limit_by_route' : 'rate_limit_by_ip';
        const guardName = name || `Rate limit ${scope} ${route.path} ${methodNames.join('_')}`;
        const existing = await findRecord(ENFYRA_API_URL, 'enfyra_guard', { name: { _eq: guardName } }, 'id,_id,name');
        const guardBody = {
          name: guardName,
          position: resolvedPosition,
          combinator: 'and',
          priority,
          isGlobal: false,
          isEnabled,
          description: description || `Rate-limit ${methodNames.join(', ')} ${route.path} by ${scope}.`,
          route: { id: getId(route) },
          methods: resolveMethodRefs(methodMap, methodNames),
        };
        const guardOperation = await createOrPatch(ENFYRA_API_URL, 'enfyra_guard', existing, guardBody);
        const guardId = guardOperation.id || getId(existing);
        const existingRules = await fetchRecords(ENFYRA_API_URL, 'enfyra_guard_rule', { guard: { id: { _eq: guardId } } }, 'id,_id,isEnabled');
        const disabledRules = [];
        for (const rule of existingRules) {
          disabledRules.push(await fetchAPI(ENFYRA_API_URL, `/enfyra_guard_rule/${encodeURIComponent(String(getId(rule)))}`, {
            method: 'PATCH',
            body: JSON.stringify({ isEnabled: false }),
          }));
        }
        const rule = await fetchAPI(ENFYRA_API_URL, '/enfyra_guard_rule', {
          method: 'POST',
          body: JSON.stringify({
            type: ruleType,
            config: { maxRequests, perSeconds },
            priority: 0,
            isEnabled: true,
            description: `${maxRequests} request${maxRequests === 1 ? '' : 's'} per ${perSeconds} seconds by ${scope}.`,
            guard: { id: guardId },
          }),
        });
        const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/guards');
        return jsonText({
          action: 'route_rate_limit_ensured',
          route: { id: getId(route), path: route.path },
          methods: methodNames,
          guard: { id: guardId, name: guardName, position: resolvedPosition, isEnabled },
          rule: { type: ruleType, config: { maxRequests, perSeconds }, result: rule },
          disabledRuleCount: disabledRules.length,
          reload,
          next: 'Call inspect_route({ path }) to confirm the guard is attached, then test behavior through the actual REST route if doing so will not consume a production rate-limit bucket.',
        });
      },
    );

  server.tool(
      'ensure_guard',
      'Advanced business operation: create or update a custom request guard tree and optional guard rules. For simple request throttling use ensure_route_rate_limit instead.',
      {
        name: z.string().describe('Guard name. Existing guard with this name is updated unless guardId is provided.'),
        guardId: z.union([z.string(), z.number()]).optional().describe('Optional existing guard id.'),
        position: z.enum(['pre_auth', 'post_auth']).optional().default('pre_auth').describe('Guard position.'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Optional route id.'),
        path: z.string().optional().describe('Optional route path.'),
        methods: z.array(z.string()).optional().describe('HTTP method names.'),
        combinator: z.enum(['and', 'or']).optional().default('and').describe('Rule combinator.'),
        priority: z.number().optional().default(0).describe('Lower runs earlier.'),
        isGlobal: z.boolean().optional().default(false).describe('Apply globally.'),
        isEnabled: z.boolean().optional().default(false).describe('Enable guard. Defaults false to avoid lockout.'),
        description: z.string().optional().describe('Admin note.'),
        rules: z.string().optional().describe('Rules JSON array: [{type, config, priority, isEnabled, description, userIds}].'),
        rulesMode: z.enum(['append', 'replace', 'none']).optional().default('append').describe('append creates rules, replace disables existing rules first, none leaves rules unchanged.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ name, guardId, position, routeId, path, methods, combinator, priority, isGlobal, isEnabled, description, rules, rulesMode, globalRulesAckKey }) => {
        assertGlobalRulesAck(globalRulesAckKey);
        if (path && routeId) throw new Error('Provide path or routeId, not both.');
        const ruleInputs = parseJsonArrayArg('rules', rules, []);
        if (position === 'pre_auth') {
          const invalid = ruleInputs.filter((rule) => rule.type === 'rate_limit_by_user' || (Array.isArray(rule.userIds) && rule.userIds.length));
          if (invalid.length) throw new Error('pre_auth guards cannot use user-based rules or userIds. Use post_auth.');
        }
        let route = null;
        if (!isGlobal && (routeId || path)) {
          route = (await resolveRoute(ENFYRA_API_URL, { path, routeId })).route;
        }
        const { methodMap } = await getMethodContext(ENFYRA_API_URL);
        const existing = guardId
          ? await findRecord(ENFYRA_API_URL, 'enfyra_guard', { id: { _eq: guardId } }, 'id,_id,name')
          : await findRecord(ENFYRA_API_URL, 'enfyra_guard', { name: { _eq: name } }, 'id,_id,name');
        const guardBody = {
          name,
          position,
          combinator,
          priority,
          isGlobal,
          isEnabled,
          description,
          ...(route ? { route: { id: getId(route) } } : {}),
          ...(methods?.length ? { methods: resolveMethodRefs(methodMap, methods) } : {}),
        };
        const guardOperation = await createOrPatch(ENFYRA_API_URL, 'enfyra_guard', existing, guardBody);
        const resolvedGuardId = guardOperation.id || getId(existing);
        const existingRules = rulesMode === 'replace'
          ? await fetchRecords(ENFYRA_API_URL, 'enfyra_guard_rule', { guard: { id: { _eq: resolvedGuardId } } }, 'id,_id,isEnabled')
          : [];
        const disabledRules = [];
        for (const rule of existingRules) {
          disabledRules.push(await fetchAPI(ENFYRA_API_URL, `/enfyra_guard_rule/${encodeURIComponent(String(getId(rule)))}`, {
            method: 'PATCH',
            body: JSON.stringify({ isEnabled: false }),
          }));
        }
        const createdRules = [];
        if (rulesMode !== 'none') {
          for (const rule of ruleInputs) {
            createdRules.push(await fetchAPI(ENFYRA_API_URL, '/enfyra_guard_rule', {
              method: 'POST',
              body: JSON.stringify({
                type: rule.type,
                config: rule.config,
                priority: rule.priority ?? 0,
                isEnabled: rule.isEnabled ?? true,
                description: rule.description,
                guard: { id: resolvedGuardId },
                ...(Array.isArray(rule.userIds) && rule.userIds.length ? { users: rule.userIds.map((id) => ({ id })) } : {}),
              }),
            }));
          }
        }
        const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/guards');
        return jsonText({
          action: 'guard_ensured',
          guard: { id: resolvedGuardId, name, route: route ? route.path : null, isGlobal },
          guardOperation,
          disabledRuleCount: disabledRules.length,
          createdRuleCount: createdRules.length,
          reload,
        });
      },
    );
}
