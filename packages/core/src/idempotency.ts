import { createHash } from 'node:crypto';
import type { Tx } from '@arkiv/db';
import { conflict, stableStringify } from '@arkiv/shared';

export const hashRequest = (v: unknown) => createHash('sha256').update(stableStringify(v)).digest('hex');

/**
 * Idempotent create (§39): the first call with (workspace, operation, key) runs `fn` and stores its result;
 * repeats with the same request return the stored result; repeats with a different request are rejected.
 * The row is inserted first, so concurrent duplicates serialize on the primary key.
 */
export async function idempotent<T>(
  tx: Tx,
  workspaceId: string,
  operation: string,
  key: string,
  request: unknown,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const requestHash = hashRequest(request);
  const inserted = await tx`
    insert into idempotency_keys (workspace_id, operation, key, request_hash)
    values (${workspaceId}, ${operation}, ${key}, ${requestHash})
    on conflict do nothing returning key`;
  if (inserted.length === 0) {
    const [existing] = await tx`
      select request_hash, response from idempotency_keys
      where workspace_id = ${workspaceId} and operation = ${operation} and key = ${key} for update`;
    if (existing!.request_hash !== requestHash) throw conflict('Idempotency key reused with a different request');
    return { result: existing!.response as T, replayed: true };
  }
  const result = await fn();
  await tx`update idempotency_keys set response = ${tx.json((result ?? null) as never)}
           where workspace_id = ${workspaceId} and operation = ${operation} and key = ${key}`;
  return { result, replayed: false };
}
