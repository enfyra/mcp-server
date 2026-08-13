import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fetchAPI } from './fetch.js';
import { jsonContent } from './response-format.js';

const MAX_RECHECK_DELAY_MS = 10000;
const MAX_VALUE_LIMIT = 100;

function redactLockValue(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  return {
    byteLength: Buffer.byteLength(value),
    sha256: createHash('sha256').update(value).digest('hex'),
    preview: value.length <= 8 ? '[redacted]' : `${value.slice(0, 4)}…${value.slice(-4)}`,
  };
}

function redactDetail(detail: Record<string, any>, includeValue: boolean) {
  const isLock = detail.systemKind === 'user_cache_lock';
  const { value, ...metadata } = detail;
  if (!includeValue || value === undefined) return metadata;
  if (isLock) return { ...metadata, value: redactLockValue(value) };
  return metadata;
}

export function registerRedisInspectionTools(server: any, ENFYRA_API_URL: string) {
  server.tool(
    'inspect_redis_key',
    'Inspect one Redis key through the protected Enfyra admin API. Returns exact TTL milliseconds and safe metadata without SSH or arbitrary Redis commands. Values are omitted by default; lock owner tokens are always redacted.',
    {
      key: z.string().min(1).describe('Exact Redis key or current-namespace key notation, such as user_cache_lock:quota-renewal:24.'),
      includeValue: z.boolean().optional().default(false).describe('Request a safe value representation when the key class permits it. Defaults to false.'),
      valueLimit: z.number().int().min(1).max(MAX_VALUE_LIMIT).optional().default(20).describe('Maximum collection items for a permitted value representation.'),
      recheckAfterMs: z.number().int().min(0).max(MAX_RECHECK_DELAY_MS).optional().default(0).describe('Optional delay before a second metadata read, used to prove whether a TTL counts down or is being renewed.'),
    },
    async ({ key, includeValue, valueLimit, recheckAfterMs }) => {
      const query = new URLSearchParams({
        key,
        limit: String(valueLimit),
        includeValue: String(includeValue),
      });
      const firstResponse = await fetchAPI(ENFYRA_API_URL, `/admin/redis/key?${query}`);
      const first = redactDetail(firstResponse?.data ?? firstResponse, includeValue);
      if (!recheckAfterMs) return jsonContent({ inspection: first });

      await new Promise((resolve) => setTimeout(resolve, recheckAfterMs));
      const secondResponse = await fetchAPI(ENFYRA_API_URL, `/admin/redis/key?${query}`);
      const second = redactDetail(secondResponse?.data ?? secondResponse, includeValue);
      return jsonContent({
        inspection: first,
        recheck: {
          requestedDelayMs: recheckAfterMs,
          ttlMillisecondsBefore: first.ttlMilliseconds,
          ttlMillisecondsAfter: second.ttlMilliseconds,
          second,
        },
      });
    },
  );
}
