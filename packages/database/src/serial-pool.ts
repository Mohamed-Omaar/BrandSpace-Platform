import pg from 'pg';

/**
 * PR A2 — ONE QUERY AT A TIME ON EACH CONNECTION.
 *
 * Inside a transaction Prisma runs every statement on ONE pooled connection,
 * and the code is free to write `Promise.all([db.a.findMany(), db.b.count()])`
 * there. pg then receives a second `client.query()` while the first is still
 * running. It queues it and the answer is the same — but it prints
 * "Calling client.query() when the client is already executing a query is
 * deprecated and will be removed in pg@9.0", and in pg@9 it will throw.
 *
 * This pool hands out connections whose promise-returning `query` waits for
 * the previous one on the same connection before it is sent. That is exactly
 * the order pg's own queue would have used, so no result changes; the queue
 * simply lives here instead of inside pg. Callback-style and streaming
 * (submittable) queries pass straight through: Prisma's adapter uses neither.
 */
export function createSerialPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(config);
  pool.on('connect', (client) => serialiseQueries(client));
  return pool;
}

const SERIALISED = Symbol.for('brandspace.pg.serialised');

/** Make one client's promise queries run one after another. Idempotent. */
export function serialiseQueries(client: pg.PoolClient | pg.Client): void {
  const target = client as unknown as Record<PropertyKey, unknown> & {
    query: (...args: unknown[]) => unknown;
  };
  if (target[SERIALISED]) return;
  target[SERIALISED] = true;
  const original = target.query.bind(client);
  let tail: Promise<unknown> = Promise.resolve();
  target.query = (...args: unknown[]): unknown => {
    const first = args[0] as { submit?: unknown } | undefined;
    const callbackStyle = typeof args[args.length - 1] === 'function';
    const submittable =
      typeof first === 'object' && first !== null && typeof first.submit === 'function';
    if (callbackStyle || submittable) return original(...args);
    const run = tail.then(() => original(...args) as Promise<unknown>);
    // A failed query must not stop the ones queued behind it.
    tail = run.catch(() => undefined);
    return run;
  };
}
