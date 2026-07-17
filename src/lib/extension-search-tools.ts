import { fetchAPI } from './fetch.js';
import { writeSourceArtifact } from './source-artifacts.js';
import { normalizeSnippetChars } from './tool-input-normalization.js';
import { paginateResults } from './pagination.js';

type ExtensionRecord = Record<string, any>;
type MenuRecord = Record<string, any>;
type SearchMatch = {
  field: string;
  section?: 'template' | 'script' | 'style' | 'code';
  line?: number;
  score: number;
  reason: string;
  snippet: string;
};

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'và',
  'la',
  'là',
  'cua',
  'của',
  'o',
  'ở',
  'cho',
  'nay',
  'này',
]);

const EXTENSION_FIELDS = [
  'id',
  '_id',
  'type',
  'name',
  'extensionId',
  'version',
  'isEnabled',
  'isSystem',
  'description',
  'updatedAt',
  'menu.id',
  'menu._id',
  'menu.label',
  'menu.path',
  'menu.icon',
  'menu.sidebar.id',
  'menu.sidebar._id',
  'code',
].join(',');

const MENU_FIELDS_WITH_EXTENSION = [
  'id',
  '_id',
  'label',
  'path',
  'icon',
  'type',
  'order',
  'isEnabled',
  'parent.id',
  'parent._id',
  'parent.label',
  'parent.path',
  'sidebar.id',
  'sidebar._id',
  'extension.id',
  'extension._id',
  'extension.type',
  'extension.name',
  'extension.extensionId',
  'extension.version',
  'extension.isEnabled',
  'extension.description',
  'extension.updatedAt',
].join(',');

function getId(record: any) {
  return record?.id ?? record?._id ?? null;
}

function unwrapData(result: any): any[] {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result)) return result;
  return [];
}

