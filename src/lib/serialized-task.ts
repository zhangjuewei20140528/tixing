const taskTails = new Map<string, Promise<void>>();

export async function runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = taskTails.get(key);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  taskTails.set(key, current);

  if (previous) await previous;
  try {
    return await task();
  } finally {
    release();
    if (taskTails.get(key) === current) taskTails.delete(key);
  }
}

export async function retryTransient<T>(
  task: () => Promise<T>,
  isTransient: (error: unknown) => boolean,
  delaysMs: readonly number[],
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (!isTransient(error) || attempt >= delaysMs.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}
