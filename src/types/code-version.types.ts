export type CodeVersionRead = (path: string) => Promise<{ dbType?: unknown; data?: Array<Record<string, unknown>> }>;
