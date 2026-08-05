import { cleanupMcpUsageFiles } from './mcp-usage-telemetry.js';
import { cleanupSourceArtifacts } from './source-artifacts.js';

export function cleanupMcpTempFiles({ usageDir }: { usageDir?: string } = {}) {
  return {
    sourceArtifacts: cleanupSourceArtifacts(),
    usageFiles: cleanupMcpUsageFiles(usageDir),
  };
}
