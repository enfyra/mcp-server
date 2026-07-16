export type SequentialBatchFailure = {
  index: number;
  error: {
    code: 'authorization_failed' | 'conflict' | 'request_failed' | 'request_timeout';
    message: string;
    statusCode?: number;
  };
};

export type SequentialBatchResult<TResult> =
  | {
      status: 'completed';
      completed: TResult[];
    }
  | {
      status: 'partial_failure';
      completed: TResult[];
      failure: SequentialBatchFailure;
      remainingIndexes: number[];
    };

function summarizeError(error: unknown): SequentialBatchFailure['error'] {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = Number(message.match(/API error \((\d{3})\)/)?.[1]);

  if (/timeout/i.test(message)) {
    return { code: 'request_timeout', message: 'The request timed out before Enfyra confirmed the write.' };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { code: 'authorization_failed', message: 'Enfyra rejected this write because the current token is not authorized.', statusCode };
  }
  if (statusCode === 409 || /duplicate key|unique constraint|\bconflict\b/i.test(message)) {
    return { code: 'conflict', message: 'The record conflicts with an existing record. Inspect the table unique constraints before retrying.', statusCode };
  }
  return { code: 'request_failed', message: 'Enfyra rejected this write. Inspect the target record and retry only after resolving the validation error.', ...(Number.isFinite(statusCode) ? { statusCode } : {}) };
}

export async function executeSequentialBatch<TItem, TResult>(
  items: TItem[],
  execute: (item: TItem, index: number) => Promise<TResult>,
): Promise<SequentialBatchResult<TResult>> {
  const completed: TResult[] = [];

  for (const [index, item] of items.entries()) {
    try {
      completed.push(await execute(item, index));
    } catch (error) {
      return {
        status: 'partial_failure',
        completed,
        failure: {
          index,
          error: summarizeError(error),
        },
        remainingIndexes: items.slice(index + 1).map((_, remainingIndex) => index + remainingIndex + 1),
      };
    }
  }

  return { status: 'completed', completed };
}
