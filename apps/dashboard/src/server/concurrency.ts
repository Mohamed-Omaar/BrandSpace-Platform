/**
 * PERF A — AT MOST `n` OF ONE PAGE'S READS IN FLIGHT AT ONCE.
 *
 * Home's independent reads now start together instead of one after another.
 * Each opens its own workspace transaction, and the database pool is small
 * (10 connections on Railway), so one page may hold only a few of them at a
 * time: two people loading Home at once must not starve each other, or every
 * other request, of a connection.
 */
export function concurrency(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active -= 1;
    queue.shift()?.();
  };
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1;
        task().then(resolve, reject).finally(next);
      };
      if (active < n) start();
      else queue.push(start);
    });
    // A read started early may fail before anything awaits it — for example
    // when the page redirects first. Marking it handled keeps that from being
    // an unhandled rejection; whoever awaits it still receives the error.
    result.catch(() => undefined);
    return result;
  };
}
