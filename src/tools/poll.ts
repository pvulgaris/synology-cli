import { setTimeout as sleep } from "node:timers/promises";

export async function poll<T>(options: {
  read: () => Promise<T>;
  done: (value: T) => boolean;
  intervalMs: number;
  timeoutMs: number;
}): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let value = await options.read();
  while (!options.done(value) && Date.now() < deadline) {
    await sleep(options.intervalMs);
    value = await options.read();
  }
  return value;
}
