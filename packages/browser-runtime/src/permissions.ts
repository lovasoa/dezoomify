export interface PermissionApi {
  contains(details: { origins: string[] }): Promise<boolean>;
  request(details: { origins: string[] }): Promise<boolean>;
}

export interface PermissionWait {
  origin: string;
  requesting: boolean;
  /** Call directly from the user event handler. Awaiting first loses the browser
   * activation needed by permission APIs. ensure itself never opens a prompt. */
  request(): void;
}

/** Concurrent waits for an origin share one prompt. Each caller must supply its
 * invocation signal so retirement removes its wait without cancelling others. */
export function createAttemptPermissions(
  api: PermissionApi,
  changed: (pending: PermissionWait[]) => void,
) {
  type Waiter = { finish(error?: unknown): void };
  type Entry = PermissionWait & { waiters: Set<Waiter> };
  const pending = new Map<string, Entry>();
  const publish = () => changed([...pending.values()]);

  async function ensure(origin: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const origins = [`${origin}/*`];
    const granted = await api.contains({ origins });
    signal.throwIfAborted();
    if (granted) return;
    let entry = pending.get(origin);
    if (!entry) {
      const created: Entry = {
        origin,
        requesting: false,
        waiters: new Set(),
        request() {
          if (pending.get(origin) !== created || created.requesting) return;
          created.requesting = true;
          // Keep this call synchronous with the product's click handler.
          const grant = api.request({ origins });
          publish();
          void grant
            .then(async (accepted) => accepted && (await api.contains({ origins })))
            .then(
              (accepted) =>
                settle(
                  accepted
                    ? undefined
                    : {
                        kind: "policy-denied",
                        blocked_reason: "access-required",
                        transport: "browser-session",
                        detail: `access to ${origin} was denied`,
                      },
                ),
              settle,
            );
        },
      };
      const settle = (error?: unknown) => {
        if (pending.get(origin) !== created) return;
        for (const waiter of [...created.waiters]) waiter.finish(error);
      };
      pending.set(origin, created);
      entry = created;
    }
    const owned = entry;
    return new Promise<void>((resolve, reject) => {
      const abort = () => waiter.finish(signal.reason);
      const waiter: Waiter = {
        finish(error) {
          if (!owned.waiters.delete(waiter)) return;
          signal.removeEventListener("abort", abort);
          if (owned.waiters.size === 0) pending.delete(origin);
          publish();
          if (error !== undefined) reject(error);
          else resolve();
        },
      };
      owned.waiters.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else publish();
    });
  }
  return { ensure };
}
