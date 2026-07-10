import { fetchAPI } from "./fetch.js";
import type { MetadataContext, MetadataTableCatalogEntry, UnknownRecord } from "./types.js";

const TABLE_CATALOG_FIELDS = "id,name,alias,description,isSingleRecord";
const DEFAULT_METADATA_CONCURRENCY = 4;

function unwrapData(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray((result as UnknownRecord).data)) {
    return (result as UnknownRecord).data as unknown[];
  }
  return [];
}

export function unwrapTableMetadata(result: unknown): UnknownRecord | null {
  if (!result || typeof result !== "object") return null;
  const record = result as UnknownRecord;
  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data as UnknownRecord;
  const table = record.table;
  if (table && typeof table === "object" && !Array.isArray(table)) return table as UnknownRecord;
  return null;
}

export async function fetchMetadataContext(apiUrl: string): Promise<MetadataContext> {
  const result = await fetchAPI(apiUrl, "/metadata");
  return {
    dbType: result?.dbType ?? null,
    enfyraVersion: result?.enfyraVersion ?? null,
  };
}

export async function fetchTableMetadata(apiUrl: string, tableName: string): Promise<UnknownRecord> {
  const result = await fetchAPI(apiUrl, `/metadata/${encodeURIComponent(tableName)}`);
  const table = unwrapTableMetadata(result);
  if (!table) throw new Error(`Metadata for table "${tableName}" did not contain a table object.`);
  return table;
}

export async function fetchTableCatalog(apiUrl: string): Promise<MetadataTableCatalogEntry[]> {
  const result = await fetchAPI(
    apiUrl,
    `/enfyra_table?fields=${encodeURIComponent(TABLE_CATALOG_FIELDS)}&limit=0&sort=name`,
  );
  return unwrapData(result)
    .filter((item): item is MetadataTableCatalogEntry => Boolean(
      item && typeof item === "object" && typeof (item as MetadataTableCatalogEntry).name === "string",
    ));
}

export async function fetchTableMetadataByRef(apiUrl: string, tableRef: unknown): Promise<UnknownRecord> {
  const catalog = await fetchTableCatalog(apiUrl);
  const entry = resolveTableCatalogEntry(catalog, tableRef);
  if (!entry) throw new Error(`Table not found: ${String(tableRef)}`);
  return fetchTableMetadata(apiUrl, entry.name);
}

export function resolveTableCatalogEntry(
  tables: MetadataTableCatalogEntry[],
  tableRef: unknown,
): MetadataTableCatalogEntry | null {
  const normalizedRef = String(tableRef ?? "");
  return tables.find((table) => (
    String(table.id ?? table._id ?? "") === normalizedRef
    || table.name === normalizedRef
    || table.alias === normalizedRef
  )) ?? null;
}

export async function fetchMetadataTables(
  apiUrl: string,
  catalog: MetadataTableCatalogEntry[],
  concurrency = DEFAULT_METADATA_CONCURRENCY,
): Promise<UnknownRecord[]> {
  const tables: UnknownRecord[] = new Array(catalog.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), catalog.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < catalog.length) {
      const index = nextIndex;
      nextIndex += 1;
      tables[index] = await fetchTableMetadata(apiUrl, catalog[index].name);
    }
  }));
  return tables;
}
