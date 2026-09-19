// Host-runner-backed JobService: identity and revision guards at the async
// subscription boundary. Each start() mints a job id; runner emissions for
// other jobs, or snapshots whose revision is not newer than the last one the
// observer saw, are dropped before they reach the UI. dispose() removes the
// job from the store so late emissions after teardown stay invisible.

import type {
  EngineSnapshotDto,
  HostRunner,
  HostStatus,
  JobEvent,
  JobHandle,
  JobObserver,
  JobService,
  JobSnapshot,
  JobStartRequest,
  RunnerHandle,
  RunnerSink,
  UserCommand,
} from "./types.ts";
import { initialHostStatus } from "./types.ts";
import { applyJobEvent, applySnapshotDto, initialSnapshot } from "./snapshot.ts";
import { createSnapshotStore, type SnapshotStore } from "./store.ts";

export interface ServiceOptions {
  now?: () => number;
  store?: SnapshotStore;
  nextId?: () => string;
}

function validateRequest(request: JobStartRequest): string | null {
  if (!request || typeof request !== "object") return "validation.bad-request";
  if (!Array.isArray(request.inputs) || request.inputs.length === 0) {
    return "validation.empty-inputs";
  }
  for (const input of request.inputs) {
    const url = (input as { url?: unknown }).url;
    if (typeof url !== "string" || url.trim() === "" || url.length > 2048) {
      return "validation.bad-input-url";
    }
  }
  if (!request.exec || typeof request.exec !== "object") return "validation.bad-exec";
  const kind = (request.exec as { kind?: unknown }).kind;
  if (kind !== "browser" && kind !== "native") return "validation.bad-exec-kind";
  if (kind === "browser") {
    const sourceUrl = (request.exec as { sourceUrl?: unknown }).sourceUrl;
    if (typeof sourceUrl !== "string" || sourceUrl.trim() === "" || sourceUrl.length > 2048) {
      return "validation.bad-exec-source";
    }
  }
  if (kind === "native") {
    const dest = (request.exec as { destination?: unknown }).destination;
    if (!dest || typeof dest !== "object") return "validation.bad-destination";
  }
  if (!request.engine || typeof request.engine !== "object") return "validation.bad-engine";
  return null;
}

export function createJobService(runner: HostRunner, opts?: ServiceOptions): JobService {
  const now = opts?.now ?? Date.now;
  const store = opts?.store ?? createSnapshotStore();
  let idSeq = 0;
  const nextId =
    opts?.nextId ??
    (() => {
      idSeq += 1;
      return `job:${idSeq}`;
    });

  async function start(request: JobStartRequest, observer: JobObserver): Promise<JobHandle> {
    const problem = validateRequest(request);
    if (problem) {
      throw {
        code: problem,
        phase: "validation",
        retryable: false,
        message: "The job request is not valid.",
        recovery: [],
      };
    }
    const id = nextId();
    let current: JobSnapshot = initialSnapshot(id, now());
    store.publish(current);
    observer.snapshot(current);
    observer.hostStatus(initialHostStatus());

    let settled = false;
    function publish(folded: JobSnapshot, host: HostStatus | null): void {
      if (folded === current) return;
      current = folded;
      if (store.publish(current)) observer.snapshot(current);
      if (host) observer.hostStatus(host);
    }
    const sink: RunnerSink = {
      event(event: JobEvent, host: HostStatus): void {
        if (settled) return;
        publish(applyJobEvent(current, event, now()), host);
      },
      snapshot(dto: EngineSnapshotDto): void {
        if (settled) return;
        publish(applySnapshotDto(current, dto, now()), null);
      },
    };

    const handle: RunnerHandle = await runner.start(request, sink);
    const jobHandle: JobHandle = {
      id,
      async command(command: UserCommand): Promise<void> {
        await handle.command(command);
      },
      async dispose(): Promise<void> {
        settled = true;
        store.remove(id);
        await handle.dispose();
      },
    };
    return jobHandle;
  }

  return { start };
}
