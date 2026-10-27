import type { ScanDiagnostics, ScanResult, StopReason, ViewerEvidence } from "./types.ts";

export const scanLimits = {
  documents: 16,
  nodes: 5000,
  references: 12000,
  images: 100,
  bytes: 1024 * 1024,
  sliceSteps: 128,
} as const;

function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    // Posted-message tasks avoid background-tab timer throttling.
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export class ScanState {
  readonly inputs: ViewerEvidence["input"][] = [];
  readonly handles = new Set<string>();
  readonly diagnostics: ScanDiagnostics = {
    documents: 0,
    nodes: 0,
    references: 0,
    viewers: 0,
    probes: 0,
    rejected: 0,
    bytes: 0,
    truncated: false,
    elapsedMs: 0,
    versions: "",
    stopped: "",
    frames: [],
  };
  private readonly started = performance.now();
  private steps = 0;
  private readonly seenImages = new Set<string>();
  private readonly stops = new Set<StopReason>();

  readonly documentUrl: string;

  constructor(documentUrl: string) {
    this.documentUrl = documentUrl;
  }

  truncate(reason: StopReason): void {
    this.stops.add(reason);
    this.diagnostics.truncated = true;
    this.diagnostics.stopped = [...this.stops].join(",");
  }

  full(): boolean {
    if (this.diagnostics.references >= scanLimits.references) {
      this.truncate("reference-limit");
      return true;
    }
    if (this.inputs.length >= scanLimits.images) {
      this.truncate("image-limit");
      return true;
    }
    return false;
  }

  /** Charge every inspected reference slot, including scalars and duplicates. */
  takeReference(): boolean {
    if (this.full()) return false;
    this.diagnostics.references++;
    return true;
  }

  async yieldSlice(): Promise<void> {
    if (++this.steps % scanLimits.sliceSteps === 0) await yieldTask();
  }

  collect({ input, handle }: ViewerEvidence): "added" | "duplicate" | "full" {
    if (this.seenImages.has(input.contents)) return "duplicate";
    const bytes = new TextEncoder().encode(input.contents).byteLength;
    if (this.diagnostics.bytes + bytes > scanLimits.bytes) {
      this.truncate("payload-limit");
      return "full";
    }
    this.seenImages.add(input.contents);
    this.diagnostics.bytes += bytes;
    this.inputs.push(input);
    if (handle) this.handles.add(handle);
    return "added";
  }

  result(): ScanResult {
    this.diagnostics.elapsedMs = performance.now() - this.started;
    return {
      ok: true,
      documentUrl: this.documentUrl,
      inputs: this.inputs,
      handles: [...this.handles],
      diagnostics: this.diagnostics,
    };
  }
}
