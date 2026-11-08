import { ScanState } from "./viewers/scan-state.ts";
import { listenViewerChannel } from "./viewers/session.ts";
import { PageTraversal } from "./viewers/traversal.ts";
import type { ScanResult } from "./viewers/types.ts";

/** Run only on explicit source access, in the page's main world. Work limits
 * bound traversal independently of scheduling; truncated scans retain their findings. */
export async function scanViewers(): Promise<ScanResult> {
  const state = new ScanState(location.href);
  try {
    await new PageTraversal(state).scan(window);
  } catch {
    state.diagnostics.rejected++;
  }
  const result = state.result();
  if (result.handles.length === 0) return result;
  const channelId = crypto.randomUUID();
  listenViewerChannel(channelId, result.handles);
  return { ...result, channelId };
}
