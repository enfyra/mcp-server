export const RUNTIME_ZONES = [
  'admin_ui',
  'api_runtime',
  'flow_runtime',
  'websocket_runtime',
  'graphql_runtime',
  'schema_data',
  'package_runtime',
  'storage_file',
  'auth_security',
] as const;

export type RuntimeZone = typeof RUNTIME_ZONES[number];
export type RuntimeRecord = Record<string, any>;

export type ZoneTable = {
  tableName: string;
  fields: string;
  sourceFields?: string[];
  labelFields?: string[];
  pathFields?: string[];
};

export const ZONE_TABLES: Record<Exclude<RuntimeZone, 'admin_ui' | 'schema_data'>, ZoneTable[]> = {
  api_runtime: [
    { tableName: 'enfyra_route', fields: 'id,_id,path,description,isEnabled,mainTable.name,availableMethods.name,publicMethods.name', labelFields: ['path', 'description'], pathFields: ['path'] },
    { tableName: 'enfyra_route_handler', fields: 'id,_id,name,key,sourceCode,scriptLanguage,route.id,route.path,method.name', sourceFields: ['sourceCode'], labelFields: ['name', 'key', 'route.path', 'method.name'], pathFields: ['route.path'] },
    { tableName: 'enfyra_pre_hook', fields: 'id,_id,name,key,sourceCode,scriptLanguage,isGlobal,route.id,route.path,methods.name', sourceFields: ['sourceCode'], labelFields: ['name', 'key', 'route.path'], pathFields: ['route.path'] },
    { tableName: 'enfyra_post_hook', fields: 'id,_id,name,key,sourceCode,scriptLanguage,isGlobal,route.id,route.path,methods.name', sourceFields: ['sourceCode'], labelFields: ['name', 'key', 'route.path'], pathFields: ['route.path'] },
    { tableName: 'enfyra_guard', fields: 'id,_id,name,description,position,isGlobal,isEnabled,route.id,route.path,methods.name', labelFields: ['name', 'description', 'route.path'], pathFields: ['route.path'] },
    { tableName: 'enfyra_guard_rule', fields: 'id,_id,name,field,operator,value,guard.id,guard.name,description,isEnabled', labelFields: ['name', 'field', 'operator', 'value', 'guard.name', 'description'] },
    { tableName: 'enfyra_route_permission', fields: 'id,_id,description,isEnabled,route.id,route.path,role.name,methods.name,allowedUsers.id', labelFields: ['description', 'route.path', 'role.name'], pathFields: ['route.path'] },
  ],
  flow_runtime: [
    { tableName: 'enfyra_flow', fields: 'id,_id,name,description,triggerType,triggerConfig,isEnabled,timeout,maxExecutions', labelFields: ['name', 'description', 'triggerType', 'triggerConfig'] },
    { tableName: 'enfyra_flow_step', fields: 'id,_id,name,key,type,description,sourceCode,condition,config,flow.id,flow.name,nextStep.id,errorStep.id,isEnabled', sourceFields: ['sourceCode', 'condition'], labelFields: ['name', 'key', 'type', 'description', 'flow.name', 'config'] },
  ],
  websocket_runtime: [
    { tableName: 'enfyra_websocket', fields: 'id,_id,path,description,sourceCode,scriptLanguage,isEnabled', sourceFields: ['sourceCode'], labelFields: ['path', 'description'], pathFields: ['path'] },
    { tableName: 'enfyra_websocket_event', fields: 'id,_id,eventName,description,sourceCode,scriptLanguage,gateway.id,gateway.path,isEnabled', sourceFields: ['sourceCode'], labelFields: ['eventName', 'description', 'gateway.path'], pathFields: ['gateway.path'] },
  ],
  graphql_runtime: [
    { tableName: 'enfyra_graphql', fields: 'id,_id,description,metadata,table.id,table.name,isEnabled', labelFields: ['description', 'table.name', 'metadata'] },
  ],
  package_runtime: [
    { tableName: 'enfyra_package', fields: 'id,_id,name,version,type,description,isEnabled,createdAt,updatedAt', labelFields: ['name', 'version', 'type', 'description'] },
  ],
  storage_file: [
    { tableName: 'enfyra_storage_config', fields: 'id,_id,name,provider,bucket,baseUrl,description,isDefault,isEnabled', labelFields: ['name', 'provider', 'bucket', 'baseUrl', 'description'] },
    { tableName: 'enfyra_folder', fields: 'id,_id,name,slug,path,description,parent.id,parent.name,isPublic,createdAt,updatedAt', labelFields: ['name', 'slug', 'path', 'description'], pathFields: ['path'] },
    { tableName: 'enfyra_file', fields: 'id,_id,fileName,originalName,mimeType,path,url,isPublic,folder.id,folder.name,storage.id,storage.name,createdAt,updatedAt', labelFields: ['fileName', 'originalName', 'mimeType', 'path', 'url', 'folder.name', 'storage.name'], pathFields: ['path', 'url'] },
    { tableName: 'enfyra_file_permission', fields: 'id,_id,file.id,file.fileName,role.name,allowedUsers.id,methods.name,description,isEnabled', labelFields: ['file.fileName', 'role.name', 'description'] },
  ],
  auth_security: [
    { tableName: 'enfyra_user', fields: 'id,_id,email,isRootAdmin,isSystem,role.id,role.name,createdAt,updatedAt', labelFields: ['email', 'role.name'] },
    { tableName: 'enfyra_role', fields: 'id,_id,name,description,isSystem,createdAt,updatedAt', labelFields: ['name', 'description'] },
    { tableName: 'enfyra_route_permission', fields: 'id,_id,description,isEnabled,route.id,route.path,role.name,methods.name,allowedUsers.id', labelFields: ['description', 'route.path', 'role.name'], pathFields: ['route.path'] },
    { tableName: 'enfyra_field_permission', fields: 'id,_id,description,action,effect,role.name,column.name,relation.propertyName,condition,isEnabled', labelFields: ['description', 'action', 'effect', 'role.name', 'column.name', 'relation.propertyName', 'condition'] },
    { tableName: 'enfyra_guard', fields: 'id,_id,name,description,position,isGlobal,isEnabled,route.id,route.path,methods.name', labelFields: ['name', 'description', 'route.path'], pathFields: ['route.path'] },
    { tableName: 'enfyra_guard_rule', fields: 'id,_id,name,field,operator,value,guard.id,guard.name,description,isEnabled', labelFields: ['name', 'field', 'operator', 'value', 'guard.name', 'description'] },
    { tableName: 'enfyra_oauth_config', fields: 'id,_id,provider,redirectUri,sourceCode,appCallbackUrl,autoSetCookies,scriptLanguage,isEnabled,description', sourceFields: ['sourceCode'], labelFields: ['provider', 'redirectUri', 'appCallbackUrl', 'description'] },
    { tableName: 'enfyra_oauth_account', fields: 'id,_id,provider,providerUserId,user.id,user.email,createdAt,updatedAt', labelFields: ['provider', 'providerUserId', 'user.email'] },
  ],
};

