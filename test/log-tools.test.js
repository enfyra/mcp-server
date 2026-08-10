import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeLogLevelFilter } from '../dist/lib/log-tools.js';

test('search_logs sends ESV Pino levels in lowercase', () => {
  assert.equal(normalizeLogLevelFilter('WARN'), 'warn');
  assert.equal(normalizeLogLevelFilter(' ERROR '), 'error');
  assert.equal(normalizeLogLevelFilter('INFO'), 'info');
});
