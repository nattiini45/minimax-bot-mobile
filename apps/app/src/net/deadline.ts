/** Bounds headers AND body reads, even when a fetch implementation ignores abort. */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  controller = new AbortController(),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('The network request was cancelled or timed out.'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    timer = setTimeout(() => controller.abort(), milliseconds);
  });
  try {
    return await Promise.race([cancelled, work(controller.signal)]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
