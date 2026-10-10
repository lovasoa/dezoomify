import type { ObservedMetadata, ScanDiagnostics, ScanResult, StopReason } from "./types.ts";

export const scanLimits = {
  documents: 16,
  nodes: 5000,
  references: 12000,
  images: 100,
  bytes: 1024 * 1024,
  sliceMs: 8,
  documentMs: 250,
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
  readonly inputs: ObservedMetadata[] = [];
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
  readonly started = Date.now();
  readonly end: number;
  private slice = Date.now();
  private readonly seenImages = new Set<string>();
  private readonly stops = new Set<StopReason>();

  readonly documentUrl: string;

  constructor(documentUrl: string, deadlineAt: number) {
    this.documentUrl = documentUrl;
    this.end = Math.min(deadlineAt, this.started + 1000);
  }

  truncate(reason: StopReason): void {
    this.stops.add(reason);
    this.diagnostics.truncated = true;
    this.diagnostics.stopped = [...this.stops].join(",");
  }

  expired(until: number): boolean {
    if (Date.now() >= until) {
      this.truncate("time-budget");
      return true;
    }
    if (this.inputs.length >= scanLimits.images) {
      this.truncate("image-limit");
      return true;
    }
    return false;
  }

  async yieldSlice(): Promise<void> {
    if (Date.now() - this.slice < scanLimits.sliceMs) return;
    await yieldTask();
    this.slice = Date.now();
  }

  collect(input: ObservedMetadata): "added" | "duplicate" | "full" {
    if (this.seenImages.has(input.contents)) return "duplicate";
    const bytes = new TextEncoder().encode(input.contents).byteLength;
    if (this.diagnostics.bytes + bytes > scanLimits.bytes) {
      this.truncate("payload-limit");
      return "full";
    }
    this.seenImages.add(input.contents);
    this.diagnostics.bytes += bytes;
    this.inputs.push(input);
    return "added";
  }

  result(): ScanResult {
    this.diagnostics.elapsedMs = Date.now() - this.started;
    return {
      ok: true,
      documentUrl: this.documentUrl,
      inputs: this.inputs,
      diagnostics: this.diagnostics,
    };
  }
}
