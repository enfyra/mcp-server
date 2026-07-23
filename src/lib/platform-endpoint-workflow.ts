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
  AnyRecord,
  WorkflowNextStep,
} from './platform-shared-operations.js';
import {
  fetchAll,
  findHandler,
  getId,
  getMethodContext,
  methodNamesFromRecords,
  normalizeMethodName,
  normalizeRestPath,
  refId,
  reloadRoutes,
  resolveMethodRefs,
  summarizeWorkflowOperation,
  uniqueMethodNames,
} from './platform-route-operations.js';
import {
  assertOneScope,
  fetchRecords,
  findRecord,
  resolveRole,
} from './platform-data-operations.js';
import {
  parseJsonObjectArg,
} from './platform-extension-source.js';

function normalizeEndpointAccess(anonymousAccess, makePublic) {
  if (makePublic !== undefined) return makePublic ? 'public' : 'private';
  return anonymousAccess || 'private';
}

export async function reviewCustomEndpointSource(apiUrl: string, method: string, sourceCode: string) {
  const repositoryTables = extractExplicitRepositoryTableNames(sourceCode);
  const selectedTables = repositoryTables.slice(0, 5);
  const results = await Promise.allSettled(
    selectedTables.map(async (tableName) => [tableName, await fetchTableMetadata(apiUrl, tableName)] as const),
  );
  const tableMetadata: Record<string, AnyRecord> = {};
  const metadataUnavailable: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      tableMetadata[result.value[0]] = result.value[1];
    } else {
      metadataUnavailable.push(selectedTables[index]);
    }
  }
  return reviewDynamicEndpointContract({
    routeKind: 'custom',
    method,
    sourceCode,
    tableMetadata,
    metadataUnavailable,
    metadataTruncated: repositoryTables.length > selectedTables.length,
  });
}

function sourceMatches(existingHandler, sourceCode, scriptLanguage, timeout) {
  if (!existingHandler) return false;
  if (String(existingHandler.sourceCode ?? '') !== String(sourceCode ?? '')) return false;
  if (scriptLanguage && String(existingHandler.scriptLanguage || 'javascript') !== String(scriptLanguage)) return false;
  if (timeout !== undefined && Number(existingHandler.timeout) !== Number(timeout)) return false;
  return true;
}

export function extensionMatches(existingExtension, opts, menuId) {
  if (!existingExtension) return false;
  if (String(existingExtension.type || '') !== String(opts.type || 'page')) return false;
  if (String(existingExtension.code ?? '') !== String(opts.code ?? '')) return false;
  if (opts.description !== undefined && String(existingExtension.description || '') !== String(opts.description || '')) return false;
  if (opts.isEnabled !== undefined && Boolean(existingExtension.isEnabled) !== Boolean(opts.isEnabled)) return false;
  if (opts.version !== undefined && String(existingExtension.version || '') !== String(opts.version)) return false;
  if ((opts.type || 'page') === 'page' && menuId && String(refId(existingExtension.menu)) !== String(menuId)) return false;
  if ((opts.type || 'page') !== 'page' && refId(existingExtension.menu)) return false;
  return true;
}

export function step(status, id, title, detail: AnyRecord = {}): AnyRecord {
  return { id, title, status, ...detail };
}

