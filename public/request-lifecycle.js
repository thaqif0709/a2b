// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// A request owns its result, error and busy state only until it is replaced or cancelled.
export class RequestScope {
  sequence = 0;
  current = null;
  start(input) {
    this.cancel();
    const controller = new AbortController();
    const task = { id: ++this.sequence, input: structuredClone(input), controller, signal: controller.signal, pending: true };
    this.current = task;
    return task;
  }
  owns(task) { return Boolean(task && this.current === task && !task.signal.aborted); }
  get pending() { return Boolean(this.current?.pending); }
  finish(task) { if (this.current === task) task.pending = false; }
  cancel() {
    this.current?.controller.abort();
    this.current = null;
  }
}

// The deadline covers both headers and the response body. Race the operation as well as aborting fetch:
// a stalled transport must release its caller even if it ignores the signal.
export async function boundedRequest(operation, { signal, timeoutMs = 0 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let timer, rejectAbort;
  const stopped = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (timeoutMs > 0) timer = setTimeout(() => controller.abort(Object.assign(
      new Error('A2B took too long to respond. Try again.'), { name: 'TimeoutError', status: 408 },
    )), timeoutMs);
    return await Promise.race([operation(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
