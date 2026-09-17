export default function init(): Promise<void>;

export class Session {
  constructor(protocolVersion: string, quotasJson: string);
  drainMessages(): string;
  dispatch(command: Uint8Array): void;
  allocateBuffer(length: number): string;
  writeBuffer(handle: string, offset: number, bytes: Uint8Array): void;
  commitBuffer(handle: string, length: number): void;
  protocolHandle(handle: string): string;
  applyProcessing(recipe: string, bytes: Uint8Array): Uint8Array;
  dispose(): void;
}

export function rankCandidates(urlsJson: string): string;
