type CacheEntry = {
  domain: RuntimeCacheDomain;
  value: unknown;
  expiresAt: number;
};

type CacheEventKind = 'mutation_invalidation' | 'auth_invalidation' | 'reload_invalidation' | 'warm_failure';

type CacheEvent = {
  timestamp: string;
  kind: CacheEventKind;
  domains: RuntimeCacheDomain[];
  entries: number;
};

const entries = new Map<string, CacheEntry>();
const MAX_CACHE_EVENTS = 20;
const MAX_CACHE_ENTRIES = 500;
const CACHE_TTL_MS = 5 * 60 * 1000;
let runtimeCacheEnabled = true;
const cacheStats = {
  hits: 0,
  misses: 0,
  invalidations: { mutation: 0, auth: 0, reload: 0 },
  warm: { attempted: 0, succeeded: 0, failed: 0 },
  domains: new Map<RuntimeCacheDomain, { hits: number; misses: number; invalidations: number; warmFailures: number }>(),
  events: [] as CacheEvent[],
};

const PATH_DOMAIN_PREFIXES: Array<[string, RuntimeCacheDomain]> = [
  ['/metadata', 'metadata'],
  ['/enfyra_table', 'metadata'],
  ['/enfyra_relation', 'metadata'],
  ['/enfyra_route_handler', 'route'],
  ['/enfyra_pre_hook', 'route'],
  ['/enfyra_post_hook', 'route'],
  ['/enfyra_route_permission', 'route'],
  ['/enfyra_route', 'route'],
  ['/enfyra_role', 'route'],
  ['/enfyra_method', 'route'],
  ['/enfyra_guard_rule', 'guard'],
  ['/enfyra_guard', 'guard'],
  ['/enfyra_field_permission', 'fieldPermission'],
  ['/enfyra_column_rule', 'column-rule'],
  ['/enfyra_setting', 'setting'],
  ['/enfyra_storage_config', 'storage'],
  ['/enfyra_oauth_config', 'oauth'],
  ['/enfyra_websocket_event', 'websocket'],
  ['/enfyra_websocket', 'websocket'],
  ['/enfyra_package', 'package'],
  ['/enfyra_flow_step', 'flow'],
  ['/enfyra_flow', 'flow'],
  ['/enfyra_folder', 'folder'],
  ['/enfyra_bootstrap_script', 'bootstrap'],
  ['/enfyra_menu', 'menu'],
  ['/enfyra_extension', 'extension'],
  ['/enfyra_graphql', 'graphql'],
];

export type RuntimeCacheDomain =
  | 'metadata'
  | 'route'
  | 'guard'
  | 'fieldPermission'
  | 'column-rule'
  | 'setting'
  | 'storage'
  | 'oauth'
  | 'websocket'
  | 'package'
  | 'flow'
  | 'folder'
  | 'bootstrap'
  | 'menu'
  | 'extension'
  | 'graphql';

const ALL_RUNTIME_CACHE_DOMAINS = [...new Set(PATH_DOMAIN_PREFIXES.map(([, domain]) => domain))];
const domainGenerations = new Map<RuntimeCacheDomain, number>();

function clone<T>(value: T): T {
  return structuredClone(value);
}

function domainStats(domain: RuntimeCacheDomain) {
  const current = cacheStats.domains.get(domain) || { hits: 0, misses: 0, invalidations: 0, warmFailures: 0 };
  cacheStats.domains.set(domain, current);
  return current;
}

function recordCacheEvent(kind: CacheEventKind, domains: Iterable<RuntimeCacheDomain>, entriesCount: number) {
  if (!entriesCount && kind !== 'auth_invalidation') return;
  cacheStats.events.push({
    timestamp: new Date().toISOString(),
    kind,
    domains: [...new Set(domains)],
    entries: entriesCount,
  });
  if (cacheStats.events.length > MAX_CACHE_EVENTS) cacheStats.events.shift();
}

export function isRuntimeCacheableGet(path: string, method = 'GET') {
  return method.toUpperCase() === 'GET' && runtimeCacheDomainForPath(path) !== null;
}