function normalizeText(value: unknown) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizePath(path: string | undefined) {
  if (!path) return '';
  const trimmed = String(path).trim();
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function filterQuery(filter: any) {
  return encodeURIComponent(JSON.stringify(filter));
}

async function fetchAllExtensions(apiUrl: string, type?: string) {
  const filter = type ? `&filter=${filterQuery({ type: { _eq: type } })}` : '';
  const result = await fetchAPI(apiUrl, `/enfyra_extension?limit=0&sort=type,name,id&fields=${encodeURIComponent(EXTENSION_FIELDS)}${filter}`);
  return unwrapData(result);
}

async function fetchMenusWithExtensions(apiUrl: string) {
  const result = await fetchAPI(apiUrl, `/enfyra_menu?limit=0&sort=order,label,path,id&fields=${encodeURIComponent(MENU_FIELDS_WITH_EXTENSION)}`);
  return unwrapData(result);
}

function menuForExtension(extension: ExtensionRecord, menus: MenuRecord[]) {
  const extensionId = String(getId(extension) ?? '');
  const directMenu = extension.menu;
  if (directMenu) return directMenu;
  if (!extensionId) return null;
  return menus.find((menu) => String(getId(menu.extension)) === extensionId) ?? null;
}

function surfaceFor(extension: ExtensionRecord, menu: MenuRecord | null) {
  const type = extension.type || 'page';
  if (type === 'page') return menu?.path ? `page:${menu.path}` : 'page:(menu missing)';
  if (type === 'global') return 'global:shell';
  if (type === 'widget') return `widget:${getId(extension) ?? extension.name}`;
  return String(type);
}

function splitSections(code: string) {
  const sections: Array<{ section: SearchMatch['section']; start: number; end: number; text: string }> = [];
  const patterns: Array<[SearchMatch['section'], RegExp]> = [
    ['template', /<template\b[^>]*>[\s\S]*?<\/template>/i],
    ['script', /<script\b[^>]*>[\s\S]*?<\/script>/i],
    ['style', /<style\b[^>]*>[\s\S]*?<\/style>/i],
  ];
  for (const [section, pattern] of patterns) {
    const match = pattern.exec(code);
    if (match?.index !== undefined) {
      sections.push({ section, start: match.index, end: match.index + match[0].length, text: match[0] });
    }
  }
  if (!sections.length) sections.push({ section: 'code', start: 0, end: code.length, text: code });
  return sections;
}

function sectionAtOffset(sections: ReturnType<typeof splitSections>, offset: number) {
  return sections.find((item) => offset >= item.start && offset <= item.end)?.section ?? 'code';
}

function lineEntries(code: string) {
  const lines = code.split('\n');
  let offset = 0;
  return lines.map((line, index) => {
    const entry = { line, lineNumber: index + 1, offset };
    offset += line.length + 1;
    return entry;
  });
}

function compactArtifact(artifact: ReturnType<typeof writeSourceArtifact>) {
  return {
    resourceUri: artifact.resourceUri,
    tmpFile: artifact.tmpFile,
    length: artifact.length,
    sha256: artifact.sha256,
  };
}

function metadataMatches(extension: ExtensionRecord, menu: MenuRecord | null, terms: string[], phrase: string, snippetChars: number): SearchMatch[] {
  const fields: Array<[string, unknown, number]> = [
    ['name', extension.name, 45],
    ['description', extension.description, 25],
    ['type', extension.type, 15],
    ['extensionId', extension.extensionId, 25],
    ['menu.label', menu?.label, 45],
    ['menu.path', menu?.path, 50],
    ['menu.icon', menu?.icon, 15],
  ];
  const matches: SearchMatch[] = [];
  for (const [field, value, weight] of fields) {
    const text = normalizeText(value);
    if (!text) continue;
    const hasPhrase = phrase && text.includes(phrase);
    const termHits = terms.filter((term) => text.includes(term));
    if (!hasPhrase && termHits.length === 0) continue;
    matches.push({
      field,
      score: weight + (hasPhrase ? 40 : 0) + termHits.length * 8,
      reason: hasPhrase ? 'metadata phrase match' : `metadata term match: ${termHits.join(', ')}`,
      snippet: String(value ?? '').slice(0, snippetChars),
    });
  }
  return matches;
}

function codeMatches(code: string, terms: string[], phrase: string, snippetChars: number, maxPerExtension: number): SearchMatch[] {
  if (!code) return [];
  const minTermHits = phrase && terms.length >= 3 ? Math.min(2, terms.length) : 1;
  const sections = splitSections(code);
  const candidates: SearchMatch[] = [];
  const entries = lineEntries(code);

  for (let index = 0; index < entries.length; index += 1) {
    const windowEntries = entries.slice(index, Math.min(entries.length, index + 3));
    const text = windowEntries.map((entry) => entry.line).join(' ');
    const normalized = normalizeText(text);
    const phraseHit = Boolean(phrase && normalized.includes(phrase));
    const termHits = terms.filter((term) => normalized.includes(term));
    const distinctHits = [...new Set(termHits)];
    if (!phraseHit && distinctHits.length < minTermHits) continue;

    const section = sectionAtOffset(sections, entries[index].offset);
    const score = (phraseHit ? 70 : 0)
      + distinctHits.length * 18
      + (section === 'template' ? 12 : section === 'script' ? 8 : 0);
    candidates.push({
      field: 'code',
      section,
      line: entries[index].lineNumber,
      score,
      reason: phraseHit ? 'source phrase match' : `source term match: ${distinctHits.join(', ')}`,
      snippet: text.replace(/\s+/g, ' ').trim().slice(0, snippetChars),
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score || (a.line ?? 0) - (b.line ?? 0))
    .slice(0, maxPerExtension);
}

function summarizeExtension(extension: ExtensionRecord, menu: MenuRecord | null, matches: SearchMatch[], includeSourceArtifact: boolean, exactPathMatch = false) {
  const id = getId(extension);
  const code = typeof extension.code === 'string' ? extension.code : '';
  return {
    id,
    name: extension.name,
    type: extension.type,
    isEnabled: extension.isEnabled,
    version: extension.version,
    updatedAt: extension.updatedAt,
    surface: surfaceFor(extension, menu),
    menu: menu ? {
      id: getId(menu),
      label: menu.label,
      path: menu.path,
      icon: menu.icon,
      sidebarId: getId(menu.sidebar),
      parent: menu.parent ? { id: getId(menu.parent), label: menu.parent.label, path: menu.parent.path } : null,
    } : null,
    exactPathMatch,
    score: matches.reduce((sum, item) => sum + item.score, 0),
    matches: matches
      .sort((a, b) => b.score - a.score)
      .slice(0, 4),
    source: code
      ? includeSourceArtifact
        ? compactArtifact(writeSourceArtifact({ tableName: 'enfyra_extension', id: id ?? extension.name, fieldName: 'code', source: code }))
        : { length: code.length }
      : null,
  };
}

export async function searchExtensions(apiUrl: string, input: any) {
  const query = String(input.query ?? '').trim();
  const path = normalizePath(input.path);
  const type = input.type;
  const maxResults = Math.min(Math.max(Number(input.maxResults ?? 4), 1), 25);
  const snippetChars = normalizeSnippetChars(input.snippetChars);
  const maxMatchesPerExtension = Math.min(Math.max(Number(input.maxMatchesPerExtension ?? 2), 1), 8);
  const includeDisabled = input.includeDisabled !== false;
  const includeSourceArtifact = Boolean(input.includeSourceArtifact);

  if (!query && !path && !type && !input.allowInventory) {
    throw new Error('Provide query, path, or type so extension search stays bounded.');
  }

  const [extensions, menus] = await Promise.all([
    fetchAllExtensions(apiUrl, type),
    fetchMenusWithExtensions(apiUrl),
  ]);

  const phrase = normalizeText(query || path);
  const terms = normalizeText([query, path].filter(Boolean).join(' '))
    .split(/[^a-z0-9_./:-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));

  const results = [];
  for (const extension of extensions) {
    if (!includeDisabled && extension.isEnabled === false) continue;
    const menu = menuForExtension(extension, menus);
    const exactPathMatch = Boolean(path && extension.type === 'page' && normalizePath(menu?.path) === path);
    if (path && !query && !type && !exactPathMatch) continue;
    if (path && query && extension.type === 'page' && normalizePath(menu?.path) !== path) continue;

    const matches = [
      ...metadataMatches(extension, menu, terms, phrase, snippetChars),
      ...codeMatches(String(extension.code ?? ''), terms, phrase, snippetChars, maxMatchesPerExtension),
    ];
    if (exactPathMatch) {
      matches.push({
        field: 'menu.path',
        score: 120,
        reason: 'exact page path match',
        snippet: String(menu?.path ?? '').slice(0, snippetChars),
      });
    }

    if (matches.length > 0 || (type && !query && !path) || input.allowInventory) {
      results.push(summarizeExtension(extension, menu, matches, includeSourceArtifact, exactPathMatch));
    }
  }

  results.sort((a, b) => Number(b.exactPathMatch) - Number(a.exactPathMatch) || b.score - a.score || String(a.name).localeCompare(String(b.name)));
  const paginated = paginateResults(results, {
    limit: maxResults,
    cursor: input.cursor,
    fingerprint: { query, path, type: type || null, includeDisabled, maxResults },
  });
  const estimatedOutputChars = JSON.stringify(paginated.items).length;

  return {
    action: 'extensions_searched',
    query: query || null,
    path: path || null,
    type: type || null,
    searched: {
      extensions: extensions.length,
      menus: menus.length,
      includeDisabled,
    },
    results: paginated.items,
    resultCount: results.length,
    page: paginated.page,
    tokenBudget: {
      estimatedOutputChars,
      estimatedOutputTokens: Math.ceil(estimatedOutputChars / 4),
      controls: {
        maxResults,
        snippetChars,
        maxMatchesPerExtension,
        includeSourceArtifact,
      },
    },
    guidance: [
      'Use path when the user points to an admin page route.',
      'Use type=global for shell/menu/account-panel notifications and type=widget for embeddable blocks.',
      'Open the source tmpFile only for the best candidate when snippets are not enough.',
    ],
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWidgetConsumerReference(code: string, widget: ExtensionRecord) {
  const id = getId(widget);
  const names = [widget.name, widget.extensionId].filter(Boolean).map(String);
  const widgetComponentPattern = /<DynamicWidgetComponent\b[^>]*>/gi;
  const tags = code.match(widgetComponentPattern) ?? [];
  for (const tag of tags) {
    if (id != null) {
      const idPattern = new RegExp(`(?:^|\\s)(?::id|id)\\s*=\\s*["']?${escapeRegExp(String(id))}(?:["'\\s>]|$)`, 'i');
      if (idPattern.test(tag)) return `DynamicWidgetComponent id ${id}`;
    }
    for (const name of names) {
      const namePattern = new RegExp(`(?:^|\\s)(?:name|widget|widget-id|extension-id)\\s*=\\s*["']${escapeRegExp(name)}["']`, 'i');
      if (namePattern.test(tag)) return `DynamicWidgetComponent reference ${name}`;
    }
  }

  if (id != null) {
    const loaderPattern = new RegExp(`loadWidgetExtension\\(\\s*["']?${escapeRegExp(String(id))}["']?\\s*\\)`, 'i');
    if (loaderPattern.test(code)) return `loadWidgetExtension(${id})`;
  }

  return null;
}

export async function inspectExtensionLocation(apiUrl: string, input: any) {
  const [extensions, menus] = await Promise.all([
    fetchAllExtensions(apiUrl),
    fetchMenusWithExtensions(apiUrl),
  ]);
  const wantedId = input.id == null ? null : String(input.id);
  const wantedName = input.name == null ? null : normalizeText(input.name);
  const wantedPath = normalizePath(input.path);

  let extension = extensions.find((item) => {
    const menu = menuForExtension(item, menus);
    if (wantedId && String(getId(item)) === wantedId) return true;
    if (wantedName && normalizeText(item.name) === wantedName) return true;
    if (wantedPath && item.type === 'page' && normalizePath(menu?.path) === wantedPath) return true;
    return false;
  });

  if (!extension && input.query) {
    const searched = await searchExtensions(apiUrl, { query: input.query, maxResults: 1, includeSourceArtifact: false });
    const first = searched.results[0];
    extension = first ? extensions.find((item) => String(getId(item)) === String(first.id)) : null;
  }

  if (!extension) {
    throw new Error('Extension not found. Provide id, name, path, or a query that matches extension metadata/source.');
  }

  const menu = menuForExtension(extension, menus);
  const id = getId(extension);
  const code = String(extension.code ?? '');
  const consumers = [];

  if (extension.type === 'widget') {
    for (const candidate of extensions) {
      if (String(getId(candidate)) === String(id)) continue;
      const candidateCode = String(candidate.code ?? '');
      if (!candidateCode) continue;
      const hit = hasWidgetConsumerReference(candidateCode, extension);
      if (!hit) continue;
      const candidateMenu = menuForExtension(candidate, menus);
      consumers.push({
        id: getId(candidate),
        name: candidate.name,
        type: candidate.type,
        surface: surfaceFor(candidate, candidateMenu),
        menu: candidateMenu ? { id: getId(candidateMenu), label: candidateMenu.label, path: candidateMenu.path } : null,
        reason: hit,
      });
    }
  }

  const source = code
    ? writeSourceArtifact({ tableName: 'enfyra_extension', id: id ?? extension.name, fieldName: 'code', source: code })
    : null;

  return {
    action: 'extension_location_inspected',
    extension: {
      id,
      name: extension.name,
      extensionId: extension.extensionId,
      type: extension.type,
      isEnabled: extension.isEnabled,
      version: extension.version,
      updatedAt: extension.updatedAt,
      description: extension.description,
    },
    surface: surfaceFor(extension, menu),
    menu: menu ? {
      id: getId(menu),
      label: menu.label,
      path: menu.path,
      icon: menu.icon,
      sidebarId: getId(menu.sidebar),
      parent: menu.parent ? { id: getId(menu.parent), label: menu.parent.label, path: menu.parent.path } : null,
    } : null,
    source,
    consumers,
    nextSteps: [
      'Use update_extension_code with this extension id after editing the source.',
      'For page extension bugs, preserve menu.path/menu permission and update only extension code unless navigation itself is wrong.',
      'For widget bugs, inspect consumers before changing the widget contract.',
      'For global extension bugs, look for shell registry calls such as menu notifications, account panel entries, and global listeners.',
    ],
  };
}
