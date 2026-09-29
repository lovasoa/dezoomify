/** Timing and request counts displayed while a job runs. */
export interface JobActivity {
  url?: string;
  startedAt?: number;
  now?: number;
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
