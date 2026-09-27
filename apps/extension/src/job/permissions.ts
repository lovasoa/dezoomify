import type { WxtBrowser } from "wxt/browser";
import { transportError } from "../runtime/fetch.ts";

export interface PermissionWait {
  origin: string;
  requesting: boolean;
  request(): void;
}

/** One attempt's grant waits. Only request(), called by a click, opens a prompt. */
export function createAttemptPermissions(
  api: Pick<WxtBrowser["permissions"], "contains" | "request">,
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
                    : transportError("access-required", `Access to ${origin} was denied`),
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
