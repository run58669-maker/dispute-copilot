/** p-limit style: at most `max` tasks run at once; the rest wait in FIFO order. */
export function pLimit(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const next = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active += 1;
        task().then(resolve, reject).finally(next);
      };
      if (active < max) run();
      else waiting.push(run);
    });
}

/** Maps with at most `max` items in flight; results keep input order. */
export function mapLimit<T, R>(items: readonly T[], max: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const limit = pLimit(max);
  return Promise.all(items.map((item) => limit(() => fn(item))));
}