async function resolveApiEndpointWorkflowState(apiUrl, opts) {
  const normalizedPath = normalizeRestPath(opts.path);
  const methodName = normalizeMethodName(opts.method);
  const access = normalizeEndpointAccess(opts.anonymousAccess, opts.public);
  assertDynamicEndpointContract(reviewDynamicEndpointContract({
    routeKind: 'custom',
    method: methodName,
    sourceCode: opts.sourceCode,
  }));
  const { methodMap, methodIdNameMap } = await getMethodContext(apiUrl);
  const methodId = methodMap[methodName];
  if (!methodId) throw new Error(`Unknown method "${methodName}". Valid methods: ${Object.keys(methodMap).sort().join(', ')}`);

  const [routes, scriptValidation, contractReview] = await Promise.all([
    fetchAll(apiUrl, '/enfyra_route?limit=1000&fields=id,_id,path,isEnabled,description,availableMethods.*,publicMethods.*,mainTable.name'),
    validateScriptSourceIfPresent(fetchAPI, apiUrl, 'enfyra_route_handler', {
      sourceCode: opts.sourceCode,
      scriptLanguage: opts.scriptLanguage || 'javascript',
    }),
    reviewCustomEndpointSource(apiUrl, methodName, opts.sourceCode),
  ]);

  const route = routes.find((item) => item.path === normalizedPath) || null;
  assertCustomEndpointRoute(route);
  const routeId = getId(route);
  const availableMethods = methodNamesFromRecords(route?.availableMethods || [], methodIdNameMap);
  const publicMethods = methodNamesFromRecords(route?.publicMethods || [], methodIdNameMap);
  const methodAvailable = availableMethods.includes(methodName);
  const routeNeedsUpdate = !!route && (
    route.isEnabled === false
    || !methodAvailable
    || (access === 'public' && !publicMethods.includes(methodName))
    || (access === 'private' && publicMethods.includes(methodName))
    || (opts.description !== undefined && route.description !== opts.description)
  );
  const handler = route ? await findHandler(apiUrl, routeId, methodId) : null;
  const handlerMatches = sourceMatches(handler, opts.sourceCode, opts.scriptLanguage || 'javascript', opts.timeout);
  const handlerNeedsOverwrite = !!handler && !handlerMatches;

  let permission = null;
  let role = null;
  let permissionMethods = [];
  let permissionMissingMethods = [];
  if (opts.roleName || opts.roleId || opts.allowedUserIds?.length) {
    if (access === 'public') {
      permissionMissingMethods = [];
    } else if (!route) {
      permissionMissingMethods = [methodName];
    } else {
      const permissions = await fetchRecords(apiUrl, 'enfyra_route_permission', {
        route: { id: { _eq: routeId } },
      }, 'id,_id,route.id,role.id,role.name,allowedUsers.id,methods.*', 1000);
      role = await resolveRole(apiUrl, { roleId: opts.roleId, roleName: opts.roleName });
      const allowedUserIds = (opts.allowedUserIds || []).map(String).sort();
      permission = permissions.find((candidate) => {
        const candidateRoleId = refId(candidate.role);
        const candidateUserIds = (candidate.allowedUsers || []).map((item) => String(refId(item))).sort();
        if (role && String(candidateRoleId) !== String(role.id)) return false;
        if (!role && candidateRoleId !== null && candidateRoleId !== undefined) return false;
        return allowedUserIds.length === candidateUserIds.length
          && allowedUserIds.every((value, index) => value === candidateUserIds[index]);
      }) || null;
      permissionMethods = methodNamesFromRecords(permission?.methods || [], methodIdNameMap);
      permissionMissingMethods = permissionMethods.includes(methodName) ? [] : [methodName];
    }
  }

  const smokeTestRequested = opts.smokeTestQuery !== undefined || opts.smokeTestBody !== undefined;
  const steps = [
    route
      ? step(routeNeedsUpdate ? 'pending' : 'completed', 'sync_route', 'Ensure route method and public access', {
        routeId,
        availableMethods,
        publicMethods,
        desiredAccess: access,
      })
      : step('pending', 'create_route', 'Create custom route', {
        desiredAccess: access,
      }),
    handler
      ? step(handlerNeedsOverwrite ? (opts.overwrite ? 'pending' : 'blocked') : 'completed', 'save_handler', 'Create or update route handler', {
        handlerId: getId(handler),
        reason: handlerNeedsOverwrite && !opts.overwrite ? 'Existing handler differs. Re-run with overwrite=true to update it.' : undefined,
      })
      : step(route && methodAvailable ? 'pending' : 'waiting', 'save_handler', 'Create route handler', {
        reason: !route ? 'Route must exist first.' : methodAvailable ? undefined : 'Route method must be available first.',
      }),
  ];

  if (opts.roleName || opts.roleId || opts.allowedUserIds?.length) {
    steps.push(
      access === 'public'
        ? step('skipped', 'ensure_route_access', 'Ensure authenticated route access', {
          reason: 'Method is public, so route permission is not required for anonymous access.',
        })
        : step(permissionMissingMethods.length ? (route ? 'pending' : 'waiting') : 'completed', 'ensure_route_access', 'Ensure authenticated route access', {
          permissionId: getId(permission),
          role,
          allowedUserIds: opts.allowedUserIds || [],
          methods: permissionMethods,
          missingMethods: permissionMissingMethods,
        }),
    );
  }

  if (smokeTestRequested) {
    const blockers = steps.filter((item) => ['pending', 'waiting', 'blocked'].includes(item.status));
    steps.push(step(blockers.length ? 'waiting' : 'pending', 'smoke_test', 'Smoke-test the endpoint', {
      reason: blockers.length ? 'Endpoint must be ready before smoke test.' : undefined,
    }));
  }

  const firstRunnable = steps.find((item) => item.status === 'pending') || null;
  const blocked = steps.find((item) => item.status === 'blocked') || null;

  const pendingAckParams = firstRunnable
    ? [
      'globalRulesAckKey',
      ...(firstRunnable.id === 'save_handler' ? ['knowledgeAckKey'] : []),
    ]
    : [];
  const nextSteps: WorkflowNextStep[] = blocked
    ? [{ tool: 'api_endpoint_workflow', input: { path: normalizedPath, method: methodName, overwrite: true }, reason: blocked.reason }]
    : firstRunnable
      ? [{
        tool: 'api_endpoint_workflow',
        input: { path: normalizedPath, method: methodName, apply: true },
        stepId: firstRunnable.id,
        requiredAckParams: pendingAckParams,
        requiresKnowledgeAck: pendingAckParams.length
          ? `Pass ${pendingAckParams.join(' and ')} from get_enfyra_required_knowledge when applying this step.`
          : undefined,
      }]
      : [];

  return {
    endpoint: {
      path: normalizedPath,
      method: methodName,
      anonymousAccess: access,
      routeId,
      handlerId: getId(handler),
    },
    methodId,
    methodMap,
    methodIdNameMap,
    route,
    handler,
    role,
    scriptValidation,
    contractReview,
    steps,
    firstRunnable,
    blocked,
    nextSteps,
  };
}

