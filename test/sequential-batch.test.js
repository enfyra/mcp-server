import test from 'node:test';
import assert from 'node:assert/strict';

import { executeSequentialBatch } from '../dist/lib/sequential-batch.js';

test('executeSequentialBatch returns every completed result', async () => {
  const result = await executeSequentialBatch([2, 3, 5], async (value) => value * 2);

  assert.deepEqual(result, {
    status: 'completed',
    completed: [4, 6, 10],
  });
});

test('executeSequentialBatch preserves the checkpoint and redacts backend details when a write fails', async () => {
  const result = await executeSequentialBatch(['first', 'second', 'third'], async (value) => {
    if (value === 'second') throw new Error('API error (409): duplicate');
    return value;
  });

  assert.deepEqual(result, {
    status: 'partial_failure',
    completed: ['first'],
    failure: {
      index: 1,
      error: {
        code: 'conflict',
        message: 'The record conflicts with an existing record. Inspect the table unique constraints before retrying.',
        statusCode: 409,
      },
    },
    remainingIndexes: [2],
  });
});

test('executeSequentialBatch never returns raw SQL from a failed write', async () => {
  const result = await executeSequentialBatch(['duplicate'], async () => {
    throw new Error('API error (400): insert into "records" values ($1) - duplicate key value violates unique constraint "records_slug_key"');
  });

  assert.equal(result.status, 'partial_failure');
  assert.deepEqual(result.failure.error, {
    code: 'conflict',
    message: 'The record conflicts with an existing record. Inspect the table unique constraints before retrying.',
    statusCode: 400,
  });
  assert.doesNotMatch(JSON.stringify(result), /insert into|records_slug_key/i);
});
