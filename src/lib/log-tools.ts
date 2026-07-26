/**
 * Enfyra MCP — stdio server (loaded by index.ts / dist/index.js).
 */

import { z } from 'zod';
// Import modules
import { fetchAPI } from './fetch.js';
export function registerLogTools(server, ENFYRA_API_URL) {
  // ============================================================================
  // LOGS TOOLS
  // ============================================================================
  
  server.tool('get_log_files', 'List available log files and stats', {}, async () => {
    const result = await fetchAPI(ENFYRA_API_URL, '/logs');
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('get_log_content', 'Get content of a specific log file', {
    filename: z.string().describe('Log file name'),
    page: z.number().optional().default(1).describe('Page number'),
    pageSize: z.number().optional().default(100).describe('Lines per page'),
    filter: z.string().optional().describe('Text filter'),
    level: z.string().optional().describe('Log level filter (INFO, WARN, ERROR)'),
  }, async ({ filename, page, pageSize, filter, level }) => {
    const queryParams = new URLSearchParams();
    if (page) queryParams.set('page', String(page));
    if (pageSize) queryParams.set('pageSize', String(pageSize));
    if (filter) queryParams.set('filter', filter);
    if (level) queryParams.set('level', level);
    const result = await fetchAPI(ENFYRA_API_URL, `/logs/${filename}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('tail_log', 'Get last N lines from a log file', {
    filename: z.string().describe('Log file name'),
    lines: z.number().optional().default(50).describe('Number of lines to retrieve'),
  }, async ({ filename, lines }) => {
    const result = await fetchAPI(ENFYRA_API_URL, `/logs/${filename}/tail?lines=${lines}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('search_logs', 'Search for ERROR or WARN logs across recent log files', {
    level: z.enum(['ERROR', 'WARN', 'INFO']).optional().default('ERROR').describe('Log level'),
    keyword: z.string().optional().describe('Keyword to filter logs'),
    limit: z.number().optional().default(50).describe('Max results per level'),
  }, async ({ level, keyword, limit }) => {
    const logFilesResult = await fetchAPI(ENFYRA_API_URL, '/logs');
    const logFiles = logFilesResult.files || [];
    const recentFiles = logFiles.filter((file) => {
      const name = file?.name || '';
      return /^app[.-]/.test(name) || /^error[.-]/.test(name);
    });
    const results = [];
    for (const file of recentFiles.slice(0, 3)) {
      try {
        const contentResult = await fetchAPI(ENFYRA_API_URL, `/logs/${file.name}?level=${level}&pageSize=${limit}`);
        const lines = contentResult.lines || contentResult.data || [];
        const filteredLines = keyword ? lines.filter(l => JSON.stringify(l).toLowerCase().includes(keyword.toLowerCase())) : lines;
        if (filteredLines.length > 0) results.push({ file: file.name, level, logs: filteredLines });
      } catch (e) { /* skip */ }
    }
    return { content: [{ type: 'text', text: `Found ${results.length} files:\n${JSON.stringify(results, null, 2)}` }] };
  });
}
