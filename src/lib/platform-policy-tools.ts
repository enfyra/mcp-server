import { z } from 'zod';
import { fetchAPI } from './fetch.js';
import { fetchTableMetadataByRef } from './metadata-client.js';
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
import {
  assertGlobalRulesAck,
  globalRulesAckParam
} from './required-knowledge.js';
import { destructivePreviewContent } from './destructive-preview.js';
import {
  canonicalFieldPermissionCondition,
  validateFieldPermissionCondition,
} from './field-permission-contract.js';

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
        const parsedCondition = parseJsonObjectArg('condition', condition, null);
        const conditionValidation = validateFieldPermissionCondition(parsedCondition);
        if (conditionValidation.ok === false) throw new Error(conditionValidation.errors.join('; '));
        const filter = {
          action: { _eq: action },
          ...(columnName ? { column: { id: { _eq: getId(field) } } } : { relation: { id: { _eq: getId(field) } } }),
          ...(role ? { role: { id: { _eq: role.id } } } : {}),
        };
        const candidates = await fetchRecords(
          ENFYRA_API_URL,
          'enfyra_field_permission',
          filter,
          'id,_id,column.id,relation.id,role.id,action,effect,condition,allowedUsers.id',
          100,
        );
        const expectedUsers = (allowedUserIds || []).map(String).sort();
        const expectedCondition = canonicalFieldPermissionCondition(parsedCondition);
        const matches = candidates.filter((candidate) => {
          const actualUsers = (candidate.allowedUsers || []).map((user) => String(getId(user))).sort();
          return candidate.effect === effect
            && canonicalFieldPermissionCondition(candidate.condition) === expectedCondition
            && JSON.stringify(actualUsers) === JSON.stringify(expectedUsers);
        });
        if (matches.length > 1) throw new Error('Multiple field permissions match; pass a permission id before changing the scope.');
        const existing = matches[0] || null;
        const body = {
          action,
          effect,
          isEnabled,
          description,
          condition: parsedCondition,
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
      'remove_field_permission',
      'Remove one field permission by id or exact logical scope.',
      {
        permissionId: z.union([z.string(), z.number()]).optional(),
        tableName: z.string().optional(),
        columnName: z.string().optional(),
        relationName: z.string().optional(),
        action: z.enum(['read', 'create', 'update']).optional(),
        effect: z.enum(['allow', 'deny']).optional(),
        roleId: z.union([z.string(), z.number()]).optional(),
        roleName: z.string().optional(),
        allowedUserIds: z.array(z.union([z.string(), z.number()])).optional(),
        expectedPermissionId: z.union([z.string(), z.number()]).optional(),
        confirm: z.boolean().optional().default(false),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ permissionId, tableName, columnName, relationName, action, effect, roleId, roleName, allowedUserIds, expectedPermissionId, confirm, globalRulesAckKey }) => {
        assertGlobalRulesAck(globalRulesAckKey);
        if (permissionId != null && (tableName || columnName || relationName || action != null || effect || roleId || roleName || allowedUserIds?.length)) {
          throw new Error('Pass permissionId alone, or use an exact logical selector without permissionId.');
        }
        let permission;
        let table = null;
        let field = null;

        if (permissionId != null) {
          permission = await findRecord(
            ENFYRA_API_URL,
            'enfyra_field_permission',
            { id: { _eq: permissionId } },
            'id,_id,column.id,column.name,column.table.id,column.table.name,relation.id,relation.propertyName,relation.sourceTable.id,relation.sourceTable.name,action,effect,role.id,allowedUsers.id',
          );
          if (!permission) throw new Error(`Field permission not found: ${String(permissionId)}`);
          table = permission.column?.table ?? permission.relation?.sourceTable ?? null;
          field = permission.column ?? permission.relation ?? null;
        } else {
          if (!tableName) throw new Error('tableName is required when permissionId is omitted.');
          if (!!columnName === !!relationName) throw new Error('Provide exactly one of columnName or relationName.');
          assertOneScope({ roleId, roleName, allowedUserIds });
          table = await fetchTableMetadataByRef(ENFYRA_API_URL, tableName);
          const role = await resolveRole(ENFYRA_API_URL, { roleId, roleName });
          field = columnName ? resolveColumn(table, columnName) : resolveRelation(table, relationName);
          const effectiveAction = action ?? 'read';
          const filter = {
            action: { _eq: effectiveAction },
            ...(effect ? { effect: { _eq: effect } } : {}),
            ...(columnName ? { column: { id: { _eq: getId(field) } } } : { relation: { id: { _eq: getId(field) } } }),
            ...(role ? { role: { id: { _eq: role.id } } } : {}),
          };
          const candidates = await fetchRecords(
            ENFYRA_API_URL,
            'enfyra_field_permission',
            filter,
            'id,_id,column.id,relation.id,role.id,action,effect,allowedUsers.id',
            100,
          );
          const expectedUsers = (allowedUserIds || []).map(String).sort();
          const scoped = candidates.filter((candidate) => {
            if (!allowedUserIds?.length) return true;
            const actualUsers = (candidate.allowedUsers || []).map((user) => String(getId(user))).sort();
            return JSON.stringify(actualUsers) === JSON.stringify(expectedUsers);
          });
          if (scoped.length === 0) throw new Error('Field permission not found for the requested target and scope.');
          if (scoped.length > 1) throw new Error('Multiple field permissions match; pass permissionId to remove exactly one rule.');
          permission = scoped[0];
        }

        const id = getId(permission);
        const resolved = {
          permissionId: id,
          table: table ? { id: getId(table), name: table.name } : null,
          target: permission.column
            ? { kind: 'column', id: getId(permission.column), name: permission.column.name }
            : { kind: 'relation', id: getId(permission.relation), name: permission.relation?.propertyName },
          scope: {
            roleId: getId(permission.role),
            allowedUserIds: (permission.allowedUsers || []).map((user) => getId(user)),
          },
          action: permission.action,
          effect: permission.effect,
        };
        if (!confirm) {
          return destructivePreviewContent('remove_field_permission', {
            action: 'field_permission_remove_preview',
            ...resolved,
            next: 'Call remove_field_permission again with confirm=true and expectedPermissionId from this preview after explicit approval.',
          }, 1);
        }
        if (expectedPermissionId == null || String(expectedPermissionId) !== String(id)) {
          throw new Error('expectedPermissionId must match the id returned by the successful preview.');
        }
        const result = await fetchAPI(ENFYRA_API_URL, `/enfyra_field_permission/${encodeURIComponent(String(id))}`, {
          method: 'DELETE',
        });
        const reload = await reloadBestEffort(ENFYRA_API_URL, '/admin/reload/metadata');
        if (!reload.succeeded) throw new Error(`Field permission was deleted but metadata reload failed: ${reload.error}`);
        const remaining = await findRecord(ENFYRA_API_URL, 'enfyra_field_permission', { id: { _eq: id } }, 'id,_id');
        if (remaining) throw new Error(`Field permission ${String(id)} still exists after deletion.`);
        return jsonText({
          action: 'field_permission_removed',
          ...resolved,
          confirmedAbsent: true,
          result,
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
      'Advanced business operation: create or update a custom request guard tree and optional guard rules. Supports type=route (default; targets one route or isGlobal=true) and type=graphql (targets (table, gqlOperation) matrix with null meaning all). On update, omitting table/gqlOperation keeps the current target; pass the literal string "all" to reset that axis back to all. For simple route throttling use ensure_route_rate_limit instead.',
      {
        name: z.string().describe('Guard name. Existing guard with this name is updated unless guardId is provided.'),
        guardId: z.union([z.string(), z.number()]).optional().describe('Optional existing guard id.'),
        type: z.enum(['route', 'graphql']).optional().default('route').describe('Guard type. type=route targets one route or isGlobal=true; type=graphql targets the (table, gqlOperation) matrix and must not set routeId/path/methods or isGlobal=true. Updating a guard whose saved type differs from this value is rejected; pass the saved type or use a new name.'),
        position: z.enum(['pre_auth', 'post_auth']).optional().default('pre_auth').describe('Guard position.'),
        routeId: z.union([z.string(), z.number()]).optional().describe('Optional route id. Required for type=route root (unless isGlobal=true); forbidden for type=graphql.'),
        path: z.string().optional().describe('Optional route path. Required for type=route root (unless isGlobal=true); forbidden for type=graphql.'),
        methods: z.array(z.string()).optional().describe('HTTP method names. Only valid for type=route; forbidden for type=graphql.'),
        table: z.string().optional().describe('Optional table name/alias/id. Only valid for type=graphql; forbidden for type=route. Omitting it on update keeps the current table target. Pass the literal string "all" on update to clear table targeting back to every table (null = all).'),
        gqlOperation: z.union([z.enum(['QUERY', 'CREATE', 'UPDATE', 'DELETE']), z.literal('all')]).optional().describe('Optional GraphQL operation. Only valid for type=graphql; forbidden for type=route. Omitting it on update keeps the current operation target. Pass the literal string "all" on update to clear operation targeting back to every operation (null = all).'),
        combinator: z.enum(['and', 'or']).optional().default('and').describe('Rule combinator.'),
        priority: z.number().optional().default(0).describe('Lower runs earlier.'),
        isGlobal: z.boolean().optional().default(false).describe('Apply globally. Only valid for type=route; type=graphql rejects isGlobal=true.'),
        isEnabled: z.boolean().optional().default(false).describe('Enable guard. Defaults false to avoid lockout.'),
        description: z.string().optional().describe('Admin note.'),
        rules: z.string().optional().describe('Rules JSON array: [{type, config, priority, isEnabled, description, userIds}]. rate_limit_by_route is type=route only; rate_limit_by_operation is type=graphql only.'),
        rulesMode: z.enum(['append', 'replace', 'none']).optional().default('append').describe('append creates rules, replace disables existing rules first, none leaves rules unchanged.'),
        globalRulesAckKey: globalRulesAckParam(z),
      },
      async ({ name, guardId, type, position, routeId, path, methods, table, gqlOperation, combinator, priority, isGlobal, isEnabled, description, rules, rulesMode, globalRulesAckKey }) => {
        assertGlobalRulesAck(globalRulesAckKey);
        if (path && routeId) throw new Error('Provide path or routeId, not both.');
        const ruleInputs = parseJsonArrayArg('rules', rules, []);
        const guardType = type || 'route';
        const tableReset = table === 'all';
        const operationReset = gqlOperation === 'all';
        const activeGqlOperation = operationReset ? null : gqlOperation;
        if (position === 'pre_auth') {
          const invalid = ruleInputs.filter((rule) => rule.type === 'rate_limit_by_user' || (Array.isArray(rule.userIds) && rule.userIds.length));
          if (invalid.length) throw new Error('pre_auth guards cannot use user-based rules or userIds. Use post_auth.');
        }
        if (guardType === 'graphql') {
          if (routeId || path) {
            throw new Error('Guard type=graphql cannot target a route. Drop routeId/path and use (table, gqlOperation) instead.');
          }
          if (methods && methods.length) {
            throw new Error('Guard type=graphql cannot set methods. GraphQL guards have no HTTP methods.');
          }
          if (isGlobal === true) {
            throw new Error('Guard type=graphql cannot set isGlobal=true. Use the (table, gqlOperation) matrix with null = all.');
          }
          const forbiddenRouteRules = ruleInputs.filter((rule) => rule.type === 'rate_limit_by_route');
          if (forbiddenRouteRules.length) {
            throw new Error('Rule rate_limit_by_route is only valid on guards with type=route.');
          }
        } else {
          if (table) {
            throw new Error('Guard type=route cannot set table. table targeting is only valid for type=graphql.');
          }
          if (gqlOperation) {
            throw new Error('Guard type=route cannot set gqlOperation. gqlOperation is only valid for type=graphql.');
          }
          const forbiddenOperationRules = ruleInputs.filter((rule) => rule.type === 'rate_limit_by_operation');
          if (forbiddenOperationRules.length) {
            throw new Error('Rule rate_limit_by_operation is only valid on guards with type=graphql.');
          }
        }
        let route = null;
        let resolvedTable = null;
        if (guardType === 'route') {
          if (!isGlobal && (routeId || path)) {
            route = (await resolveRoute(ENFYRA_API_URL, { path, routeId })).route;
          }
        } else if (table && !tableReset) {
          resolvedTable = await fetchTableMetadataByRef(ENFYRA_API_URL, table);
        }
        const { methodMap } = await getMethodContext(ENFYRA_API_URL);
        const existing = guardId
          ? await findRecord(ENFYRA_API_URL, 'enfyra_guard', { id: { _eq: guardId } }, 'id,_id,name,type')
          : await findRecord(ENFYRA_API_URL, 'enfyra_guard', { name: { _eq: name } }, 'id,_id,name,type');
        const existingType = existing ? (existing.type === 'graphql' ? 'graphql' : 'route') : null;
        if (existing && existingType !== guardType) {
          const guardRef = existing.name && String(existing.name) === String(name) ? `"${name}"` : `id ${getId(existing)}`;
          throw new Error(
            `Guard ${guardRef} already exists with type=${existingType}, but this call requests type=${guardType}. ` +
            `Re-run with type='${existingType}' to update it in place, or use a different name to create a new guard. ` +
            'Switching a guard type in place is rejected because stale targeting fields (route/methods or table/gqlOperation) would remain on the merged record.',
          );
        }
        const appliedTableReset = guardType === 'graphql' && tableReset && !!existing;
        const appliedOperationReset = guardType === 'graphql' && operationReset && !!existing;
        const guardBody = {
          name,
          type: guardType,
          position,
          combinator,
          priority,
          isGlobal: guardType === 'graphql' ? false : isGlobal,
          isEnabled,
          description,
          ...(route ? { route: { id: getId(route) } } : {}),
          ...(methods?.length && guardType === 'route' ? { methods: resolveMethodRefs(methodMap, methods) } : {}),
          ...(resolvedTable ? { table: { id: getId(resolvedTable) } } : {}),
          ...(appliedTableReset ? { table: null } : {}),
          ...(activeGqlOperation && guardType === 'graphql' ? { gqlOperation: activeGqlOperation } : {}),
          ...(appliedOperationReset ? { gqlOperation: null } : {}),
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
          guard: {
            id: resolvedGuardId,
            name,
            type: guardType,
            route: route ? route.path : null,
            table: resolvedTable ? { id: getId(resolvedTable), name: resolvedTable.name } : null,
            gqlOperation: guardType === 'graphql' ? (activeGqlOperation || null) : null,
            isGlobal: guardType === 'route' ? isGlobal : false,
            targetingReset: guardType === 'graphql'
              ? { table: appliedTableReset, gqlOperation: appliedOperationReset }
              : null,
          },
          guardOperation,
          disabledRuleCount: disabledRules.length,
          createdRuleCount: createdRules.length,
          reload,
        });
      },
    );
}
