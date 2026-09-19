// Host-runner-backed JobService: a stateless forwarder over the engine.
// Each start() validates the request, mints a job id, and forwards absolute
// engine snapshots (plus host presentation state) straight to the observer.
// The service keeps no per-job state: no current snapshot, no settled flag,
// no DTO revision gate. The engine sequence is authoritative; stale
// revisions and retired jobs are dropped at the transport edge (the runner)
// before they ever reach this sink. dispose() delegates to the runner
// handle; late emissions after teardown stay invisible because the runner
// drops them at its edge.

import type {
  EngineSnapshotDto,
  HostRunner,
  HostStatus,
  JobHandle,
  JobObserver,
  JobService,
  JobStartRequest,
  RunnerHandle,
  RunnerSink,
  UserCommand,
} from "./types.ts";
import { initialHostStatus } from "./types.ts";

export interface ServiceOptions {
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
    observer.hostStatus(initialHostStatus());

    const sink: RunnerSink = {
      snapshot(dto: EngineSnapshotDto, host?: HostStatus): void {
        observer.snapshot(dto);
        if (host) observer.hostStatus(host);
      },
    };

    const handle: RunnerHandle = await runner.start(request, sink);
    const jobHandle: JobHandle = {
      id,
      async command(command: UserCommand): Promise<void> {
        await handle.command(command);
      },
      ...(typeof handle.resolvePermission === "function"
        ? { resolvePermission: handle.resolvePermission.bind(handle) }
        : {}),
      async dispose(): Promise<void> {
        await handle.dispose();
      },
    };
    return jobHandle;
  }

  return { start };
}