async function applyApiEndpointWorkflowStep(apiUrl, state, opts, stepId) {
  const selectedStep = stepId
    ? state.steps.find((item) => item.id === stepId)
    : state.firstRunnable;
  if (!selectedStep) return { action: 'noop', reason: 'No runnable step remains.' };
  if (selectedStep.status !== 'pending') {
    throw new Error(`Step "${selectedStep.id}" is ${selectedStep.status}, not pending.`);
  }

  const endpoint = state.endpoint;
  if (selectedStep.id === 'create_route') {
    const result = await fetchAPI(apiUrl, '/enfyra_route', {
      method: 'POST',
      body: JSON.stringify({
        path: endpoint.path,
        description: opts.description,
        isEnabled: true,
        availableMethods: [{ id: state.methodId }],
        publicMethods: endpoint.anonymousAccess === 'public' ? [{ id: state.methodId }] : [],
      }),
    });
    return { action: 'route_created', result, routeReload: await reloadRoutes(apiUrl) };
  }

  if (selectedStep.id === 'sync_route') {
    const availableMethods = methodNamesFromRecords(state.route.availableMethods, state.methodIdNameMap);
    const publicMethods = methodNamesFromRecords(state.route.publicMethods, state.methodIdNameMap);
    const finalAvailable = uniqueMethodNames([...availableMethods, endpoint.method]);
    const finalPublic = endpoint.anonymousAccess === 'public'
      ? uniqueMethodNames([...publicMethods, endpoint.method])
      : publicMethods.filter((method) => method !== endpoint.method);
    const result = await fetchAPI(apiUrl, `/enfyra_route/${encodeURIComponent(String(endpoint.routeId))}`, {
      method: 'PATCH',
      body: JSON.stringify({
        isEnabled: true,
        availableMethods: resolveMethodRefs(state.methodMap, finalAvailable),
        publicMethods: resolveMethodRefs(state.methodMap, finalPublic),
        ...(opts.description !== undefined ? { description: opts.description } : {}),
      }),
    });
    return { action: 'route_synced', result, routeReload: await reloadRoutes(apiUrl) };
  }

  if (selectedStep.id === 'save_handler') {
    assertDynamicCodeKnowledgeAck(opts.knowledgeAckKey);
    if (!endpoint.routeId) throw new Error('Route must exist before saving handler.');
    const body = {
      sourceCode: opts.sourceCode,
      scriptLanguage: opts.scriptLanguage || 'javascript',
      ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    };
    if (state.handler) {
      const result = await fetchAPI(apiUrl, `/enfyra_route_handler/${encodeURIComponent(String(getId(state.handler)))}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return { action: 'handler_updated', result, routeReload: await reloadRoutes(apiUrl) };
    }
    const result = await fetchAPI(apiUrl, '/enfyra_route_handler', {
      method: 'POST',
      body: JSON.stringify({
        route: { id: endpoint.routeId },
        method: { id: state.methodId },
        ...body,
      }),
    });
    return { action: 'handler_created', result, routeReload: await reloadRoutes(apiUrl) };
  }

  if (selectedStep.id === 'ensure_route_access') {
    assertOneScope(opts);
    const role = state.role || await resolveRole(apiUrl, { roleId: opts.roleId, roleName: opts.roleName });
    const existing = state.steps.find((item) => item.id === 'ensure_route_access')?.permissionId
      ? await findRecord(apiUrl, 'enfyra_route_permission', { id: { _eq: state.steps.find((item) => item.id === 'ensure_route_access').permissionId } }, 'id,_id,methods.*')
      : null;
    const existingMethods = methodNamesFromRecords(existing?.methods || [], state.methodIdNameMap);
    const finalMethods = uniqueMethodNames([...existingMethods, endpoint.method]);
    const body = {
      isEnabled: true,
      description: opts.routePermissionDescription,
      methods: resolveMethodRefs(state.methodMap, finalMethods),
      ...(role ? { role: { id: role.id } } : {}),
      ...(opts.allowedUserIds?.length ? { allowedUsers: opts.allowedUserIds.map((id) => ({ id })) } : {}),
    };
    const result = existing
      ? await fetchAPI(apiUrl, `/enfyra_route_permission/${encodeURIComponent(String(getId(existing)))}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      : await fetchAPI(apiUrl, '/enfyra_route_permission', {
        method: 'POST',
        body: JSON.stringify({
          route: { id: endpoint.routeId },
          ...body,
        }),
      });
    return { action: existing ? 'route_access_updated' : 'route_access_created', result, routeReload: await reloadRoutes(apiUrl) };
  }

  if (selectedStep.id === 'smoke_test') {
    const query = parseJsonObjectArg('smokeTestQuery', opts.smokeTestQuery, {});
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) queryParams.set(key, String(value));
    }
    const body = opts.smokeTestBody === undefined ? undefined : parseJsonObjectArg('smokeTestBody', opts.smokeTestBody, {});
    const smokePath = `${endpoint.path}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
    const result = await fetchAPI(apiUrl, smokePath, {
      method: endpoint.method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { action: 'smoke_test_passed', result };
  }

  throw new Error(`Unsupported workflow step: ${selectedStep.id}`);
}

export async function runApiEndpointWorkflow(apiUrl, opts) {
  let state = await resolveApiEndpointWorkflowState(apiUrl, opts);
  const operations = [];
  let completedEphemeralStepId = null;
  if (opts.apply || opts.applyAll) {
    assertGlobalRulesAck(opts.globalRulesAckKey);
    if (opts.applyAll && state.steps.some((item) => item.id === 'save_handler' && ['pending', 'waiting'].includes(item.status))) {
      assertDynamicCodeKnowledgeAck(opts.knowledgeAckKey);
    }
    const maxSteps = opts.applyAll ? 10 : 1;
    for (let i = 0; i < maxSteps; i += 1) {
      if (state.blocked || !state.firstRunnable) break;
      const operation = await applyApiEndpointWorkflowStep(apiUrl, state, opts, opts.stepId);
      operations.push(operation);
      if (state.firstRunnable.id === 'smoke_test') {
        completedEphemeralStepId = 'smoke_test';
        break;
      }
      if (!opts.applyAll) break;
      state = await resolveApiEndpointWorkflowState(apiUrl, opts);
    }
  }
  const latestState = operations.length ? await resolveApiEndpointWorkflowState(apiUrl, opts) : state;
  const latestSteps = completedEphemeralStepId
    ? latestState.steps.map((item) => (
      item.id === completedEphemeralStepId
        ? { ...item, status: 'completed', result: 'passed' }
        : item
    ))
    : latestState.steps;
  const nextSteps = completedEphemeralStepId
    ? latestState.nextSteps.filter((item) => item.stepId !== completedEphemeralStepId)
    : latestState.nextSteps;
  return {
    action: operations.length ? 'api_endpoint_workflow_advanced' : 'api_endpoint_workflow_planned',
    endpoint: latestState.endpoint,
    scriptValidation: latestState.scriptValidation,
    contractReview: latestState.contractReview,
    steps: latestSteps,
    operations: operations.map(summarizeWorkflowOperation),
    complete: latestSteps.every((item) => ['completed', 'skipped'].includes(item.status)),
    nextSteps,
    cleanupHints: latestState.endpoint.routeId
      ? [
        `Use delete_route({ routeId: ${JSON.stringify(latestState.endpoint.routeId)}, confirm: false }) to preview route-owned handlers, hooks, guards, and permissions before cleanup.`,
        `Then call delete_route({ routeId: ${JSON.stringify(latestState.endpoint.routeId)}, expectedRouteId: ${JSON.stringify(latestState.endpoint.routeId)}, expectedPath: ${JSON.stringify(latestState.endpoint.path)}, confirm: true }) when the route contract is no longer needed.`,
      ]
      : [],
  };
}
