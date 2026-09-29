import { errorMessage } from "../client.js";

export interface ReadSource<T> {
  source: string;
  value: T | null;
  error?: string;
}

export async function readSource<T>(
  source: string,
  read: () => Promise<T>
): Promise<ReadSource<T>> {
  try {
    return { source, value: await read() };
  } catch (err) {
    return {
      source,
      value: null,
      error: errorMessage(err),
    };
  }
}

export function readWarnings(
  sources: ReadonlyArray<ReadSource<unknown>>
): Array<{ source: string; error: string }> {
  return sources.flatMap((source) =>
    source.error ? [{ source: source.source, error: source.error }] : []
  );
}
