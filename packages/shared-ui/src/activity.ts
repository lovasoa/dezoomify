/** Timing and request counts displayed while a job runs. Hosts inject the
 * clock: `now` is always the host clock reading (never read from globals). */
export interface JobActivity {
  url?: string;
  startedAt?: number;
  now: number;
  detail?: string;
  pendingRequests?: number;
  completedRequests?: number;
  failedRequests?: number;
  longestPendingMs?: number;
  timeoutMs?: number;
  lastProgressAt?: number;
  paused?: boolean;
  pausedAt?: number;
  pausedDurationMs?: number;
}