export function runtimeCacheDomainForPath(path: string): RuntimeCacheDomain | null {
  const normalizedPath = path.split('?')[0];
  const match = PATH_DOMAIN_PREFIXES.find(([prefix]) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`));
  return match?.[1] ?? null;
}

export function getRuntimeCache(path: string) {
  if (!runtimeCacheEnabled) return undefined;
  const entry = entries.get(path);
  const domain = runtimeCacheDomainForPath(path);
  const validEntry = entry && entry.expiresAt > Date.now() ? entry : undefined;
  if (entry && !validEntry) entries.delete(path);
  if (domain) {
    const stats = domainStats(domain);
    if (validEntry) {
      cacheStats.hits += 1;
      stats.hits += 1;
    } else {
      cacheStats.misses += 1;
      stats.misses += 1;
    }
  }
  if (!validEntry) return undefined;
  entries.delete(path);
  entries.set(path, validEntry);
  return clone(validEntry.value);
}

export function runtimeCacheGenerationForPath(path: string) {
  const domain = runtimeCacheDomainForPath(path);
  return domain ? domainGenerations.get(domain) || 0 : 0;
}

export function setRuntimeCache(path: string, value: unknown, expectedGeneration?: number) {
  const domain = runtimeCacheDomainForPath(path);
  if (!domain || !runtimeCacheEnabled) return;
  if (expectedGeneration !== undefined && expectedGeneration !== (domainGenerations.get(domain) || 0)) return;
  entries.delete(path);
  entries.set(path, { domain, value: clone(value), expiresAt: Date.now() + CACHE_TTL_MS });
  while (entries.size > MAX_CACHE_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function setRuntimeCacheEnabled(enabled: boolean) {
  runtimeCacheEnabled = enabled;
}

export function runtimeCacheKeysForDomains(domains: Iterable<RuntimeCacheDomain>) {
  const allowed = new Set(domains);
  return [...entries.entries()]
    .filter(([, entry]) => allowed.has(entry.domain))
    .map(([path]) => path);
}

export function clearRuntimeCache(reason?: 'mutation' | 'auth' | 'reload') {
  const removed = [...entries.values()];
  for (const domain of ALL_RUNTIME_CACHE_DOMAINS) {
    domainGenerations.set(domain, (domainGenerations.get(domain) || 0) + 1);
  }
  if (reason) {
    cacheStats.invalidations[reason] += removed.length;
    for (const entry of removed) domainStats(entry.domain).invalidations += 1;
    recordCacheEvent(`${reason}_invalidation`, removed.map((entry) => entry.domain), removed.length);
  }
  entries.clear();
}

export function clearRuntimeCacheDomains(domains: Iterable<RuntimeCacheDomain>, reason?: 'mutation' | 'auth' | 'reload') {
  const allowed = new Set(domains);
  for (const domain of allowed) {
    domainGenerations.set(domain, (domainGenerations.get(domain) || 0) + 1);
  }
  const removedDomains: RuntimeCacheDomain[] = [];
  for (const [path, entry] of entries) {
    if (!allowed.has(entry.domain)) continue;
    if (reason) {
      cacheStats.invalidations[reason] += 1;
      domainStats(entry.domain).invalidations += 1;
      removedDomains.push(entry.domain);
    }
    entries.delete(path);
  }
  if (reason) recordCacheEvent(`${reason}_invalidation`, removedDomains, removedDomains.length);
}

export function recordRuntimeCacheWarm(path: string, succeeded: boolean) {
  const domain = runtimeCacheDomainForPath(path);
  if (!domain) return;
  cacheStats.warm.attempted += 1;
  if (succeeded) cacheStats.warm.succeeded += 1;
  else {
    cacheStats.warm.failed += 1;
    domainStats(domain).warmFailures += 1;
    recordCacheEvent('warm_failure', [domain], 1);
  }
}

export function getRuntimeCacheTelemetry() {
  const lookups = cacheStats.hits + cacheStats.misses;
  return {
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    hitRate: lookups ? Number((cacheStats.hits / lookups).toFixed(4)) : null,
    invalidations: { ...cacheStats.invalidations },
    warm: { ...cacheStats.warm },
    warmSuccessRate: cacheStats.warm.attempted
      ? Number((cacheStats.warm.succeeded / cacheStats.warm.attempted).toFixed(4))
      : null,
    domains: Object.fromEntries(cacheStats.domains.entries()),
    events: cacheStats.events.map((event) => ({ ...event, domains: [...event.domains] })),
  };
}

export function runtimeCacheDomainsForReloadSteps(steps: string[]): RuntimeCacheDomain[] {
  const domains = new Set<RuntimeCacheDomain>();
  for (const step of steps) {
    if (step === 'metadata' || step === 'graphql') domains.add('metadata');
    if (step === 'metadata' || step === 'route') domains.add('route');
    if (step === 'menu') {
      domains.add('menu');
      domains.add('extension');
    }
    if (step === 'extension') {
      domains.add('extension');
      domains.add('menu');
    }
    if (step === 'storage' || step === 'storage_config' || step === 'enfyra_storage_config') domains.add('storage');
    if (step === 'graphql') domains.add('graphql');
    if (step === 'guard') domains.add('guard');
    if (step === 'fieldPermission') domains.add('fieldPermission');
    if (step === 'column-rule') domains.add('column-rule');
    if (step === 'setting' || step === 'settingGraphql') domains.add('setting');
    if (step === 'oauth') domains.add('oauth');
    if (step === 'websocket') domains.add('websocket');
    if (step === 'package') domains.add('package');
    if (step === 'flow') domains.add('flow');
    if (step === 'folder') domains.add('folder');
    if (step === 'bootstrap') domains.add('bootstrap');
  }
  return [...domains];
}

export function runtimeCacheDomainsForMutationPath(path: string) {
  const domain = runtimeCacheDomainForPath(path);
  if (!domain) return [];
  const stepsByDomain: Record<RuntimeCacheDomain, string[]> = {
    metadata: ['metadata', 'route', 'graphql', 'fieldPermission', 'column-rule'],
    route: ['route'],
    guard: ['guard'],
    fieldPermission: ['fieldPermission', 'graphql'],
    'column-rule': ['column-rule'],
    setting: ['setting', 'settingGraphql'],
    storage: ['storage'],
    oauth: ['oauth'],
    websocket: ['websocket'],
    package: ['package'],
    flow: ['flow'],
    folder: ['folder'],
    bootstrap: ['bootstrap'],
    menu: ['menu', 'extension'],
    extension: ['extension'],
    graphql: ['graphql'],
  };
  const domains = runtimeCacheDomainsForReloadSteps(stepsByDomain[domain]);
  const normalizedPath = path.split('?')[0];
  if (normalizedPath === '/enfyra_role' || normalizedPath.startsWith('/enfyra_role/')) {
    domains.push('fieldPermission');
  }
  return [...new Set(domains)];
}
