import { ScanState } from "./openseadragon/scan-state.ts";
import { PageTraversal } from "./openseadragon/traversal.ts";
import type { ScanResult } from "./openseadragon/types.ts";

/** Run only on explicit source access, in the page's main world. */
export async function scanOpenSeadragon(deadlineAt: number): Promise<ScanResult> {
  const state = new ScanState(location.href, deadlineAt);
  try {
    await new PageTraversal(state).scan(window);
  } catch {
    state.diagnostics.rejected++;
  }
  return state.result();
}
