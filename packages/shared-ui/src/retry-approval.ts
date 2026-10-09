import type { TileAcquisition } from "@dezoomify/wasm-bindings";

/** A job-wide approval grants one further attempt to every tile at that attempt number. */
export class RetryApproval {
  private approvedAttempt = -1;
  private pending:
    | {
        request: TileAcquisition;
        promise: Promise<void>;
        resolve(): void;
        reject(error: unknown): void;
      }
    | undefined;
  private failure: unknown;

  private readonly changed: (request: TileAcquisition | undefined) => void;

  constructor(changed: (request: TileAcquisition | undefined) => void) {
    this.changed = changed;
  }

  async acquire(request: TileAcquisition): Promise<void> {
    if (!request.requires_approval) return;
    while (request.attempt > this.approvedAttempt) {
      if (this.failure) throw this.failure;
      let pending = this.pending;
      if (!pending) {
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        pending = { request, promise, resolve, reject };
        this.pending = pending;
        this.changed(request);
      }
      await pending.promise;
    }
    if (this.failure) throw this.failure;
  }

  retry(): void {
    const pending = this.pending;
    if (!pending) return;
    this.approvedAttempt = pending.request.attempt;
    this.pending = undefined;
    this.changed(undefined);
    pending.resolve();
  }

  cancel(error: unknown = { kind: "cancelled" }): void {
    this.failure = error;
    const pending = this.pending;
    this.pending = undefined;
    this.changed(undefined);
    pending?.reject(error);
  }
}