export const RUNTIME_ZONE_DESCRIPTIONS: Record<RuntimeZone, string> = {
  admin_ui: 'Admin menu + extension UI records: pages, widgets, global shell extensions, menu chips, account panel entries.',
  api_runtime: 'REST routes, handlers, hooks, guards, guard rules, and route permissions.',
  flow_runtime: 'Flows and flow steps that run background jobs, scheduled tasks, and manual operations.',
  websocket_runtime: 'Socket.IO gateways and event handlers.',
  graphql_runtime: 'Table GraphQL exposure metadata used by generated resolvers.',
  schema_data: 'Tables, columns, relations, column rules, field permissions, and route-backed data shape.',
  package_runtime: 'Installed app/server packages and runtime package availability.',
  storage_file: 'Storage configs, folders, files, public file state, and file permissions.',
  auth_security: 'Users, roles, route/field permissions, guards, OAuth provider provisioning, and linked OAuth accounts.',
};

export function buildRuntimeZoneCatalog() {
  return {
    action: 'runtime_zone_catalog',
    zones: RUNTIME_ZONES.map((name) => ({
      name,
      description: RUNTIME_ZONE_DESCRIPTIONS[name],
      nextSearch: {
        tool: 'search_runtime_zone',
        input: { mode: 'search', zone: name },
      },
    })),
    guidance: [
      'Choose one returned zone and call its nextSearch input.',
      'Add query or path when you know a target. Keep them omitted for a bounded zone inventory.',
    ],
  };
}

