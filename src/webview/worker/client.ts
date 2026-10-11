/** Promise-based client for the data worker (one worker per document). */

import workerSource from 'virtual:data-worker';
import type { WorkerApi, WorkerMethod, WorkerRequest, WorkerResponse } from './protocol';

type Args<M extends WorkerMethod> = Parameters<WorkerApi[M]>[0];
type Result<M extends WorkerMethod> = ReturnType<WorkerApi[M]>;

let workerUrl: string | undefined;

export class DataClient {
  private readonly worker: Worker;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    // A blob URL keeps the worker same-origin under strict webview CSPs.
    workerUrl ??= URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error !== undefined) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Worker error'));
      this.pending.clear();
    };
  }

  call<M extends WorkerMethod>(method: M, args: Args<M>, transfer: Transferable[] = []): Promise<Result<M>> {
    const id = ++this.seq;
    return new Promise<Result<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const msg: WorkerRequest = { id, method, args };
      this.worker.postMessage(msg, transfer);
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Worker terminated'));
    this.pending.clear();
  }
}
