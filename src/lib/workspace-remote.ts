import { fetchAPI } from './fetch.js';
import { fetchTableMetadata } from './metadata-client.js';
import { validateDynamicScript, validateExtensionCode } from './platform-extension-source.js';
import { assertDynamicCodeKnowledgeAck, assertExtensionKnowledgeAck, assertGlobalRulesAck } from './required-knowledge.js';
import { executeToolDefinition } from './tool-execution.js';
import { resolveCatalogToolAvailability } from './tool-permission-profile.js';
import { getPrimaryFieldName } from './tool-record-operations.js';
import type { ToolsetRegistrationState } from './types.js';
import type { WorkspaceArtifactRef, WorkspaceDependencies, WorkspaceRemoteSource } from './workspace-types.js';

export function createWorkspaceRemote(apiUrl: string, state: ToolsetRegistrationState): Pick<WorkspaceDependencies, 'read' | 'validate' | 'write'> {
  return {
    read: async (artifact: WorkspaceArtifactRef): Promise<WorkspaceRemoteSource | null> => {
      const table = await fetchTableMetadata(apiUrl, artifact.tableName);
      const columns = (table.columns ?? []) as Array<{ name: string; isPrimary?: boolean }>;
      const primaryKey = await getPrimaryFieldName(artifact.tableName, table);
      const sourceField = artifact.tableName === 'enfyra_extension' ? 'code' : 'sourceCode';
      if (!columns.some((column) => column.name === sourceField)) throw new Error(`${artifact.tableName} does not expose an editable ${sourceField} field.`);
      const languageField = ['scriptLanguage', 'language'].find((name) => columns.some((column) => column.name === name));
      const fields = [primaryKey, sourceField, ...(languageField ? [languageField] : [])];
      const query = new URLSearchParams({ filter: JSON.stringify({ [primaryKey]: { _eq: artifact.id } }), limit: '1', fields: fields.join(',') });
      const result = await fetchAPI(apiUrl, `/${artifact.tableName}?${query}`);
      const record = Array.isArray(result?.data) ? result.data[0] : Array.isArray(result) ? result[0] : null;
      if (!record) return null;
      if (String(record[primaryKey]) !== artifact.id || typeof record[sourceField] !== 'string') throw new Error('Workspace source response did not match the requested artifact or expose readable source.');
      return { source: record[sourceField], sourceField, language: languageField ? String(record[languageField] ?? 'javascript') : 'javascript' };
    },
    validate: async (artifact, source) => {
      assertGlobalRulesAck(undefined);
      if (artifact.tableName === 'enfyra_extension') {
        assertExtensionKnowledgeAck(undefined);
        return validateExtensionCode(apiUrl, source, artifact.id);
      }
      assertDynamicCodeKnowledgeAck(undefined);
      return validateDynamicScript(apiUrl, source, artifact.language);
    },
    write: async (artifact, _source, expectedHash, sourceFile) => {
      const name = artifact.tableName === 'enfyra_extension' ? 'update_extension_code' : 'update_script_source';
      const tool = state.getTool(name);
      if (!tool) throw new Error(`Workspace writer is not registered: ${name}`);
      const args = artifact.tableName === 'enfyra_extension'
        ? { id: artifact.id, sourceFile, expectedSha256: expectedHash }
        : { tableName: artifact.tableName, id: artifact.id, sourceFile, expectedSourceSha256: expectedHash, scriptLanguage: artifact.language };
      const result = await executeToolDefinition(tool, args, undefined, resolveCatalogToolAvailability);
      if (result?.isError) throw new Error(result.content?.find((item: any) => item.type === 'text')?.text ?? `${name} failed.`);
      return result;
    },
  };
}
