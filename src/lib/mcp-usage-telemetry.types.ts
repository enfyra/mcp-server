export type McpErrorReportStatus = 'sent' | 'disabled' | 'in_progress' | 'scheduled' | 'empty' | 'rejected' | 'failed';

export interface McpErrorReportFlushResult {
  status: McpErrorReportStatus;
  errorCount: number;
  sourceLineCount: number;
  statusCode?: number;
}
